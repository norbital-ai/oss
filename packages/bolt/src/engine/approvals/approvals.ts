import { actor_id, actor_ref } from '../access/actor.ts';
// Approval requests (rules 44–46, spec §8), the provisional-commit model: a routed write is committed at once and held by
// its request; each move of the state machine (machine.ts) is one guarded statement with every effect it has — the log
// entry, the readable `approval_request` face, the queued approval effect and on rejection the rollback of every held
// record to its checkpoint. The requester's save in ChangesRequested resubmits inside that write (`resubmit`).
import { constraintIndex } from '../schema/plan.ts';
import { Clock, Effect, Layer, Option, Result, Schema } from 'effect';
import { audited, auditActor } from '../audit-operation.ts';
import { Audit } from '../audit.ts';
import { encode_wire } from '@norbital-ai/std/wire';
import { bindingsAt } from '../query/reader.ts';
import {
	Approvals,
	Activation,
	Guest,
	Live,
	Manifest,
	type ApprovalFilter,
	type GuestShape,
	type PlannedCommit,
	type Readable
} from '../services.ts';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { capturePiece } from '../db/captured.ts';
import { storedCaptures, storedRowSql } from '../db/stored.ts';
import { teams, type EngineManifest } from '../manifest.ts';
import {
	LIMITS,
	type Authority,
	type Bindings,
	type EngineActor,
	type Invocation,
	type Lock,
	type Outcome,
	type QueuedRun
} from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import { catalog_of } from '../access/pred.ts';
import { canonical, q } from '@norbital-ai/store';
import { BoltError } from '../../protocol/errors.ts';
import {
	act,
	answerOf,
	guestFailure,
	hasCallback,
	storedTrees,
	transformBridge,
	type ApprovalHook,
	type CarriedWrite,
	type HeldRecord,
	type StepsSnapshot,
	type WriteEngine
} from '../write/act.ts';
import { coalescing } from '../query/engine.ts';
import {
	ApprovalLogFields,
	ApprovalStateSchema,
	type ApprovalView
} from '../../protocol/approval-view.ts';
import { affectedTables, compileCommit, committed, runCommit, type Commit, type CommitAnswer } from '../write/commit.ts';
import { Chain, GATED, minter, decided } from '../write/sql.ts';
import { effectDepthFailure, effectRun, enqueue, settleApprovalEffects, writerOf } from '../runs/queue.ts';
import { syncOutboxPiece } from '../sync/write.ts';
import type { ApprovalEffectEvent } from '../../protocol/effect-events.ts';
import { participant, rolesOf, sameFlow, unknownTeam } from './route.ts';
import { Checkpoint, StoredSnapshot } from './snapshot.ts';
import { readGuardBaseline } from './read-guards.ts';
import { checkpoint } from './lock.ts';
import {
	decisionsFor,
	moveOf,
	OPEN,
	transition,
	type ApprovalDecision,
	type ApprovalMove,
	type ApprovalState,
	type Step
} from './machine.ts';
import { rollbackPlan, type RolledBack, type Skipped } from './rollback.ts';
import { Authorities } from '../identity/actor.ts';
import { open_sql } from './sql.ts';

/** The readable face's status of each state (`approval_request.status`). */
const STATUS = {
	Pending: 'ONGOING',
	ChangesRequested: 'CHANGES_REQUESTED',
	Approved: 'APPROVED',
	Rejected: 'REJECTED',
	Superseded: 'SUPERSEDED',
	Withdrawn: 'WITHDRAWN'
} as const satisfies { [S in ApprovalState]: string };
const LogEntry = Schema.Struct({
	...ApprovalLogFields,
	by: Schema.String,
	/** The automation whose run asked (`by` names only that run): any of its runs may withdraw the request. */
	automation: Schema.optionalKey(Schema.String)
});
type LogEntry = typeof LogEntry.Type;
const StoredRow = Schema.Struct({
	id: Schema.String,
	state: ApprovalStateSchema,
	step: Schema.Number,
	requestor: Schema.String,
	requestor_user: Schema.NullOr(Schema.String),
	route: StoredSnapshot,
	model: Schema.String,
	record: Schema.String,
	action: Schema.Literals(['create', 'update', 'delete']),
	records: Schema.Array(Checkpoint),
	log: Schema.Array(LogEntry),
	at_text: Schema.String
});
type Stored = Omit<typeof StoredRow.Type, 'requestor_user' | 'at_text'> & {
	user: typeof StoredRow.Type.requestor_user;
	at: typeof StoredRow.Type.at_text;
};
type Refusal = Extract<Outcome, { kind: 'refused' }>;
type Conflict = Extract<Outcome, { kind: 'conflict' }>;
export type Decision =
	{ kind: 'decided'; request_id: string; status: ApprovalState } | Refusal | Conflict;
export type { ApprovalView } from '../../protocol/approval-view.ts';
export type DecideInput = {
	request_id: string;
	decision: ApprovalDecision;
	reason?: string;
	authority: Authority;
	now: string;
};
type ApprovalsOptions = {
	publication: Live['Service']['publish'];
	sourceEpoch?: string;
	bindings(at?: string): Effect.Effect<Bindings>;
	/** Publishes a decision's captured rows, and wakes the queue (the act path's own `committed`). */
	committed?(answer: CommitAnswer): Effect.Effect<void>;
	/** The approving decision's `on_approved` (`approvedWrites`): planned commits to join its statement, or why it cannot stand. */
	approved?(
		request: Stored,
		authority: Authority,
		bindings: Bindings
	): Effect.Effect<readonly PlannedCommit[] | Refusal | Conflict, EngineError>;
};

const refused = (code: Refusal['code'], message: string, field?: string): Refusal => ({
	kind: 'refused',
	code,
	message,
	...(field === undefined ? {} : { field })
});
const conflict = (id: string): Decision => ({
	kind: 'conflict',
	records: [{ model: 'approval_request', id }]
});
/** The `approval_request` columns a state of `route` shows: its steps' names, the current step's approvers, the superseders. */
const face = (route: StepsSnapshot, next: Step) => {
	const open = OPEN.includes(next.state),
		step = route.steps[next.step];
	return {
		steps: route.steps.length,
		names: route.steps.map((s) => s.name),
		teams: open ? (step?.teams ?? []) : [],
		users: open ? (step?.users ?? []) : [],
		superseders: open ? route.superseded_by : []
	};
};
function makeApprovals(m: EngineManifest, db: TenantDbShape, options: ApprovalsOptions) {
	const cat = catalog_of(m);
	const sourceAuthorities = new Authorities(m, 'approval');
	const table = (model: string) => cat.exposures.get(model)?.model.name ?? model;
	const hasEffect = (a: Pick<Stored, 'model' | 'action'>) => m.exposures[a.model]?.[a.action]?.effect === true;
	const toStored = ({ requestor_user, at_text, ...stored }: typeof StoredRow.Type): Stored => ({
		...stored,
		user: requestor_user,
		at: new Date(at_text).toISOString()
	});
	const select = `SELECT id::text AS id, state, step, requestor, requestor_user, route, collection AS model, record, action, records, log,
		to_json(at)#>>'{}' AS at_text FROM bolt_approvals`;
	const load = Effect.fn('Approvals.load')(function* (id: string) {
		const rows = yield* db.rows(StoredRow, { text: `${select} WHERE id::text = $1`, params: [id] });
		return rows[0] === undefined ? null : toStored(rows[0]);
	});
	/** An approval event keeps row ids when their current images no longer exist. */
	const current = Effect.fn('Approvals.current')(function* (a: Stored) {
		const held = a.records.filter((r) => r.model === a.model).map((r) => r.id);
		const ids = held.length === 0 ? [a.record] : held;
		if (cat.exposures.get(a.model) === undefined) return ids.map((id) => ({ id, row: null }));
		const rows = yield* db.rows(Schema.Struct({ id: Schema.String, row: Schema.Record(Schema.String, Schema.Json) }), {
			text: `SELECT t.id::text AS id, ${storedRowSql(cat, a.model, 't')} AS row FROM ${q(table(a.model))} t WHERE t.id::text IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			params: [JSON.stringify(ids)]
		});
		const found = new Map(rows.map((r) => [r.id, r.row]));
		return ids.map((id) => ({ id, row: found.get(id) ?? null }));
	});
	/** Every approval move is an event for its verb's effect, separate from committed row changes. */
	const approvalEffects = (
		a: Pick<Stored, 'id' | 'model' | 'user' | 'action'>,
		route: StepsSnapshot,
		move: ApprovalMove | 'request',
		next: Step,
		records: ApprovalEffectEvent['records'],
		now: string,
		auth: Authority
	) => {
		if (!hasEffect(a)) return [];
		const step = route.steps[next.step];
		const event: ApprovalEffectEvent = {
			kind: 'approval',
			move,
			step: next.step,
			steps: route.steps,
			done: !OPEN.includes(next.state),
			request: a.id,
			records,
			requester: a.user,
			approvers: { teams: step?.teams ?? [], users: step?.users ?? [] }
		};
		const writer = writerOf(auth);
		const run: QueuedRun = {
			automation: effectRun(a.model, a.action),
			input: { ids: records.map((record) => record.id), changes: [], event },
			due_at: now,
			cause: 'effect',
			...writer
		};
		return [writer.depth > LIMITS.writeDepth
			? { ...run, state: 'failed', error: effectDepthFailure, finished_at: now }
			: run];
	};
	/**
	 * Released rows use this statement's images first, including carried writes. Approval sends every change;
	 * rollback only initializes missing replicas with the restored values they could not read while held.
	 */
	const releasedSyncRows = (
		c: Chain, a: Pick<Stored, 'records'>, actor: EngineActor, now: string,
		options: Parameters<typeof syncOutboxPiece>[6] = {}
	) => {
		const held = a.records.filter((record) => cat.exposures.has(record.model));
		const written = new Set(held.map((record) => record.model));
		const source = c.cte(
			'ap_out',
			[...written]
				.map((model) => {
					const records = held
						.filter((record) => record.model === model)
						.map(({ id, before }) => ({ id, before }));
					const col = c.p(model);
					return `SELECT ${col}::text AS c, r.id, coalesce(t.revision,
				(SELECT max(h.revision) FROM bolt_history h WHERE h.collection = ${col} AND h.record::text = r.id), r.before + 1) AS revision,
				CASE WHEN t.id IS NULL THEN 'delete' WHEN r.before IS NULL THEN 'create' ELSE 'update' END::text AS op,
				'direct'::text AS cause, false AS erased,
				CASE WHEN t.id IS NOT NULL THEN NULL::jsonb ELSE (SELECT coalesce(jsonb_object_agg(p.key,p.value),'{}'::jsonb)
				 FROM (SELECT DISTINCT ON(e.key) e.key,e.value FROM bolt_history h CROSS JOIN LATERAL jsonb_each(h.changes) e
				 WHERE h.collection = ${col} AND h.record::text = r.id AND h.revision <= r.before ORDER BY e.key,h.revision DESC) p) END AS o,
				CASE WHEN t.id IS NULL THEN NULL::jsonb ELSE ${storedRowSql(cat, model, 't')} END AS n
			FROM jsonb_to_recordset(${c.p(records)}::jsonb) AS r(id text, before int)
			LEFT JOIN ${q(table(model))} t ON t.id::text = r.id
			WHERE (t.id IS NOT NULL OR r.before IS NOT NULL)
			AND NOT EXISTS (SELECT 1 FROM allp p WHERE p.c = ${col} AND p.id = r.id)`;
				})
				.concat(
					`SELECT p.c,p.id,p.revision,p.op,p.cause,p.erased,p.o,p.n FROM allp p
			WHERE p.cause IN ('direct','cascade') AND NOT p.erased
			`
				)
				.join(' UNION ALL ')
		);
		syncOutboxPiece(m, c, now, new Set(Object.keys(m.models)), actor, source, options);
	};

	const hook: ApprovalHook = {
		route: Effect.fn('Approvals.route')(function* (act) {
			const route = act.snapshot;
			const unknown = unknownTeam(m, route);
			if (unknown !== undefined)
				return yield* Effect.fail(
					BoltError.make(
						'invalid_spec',
						'admission',
						`The approval flow names the team '${unknown}', which this workspace does not declare.`
					)
				);
			const b = act.bindings,
				auth = act.authority;
			// retry-stable (L-BOLT-201): minted from the invocation and its key
			const request_id = minter(`approval:${act.seed}:${act.model}:${act.record}`, b.now)();
			const requestor = actor_ref(auth.actor),
				user = auth.preview?.by ?? actor_id(auth.actor);
			const entry: LogEntry = {
				move: 'request',
				by: requestor,
				at: b.now,
				from: null,
				to: 'Pending',
				step: 0,
				reason: null,
				...(auth.actor.kind === 'system' && 'automation' in auth.actor.by
					? { automation: auth.actor.by.automation }
					: {})
			};
			const shown = face(route, { state: 'Pending', step: 0 });
			const runs = approvalEffects(
				{ id: request_id, model: act.model, user, action: act.action },
				route,
				'request',
				{ state: 'Pending', step: 0 },
				act.records.map((r: HeldRecord) => ({ id: r.id, row: { ...r.values, id: r.id } })),
				b.now,
				auth
			);
			return {
				request_id,
				route,
				pieces: (c: Chain, held: string | null) => {
					const col = c.p(act.model),
						rec = c.p(act.record);
					capturePiece(c,
						'ap_state',
						'bolt_approvals',
						`INSERT INTO bolt_approvals (id, state, step, collection, record, action, requestor, requestor_user, route, records, log, at)
	SELECT ${c.p(request_id)}::uuid, 'Pending', 0, ${col}, ${rec}, ${c.p(act.action)}, ${c.p(requestor)}, ${c.p(user)}, ${c.p(route)}::jsonb,
		(SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM (
			SELECT jsonb_build_object('collection', ${col}::text, 'id', ${rec}::text, 'op', 'update', 'before', (SELECT revision FROM ${q(table(act.model))} WHERE id::text = ${rec}))
				AS e WHERE NOT EXISTS (SELECT 1 FROM allp WHERE c = ${col} AND id = ${rec} AND cause IN ('direct', 'cascade'))
			UNION ALL SELECT ${checkpoint('x')} FROM (SELECT DISTINCT ON (c, id) * FROM allp WHERE cause IN ('direct', 'cascade') AND NOT erased) x) s),
		jsonb_build_array(${c.p(entry)}::jsonb), ${c.p(b.now)}::timestamptz
	WHERE ${GATED}${held === null ? '' : ` AND NOT EXISTS (SELECT 1 FROM ${held})`} ON CONFLICT (id) DO NOTHING`,
						{ returning: 'id,records' }
					);
					capturePiece(c,
						'ap_request',
						'approval_request',
						`INSERT INTO approval_request (id, collection_name, record_id, action, status, step, steps, step_names, approver_teams,
		approver_users, superseder_teams, created_at)
	SELECT id, ${col}, ${rec}, ${c.p(act.action)}, 'ONGOING', 0, ${shown.steps}, ${c.p(shown.names)}::jsonb, ${c.p(shown.teams)}::jsonb,
		${c.p(shown.users)}::jsonb, ${c.p(shown.superseders)}::jsonb, ${c.p(b.now)}::timestamptz FROM ap_state`
					);
					capturePiece(c,
						'ap_requestor',
						'requestor',
						`INSERT INTO requestor (id, approval_request_id, user_id) SELECT id::text || ':' || ${c.p(requestor)}, id, ${c.p(user ?? requestor)} FROM ap_state`
					);
					if (runs.length > 0) enqueue(c, runs, { when: 'EXISTS (SELECT 1 FROM ap_state)' });
				}
			};
		}),

		resubmit: Effect.fn('Approvals.resubmit')(function* (act) {
			const a = yield* load(act.request);
			if (a === null)
				return yield* Effect.fail(
					BoltError.make('not_found', 'admission', 'No approval request has this id.')
				);
			if (a.route.__boltReadGuards !== undefined)
				return yield* Effect.fail(
					BoltError.make(
						'source_changed',
						'admission',
						'This request depends on earlier reads. Reject it and start a fresh request.'
					)
				);
			const route = act.snapshot.kind === 'allow' ? a.route : act.snapshot;
			const unknown = unknownTeam(m, route);
			if (unknown !== undefined)
				return yield* Effect.fail(
					BoltError.make(
						'invalid_spec',
						'admission',
						`The approval flow names the team '${unknown}', which this workspace does not declare.`
					)
				);
			// the same steps resume where changes were requested; changed steps restart at the first
			const next: Step = { state: 'Pending', step: sameFlow(a.route, route) ? a.step : 0 };
			const b = act.bindings,
				by = actor_ref(act.authority.actor);
			const entry: LogEntry = {
				move: 'resubmit',
				by,
				at: b.now,
				from: 'ChangesRequested',
				to: next.state,
				step: next.step,
				reason: null,
				changed: [
					...new Set(
						act.changed.flatMap((row) =>
							row.model === a.model && row.id === a.record
								? row.fields
								: row.fields.map((f) => `${row.model}.${f}`)
						)
					)
				]
			};
			const shown = face(route, next);
			const runs = approvalEffects(
				a,
				route,
				'resubmit',
				next,
				act.records.map((r: HeldRecord) => ({ id: r.id, row: { ...r.values, id: r.id } })),
				b.now,
				act.authority
			);
			return {
				request: a.id,
				pending: true,
				pieces: (c: Chain, held: string | null) => {
					capturePiece(c,
						'ap_resubmit',
						'bolt_approvals',
						`UPDATE bolt_approvals a SET state = ${c.p(next.state)}, step = ${next.step}, route = ${c.p(route)}::jsonb,
		records = ${held === null ? 'a.records' : `coalesce((SELECT h.records FROM ${held} h WHERE h.id=a.id),a.records)`},
		log = log || jsonb_build_array(${c.p(entry)}::jsonb), closed_at = NULL
	WHERE id::text = ${c.p(a.id)} AND state = 'ChangesRequested' AND requestor = ${c.p(by)} AND ${GATED}`
					);
					c.assert(
						'(SELECT count(*) FROM ap_resubmit) = 1',
						'conflict',
						JSON.stringify({ model: 'approval_request', ids: [a.id] })
					);
					capturePiece(c,
						'ap_resubmit_face',
						'approval_request',
						`UPDATE approval_request SET status = ${c.p(STATUS[next.state])}, step = ${next.step}, steps = ${shown.steps},
		step_names = ${c.p(shown.names)}::jsonb, approver_teams = ${c.p(shown.teams)}::jsonb, approver_users = ${c.p(shown.users)}::jsonb,
		superseder_teams = ${c.p(shown.superseders)}::jsonb, closed_at = NULL,
		closed_by = NULL, revision = revision + 1 WHERE id IN (SELECT id FROM ap_resubmit)`
					);
					if (runs.length > 0) enqueue(c, runs, { when: 'EXISTS (SELECT 1 FROM ap_resubmit)' });
				}
			};
		})
	};

	/** A reviewer's current source authority (a stale preview or a moved team decides nothing). */
	const currentMember = Effect.fn('Approvals.currentMember')(function* (
		actor: Extract<Authority['actor'], { kind: 'member' }>,
		preview?: Authority['preview'],
		admin: boolean = false
	) {
		if (preview === undefined) return yield* sourceAuthorities.member(db, options.publication, actor.id, !admin);
		const real = yield* sourceAuthorities.member(db, options.publication, preview.by);
		if (real === null || !real.admin || real.actor.kind !== 'member') return null;
		if (preview.team !== null && actor.id !== preview.by) return null;
		const current =
			preview.team === null
				? yield* sourceAuthorities.member(db, options.publication, actor.id, true)
				: yield* sourceAuthorities.team(db, real.actor, preview.team);
		return current === null ? null : { ...current, preview };
	});

	/**
	 * One decision: the guarded state change, its log entry, the readable face, the approval effect and (reject) the
	 * rollback. A superseder's approve supersedes; a request whose record or model a release removed ends by reject.
	 * `withdraw` is the requester's alone: the member who asked, or any run of the automation that did.
	 */
	const decide = Effect.fn('Approvals.decide')(function* (
		x: DecideInput
	): Effect.fn.Return<Decision, EngineError> {
		const actor = x.authority.actor;
		const automation =
			x.decision === 'withdraw' && actor.kind === 'system' && 'automation' in actor.by
				? actor.by.automation
				: undefined;
		if (actor.kind !== 'member' && automation === undefined)
			return refused('forbidden', 'Only a member may decide an approval.');
		const a = yield* load(x.request_id);
		if (a === null) return refused('not_found', 'No approval request has this id.');
		const auth =
			actor.kind === 'member'
				? yield* currentMember(actor, x.authority.preview, x.authority.admin)
				: x.authority;
		if (auth === null)
			return refused('forbidden', 'You are no longer authorized to act on this request.');
		const roles =
				automation !== undefined && a.log[0]?.automation === automation
					? new Set([...rolesOf(a, auth), 'requester' as const])
					: rolesOf(a, auth),
			move = moveOf(x.decision, roles),
			reason = x.reason?.trim() ?? '';
		// a rerun's withdraw of what its earlier attempt withdrew
		if (move === 'withdraw' && a.state === 'Withdrawn' && roles.has('requester'))
			return { kind: 'decided', request_id: a.id, status: a.state };
		const t = transition(a, a.route.steps.length, move, roles, reason);
		if ('refused' in t)
			return t.refused === 'forbidden'
				? refused('forbidden', t.message)
				: refused('invalid_input', t.message, t.refused === 'reason' ? 'reason' : undefined);
		const readGuards =
			move === 'approve' || move === 'supersede' ? a.route.__boltReadGuards : undefined;
		if (readGuards !== undefined && readGuards.sourceEpoch !== options.sourceEpoch)
			return refused(
				'source_changed',
				'This request was prepared by another source release. Reject it and start a fresh request.'
			);
		const { next, edge } = t;
		const now = x.now,
			by = actor_ref(auth.actor),
			open = OPEN.includes(next.state),
			stands = next.state === 'Approved' || next.state === 'Superseded';
		const b = yield* options.bindings(now);
		const plan =
			edge.rollback === true
				? yield* rollbackPlan(m, db, a.records, b)
				: {
						writes: [],
						restored: [],
						rolled_back: Array.of<RolledBack>(),
						skipped: Array.of<Skipped>(),
						observations: []
					};
		if (plan.skipped.some((record) => record.field === '*' && record.reason !== 'modelRemoved'))
			return refused(
				'invalid_input',
				'An approval checkpoint cannot be restored. The request and its records remain held.'
			);
		// what the approved write carries `on_approved` commits in this statement, or the decision does not stand
		const approved =
			stands && options.approved !== undefined ? yield* options.approved(a, auth, b) : [];
		if ('kind' in approved) return approved;
		const carried = approved.map((planned) => planned.commit);
		const fingerprints = [
			...(readGuards?.fingerprints ?? []),
			...carried.flatMap((commit) => commit.fingerprints ?? [])
		];
		const entry: LogEntry = {
			move,
			by,
			at: now,
			from: a.state,
			to: next.state,
			step: a.step,
			reason: reason === '' ? null : reason,
			...(edge.rollback === true ? { rolled_back: plan.rolled_back, skipped: plan.skipped } : {})
		};
		const runs = approvalEffects(a, a.route, move, next, hasEffect(a) ? yield* current(a) : [], now, auth);
		const refreshKey = `approval:${a.id}:${a.log.length}`;
		const mint = minter(`approval:${a.id}:${a.log.length}`, now);
		const shown = face(a.route, next);
		const commit: Commit = {
			key: `approval:${a.id}:${a.log.length}`,
			digest: canonical({ request: a.id, at: a.log.length, move, by }),
			issuedAt: now,
			now,
			today: b.today,
			actor: auth.actor,
			writer: writerOf(auth),
			writes: [...plan.writes, ...carried.flatMap((commit) => commit.writes)],
			owned: carried.flatMap((commit) => commit.owned),
			rate: [],
			runs: [
				...runs.map((run) => ({ ...run, id: mint() })),
				...carried.flatMap((commit) => commit.runs)
			],
			notices: carried.flatMap((commit) => commit.notices),
			output: null,
			restored: plan.restored,
			approvalDecision: { request: a.id, stands },
			...(fingerprints.length === 0 ? {} : { fingerprints }),
			before: (c) => {
				for (const observation of plan.observations) {
					const selected = `SELECT revision FROM ${q(table(observation.model))} WHERE id::text = ${c.p(observation.id)}`;
					c.assert(
						observation.revision === null
							? `NOT EXISTS (${selected})`
							: `coalesce((${selected}) = ${c.p(observation.revision)}, false)`,
						'conflict',
						JSON.stringify({ model: observation.model, ids: [observation.id] })
					);
				}
				// the request as loaded, locked: a concurrent move on it waits, then finds it moved
				c.cte(
					'ap_authorize',
					`SELECT id FROM bolt_approvals WHERE id::text = ${c.p(a.id)} AND state = ${c.p(a.state)} AND step = ${a.step}
	AND jsonb_array_length(log) = ${a.log.length} AND ${GATED} FOR UPDATE`
				);
				c.assert(
					'(SELECT count(*) FROM ap_authorize) = 1',
					'conflict',
					JSON.stringify({ model: 'approval_request', ids: [a.id] })
				);
			},
			pieces: (c) => {
				capturePiece(c,
					'up',
					'bolt_approvals',
					`UPDATE bolt_approvals SET state = ${c.p(next.state)}, step = ${next.step}, log = log || jsonb_build_array(${c.p(entry)}::jsonb),
	closed_at = ${c.p(open ? null : now)}::timestamptz${readGuards === undefined ? '' : `, route = jsonb_set(route, '{__boltReadGuardRefresh}', to_jsonb(${c.p(refreshKey)}::text))`} WHERE id IN (SELECT id FROM ap_authorize)`
				);
				capturePiece(c,
					'pr',
					'approval_request',
					`UPDATE approval_request SET status = ${c.p(STATUS[next.state])}, step = ${next.step},
	approver_teams = ${c.p(shown.teams)}::jsonb, approver_users = ${c.p(shown.users)}::jsonb, superseder_teams = ${c.p(shown.superseders)}::jsonb,
	closed_at = ${c.p(open ? null : now)}::timestamptz, closed_by = ${c.p(open ? null : by)}, revision = revision + 1 WHERE id IN (SELECT id FROM up)`
				);
				if (stands) releasedSyncRows(c, a, auth.actor, now);
				else if (!open && edge.rollback === true)
					releasedSyncRows(c, a, auth.actor, now, {
						preserve_local: true,
						missing_only: true
					});
				if (!open) settleApprovalEffects(c, a.id, stands);
				c.assert(
					'(SELECT count(*) FROM up) = 1',
					'conflict',
					JSON.stringify({ model: 'approval_request', ids: [a.id] })
				);
			}
		};
		const lockedTables = [
			...new Set([
				...(readGuards?.tables ?? []),
				...plan.observations.map((observation) => observation.model),
				...affectedTables(m, cat, plan.writes),
				...approved.flatMap((planned) => [
					...(planned.lock?.tables ?? []),
					...affectedTables(m, cat, planned.commit.writes)
				]),
				'bolt_approvals',
				'approval_request'
			])
		].sort();
		const decisionLock: Lock | undefined =
			readGuards === undefined && plan.observations.length === 0 && approved.length === 0
				? undefined
				: { tables: lockedTables, mode: 'SHARE ROW EXCLUSIVE' };
		const result = yield* Effect.result(
			runCommit(
				db,
				(audit) => compileCommit(m, cat, commit, audit),
				(statement) => ({
					statements: [
						statement,
						...(readGuards === undefined
							? []
							: [readGuardBaseline(a.id, readGuards, readGuards.sourceEpoch, refreshKey)])
					],
					...(decisionLock === undefined ? {} : { lock: decisionLock })
				}),
				auth.actor,
				false
			)
		);
		if (Result.isFailure(result)) {
			const outcome = decided(result.failure, yield* constraintIndex(m)).outcome;
			return outcome.kind === 'refused' || outcome.kind === 'conflict'
				? outcome
				: refused('internal', 'The decision could not be recorded.');
		}
		const answer = result.success[0];
		if (answer?.approval_decided !== 1) return conflict(a.id);
		yield* options.committed?.({ ...answer, captured: storedCaptures(cat, answer.captured) }) ?? Effect.void;
		return { kind: 'decided', request_id: a.id, status: next.state };
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
				AND ($4 OR ${open_sql('state')})
			ORDER BY at DESC, seq DESC LIMIT 200`,
			params: [
				filter.ids === undefined ? null : JSON.stringify(filter.ids),
				filter.model ?? null,
				filter.records === undefined ? null : JSON.stringify(filter.records),
				filter.all === true
			]
		});
		const me = actor_ref(auth.actor);
		const seen: Stored[] = [];
		for (const row of rows) {
			const a = toStored(row);
			// ponytail: a non-participant's read check is one read per request; batch by model when lists grow
			if (participant(a, auth) || a.requestor === me || (yield* readable(a.model, a.record)))
				seen.push(a);
		}
		const member = 'member:';
		const ids = [
			...new Set(
				seen.flatMap((a) => [
					...[a.requestor, ...a.log.map((d) => d.by)]
						.filter((x) => x.startsWith(member))
						.map((x) => x.slice(member.length)),
					...a.route.steps.flatMap((s) => s.users)
				])
			)
		];
		const names =
			ids.length === 0
				? []
				: yield* db.rows(Schema.Struct({ id: Schema.String, name: Schema.NullOr(Schema.String) }), {
						text: `SELECT id::text AS id, coalesce(name, email) AS name FROM sys_user WHERE id::text IN (SELECT jsonb_array_elements_text($1::jsonb))`,
						params: [JSON.stringify(ids)]
					});
		const name = new Map(names.map((n) => [n.id, n.name]));
		const who = (ref: string): ApprovalView['requestor'] => ({
			ref,
			name: ref.startsWith(member) ? (name.get(ref.slice(member.length)) ?? null) : null
		});
		const teamCatalogue = teams(m);
		return seen.map((a): ApprovalView => ({
			id: a.id,
			model: a.model,
			record: a.record,
			action: a.action,
			at: a.at,
			status: a.state,
			step: a.step,
			steps: a.route.steps,
			superseded_by: a.route.superseded_by,
			team_names: Object.fromEntries(
				[...new Set([...a.route.steps.flatMap((s) => s.teams), ...a.route.superseded_by])].map(
					(handle) => [
						handle,
						Object.hasOwn(teamCatalogue, handle) ? (teamCatalogue[handle]?.name ?? handle) : handle
					]
				)
			),
			user_names: Object.fromEntries(
				[...new Set(a.route.steps.flatMap((s) => s.users))].map((id) => [id, name.get(id) ?? id])
			),
			requestor: who(a.requestor),
			log: a.log.map(({ by, automation: _automation, ...entry }) => ({ ...entry, by: who(by) })),
			records: a.records.map(({ model, id, op }) => ({ model, id, op })),
			moves: decisionsFor(a.state, rolesOf(a, auth)),
			mine: a.requestor === me,
			participant: participant(a, auth)
		}));
	});

	return {
		hook,
		decide,
		list,
		view: Effect.fn('Approvals.view')(function* (
			request_id: string,
			auth: Authority,
			readable: Readable
		) {
			return (yield* list({ ids: [request_id], all: true }, auth, readable))[0] ?? null;
		})
	};
}

const bindingOf = (m: EngineManifest, at?: string) =>
	Effect.gen(function* () {
		const now = at ?? new Date(yield* Clock.currentTimeMillis).toISOString();
		return bindingsAt(now, m.workspace.tz);
	});
/**
 * The approving decision's `on_approved`, in bulk: every held row of the request's model asked again as it now stands
 * (`ctx.approving`), one invocation per verb, and what they answer planned as acts (their own callbacks, carried by that
 * model) all at once over one coalesced reader, for the decision's one statement. A refusal or a conflict leaves the
 * request pending.
 */
const approvedWrites = Effect.fn('Approvals.approvedWrites')(function* (
	m: EngineManifest,
	db: TenantDbShape,
	guest: GuestShape,
	a: Stored,
	auth: Authority,
	b: Bindings
): Effect.fn.Return<readonly PlannedCommit[] | Refusal | Conflict, EngineError> {
	const cat = catalog_of(m);
	const held = [
		...Map.groupBy(
			a.records.filter((record) => record.model === a.model),
			(record) => record.op
		)
	].flatMap(([verb, records]) => verb === 'delete' || !hasCallback(m, a.model, verb)
		? [] : [{ verb, records }]);
	const ask = Effect.fn('Approvals.askAgain')(function* (
		verb: 'create' | 'update',
		ids: readonly string[]
	): Effect.fn.Return<readonly CarriedWrite[] | Refusal, EngineError> {
		const rows = yield* storedTrees(db, m, cat, a.model, ids, b, Object.keys(m.exposures[a.model]?.[verb]?.columns ?? {}));
		const input = rows.flatMap((row) => row === null ? [] : [{
			before: verb === 'create' ? null : row,
			set: verb === 'create' ? row : {},
			after: row
		}]);
		if (input.length === 0) return [];
		const seed = `approval:${a.id}:${a.log.length}:${verb}`;
		const invocation: Invocation = {
			id: seed,
			kind: verb,
			target: a.model,
			input,
			ctx: {
				actor: auth.actor,
				policies: auth.policies,
				admin: auth.admin,
				now: b.now,
				today: b.today,
				tz: b.tz,
				seed,
				approving: true
			},
			budget: { crossings: LIMITS.crossings.write, readBytes: LIMITS.readBytes }
		};
		const g = yield* guest.invoke(invocation, transformBridge(m, db, invocation));
		if (g.kind === 'refused')
			return {
				kind: 'refused',
				code: 'refused',
				message: g.message,
				rule: `${a.model}.${verb}`,
				...(g.field === undefined ? {} : { field: g.field })
			};
		if (g.kind === 'failed') {
			const failure = yield* guestFailure(g.error);
			return failure.kind === 'refused'
				? failure
				: refused('internal', 'The approved write could not be asked again.');
		}
		const answer = answerOf(verb, g.output, input.length, m, a.model);
		if (typeof answer === 'string') return yield* BoltError.make('transform_shape', 'guest', answer);
		return answer.on_approved;
	});
	const asked = yield* Effect.forEach(
		held,
		({ verb, records }) =>
			ask(
				verb,
				records.map((record) => record.id)
			),
		{ concurrency: 'unbounded' }
	);
	const carried: CarriedWrite[] = [];
	for (const answer of asked) {
		if ('kind' in answer) return answer;
		carried.push(...answer);
	}
	// each model's creates and updates are one act, carried by the request's model and admitted by its approval
	const groups = [...Map.groupBy(carried, (write) => `${write.model}:${write.op}`).values()];
	if (groups.length === 0) return [];
	const shared = yield* coalescing(db, groups.length);
	const engine: WriteEngine = { manifest: m, db: shared, guest };
	const planned: (PlannedCommit | undefined)[] = groups.map(() => undefined);
	const outcomes = yield* Effect.forEach(
		groups,
		(group, index) => {
			const first = group[0];
			if (first === undefined) return Effect.fail(BoltError.make('corrupt', 'admission', 'The approved write group has no rows.')).pipe(Effect.ensuring(shared.done));
			return act(engine, {
				model: first.model,
				verb: first.op,
				input: group.map((write) =>
					write.op === 'create'
						? write.row
						: { target: write.target ?? null, set: write.set ?? null }
				),
				mode: {
					_tag: 'Record',
					carriedBy: a.model,
					pending: new Map(),
					sink: (commit) => {
						planned[index] = commit;
					}
				},
				authority: { ...auth, admin: true },
				key: `approval:${a.id}:${a.log.length}:${first.model}:${first.op}`,
				invocationId: `approval:${a.id}:${a.log.length}:${first.model}:${first.op}`,
				issuedAt: b.now,
				bindings: b
			}).pipe(Effect.ensuring(shared.done));
		},
		{ concurrency: 'unbounded' }
	);
	for (const [index, { outcome }] of outcomes.entries()) {
		if (outcome.kind === 'refused' || outcome.kind === 'conflict') return outcome;
		if (outcome.kind !== 'committed')
			return refused(
				'internal',
				`The approved write's ${groups[index]?.[0]?.model ?? ''} rows could not be planned.`
			);
	}
	return planned.flatMap((commit) => (commit === undefined ? [] : [commit]));
});
/** Source routing is a direct planner dependency; it never acquires Approvals or Writes. */
export const approval_hook = (manifest: EngineManifest, db: TenantDbShape, publication: Live['Service']['publish']): ApprovalHook =>
	makeApprovals(manifest, db, { publication, bindings: (at) => bindingOf(manifest, at) }).hook;
export const ApprovalsLive = Layer.effect(
	Approvals,
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			audit = yield* Audit,
			activation = yield* Activation,
			db = yield* TenantDb,
			live = yield* Live,
			guest = yield* Guest,
			context = yield* Effect.context<Effect.Services<ReturnType<typeof committed>>>();
		const area = makeApprovals(manifest, db, {
			publication: live.publish,
			sourceEpoch: activation.release,
			bindings: (at) => bindingOf(manifest, at),
			approved: (request, authority, bindings) =>
				approvedWrites(manifest, db, guest, request, authority, bindings),
			committed: (answer) => committed(answer).pipe(Effect.provideContext(context), Effect.asVoid)
		});
		return Approvals.of({
			decide: (input: DecideInput) =>
				audited(
					db,
					{
						category: 'approval',
						action: input.decision,
						actor: auditActor(input.authority.actor),
						approval: input.request_id,
						payload: encode_wire({
							request_id: input.request_id,
							decision: input.decision,
							reason: input.reason
						})
					},
					area.decide(input)
				).pipe(Effect.provideService(Audit, audit)),
			list: area.list,
			view: (id, authority, readable) =>
				area.view(id, authority, readable).pipe(Effect.map(Option.fromNullishOr))
		});
	})
);
