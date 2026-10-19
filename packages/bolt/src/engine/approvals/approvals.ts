// Approval requests (rules 44–46), the provisional-commit model: a routed write is committed at once and held by its
// request; each move of the state machine (machine.ts) is one guarded statement with every effect it has — the log
// entry, the readable `approval_request` face, the notices, and on rejection or withdrawal the rollback of every held
// record to its checkpoint.
import { Clock, Effect, Layer, Option, Result, Schema } from 'effect';
import { localOf } from '@norbital-ai/std/zone';
import {
	Approvals,
	Guest,
	Links,
	Live,
	Manifest,
	Wake,
	type ApprovalsShape,
	type GuestShape,
	type Readable,
	type ApprovalFilter
} from '../services.ts';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { teams, type EngineManifest } from '../manifest.ts';
import type { NotificationEvent } from '../../decl/collection.ts';
import type { Authority, Bindings, NoticeRow, Outcome, RowData } from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import { catalogOf } from '../access/pred.ts';
import { q } from '../../protocol/catalog.ts';
import { constraintsOf, type ApprovalHook } from '../write/act.ts';
import { actorRef, compileCommit, CommitAnswer, committed } from '../write/commit.ts';
import { Chain, GATED, minter, noticeInsert, canonical, decided } from '../write/sql.ts';
import { collectionNotices } from '../notifications/rules.ts';
import { outboundFrom, outboundPiece } from '../integrations/outbound.ts';
import { participant, rolesOf, routeSnapshot as snapshot, type Request } from './route.ts';
import { checkpoint } from './lock.ts';
import {
	movesFor,
	OPEN,
	SOURCE_CHANGED,
	transition,
	type ApprovalMove,
	type ApprovalState
} from './machine.ts';
import { rollbackPlan, type RolledBack, type Skipped } from './rollback.ts';
import { Authorities } from '../identity/actor.ts';

/** The readable face's status of each state (`approval_request.status`, the view's `status`). */
export const STATUS = {
	Pending: 'ONGOING',
	ChangesRequested: 'CHANGES_REQUESTED',
	Approved: 'APPROVED',
	Rejected: 'REJECTED',
	Withdrawn: 'WITHDRAWN',
	Superseded: 'SUPERSEDED'
} as const satisfies { [S in ApprovalState]: string };
/** `approvals.process`'s `status` names the move. */
const MOVES = {
	APPROVED: 'approve',
	REJECTED: 'reject',
	REQUEST_FOR_CHANGE: 'requestChanges',
	RESUBMITTED: 'resubmit',
	WITHDRAWN: 'withdraw',
	SUPERSEDED: 'supersede',
	COMMENT: 'comment',
	CLOSED: 'close'
} as const satisfies { [status: string]: ApprovalMove };
export type DecisionStatus = keyof typeof MOVES;
/** The `status` naming each move. */
export const STATUS_OF = {
	approve: 'APPROVED',
	reject: 'REJECTED',
	requestChanges: 'REQUEST_FOR_CHANGE',
	resubmit: 'RESUBMITTED',
	withdraw: 'WITHDRAWN',
	supersede: 'SUPERSEDED',
	comment: 'COMMENT',
	close: 'CLOSED'
} as const satisfies { [M in ApprovalMove]: DecisionStatus };
const State = Schema.Literals([
	'Pending',
	'ChangesRequested',
	'Approved',
	'Rejected',
	'Withdrawn',
	'Superseded'
]);

const Entry = Schema.Struct({
	collection: Schema.String,
	id: Schema.String,
	op: Schema.Literals(['create', 'update', 'delete']),
	before: Schema.NullOr(Schema.Number)
});
const LogEntry = Schema.Struct({
	move: Schema.Literals([
		'request',
		'approve',
		'reject',
		'requestChanges',
		'resubmit',
		'withdraw',
		'supersede',
		'comment',
		'close'
	]),
	by: Schema.String,
	at: Schema.String,
	from: Schema.NullOr(State),
	to: State,
	step: Schema.Number,
	reason: Schema.NullOr(Schema.String),
	rolledBack: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				collection: Schema.String,
				id: Schema.String,
				action: Schema.Literals(['restored', 'removed', 'recreated'])
			})
		)
	),
	skipped: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				collection: Schema.String,
				id: Schema.String,
				field: Schema.String,
				reason: Schema.String
			})
		)
	)
});
type LogEntry = typeof LogEntry.Type;
const StoredRow = Schema.Struct({
	id: Schema.String,
	state: State,
	step: Schema.Number,
	requestor: Schema.String,
	requestor_user: Schema.NullOr(Schema.String),
	route: Schema.Json,
	collection: Schema.String,
	record: Schema.String,
	action: Schema.String,
	records: Schema.Array(Entry),
	log: Schema.Array(LogEntry),
	at_text: Schema.String
});
type Stored = Request & {
	id: string;
	collection: string;
	record: string;
	action: string;
	user: string | null;
	records: readonly (typeof Entry.Type)[];
	log: readonly LogEntry[];
	at: string;
};
type Refusal = Extract<Outcome, { kind: 'refused' }>;
export type Decision =
	| { kind: 'decided'; requestId: string; status: string }
	| Refusal
	| Extract<Outcome, { kind: 'conflict' }>;
type Who = { ref: string; name: string | null };
/** The approval view (§3.8 "Where it shows"): the request, every interaction, the held records and the viewer's moves. */
export type ApprovalView = {
	id: string;
	collection: string;
	record: string;
	action: string;
	at: string;
	status: string;
	step: number;
	steps: readonly (readonly string[])[];
	superseded_by: readonly string[];
	/** Current source labels for captured route handles; labels never affect decision eligibility. */
	teamNames: Readonly<Record<string, string>>;
	requestor: Who;
	/** Every transition and comment, oldest first. */
	log: readonly {
		move: LogEntry['move'];
		by: Who;
		at: string;
		from: string | null;
		to: string;
		step: number;
		reason: string | null;
		rolledBack: LogEntry['rolledBack'];
		skipped: LogEntry['skipped'];
	}[];
	/** The records the provisional change holds (the checkpoint): root first. */
	records: readonly { collection: string; id: string; op: 'create' | 'update' | 'delete' }[];
	/** The moves the viewer may take now — the state machine's own answer, so buttons match the engine. */
	moves: readonly { status: DecisionStatus; reason: 'required' | 'optional' }[];
	mine: boolean;
	participant: boolean;
};
export type DecideInput = {
	requestId: string;
	status: DecisionStatus;
	reason?: string;
	authority: Authority;
	now: string;
};
type ApprovalsOptions = {
	bindings(at?: string): Effect.Effect<Bindings>;
	guest?: GuestShape | undefined;
	/** Publishes a decision's captured rows and notices, and wakes the queue (the act path's own `committed`). */
	committed?(
		answer: Pick<CommitAnswer, 'captured' | 'next_due' | 'changed_instances'>
	): Effect.Effect<void>;
	/** Re-reads the request's views and the `$approval` of the records it holds. */
	changed?(
		requestId: string,
		records: readonly { collection: string; id: string }[]
	): Effect.Effect<void>;
};

const refused = (code: Refusal['code'], message: string, field?: string): Refusal => ({
	kind: 'refused',
	code,
	message,
	...(field === undefined ? {} : { field })
});
const conflict = (id: string): Decision => ({
	kind: 'conflict',
	records: [{ collection: 'approval_request', id, fields: ['status'] }]
});
const teamIds = (ts: readonly string[] | undefined) => ts ?? [];

/** The events each move raises, with the step whose approvers `step_approvers` names. */
function eventsOf(
	move: ApprovalMove,
	from: { step: number },
	next: { state: ApprovalState; step: number }
): (readonly [NotificationEvent, number])[] {
	switch (move) {
		case 'approve':
			return next.state === 'Approved'
				? [
						['approvalStepApproved', from.step],
						['approvalCompleted', from.step]
					]
				: [
						['approvalStepApproved', from.step],
						['approvalStepRequested', next.step]
					];
		case 'reject':
			return [['rejected', from.step]];
		case 'requestChanges':
			return [['approvalChangesRequested', from.step]];
		case 'resubmit':
			return [
				['approvalResubmitted', 0],
				['approvalStepRequested', 0]
			];
		case 'withdraw':
		case 'close':
			return [['approvalWithdrawn', from.step]];
		case 'supersede':
			return [['approvalSuperseded', from.step]];
		case 'comment':
			return [['approvalCommented', from.step]];
	}
}

function makeApprovals(m: EngineManifest, db: TenantDbShape, options: ApprovalsOptions) {
	const cat = catalogOf(m);
	const sourceAuthorities = new Authorities(m, 'approval');
	const toStored = (r: typeof StoredRow.Type): Stored => ({
		id: r.id,
		state: r.state,
		step: r.step,
		requestor: r.requestor,
		user: r.requestor_user,
		route: snapshot(r.route),
		collection: r.collection,
		record: r.record,
		action: r.action,
		records: r.records,
		log: r.log,
		at: new Date(r.at_text).toISOString()
	});
	const select = `SELECT id::text AS id, state, step, requestor, requestor_user, route, collection, record, action, records, log,
		to_json(at)#>>'{}' AS at_text FROM bolt_approvals`;
	const load = Effect.fn('Approvals.load')(function* (id: string) {
		const rows = yield* db.rows(StoredRow, { text: `${select} WHERE id::text = $1`, params: [id] });
		return rows[0] === undefined ? null : toStored(rows[0]);
	});
	/** The root collection's held rows as they are now (a removed one as its id), for `{ user }` recipients. */
	const current = Effect.fn('Approvals.current')(function* (a: Stored) {
		const ids = a.records.filter((r) => r.collection === a.collection).map((r) => r.id);
		const table = cat.collections.get(a.collection)?.model.name;
		if (table === undefined || ids.length === 0)
			return [{ id: a.record, values: { id: a.record } }];
		const rows = yield* db.rows(Schema.Struct({ j: Schema.Record(Schema.String, Schema.Json) }), {
			text: `SELECT to_jsonb(t) AS j FROM ${q(table)} t WHERE t.id::text IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			params: [JSON.stringify(ids)]
		});
		const found = new Map(rows.map((r) => [String(r.j['id']), r.j]));
		return ids.map((id) => ({ id, values: found.get(id) ?? { id } }));
	});
	const notices = Effect.fn('Approvals.notices')(function* (
		a: Pick<Stored, 'id' | 'collection' | 'record' | 'action' | 'user' | 'route' | 'log'>,
		events: readonly (readonly [NotificationEvent, number])[],
		records: readonly { id: string; values: RowData }[],
		auth: Authority,
		now: string
	) {
		const b = yield* options.bindings(now);
		const notes: (NoticeRow & { id: string })[] = [];
		for (const [event, step] of events)
			notes.push(
				...(yield* collectionNotices(options.guest, m, {
					collection: a.collection,
					event,
					records: records.map((r) => ({ ...r, action: a.action })),
					requestor: a.user,
					approvers: a.route.steps[step] ?? [],
					actor: auth.actor,
					bindings: b,
					// one notice per rule per transition (the log entry's index), so a resubmitted step notifies again
					id: (rule) => `${a.id}:${a.log.length}:${event}:${rule}`,
					link: { collection: a.collection, id: a.record }
				}))
			);
		return notes;
	});

	const hook: ApprovalHook = {
		route: Effect.fn('Approvals.route')(function* (act) {
			const routes = act.routes.map((route) => ({
				steps: route.steps,
				superseded_by: route.superseded_by ?? []
			}));
			const route = routes[0];
			if (route === undefined) return refused('forbidden', 'No approval route admits this change.');
			if (routes.some((r) => canonical(r) !== canonical(route)))
				return refused(
					'approvalSplit',
					'These records need different approvals; submit them separately.'
				);
			const b = act.bindings,
				auth = act.authority;
			// retry-stable (L-BOLT-201): minted from the invocation and its key
			const requestId = minter(`approval:${act.seed}:${act.collection}:${act.record}`, b.now)();
			const a = {
				id: requestId,
				collection: act.collection,
				record: act.record,
				action: act.action,
				user: auth.actor.kind === 'member' ? auth.actor.id : null,
				route,
				log: []
			};
			const requestor = actorRef(auth.actor);
			const notes = yield* notices(
				a,
				[
					['approvalStarted', 0],
					['approvalStepRequested', 0]
				],
				act.records,
				auth,
				b.now
			);
			const entry: LogEntry = {
				move: 'request',
				by: requestor,
				at: b.now,
				from: null,
				to: 'Pending',
				step: 0,
				reason: null
			};
			const table = cat.collections.get(act.collection)?.model.name ?? act.collection;
			return {
				requestId,
				route,
				pieces: (c: Chain, held: string | null) => {
					const col = c.p(act.collection),
						rec = c.p(act.record);
					c.cte(
						'ap_state',
						`INSERT INTO bolt_approvals (id, state, step, collection, record, action, requestor, requestor_user, route, records, log, at)
	SELECT ${c.p(requestId)}::uuid, 'Pending', 0, ${col}, ${rec}, ${c.p(act.action)}, ${c.p(requestor)}, ${c.p(a.user)}, ${c.p(route)}::jsonb,
		(SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM (
			SELECT jsonb_build_object('collection', ${col}::text, 'id', ${rec}::text, 'op', 'update', 'before', (SELECT revision FROM ${q(table)} WHERE id::text = ${rec}))
				AS e WHERE NOT EXISTS (SELECT 1 FROM allp WHERE c = ${col} AND id = ${rec} AND cause IN ('direct', 'cascade'))
			UNION ALL SELECT ${checkpoint('x')} FROM (SELECT DISTINCT ON (c, id) * FROM allp WHERE cause IN ('direct', 'cascade') AND NOT erased) x) s),
		jsonb_build_array(${c.p(entry)}::jsonb), ${c.p(b.now)}::timestamptz
	WHERE ${GATED}${held === null ? '' : ` AND NOT EXISTS (SELECT 1 FROM ${held})`} ON CONFLICT (id) DO NOTHING RETURNING id`
					);
					c.cte(
						'ap_request',
						`INSERT INTO approval_request (id, collection_name, record_id, action, status, step, steps, approver_teams, superseder_teams, created_at)
	SELECT id, ${col}, ${rec}, ${c.p(act.action)}, 'ONGOING', 0, ${route.steps.length}, ${c.p(teamIds(route.steps[0]))}::jsonb,
		${c.p(teamIds(route.superseded_by))}::jsonb, ${c.p(b.now)}::timestamptz FROM ap_state`
					);
					c.cte(
						'ap_requestor',
						`INSERT INTO requestor (id, approval_request_id, user_id) SELECT id::text || ':' || ${c.p(requestor)}, id, ${c.p(a.user ?? requestor)} FROM ap_state`
					);
					if (notes.length > 0)
						noticeInsert(
							c,
							'ap_notice',
							notes,
							b.now,
							'EXISTS (SELECT 1 FROM ap_state)',
							m.teams,
							m.workspace.signup?.policies
						);
				}
			};
		})
	};

	/** A reviewer's or requester's current source authority (a stale preview or a moved team decides nothing). */
	const currentMember = Effect.fn('Approvals.currentMember')(function* (
		actor: Extract<Authority['actor'], { kind: 'member' }>,
		preview?: Authority['preview'],
		admin = false
	) {
		if (preview === undefined) return yield* sourceAuthorities.member(db, actor.id, !admin);
		const real = yield* sourceAuthorities.member(db, preview.by);
		if (real === null || !real.admin || real.actor.kind !== 'member') return null;
		if (preview.team !== null && actor.id !== preview.by) return null;
		const current =
			preview.team === null
				? yield* sourceAuthorities.member(db, actor.id, true)
				: yield* sourceAuthorities.team(db, real.actor, preview.team);
		return current === null ? null : { ...current, preview };
	});

	/** A release removed the open request's collection, or its record (that the request did not delete). */
	const sourceGone = Effect.fn('Approvals.sourceGone')(function* (a: Stored) {
		if (!OPEN.includes(a.state)) return false;
		const table = cat.collections.get(a.collection)?.model.name;
		if (table === undefined) return true;
		if (
			a.records.some((r) => r.collection === a.collection && r.id === a.record && r.op === 'delete')
		)
			return false;
		// ponytail: one existence read per open request in a list; batch per collection when lists grow
		const rows = yield* db.rows(Schema.Struct({ n: Schema.Number }), {
			text: `SELECT count(*)::int AS n FROM ${q(table)} WHERE id::text = $1`,
			params: [a.record]
		});
		return (rows[0]?.n ?? 0) === 0;
	});
	/** One move: the guarded state change, its log entry, the readable face, the notices and (reject, withdraw) the rollback. */
	const process = Effect.fn('Approvals.process')(function* (
		x: DecideInput
	): Effect.fn.Return<Decision, EngineError> {
		const a = yield* load(x.requestId);
		if (a === null) return refused('notFound', 'No approval request has this id.');
		const move = MOVES[x.status];
		const gone = yield* sourceGone(a);
		const given = x.reason?.trim() ?? '';
		const reason = move === 'close' && given === '' ? SOURCE_CHANGED : given;
		const auth =
			x.authority.actor.kind === 'member'
				? yield* currentMember(x.authority.actor, x.authority.preview, x.authority.admin)
				: x.authority;
		if (auth === null)
			return refused('forbidden', 'You are no longer authorized to act on this request.');
		const t = transition(a, a.route.steps.length, move, rolesOf(a, auth), reason, gone);
		if ('refused' in t)
			return t.refused === 'forbidden'
				? refused('forbidden', t.message)
				: t.refused === 'sourceChanged'
					? refused('sourceChanged', t.message)
					: refused('invalidInput', t.message, t.refused === 'reason' ? 'reason' : undefined);
		const { next, edge } = t;
		const now = x.now,
			by = actorRef(auth.actor),
			open = OPEN.includes(next.state);
		const plan =
			edge.rollback === true
				? yield* rollbackPlan(m, db, a.records, yield* options.bindings(now))
				: { writes: [], restored: [], rolledBack: [] as RolledBack[], skipped: [] as Skipped[] };
		const entry: LogEntry = {
			move,
			by,
			at: now,
			from: a.state,
			to: next.state,
			step: a.step,
			reason: reason === '' ? null : reason,
			...(edge.rollback === true ? { rolledBack: plan.rolledBack, skipped: plan.skipped } : {})
		};
		const notes = yield* notices(a, eventsOf(move, a, next), yield* current(a), auth, now);
		const b = yield* options.bindings(now);
		const statement = compileCommit(m, cat, {
			key: `approval:${a.id}:${a.log.length}`,
			digest: canonical({ request: a.id, at: a.log.length, move, by }),
			issuedAt: now,
			now,
			today: b.today,
			actor: auth.actor,
			writes: plan.writes,
			owned: [],
			rate: [],
			runs: [],
			notices: [],
			output: null,
			restored: plan.restored,
			approvalDecision: { request: a.id },
			before: (c) => {
				// the request as loaded, locked: a concurrent move on it waits, then finds it moved
				c.cte(
					'ap_authorize',
					`SELECT id FROM bolt_approvals WHERE id::text = ${c.p(a.id)} AND state = ${c.p(a.state)} AND step = ${a.step}
	AND jsonb_array_length(log) = ${a.log.length} AND ${GATED} FOR UPDATE`
				);
				c.assert(
					'(SELECT count(*) FROM ap_authorize) = 1',
					'conflict',
					JSON.stringify({ collection: 'approval_request', ids: [a.id] })
				);
			},
			pieces: (c) => {
				c.cte(
					'up',
					`UPDATE bolt_approvals SET state = ${c.p(next.state)}, step = ${next.step}, log = log || jsonb_build_array(${c.p(entry)}::jsonb),
	closed_at = ${c.p(open ? null : now)}::timestamptz WHERE id IN (SELECT id FROM ap_authorize) RETURNING id`
				);
				c.cte(
					'pr',
					`UPDATE approval_request SET status = ${c.p(STATUS[next.state])}, step = ${next.step},
	approver_teams = ${c.p(open ? teamIds(a.route.steps[next.step]) : [])}::jsonb, superseder_teams = ${c.p(open ? teamIds(a.route.superseded_by) : [])}::jsonb,
	closed_at = ${c.p(open ? null : now)}::timestamptz, closed_by = ${c.p(open ? null : by)}, revision = revision + 1 WHERE id IN (SELECT id FROM up)`
				);
				if (notes.length > 0)
					noticeInsert(
						c,
						'ap_notice',
						notes,
						now,
						'EXISTS (SELECT 1 FROM up)',
						m.teams,
						m.workspace.signup?.policies
					);
				// the change stands: the outbound sends its held records deferred are queued now, from their current rows
				const sending = a.records.filter(
					(r) => r.op !== 'delete' && outboundFrom(m).has(r.collection)
				);
				if ((next.state === 'Approved' || next.state === 'Superseded') && sending.length > 0)
					outboundPiece(
						m,
						c,
						now,
						new Set(sending.map((r) => r.collection)),
						c.cte(
							'ap_out',
							[...new Set(sending.map((r) => r.collection))]
								.map(
									(collection) =>
										`SELECT ${c.p(collection)}::text AS c, t.id::text AS id, t.revision, r.op, 'direct'::text AS cause, false AS erased,
		NULL::jsonb AS o, to_jsonb(t) AS n FROM ${q(cat.collections.get(collection)?.model.name ?? collection)} t
		JOIN jsonb_to_recordset(${c.p(sending.filter((s) => s.collection === collection).map(({ id, op }) => ({ id, op })))}::jsonb) AS r(id text, op text)
			ON t.id::text = r.id WHERE EXISTS (SELECT 1 FROM up)`
								)
								.join(' UNION ALL ')
						)
					);
				c.assert(
					'(SELECT count(*) FROM up) = 1',
					'conflict',
					JSON.stringify({ collection: 'approval_request', ids: [a.id] })
				);
			}
		});
		const result = yield* Effect.result(db.returning(CommitAnswer, statement));
		if (Result.isFailure(result)) {
			const outcome = decided(result.failure, constraintsOf(m)).outcome;
			return outcome.kind === 'refused' || outcome.kind === 'conflict'
				? outcome
				: refused('internal', 'The decision could not be recorded.');
		}
		const answer = result.success[0];
		if (answer?.approval_decided !== 1) return conflict(a.id);
		yield* options.committed?.(answer) ?? Effect.void;
		yield* options.changed?.(a.id, a.records) ?? Effect.void;
		return { kind: 'decided', requestId: a.id, status: STATUS[next.state] };
	});

	const list = Effect.fn('Approvals.list')(function* (
		filter: ApprovalFilter,
		auth: Authority,
		readable: Readable
	) {
		const rows = yield* db.rows(StoredRow, {
			text: `${select}
			WHERE ($1::jsonb IS NULL OR id::text IN (SELECT jsonb_array_elements_text($1::jsonb)))
				AND (($2::text IS NULL OR collection = $2) AND ($3::jsonb IS NULL OR record IN (SELECT jsonb_array_elements_text($3::jsonb)))
					OR EXISTS (SELECT 1 FROM jsonb_array_elements(records) r WHERE ($2::text IS NULL OR r->>'collection' = $2)
						AND ($3::jsonb IS NULL OR r->>'id' IN (SELECT jsonb_array_elements_text($3::jsonb)))))
				AND ($4 OR state IN ('Pending', 'ChangesRequested'))
			ORDER BY at DESC, seq DESC LIMIT 200`,
			params: [
				filter.ids === undefined ? null : JSON.stringify(filter.ids),
				filter.collection ?? null,
				filter.records === undefined ? null : JSON.stringify(filter.records),
				filter.all === true
			]
		});
		const me = actorRef(auth.actor);
		const seen: Stored[] = [];
		for (const row of rows) {
			const a = toStored(row);
			// ponytail: a non-participant's read check is one read per request; batch by collection when lists grow
			if (participant(a, auth) || a.requestor === me || (yield* readable(a.collection, a.record)))
				seen.push(a);
		}
		const refs = [...new Set(seen.flatMap((a) => [a.requestor, ...a.log.map((d) => d.by)]))]
			.filter((x) => x.startsWith('member:'))
			.map((x) => x.slice('member:'.length));
		const names =
			refs.length === 0
				? []
				: yield* db.rows(Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }), {
						text: `SELECT id::text AS id, name FROM sys_user WHERE id::text IN (SELECT jsonb_array_elements_text($1::jsonb))`,
						params: [JSON.stringify(refs)]
					});
		const name = new Map(names.map((n) => [`member:${n.id}`, n.name]));
		const who = (ref: string): Who => ({ ref, name: name.get(ref) ?? null });
		const teamCatalogue = teams(m);
		return yield* Effect.forEach(seen, (a) =>
			Effect.map(sourceGone(a), (gone): ApprovalView => ({
				id: a.id,
				collection: a.collection,
				record: a.record,
				action: a.action,
				at: a.at,
				status: STATUS[a.state],
				step: a.step,
				steps: a.route.steps,
				superseded_by: a.route.superseded_by,
				teamNames: Object.fromEntries(
					[...new Set([...a.route.steps.flat(), ...a.route.superseded_by])].map((handle) => [
						handle,
						Object.hasOwn(teamCatalogue, handle) ? (teamCatalogue[handle]?.name ?? handle) : handle
					])
				),
				requestor: who(a.requestor),
				log: a.log.map((d) => ({
					move: d.move,
					by: who(d.by),
					at: d.at,
					from: d.from === null ? null : STATUS[d.from],
					to: STATUS[d.to],
					step: d.step,
					reason: d.reason,
					rolledBack: d.rolledBack,
					skipped: d.skipped
				})),
				records: a.records.map(({ collection, id, op }) => ({ collection, id, op })),
				moves: movesFor(a.state, rolesOf(a, auth), gone).map(({ move, reason }) => ({
					status: STATUS_OF[move],
					reason
				})),
				mine: a.requestor === me,
				participant: participant(a, auth)
			}))
		);
	});

	return {
		hook,
		process,
		list,
		view: Effect.fn('Approvals.view')(function* (
			requestId: string,
			auth: Authority,
			readable: Readable
		) {
			return (yield* list({ ids: [requestId], all: true }, auth, readable))[0] ?? null;
		})
	};
}

const bindingOf = (m: EngineManifest, at?: string) =>
	Effect.gen(function* () {
		const now = at ?? new Date(yield* Clock.currentTimeMillis).toISOString();
		return {
			now,
			today: localOf(Date.parse(now), m.workspace.tz).date,
			tz: m.workspace.tz,
			params: {}
		};
	});
/** Source routing is a direct planner dependency; it never acquires Approvals or Writes. */
export const approvalHook = (
	manifest: EngineManifest,
	db: TenantDbShape,
	guest?: GuestShape
): ApprovalHook =>
	makeApprovals(manifest, db, { guest, bindings: (at) => bindingOf(manifest, at) }).hook;
export const ApprovalsLive = Layer.effect(
	Approvals,
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			db = yield* TenantDb,
			guest = yield* Guest,
			live = yield* Live,
			wake = yield* Wake,
			links = yield* Links;
		const area = makeApprovals(manifest, db, {
			guest,
			bindings: (at) => bindingOf(manifest, at),
			committed: (answer) =>
				committed(answer).pipe(
					Effect.provideService(Live, live),
					Effect.provideService(Wake, wake),
					Effect.provideService(Links, links),
					Effect.asVoid
				),
			changed: (requestId, records) =>
				Effect.sync(() => {
					live.syncChanged('approval_request', [requestId]);
					for (const [collection, rows] of Map.groupBy(records, (r) => r.collection))
						live.syncChanged(
							collection,
							rows.map((r) => r.id)
						);
				})
		});
		return Approvals.of({
			process: area.process,
			list: area.list,
			view: (id, authority, readable) =>
				area.view(id, authority, readable).pipe(Effect.map(Option.fromNullishOr))
		});
	})
);
