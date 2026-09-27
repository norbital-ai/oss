// Approvals as today (rules 44–47, §3.8, §5.5; `docs/access/approvals.md`): the write hook that routes an act and adds
// the provisional commit's pieces (hold revisions, `bolt_approvals`, `approval_request`, `requestor`, notices), the
// guarded decisions, the seal, the point-in-time restore and the participants' read branch (rule 13).
import type { NotificationEvent } from '../../decl/collection.ts';
import type { Json } from '../../decl/values.ts';
import { BoltError, DbError, type Authority, type Captured, type EngineManifest, type NoticeRow, type Outcome, type Pred, type RowData, type TenantDb, type TenantTx } from '../contracts.ts';
import { catalogOf, or } from '../access/pred.ts';
import { q, SEARCH_COLUMN } from '../../protocol/catalog.ts';
import type { ApprovalHook } from '../write/act.ts';
import { actorRef, rollups } from '../write/commit.ts';
import { Chain, GATED, minter, noticeCaptures, noticeInsert, ownPredSql } from '../write/sql.ts';
import { canApprove, canSupersede, participant, resolve, type Request, type Snapshot } from './route.ts';

/** A decision as the timeline names it. */
const decisionOf = (next: { state: State; superseded?: true }) => next.superseded ? 'SUPERSEDED' : next.state === 'Pending' || next.state === 'Approved' ? 'APPROVED'
	: next.state === 'Rejected' ? 'REJECTED' : next.state === 'ChangesRequested' ? 'REQUEST_FOR_CHANGE' : 'WITHDRAWN';
const STATUS = { Pending: 'ONGOING', Approved: 'APPROVED', Rejected: 'REJECTED', ChangesRequested: 'CHANGES_REQUESTED', Withdrawn: 'WITHDRAWN' } as const;
type State = Request['state'];
type Stored = Request & { id: string; collection: string; record: string; action: string; user: string | null; sealed: boolean };
type Rule = { channel: string; to: readonly unknown[]; on?: { action?: readonly string[] }; title: string | { one: string }; body?: string | { one: string } };
type Refusal = Extract<Outcome, { kind: 'refused' }>;
export type Decision = { kind: 'decided'; requestId: string; status: string } | Refusal | Extract<Outcome, { kind: 'conflict' }>;
/** The approval view (§3.8 "Where it shows", L-BOLT-484, 600): the request with its flow, decisions and what the viewer may do. */
export type ApprovalView = {
	id: string; collection: string; record: string; action: string; at: string;
	status: string; step: number; steps: readonly (readonly string[])[]; superceded_by: readonly string[];
	requestor: { ref: string; name: string | null };
	decisions: readonly { step: number; status: string; by: { ref: string; name: string | null }; reason: string | null; at: string }[];
	appliedAt: string | null; restoredAt: string | null;
	mine: boolean; canDecide: boolean; canSupersede: boolean; participant: boolean;
};
export type DecideInput = { requestId: string; status: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE' | 'SUPERSEDED'; reason?: string; authority: Authority; now: string };
export type Approvals = {
	hook: ApprovalHook;
	process(x: DecideInput): Promise<Decision>;
	withdraw(x: { requestId: string; authority: Authority; now: string }): Promise<Decision>;
	/** `collections.resume`: clears every stamp once; `records` are the rows to publish. */
	seal(requestId: string, now: string): Promise<{ sealed: boolean; records: readonly { collection: string; id: string }[] }>;
	/** `collections.discard`: every held row back to its earliest `hold` snapshot, once; a restore that cannot apply is `conflicted`. */
	restore(requestId: string, now: string): Promise<'restored' | 'conflicted' | 'noop'>;
	/** Rule 13's approval-read branch (and the inbox): `approval_id` in the open requests `auth` participates in. */
	heldScope(auth: Authority): Promise<Pred>;
	/** The approval view for a participant or a reader of the held record (`readable`); `null` for anyone else. */
	view(requestId: string, auth: Authority, readable: (collection: string, id: string) => Promise<boolean>): Promise<ApprovalView | null>;
	/** The platform runs a decision queues (rule 48): `collections.resume` and `collections.discard`, input `{ requestId }`. */
	handlers(): { [name: string]: (input: Json) => Promise<Json> };
};
export type ApprovalsOptions = {
	/** Rule 47: the seal and the restore publish their committed rows to live data (the engine's lane). */
	publish?(captured: readonly Captured[]): void;
	/** The clock a platform run seals or restores at; default the wall clock. */
	clock?(): string;
};

const refused = (code: Refusal['code'], message: string, field?: string): Refusal => ({ kind: 'refused', code, message, ...(field === undefined ? {} : { field }) });
const notPending = (id: string): Decision => ({ kind: 'conflict', records: [{ collection: 'approval_request', id, fields: ['status'] }] });
const lower = (ts: readonly string[] | undefined) => (ts ?? []).map((t) => t.toLowerCase());
const teams = (v: unknown): string[] => Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
/** A stored route as eligibility reads it: anything but lists of team names narrows to nobody (L-BOLT-229's malformed rows). */
const snapshot = (v: unknown): Snapshot => {
	const r = (v ?? {}) as { steps?: unknown; superceded_by?: unknown };
	return { steps: Array.isArray(r.steps) ? r.steps.map(teams) : [], superceded_by: teams(r.superceded_by) };
};
const one = (t: string | { one: string } | undefined) => t === undefined ? null : typeof t === 'string' ? t : t.one;
/** Rule 25a: a seal or restore that selected held rows and wrote none stops; the durable run records it, never re-queued. */
const stalled = (what: string) => new BoltError('noProgress', 'commit', `${what} selected held rows and wrote none; it stops (rule 25a)`);
/** The decision's fast path leaves a stalled seal or restore to its queued run, which records it. */
const leaveToRun = (e: unknown) => { if (!(e instanceof BoltError && e.code === 'noProgress')) throw e; };

/** A seal or restore piece's RETURNING: the committed images live data routes (rule 65). */
const IMAGES = `id::text AS id, coalesce(new.revision, old.revision)::int AS revision,
	CASE WHEN old.id IS NULL THEN NULL ELSE to_jsonb(old) END AS o, CASE WHEN new.id IS NULL THEN NULL ELSE to_jsonb(new) END AS n`;
type Image = { c: string; id: string; revision: number; o: RowData | null; n: RowData | null };
const captured = (xs: readonly Image[], cause: Captured['cause'] = 'direct'): Captured[] => xs.map((x) => ({ collection: x.c, id: x.id, revision: x.revision,
	op: x.o === null ? 'create' : x.n === null ? 'delete' : 'update', old: x.o, new: x.n, cause }));

export function approvals(m: EngineManifest, db: TenantDb, options: ApprovalsOptions = {}): Approvals {
	const publish = (xs: readonly Captured[]) => { if (xs.length > 0) options.publish?.(xs); };
	const cat = catalogOf(m);
	const toStored = (r: { readonly [c: string]: Json }): Stored => ({ id: String(r['id']), state: r['state'] as State, step: Number(r['step']),
		requestor: String(r['requestor']), user: r['requestor_user'] as string | null, route: snapshot(r['route']),
		collection: String(r['collection']), record: String(r['record']), action: String(r['action']), sealed: r['sealed_at'] !== null });
	const load = async (id: string): Promise<Stored | null> => {
		const [r] = await db.read([{ text: `SELECT id::text AS id, * FROM bolt_approvals WHERE id::text = $1`, params: [id] }]);
		const row = r!.rows[0];
		return row === undefined ? null : toStored(row);
	};

	// ── notices: rows of the statement that caused the event (rule 47). ponytail: `{ team }`/`{ policy }` recipients stay
	// descriptors that `notifications.deliver` expands; titles are the authored text (`one`), not interpolated.
	const rules = (a: Stored, event: NotificationEvent): Rule[] => ((m.collections[a.collection]?.notifications?.[event] ?? []) as Rule[])
		.filter((r) => r.on?.action === undefined || r.on.action.includes(a.action));
	const notices = async (a: Stored, events: readonly (readonly [NotificationEvent, number])[], record?: RowData | null): Promise<(NoticeRow & { id: string })[]> => {
		const byUser = events.some(([e]) => rules(a, e).some((r) => r.to.some((t) => typeof t === 'object' && t !== null && 'user' in t)));
		if (byUser && record === undefined) {
			const [r] = await db.read([{ text: `SELECT to_jsonb(t) AS r FROM ${q(a.collection)} t WHERE t.id::text = $1`, params: [a.record] }]);
			record = (r!.rows[0]?.['r'] ?? null) as RowData | null;
		}
		return events.flatMap(([event, step]) => rules(a, event).map((rule, i) => {
			const id = `${a.id}:${event}:${step}:${i}`;
			const to = rule.to.flatMap((t): Json[] => t === 'requestor' ? (a.user === null ? [] : [{ user: a.user }])
				: t === 'step_approvers' ? (a.route.steps[step] ?? []).map((team) => ({ team }))
				: typeof t === 'object' && t !== null && 'user' in t ? (typeof record?.[String(t.user)] === 'string' ? [{ user: record[String(t.user)]! }] : [])
				: [t as Json]);
			return { id, once: id, to: { channel: rule.channel, recipients: to }, title: one(rule.title)!, ...(rule.body === undefined ? {} : { body: one(rule.body)! }),
				link: { collection: a.collection, id: a.record } };
		}));
	};
	const noticePiece = (c: Chain, rows: readonly NoticeRow[], now: string, when: string) => {
		if (rows.length > 0) noticeInsert(c, 'ap_notice', rows as unknown as Json, now, m.teams, when);
	};
	/** One `hold` revision per row the act touched (rule 45): its full pre-image, `null` for a row the request created. */
	const hold = (c: Chain, requestId: string, auth: Authority, now: string) => {
		c.cte('ap_hold', `INSERT INTO bolt_history (collection, record, revision, at, actor, op, cause, approval_id, changes)
	SELECT x.c, x.id::uuid, coalesce((x.o->>'revision')::int, 0), ${c.p(now)}::timestamptz, ${c.p(actorRef(auth.actor))}, x.op, 'hold',
		${c.p(requestId)}::uuid, coalesce(x.o, 'null'::jsonb) FROM allp x WHERE x.cause <> 'derived'`);
	};

	const hook: ApprovalHook = {
		async participant(requestId, auth) {
			const a = await load(requestId);
			return a !== null && participant(a, auth);
		},
		async route({ collection, authority: auth, bindings: b, rows }) {
			// a participant's write on a held row rides the open request (rule 46): stamped and hold-revisioned, never a second one
			const riding = rows.map((r) => r.pre?.['approval_id']).find((x): x is string => typeof x === 'string');
			if (riding !== undefined) return { requestId: riding, pieces: (c: Chain) => hold(c, riding, auth, b.now) };
			const snap = resolve(m, collection, b, auth, rows.map(({ write: w, pre, routes }) => ({ op: w.op, pre, routes,
				post: w.op === 'create' ? { ...w.values, id: w.id } : w.op === 'update' ? { ...pre, ...w.set } : null,
				changed: w.op === 'create' ? Object.keys(w.values) : w.op === 'update' ? Object.keys(w.set) : [] })));
			if (snap === 'split') return refused('approvalSplit', 'These records need different approvals; submit them separately.');
			if (snap === null) return null;
			const first = rows[0]!.write;
			// retry-stable (L-BOLT-201): a create's id is minted from the invocation, an update's row names its revision
			const requestId = (await minter(`approval:${first.collection}:${first.id}:${first.op === 'create' ? 0 : first.revision}`, b.now))();
			const a: Stored = { id: requestId, state: 'Pending', step: 0, requestor: actorRef(auth.actor), user: auth.actor.kind === 'member' ? auth.actor.id : null,
				route: snap, collection, record: first.id, action: first.op, sealed: false };
			const record = first.op === 'create' ? { ...first.values, id: first.id } : first.op === 'update' ? { ...rows[0]!.pre, ...first.set } : rows[0]!.pre;
			const notes = await notices(a, [['approvalStarted', 0], ['approvalStepRequested', 0]], record);
			return { requestId, pieces: (c: Chain) => {
				hold(c, requestId, auth, b.now);
				c.cte('ap_state', `INSERT INTO bolt_approvals (id, state, step, collection, record, action, requestor, requestor_user, route, at)
	SELECT ${c.p(requestId)}::uuid, 'Pending', 0, ${c.p(collection)}, ${c.p(a.record)}, ${c.p(a.action)}, ${c.p(a.requestor)}, ${c.p(a.user)},
		${c.p(snap as unknown as Json)}::jsonb, ${c.p(b.now)}::timestamptz WHERE ${GATED} ON CONFLICT (id) DO NOTHING RETURNING id`);
				c.cte('ap_request', `INSERT INTO approval_request (id, collection_name, record_id, action, status, step, steps, approver_teams, superseder_teams, created_at)
	SELECT id, ${c.p(collection)}, ${c.p(a.record)}, ${c.p(a.action)}, 'ONGOING', 0, ${snap.steps.length}, ${c.p(lower(snap.steps[0]))}::jsonb,
		${c.p(lower(snap.superceded_by))}::jsonb, ${c.p(b.now)}::timestamptz FROM ap_state`);
				c.cte('ap_requestor', `INSERT INTO requestor (id, approval_request_id, user_id) SELECT id::text || ':' || ${c.p(a.requestor)}, id, ${c.p(a.user ?? a.requestor)} FROM ap_state`);
				noticePiece(c, notes, b.now, 'EXISTS (SELECT 1 FROM ap_state)');
			} };
		},
	};

	/**
	 * One guarded transition (only from `Pending` at the step the decider saw) with its projection and notices. A final
	 * decision is one write statement (rule 20): the last approval or a supersede carries the seal's pieces, a reject,
	 * request-for-change or withdraw the restore's (then any roll-up it moved, in the same transaction). When that
	 * statement cannot apply (a restore conflict, rule 47; no progress, rule 25a) the decision lands alone with its
	 * queued follow-up, which marks the request conflicted or records the stall.
	 */
	async function transition(a: Stored, next: { state: State; step: number; superseded?: true }, auth: Authority, reason: string,
		events: readonly (readonly [NotificationEvent, number])[], now: string): Promise<Decision> {
		const followup = next.state === 'Approved' ? 'collections.resume' : next.state === 'Pending' ? null : 'collections.discard';
		if (followup === null) return queued(a, next, auth, reason, events, now, null);
		try {
			return await fused(a, next, auth, reason, events, now, followup);
		} catch (e) {
			const cannot = e instanceof DbError && (e.sqlstate.startsWith('23') || e.message.startsWith('noProgress'))
				|| e instanceof BoltError && e.code === 'noProgress';
			if (!cannot) throw e;
			return queued(a, next, auth, reason, events, now, followup);
		}
	}
	/** The transition's own pieces: the guarded `up` (with the decision log), the `approval_request` projection, the notices. */
	async function decisionPieces(c: Chain, a: Stored, next: { state: State; step: number; superseded?: true }, auth: Authority, reason: string,
		events: readonly (readonly [NotificationEvent, number])[], now: string, closes: 'sealed_at' | 'restored_at' | null) {
		const by = actorRef(auth.actor), open = next.state === 'Pending';
		// the decision log (the approval view's timeline) is part of the guarded transition
		const decision = { step: a.step, status: decisionOf(next), by, reason: reason === '' ? null : reason, at: now };
		c.cte('up', `UPDATE bolt_approvals SET state = ${c.p(next.state)}, step = ${next.step}, superseded = ${next.superseded === true}, decided_by = ${c.p(by)},
	reason = ${c.p(reason === '' ? null : reason)}, decisions = decisions || jsonb_build_array(${c.p(decision)}::jsonb)${closes === null ? '' : `, ${closes} = ${c.p(now)}::timestamptz`}
	WHERE id::text = ${c.p(a.id)} AND state = 'Pending' AND step = ${a.step} RETURNING id`);
		c.cte('pr', `UPDATE approval_request SET status = ${c.p(STATUS[next.state])}, step = ${next.step},
	approver_teams = ${c.p(open ? lower(a.route.steps[next.step]) : [])}::jsonb, superseder_teams = ${c.p(open ? lower(a.route.superceded_by) : [])}::jsonb,
	closed_at = ${c.p(open ? null : now)}::timestamptz, closed_by = ${c.p(open ? null : by)}${closes === 'sealed_at' ? `, applied_at = ${c.p(now)}::timestamptz` : ''},
	revision = revision + 1 WHERE id IN (SELECT id FROM up)`);
		const sealing = closes === 'sealed_at' ? [['committed', a.step], ['approvalCompleted', a.step]] as const : [];
		noticePiece(c, await notices(a, [...events, ...sealing]), now, 'EXISTS (SELECT 1 FROM up)');
	}
	/** A final decision and its seal or restore, one statement (the restore's roll-ups after it, one transaction). */
	async function fused(a: Stored, next: { state: State; step: number; superseded?: true }, auth: Authority, reason: string,
		events: readonly (readonly [NotificationEvent, number])[], now: string, followup: 'collections.resume' | 'collections.discard'): Promise<Decision> {
		const c = new Chain();
		if (followup === 'collections.resume') {
			const [held] = await db.read([{ text: `SELECT DISTINCT collection FROM bolt_history WHERE approval_id::text = $1`, params: [a.id] }]);
			await decisionPieces(c, a, next, auth, reason, events, now, 'sealed_at');
			const rows = sealPieces(c, a.id, held!.rows.map((r) => String(r['collection'])).filter((t) => m.models[t] !== undefined), 'up');
			const res = await db.write(c.sql(`(SELECT count(*) FROM up)::int AS n, ${rows} AS records, (SELECT count(*) FROM progress)::int AS p, ${noticeCaptures(c)} AS notices`));
			if (res.rows[0]?.['n'] !== 1) return notPending(a.id);
			publish([...captured((res.rows[0]?.['records'] ?? []) as unknown as Image[]), ...res.rows[0]!['notices'] as unknown as Captured[]]);
			return { kind: 'decided', requestId: a.id, status: STATUS[next.state] };
		}
		await decisionPieces(c, a, next, auth, reason, events, now, 'restored_at'); // its notices may read, so before the transaction
		const out = await db.transaction(async (tx) => {
			const holds = await tx.query(holdsRead(a.id));
			const r = restorePieces(c, a.id, holds.rows, now, 'up');
			const res = await tx.query(c.sql(`(SELECT count(*) FROM up)::int AS n, ${r.rows} AS rows, ${noticeCaptures(c)} AS notices`));
			if (res.rows[0]!['n'] !== 1) return null;
			return [...await restored(tx, r, res.rows[0]!['rows'] as unknown as Image[], now), ...res.rows[0]!['notices'] as unknown as Captured[]];
		});
		if (out === null) return notPending(a.id);
		publish(out);
		return { kind: 'decided', requestId: a.id, status: STATUS[next.state] };
	}
	/** The transition alone with its queued follow-up (the durable path), then the follow-up's fast path. */
	async function queued(a: Stored, next: { state: State; step: number; superseded?: true }, auth: Authority, reason: string,
		events: readonly (readonly [NotificationEvent, number])[], now: string, followup: 'collections.resume' | 'collections.discard' | null): Promise<Decision> {
		const c = new Chain();
		await decisionPieces(c, a, next, auth, reason, events, now, null);
		if (followup !== null) c.cte('rn', `INSERT INTO sys_run (id, automation, input, due_at, key, cause, depth)
	SELECT ${c.p(`${a.id}:${followup}`)}, ${c.p(followup)}, ${c.p({ requestId: a.id })}::jsonb, ${c.p(now)}::timestamptz, ${c.p(`${a.id}:${followup}`)}, 'approval', 0
	FROM up ON CONFLICT (key) DO NOTHING`);
		const res = await db.write(c.sql(`(SELECT count(*) FROM up)::int AS n, ${noticeCaptures(c)} AS notices`));
		if (res.rows[0]?.['n'] !== 1) return notPending(a.id);
		publish(res.rows[0]!['notices'] as unknown as Captured[]);
		// the queued task is the durable follow-up; running it here is the fast path, and both are once-only
		let status: string = STATUS[next.state];
		if (followup === 'collections.resume') await seal(a.id, now).catch(leaveToRun);
		if (followup === 'collections.discard' && await restore(a.id, now).catch(leaveToRun) === 'conflicted') status = 'CONFLICTED';
		return { kind: 'decided', requestId: a.id, status };
	}

	async function process(x: DecideInput): Promise<Decision> {
		const a = await load(x.requestId);
		if (a === null) return refused('notFound', 'No approval request has this id.');
		if (a.state !== 'Pending') return notPending(a.id);
		const reason = x.reason?.trim() ?? '', auth = x.authority;
		const needs = (why: string) => refused('invalidInput', `${why} needs a reason.`, 'reason');
		if (x.status === 'SUPERSEDED') {
			if (!canSupersede(a, auth)) return refused('forbidden', 'You may not supersede this approval.');
			if (reason === '') return needs('Superseding');
			return transition(a, { state: 'Approved', step: a.step, superseded: true }, auth, reason, [['approvalSuperseded', a.step]], x.now);
		}
		if (!canApprove(a, auth.actor)) return refused('forbidden', 'You are not an approver of this step.');
		if (x.status === 'REJECTED') return transition(a, { state: 'Rejected', step: a.step }, auth, reason, [['rejected', a.step]], x.now);
		if (x.status === 'REQUEST_FOR_CHANGE') {
			if (reason === '') return needs('Requesting changes');
			return transition(a, { state: 'ChangesRequested', step: a.step }, auth, reason, [['approvalChangesRequested', a.step]], x.now);
		}
		const last = a.step + 1 >= a.route.steps.length;
		return transition(a, last ? { state: 'Approved', step: a.step } : { state: 'Pending', step: a.step + 1 }, auth, reason,
			last ? [['approvalStepApproved', a.step]] : [['approvalStepApproved', a.step], ['approvalStepRequested', a.step + 1]], x.now);
	}

	async function seal(requestId: string, now: string): ReturnType<Approvals['seal']> {
		const a = await load(requestId);
		if (a === null || a.state !== 'Approved' || a.sealed) return { sealed: false, records: [] };
		const [held] = await db.read([{ text: `SELECT DISTINCT collection FROM bolt_history WHERE approval_id::text = $1`, params: [requestId] }]);
		const c = new Chain();
		c.cte('st', `UPDATE bolt_approvals SET sealed_at = ${c.p(now)}::timestamptz WHERE id::text = ${c.p(requestId)} AND state = 'Approved' AND sealed_at IS NULL RETURNING id`);
		const rows = sealPieces(c, requestId, held!.rows.map((r) => String(r['collection'])).filter((t) => m.models[t] !== undefined), 'st');
		c.cte('pr', `UPDATE approval_request SET applied_at = ${c.p(now)}::timestamptz, revision = revision + 1 WHERE id IN (SELECT id FROM st)`);
		noticePiece(c, await notices(a, [['committed', a.step], ['approvalCompleted', a.step]]), now, 'EXISTS (SELECT 1 FROM st)');
		c.cte('rn', `UPDATE sys_run SET state = 'done' WHERE key = ${c.p(`${requestId}:collections.resume`)} AND EXISTS (SELECT 1 FROM st)`);
		let res;
		try {
			res = await db.write(c.sql(`(SELECT count(*) FROM st)::int AS n, ${rows} AS records, (SELECT count(*) FROM progress)::int AS p, ${noticeCaptures(c)} AS notices`));
		} catch (e) {
			if (e instanceof DbError && e.message.startsWith('noProgress')) throw stalled('the seal');
			throw e;
		}
		const images = (res.rows[0]?.['records'] ?? []) as unknown as Image[];
		publish([...captured(images), ...(res.rows[0]?.['notices'] ?? []) as unknown as Captured[]]);
		return { sealed: res.rows[0]?.['n'] === 1, records: images.map((x) => ({ collection: x.c, id: x.id })) };
	}

	async function restore(requestId: string, now: string): ReturnType<Approvals['restore']> {
		try {
			const r = await db.transaction((tx) => restoreIn(tx, requestId, now));
			if (r === 'noop') return r;
			publish(r);
			return 'restored';
		} catch (e) {
			if (!(e instanceof DbError && e.sqlstate.startsWith('23'))) throw e;
			// CONFLICTED (rule 47): the transaction rolled back, so the hold stays; an administrator retries the restore
			const a = (await load(requestId))!;
			const c = new Chain();
			c.cte('st', `UPDATE bolt_approvals SET conflicted = true WHERE id::text = ${c.p(requestId)} AND restored_at IS NULL RETURNING id`);
			c.cte('pr', `UPDATE approval_request SET status = 'CONFLICTED', revision = revision + 1 WHERE id IN (SELECT id FROM st)`);
			noticePiece(c, await notices(a, [['approvalConflicted', a.step]]), now, 'EXISTS (SELECT 1 FROM st)');
			publish((await db.write(c.sql(`(SELECT count(*) FROM st)::int AS n, ${noticeCaptures(c)} AS notices`))).rows[0]!['notices'] as unknown as Captured[]);
			return 'conflicted';
		}
	}
	/**
	 * Record-level point-in-time recovery: one read of the `hold` snapshots, then one statement (rule 20's restore row)
	 * whose first piece claims the request (`restored_at`, once) and gates every other piece, FKs judged at its end;
	 * then, only where a restored table feeds a roll-up, the roll-ups in the same transaction.
	 */
	async function restoreIn(tx: TenantTx, requestId: string, now: string): Promise<Captured[] | 'noop'> {
		const holds = await tx.query(holdsRead(requestId));
		const c = new Chain();
		c.cte('g', `UPDATE bolt_approvals SET restored_at = ${c.p(now)}::timestamptz, conflicted = false WHERE id::text = ${c.p(requestId)}
	AND state IN ('Rejected', 'ChangesRequested', 'Withdrawn') AND restored_at IS NULL RETURNING state`);
		const r = restorePieces(c, requestId, holds.rows, now, 'g');
		c.cte('pr', `UPDATE approval_request SET status = (SELECT CASE g.state ${Object.entries(STATUS).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(' ')} END FROM g),
	revision = revision + 1 WHERE id::text = ${c.p(requestId)} AND EXISTS (SELECT 1 FROM g)`);
		c.cte('rn', `UPDATE sys_run SET state = 'done' WHERE key = ${c.p(`${requestId}:collections.discard`)} AND EXISTS (SELECT 1 FROM g)`);
		const res = await tx.query(c.sql(`(SELECT count(*) FROM g)::int AS n, ${r.rows} AS rows`));
		if (res.rows[0]!['n'] !== 1) return 'noop';
		return restored(tx, r, res.rows[0]!['rows'] as unknown as Image[], now);
	}
	const holdsRead = (requestId: string) => ({ text: `SELECT DISTINCT ON (collection, record) collection, record::text AS id, changes FROM bolt_history
		WHERE approval_id::text = $1 AND cause = 'hold' ORDER BY collection, record, revision, at`, params: [requestId] });
	/**
	 * The seal's pieces (rule 47), gated on `gate` (a piece returning the request id once): every stamp cleared, and
	 * nothing else (no revision, no edge or `edit` rule, no trigger). Rule 25a: stamped rows selected in this statement's
	 * snapshot but none cleared fails it (`progress`, which the caller's select reads). Returns the images' expression.
	 */
	function sealPieces(c: Chain, requestId: string, tables: readonly string[], gate: string): string {
		const cleared = tables.map((t, i) =>
			c.cte(`s${i}`, `UPDATE ${q(t)} SET approval_id = NULL WHERE approval_id = (SELECT id FROM ${gate}) RETURNING ${c.p(t)}::text AS c, ${IMAGES}`));
		const count = (xs: readonly string[]) => xs.length === 0 ? '0' : xs.map((x) => `(SELECT count(*) FROM ${x})`).join(' + ');
		const selected = tables.map((t) => `(SELECT count(*) FROM ${q(t)} WHERE approval_id::text = ${c.p(requestId)})`);
		c.cte('progress', `SELECT bolt_assert(NOT EXISTS (SELECT 1 FROM ${gate}) OR ${count(selected)} = 0 OR ${count(cleared)} > 0, 'noProgress', ${c.p(requestId)})`);
		return cleared.length === 0 ? `'[]'::jsonb` : `(SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) FROM (${cleared.map((x) => `SELECT c, id, revision, o, n FROM ${x}`).join(' UNION ALL ')}) x)`;
	}
	type Restoring = { tables: ReadonlyMap<string, readonly { readonly [c: string]: Json }[]>; rows: string };
	/**
	 * Record-level point-in-time recovery's pieces (rule 47), gated on `gate`: rows born under the hold deleted, every
	 * other row rewritten to its earliest `hold` snapshot (re-inserted if deleted in flight), one `restore` revision each.
	 */
	function restorePieces(c: Chain, requestId: string, holds: readonly { readonly [c: string]: Json }[], now: string, gate: string): Restoring {
		const G = `EXISTS (SELECT 1 FROM ${gate})`, parts: string[] = [];
		const tables = Map.groupBy(holds.filter((r) => m.models[String(r['collection'])] !== undefined), (r) => String(r['collection']));
		[...tables].forEach(([t, rows], i) => {
			const born = rows.filter((r) => r['changes'] === null).map((r) => r['id']!);
			const snaps = rows.flatMap((r) => r['changes'] === null ? [] : [r['changes'] as RowData]);
			if (born.length > 0) parts.push(c.cte(`d${i}`, `DELETE FROM ${q(t)} t WHERE t.id::text IN (SELECT jsonb_array_elements_text(${c.p(born)}::jsonb)) AND ${G}
	RETURNING ${c.p(t)}::text AS c, t.id::text AS id, 'delete'::text AS op, to_jsonb(t) AS o, NULL::jsonb AS n`));
			if (snaps.length === 0) return;
			const generated = new Set([SEARCH_COLUMN, ...[...cat.models.get(t)!.fields.values()].filter((f) => f.computed).map((f) => f.column)]);
			const cols = Object.keys(snaps[0]!).filter((k) => k !== 'revision' && !generated.has(k));
			parts.push(c.cte(`u${i}`, `INSERT INTO ${q(t)} AS t (${[...cols, 'revision'].map(q).join(', ')})
	SELECT ${cols.map((k) => `r.${q(k)}`).join(', ')}, coalesce((SELECT max(h.revision) FROM bolt_history h WHERE h.collection = ${c.p(t)} AND h.record = r.id), r.revision) + 1
	FROM jsonb_populate_recordset(null::${q(t)}, ${c.p(snaps as unknown as Json)}::jsonb) r WHERE ${G}
	ON CONFLICT (id) DO UPDATE SET ${[...cols.filter((k) => k !== 'id').map((k) => `${q(k)} = excluded.${q(k)}`), 'revision = t.revision + 1'].join(', ')}
	RETURNING ${c.p(t)}::text AS c, new.id::text AS id, CASE WHEN old.id IS NULL THEN 'create' ELSE 'update' END AS op,
		CASE WHEN old.id IS NULL THEN NULL ELSE to_jsonb(old) END AS o, to_jsonb(new) AS n`));
		});
		const all = parts.length === 0 ? 'SELECT NULL::text c, NULL::text id, NULL::text op, NULL::jsonb o, NULL::jsonb n WHERE false'
			: parts.map((x) => `SELECT c, id, op, o, n FROM ${x}`).join(' UNION ALL ');
		c.cte('h', `INSERT INTO bolt_history (collection, record, revision, at, actor, op, cause, approval_id, changes)
	SELECT x.c, x.id::uuid, coalesce((x.n->>'revision')::int, (x.o->>'revision')::int + 1), ${c.p(now)}::timestamptz, 'system:restore', x.op, 'restore',
		${c.p(requestId)}::uuid, coalesce(x.n, '{}'::jsonb) FROM (${all}) x`);
		return { tables, rows: `(SELECT coalesce(jsonb_agg(jsonb_build_object('c', c, 'id', id, 'revision', coalesce((n->>'revision')::int, (o->>'revision')::int + 1),
	'o', o, 'n', n)), '[]'::jsonb) FROM (${all}) x)` };
	}
	/** After a restore's statement: rule 25a's progress, then the roll-ups over the restored children (rule 43). */
	async function restored(tx: TenantTx, r: Restoring, changed: readonly Image[], now: string): Promise<Captured[]> {
		const selected = [...r.tables.values()].reduce((n, rs) => n + rs.length, 0);
		if (selected > 0 && changed.length === 0) throw stalled('the restore'); // rolls the transaction back
		const out = captured(changed);
		// ponytail: one level; a roll-up of a roll-up needs the parents' own parents recomputed in dependency order
		for (const parent of Object.keys(m.models)) {
			const rs = rollups(m, cat, parent).filter((x) => r.tables.has(x.child));
			const ids = [...new Set(changed.flatMap((x) => rs.filter((y) => y.child === x.c).flatMap((y) => [x.o?.[y.fk], x.n?.[y.fk]])))].filter((v) => typeof v === 'string');
			if (ids.length === 0) continue;
			const d = new Chain();
			const sets = rs.map((y) => `${q(y.field)} = (SELECT ${y.kind === 'count' ? 'count(*)' : `coalesce(sum(x.${q(y.childField!)}), 0)`} FROM ${q(y.child)} x
		WHERE x.${q(y.fk)} = p.id AND ${y.where === undefined ? 'true' : ownPredSql(y.where, 'x', d)})`);
			d.cte('u', `UPDATE ${q(parent)} p SET ${sets.join(', ')}, revision = p.revision + 1, updated_at = ${d.p(now)}::timestamptz
	WHERE p.id::text IN (SELECT jsonb_array_elements_text(${d.p(ids)}::jsonb)) RETURNING p.id::text AS id, new.revision, to_jsonb(old) AS o, to_jsonb(new) AS n`);
			d.cte('h', `INSERT INTO bolt_history (collection, record, revision, at, actor, op, cause, changes)
	SELECT ${d.p(parent)}, u.id::uuid, u.revision, ${d.p(now)}::timestamptz, 'system:restore', 'update', 'derived', u.n FROM u`);
			const up = await tx.query(d.sql(`(SELECT coalesce(jsonb_agg(jsonb_build_object('c', ${d.p(parent)}::text, 'id', id, 'revision', revision, 'o', o, 'n', n)), '[]'::jsonb) FROM u) AS rows`));
			out.push(...captured(up.rows[0]!['rows'] as unknown as Image[], 'derived'));
		}
		return out;
	}

	return {
		hook, process, seal, restore,
		handlers() {
			const now = options.clock ?? (() => new Date().toISOString());
			const id = (input: Json) => String((input as { requestId?: Json } | null)?.requestId ?? '');
			return {
				'collections.resume': async (input) => (await seal(id(input), now())) as unknown as Json,
				'collections.discard': async (input) => ({ restored: await restore(id(input), now()) }),
			};
		},
		async withdraw({ requestId, authority, now }) {
			const a = await load(requestId);
			if (a === null) return refused('notFound', 'No approval request has this id.');
			if (a.state !== 'Pending') return notPending(a.id);
			if (a.requestor !== actorRef(authority.actor)) return refused('forbidden', 'Only the requestor may withdraw an approval.');
			return transition(a, { state: 'Withdrawn', step: a.step }, authority, '', [['approvalWithdrawn', a.step]], now);
		},
		async view(requestId, auth, readable) {
			const [r] = await db.read([{ text: `SELECT id::text AS id, *, to_json(at)#>>'{}' AS at_text, to_json(sealed_at)#>>'{}' AS sealed_text, to_json(restored_at)#>>'{}' AS restored_text
				FROM bolt_approvals WHERE id::text = $1`, params: [requestId] }]);
			const row = r!.rows[0];
			if (row === undefined) return null;
			const a = toStored(row), me = actorRef(auth.actor);
			const pending = a.state === 'Pending';
			const part = participant(a, auth) || a.requestor === me;
			if (!part && !(await readable(a.collection, a.record))) return null;
			const log = (Array.isArray(row['decisions']) ? row['decisions'] : []) as { step: number; status: string; by: string; reason: string | null; at: string }[];
			const refs = [...new Set([a.requestor, ...log.map((d) => d.by)])].filter((x) => x.startsWith('member:')).map((x) => x.slice('member:'.length));
			const [names] = await db.read([{ text: `SELECT id, name FROM sys_user WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))`, params: [JSON.stringify(refs)] }]);
			const name = new Map(names!.rows.map((n) => [`member:${String(n['id'])}`, (n['name'] ?? null) as string | null]));
			const who = (ref: string) => ({ ref, name: name.get(ref) ?? null });
			const iso = (v: Json | undefined) => typeof v === 'string' ? new Date(v).toISOString() : null;
			return { id: a.id, collection: a.collection, record: a.record, action: a.action, at: iso(row['at_text'])!,
				status: row['conflicted'] === true ? 'CONFLICTED' : STATUS[a.state], step: a.step, steps: a.route.steps, superceded_by: a.route.superceded_by,
				requestor: who(a.requestor), decisions: log.map((d) => ({ step: d.step, status: d.status, by: who(d.by), reason: d.reason, at: d.at })),
				appliedAt: iso(row['sealed_text']), restoredAt: iso(row['restored_text']),
				mine: a.requestor === me, canDecide: pending && canApprove(a, auth.actor), canSupersede: pending && canSupersede(a, auth), participant: participant(a, auth) };
		},
		async heldScope(auth) {
			const [r] = await db.read([{ text: `SELECT id::text AS id, * FROM bolt_approvals WHERE state = 'Pending'`, params: [] }]);
			const ids = r!.rows.map(toStored).filter((a) => participant(a, auth)).map((a) => a.id);
			// ponytail: `or` of `eq`s; the query compiler's `in` binds a JSON list where Postgres wants an array literal
			return or(ids.map((id): Pred => ({ t: 'cmp', field: 'approval_id', op: 'eq', arg: { lit: id } })));
		},
	};
}
