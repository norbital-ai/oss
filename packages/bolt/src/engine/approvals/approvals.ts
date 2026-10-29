// Approval requests (rules 44–46, spec §8), the provisional-commit model: a routed write is committed at once and held by
// its request; each move of the state machine (machine.ts) is one guarded statement with every effect it has — the log
// entry, the readable `approval_request` face, the queued notify event (H1) and on rejection the rollback of every held
// record to its checkpoint. The requester's save in ChangesRequested resubmits inside that write (`resubmit`).
import { Clock, Effect, Layer, Option, Result, Schema } from 'effect';
import { audited, auditActor } from '../audit-operation.ts';
import { Audit } from '../audit.ts';
import { encodeWire } from '@norbital-ai/std/wire';
import { bindingsAt } from '../query/reader.ts';
import type { ApprovalStep } from '../../decl/access/policy.ts';
import type { Json } from '../../decl/values.ts';
import {
	Approvals,
	Activation,
	Live,
	Manifest,
	type ApprovalFilter,
	type Readable
} from '../services.ts';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { teams, type EngineManifest } from '../manifest.ts';
import type { Authority, Bindings, EngineActor, Lock, Outcome, QueuedRun } from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import { catalogOf } from '../access/pred.ts';
import { canonical, q } from '@norbital-ai/store';
import { BoltError } from '../../protocol/errors.ts';
import {
	constraintsOf,
	type ApprovalHook,
	type HeldRecord,
	type StepsSnapshot
} from '../write/act.ts';
import {
	actorRef,
	affectedTables,
	compileCommit,
	CommitAnswer,
	committed
} from '../write/commit.ts';
import { Chain, GATED, minter, decided } from '../write/sql.ts';
import { enqueue, writerOf } from '../runs/queue.ts';
import { syncOutboxPiece } from '../sync/write.ts';
import { notifyRun, type NotifyWire } from '../notifications/notify.ts';
import { participant, rolesOf, sameFlow, unknownTeam, type Request } from './route.ts';
import { StoredSnapshot } from './snapshot.ts';
import { readGuardBaseline } from './read-guards.ts';
import { decodeRows } from '../db/rows.ts';
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

/** The readable face's status of each state (`approval_request.status`). */
const STATUS = {
	Pending: 'ONGOING',
	ChangesRequested: 'CHANGES_REQUESTED',
	Approved: 'APPROVED',
	Rejected: 'REJECTED',
	Superseded: 'SUPERSEDED'
} as const satisfies { [S in ApprovalState]: string };
const State = Schema.Literals([
	'Pending',
	'ChangesRequested',
	'Approved',
	'Rejected',
	'Superseded'
]);

// stored `records` entries keep their `collection` key (the audit trigger reads it); the engine speaks `model`
const Entry = Schema.Struct({
	model: Schema.String,
	id: Schema.String,
	op: Schema.Literals(['create', 'update', 'delete']),
	before: Schema.NullOr(Schema.Number)
}).pipe(Schema.encodeKeys({ model: 'collection' }));
const LogEntry = Schema.Struct({
	move: Schema.Literals([
		'request',
		'approve',
		'reject',
		'requestChanges',
		'resubmit',
		'supersede'
	]),
	by: Schema.String,
	at: Schema.String,
	from: Schema.NullOr(State),
	to: State,
	step: Schema.Number,
	reason: Schema.NullOr(Schema.String),
	/** A resubmission's changed fields: the root record's by name, any other held row's as `<model>.<field>`. */
	changed: Schema.optionalKey(Schema.Array(Schema.String)),
	rolledBack: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				model: Schema.String,
				id: Schema.String,
				action: Schema.Literals(['restored', 'removed', 'recreated'])
			})
		)
	),
	skipped: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				model: Schema.String,
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
	route: StoredSnapshot,
	model: Schema.String,
	record: Schema.String,
	action: Schema.Literals(['create', 'update', 'delete']),
	records: Schema.Array(Entry),
	log: Schema.Array(LogEntry),
	at_text: Schema.String
});
type Stored = Request & {
	route: StoredSnapshot;
	id: string;
	model: string;
	record: string;
	action: 'create' | 'update' | 'delete';
	user: string | null;
	records: readonly (typeof Entry.Type)[];
	log: readonly LogEntry[];
	at: string;
};
type Refusal = Extract<Outcome, { kind: 'refused' }>;
export type Decision =
	| { kind: 'decided'; requestId: string; status: ApprovalState }
	| Refusal
	| Extract<Outcome, { kind: 'conflict' }>;
type Who = { ref: string; name: string | null };
/** The approval view (§3.8, spec §7): the request, its named steps, every interaction, the held records and the viewer's decisions. */
export type ApprovalView = {
	id: string;
	model: string;
	record: string;
	action: 'create' | 'update' | 'delete';
	at: string;
	status: ApprovalState;
	step: number;
	steps: readonly ApprovalStep[];
	superseded_by: readonly string[];
	/** Current source labels for the snapshot's team handles; labels never affect decision eligibility. */
	teamNames: Readonly<Record<string, string>>;
	/** The names of the snapshot's `users` approvers. */
	userNames: Readonly<Record<string, string>>;
	requestor: Who;
	/** Every transition, oldest first: the timeline's back-and-forth. */
	log: readonly {
		move: LogEntry['move'];
		by: Who;
		at: string;
		from: ApprovalState | null;
		to: ApprovalState;
		step: number;
		reason: string | null;
		changed: LogEntry['changed'];
		rolledBack: LogEntry['rolledBack'];
		skipped: LogEntry['skipped'];
	}[];
	/** The records the provisional change holds (the checkpoint): root first. */
	records: readonly { model: string; id: string; op: 'create' | 'update' | 'delete' }[];
	/** The decisions the viewer may take now — the state machine's own answer, so buttons match the engine. */
	moves: readonly { decision: ApprovalDecision; reason: 'required' | 'optional' }[];
	mine: boolean;
	participant: boolean;
};
export type DecideInput = {
	requestId: string;
	decision: ApprovalDecision;
	reason?: string;
	authority: Authority;
	now: string;
};
type ApprovalsOptions = {
	sourceEpoch?: string;
	bindings(at?: string): Effect.Effect<Bindings>;
	/** Publishes a decision's captured rows, and wakes the queue (the act path's own `committed`). */
	committed?(answer: CommitAnswer): Effect.Effect<void>;
	/** Re-reads the request's views and the `$approval` of the records it holds. */
	changed?(
		requestId: string,
		records: readonly { model: string; id: string }[]
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
	records: [{ model: 'approval_request', id, fields: ['status'] }]
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
const own = (actor: EngineActor) => (actor.kind === 'member' ? actor.id : null);

function makeApprovals(m: EngineManifest, db: TenantDbShape, options: ApprovalsOptions) {
	const cat = catalogOf(m);
	const sourceAuthorities = new Authorities(m, 'approval');
	const table = (model: string) => cat.exposures.get(model)?.model.name ?? model;
	const notifies = (model: string) => m.exposures[model]?.notify === true;
	const toStored = (r: typeof StoredRow.Type): Stored => ({
		id: r.id,
		state: r.state,
		step: r.step,
		requestor: r.requestor,
		user: r.requestor_user,
		route: r.route,
		model: r.model,
		record: r.record,
		action: r.action,
		records: r.records,
		log: r.log,
		at: new Date(r.at_text).toISOString()
	});
	const select = `SELECT id::text AS id, state, step, requestor, requestor_user, route, collection AS model, record, action, records, log,
		to_json(at)#>>'{}' AS at_text FROM bolt_approvals`;
	const load = Effect.fn('Approvals.load')(function* (id: string) {
		const rows = yield* db.rows(StoredRow, { text: `${select} WHERE id::text = $1`, params: [id] });
		return rows[0] === undefined ? null : toStored(rows[0]);
	});
	/** The root model's held rows as they are now (a removed one as its id): the notify event's records. */
	const current = Effect.fn('Approvals.current')(function* (a: Stored) {
		const ids = a.records.filter((r) => r.model === a.model).map((r) => r.id);
		if (cat.exposures.get(a.model) === undefined || ids.length === 0) return [{ id: a.record }];
		const rows = yield* db.rows(Schema.Struct({ j: Schema.Record(Schema.String, Schema.Json) }), {
			text: `SELECT to_jsonb(t) AS j FROM ${q(table(a.model))} t WHERE t.id::text IN (SELECT jsonb_array_elements_text($1::jsonb))`,
			params: [JSON.stringify(ids)]
		});
		const found = new Map(rows.map((r) => [String(r.j['id']), r.j]));
		return ids.map((id): Json => found.get(id) ?? { id });
	});
	/** H1: the `bolt.notify` run of one move, when the request's model declares `notify`. */
	const notified = (
		a: Pick<Stored, 'id' | 'model' | 'user'>,
		route: StepsSnapshot,
		move: ApprovalMove | 'request',
		next: Step,
		records: readonly Json[],
		now: string
	): QueuedRun[] => {
		if (!notifies(a.model)) return [];
		const step = route.steps[next.step];
		const event: NotifyWire = {
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
		return [notifyRun({ model: a.model, event }, now)];
	};
	/**
	 * Once the change stands (approved, superseded): the held records' current images — this statement's own writes
	 * first — reach the sync outbox they skipped while held (H3); a deleted held record sends its checkpoint image as a delete.
	 */
	const standing = (c: Chain, a: Pick<Stored, 'records'>, actor: EngineActor, now: string) => {
		const held = a.records.filter((record) => cat.exposures.has(record.model));
		if (held.length === 0) return;
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
				CASE WHEN t.id IS NULL THEN NULL::jsonb ELSE to_jsonb(t) END AS n
			FROM jsonb_to_recordset(${c.p(records)}::jsonb) AS r(id text, before int)
			LEFT JOIN ${q(table(model))} t ON t.id::text = r.id
			WHERE (t.id IS NOT NULL OR r.before IS NOT NULL)
			AND NOT EXISTS (SELECT 1 FROM allp p WHERE p.c = ${col} AND p.id = r.id)`;
				})
				.concat(
					`SELECT p.c,p.id,p.revision,p.op,p.cause,p.erased,p.o,p.n FROM allp p
			WHERE p.cause IN ('direct','cascade') AND NOT p.erased
			AND ${c.p(held.map(({ model, id }) => ({ collection: model, id })))}::jsonb @> jsonb_build_array(jsonb_build_object('collection',p.c,'id',p.id))`
				)
				.join(' UNION ALL ')
		);
		syncOutboxPiece(m, c, now, written, actor, source);
	};

	const hook: ApprovalHook = {
		route: Effect.fn('Approvals.route')(function* (act) {
			const route = act.snapshot;
			const unknown = unknownTeam(m, route);
			if (unknown !== undefined)
				return yield* Effect.fail(
					BoltError.make(
						'invalidSpec',
						'admission',
						`The approval flow names the team '${unknown}', which this workspace does not declare.`
					)
				);
			const b = act.bindings,
				auth = act.authority;
			// retry-stable (L-BOLT-201): minted from the invocation and its key
			const requestId = minter(`approval:${act.seed}:${act.model}:${act.record}`, b.now)();
			const requestor = actorRef(auth.actor),
				user = own(auth.actor);
			const entry: LogEntry = {
				move: 'request',
				by: requestor,
				at: b.now,
				from: null,
				to: 'Pending',
				step: 0,
				reason: null
			};
			const shown = face(route, { state: 'Pending', step: 0 });
			const runs = notified(
				{ id: requestId, model: act.model, user },
				route,
				'request',
				{ state: 'Pending', step: 0 },
				act.records.map((r: HeldRecord): Json => ({ ...r.values, id: r.id })),
				b.now
			);
			return {
				requestId,
				route,
				pieces: (c: Chain, held: string | null) => {
					const col = c.p(act.model),
						rec = c.p(act.record);
					c.cte(
						'ap_state',
						`INSERT INTO bolt_approvals (id, state, step, collection, record, action, requestor, requestor_user, route, records, log, at)
	SELECT ${c.p(requestId)}::uuid, 'Pending', 0, ${col}, ${rec}, ${c.p(act.action)}, ${c.p(requestor)}, ${c.p(user)}, ${c.p(route)}::jsonb,
		(SELECT coalesce(jsonb_agg(e), '[]'::jsonb) FROM (
			SELECT jsonb_build_object('collection', ${col}::text, 'id', ${rec}::text, 'op', 'update', 'before', (SELECT revision FROM ${q(table(act.model))} WHERE id::text = ${rec}))
				AS e WHERE NOT EXISTS (SELECT 1 FROM allp WHERE c = ${col} AND id = ${rec} AND cause IN ('direct', 'cascade'))
			UNION ALL SELECT ${checkpoint('x')} FROM (SELECT DISTINCT ON (c, id) * FROM allp WHERE cause IN ('direct', 'cascade') AND NOT erased) x) s),
		jsonb_build_array(${c.p(entry)}::jsonb), ${c.p(b.now)}::timestamptz
	WHERE ${GATED}${held === null ? '' : ` AND NOT EXISTS (SELECT 1 FROM ${held})`} ON CONFLICT (id) DO NOTHING RETURNING id`
					);
					c.cte(
						'ap_request',
						`INSERT INTO approval_request (id, collection_name, record_id, action, status, step, steps, step_names, approver_teams,
		approver_users, superseder_teams, created_at)
	SELECT id, ${col}, ${rec}, ${c.p(act.action)}, 'ONGOING', 0, ${shown.steps}, ${c.p(shown.names)}::jsonb, ${c.p(shown.teams)}::jsonb,
		${c.p(shown.users)}::jsonb, ${c.p(shown.superseders)}::jsonb, ${c.p(b.now)}::timestamptz FROM ap_state`
					);
					c.cte(
						'ap_requestor',
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
					BoltError.make('notFound', 'admission', 'No approval request has this id.')
				);
			if (a.route.__boltReadGuards !== undefined)
				return yield* Effect.fail(
					BoltError.make(
						'sourceChanged',
						'admission',
						'This request depends on earlier reads. Reject it and start a fresh request.'
					)
				);
			const allowed = act.snapshot.kind === 'allow';
			const route = act.snapshot.kind === 'allow' ? a.route : act.snapshot;
			const unknown = unknownTeam(m, route);
			if (unknown !== undefined)
				return yield* Effect.fail(
					BoltError.make(
						'invalidSpec',
						'admission',
						`The approval flow names the team '${unknown}', which this workspace does not declare.`
					)
				);
			// the same steps resume where changes were requested; changed steps restart at the first
			const next: Step = allowed
				? { state: 'Approved', step: a.step }
				: { state: 'Pending', step: sameFlow(a.route, route) ? a.step : 0 };
			const b = act.bindings,
				by = actorRef(act.authority.actor);
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
			const runs = notified(
				a,
				route,
				'resubmit',
				next,
				act.records.map((r: HeldRecord): Json => ({ ...r.values, id: r.id })),
				b.now
			);
			return {
				request: a.id,
				pending: !allowed,
				pieces: (c: Chain) => {
					c.cte(
						'ap_resubmit',
						`UPDATE bolt_approvals SET state = ${c.p(next.state)}, step = ${next.step}, route = ${c.p(route)}::jsonb,
		log = log || jsonb_build_array(${c.p(entry)}::jsonb), closed_at = ${c.p(allowed ? b.now : null)}::timestamptz
	WHERE id::text = ${c.p(a.id)} AND state = 'ChangesRequested' AND requestor = ${c.p(by)} AND ${GATED} RETURNING id`
					);
					c.assert(
						'(SELECT count(*) FROM ap_resubmit) = 1',
						'conflict',
						JSON.stringify({ model: 'approval_request', ids: [a.id] })
					);
					c.cte(
						'ap_resubmit_face',
						`UPDATE approval_request SET status = ${c.p(STATUS[next.state])}, step = ${next.step}, steps = ${shown.steps},
		step_names = ${c.p(shown.names)}::jsonb, approver_teams = ${c.p(shown.teams)}::jsonb, approver_users = ${c.p(shown.users)}::jsonb,
		superseder_teams = ${c.p(shown.superseders)}::jsonb, closed_at = ${c.p(allowed ? b.now : null)}::timestamptz,
		closed_by = ${c.p(allowed ? by : null)}, revision = revision + 1 WHERE id IN (SELECT id FROM ap_resubmit)`
					);
					if (allowed) standing(c, a, act.authority.actor, b.now);
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

	/**
	 * One decision: the guarded state change, its log entry, the readable face, the notify event and (reject) the
	 * rollback. A superseder's approve supersedes; a request whose record or model a release removed ends by reject.
	 */
	const decide = Effect.fn('Approvals.decide')(function* (
		x: DecideInput
	): Effect.fn.Return<Decision, EngineError> {
		if (x.authority.actor.kind !== 'member')
			return refused('forbidden', 'Only a member may decide an approval.');
		const a = yield* load(x.requestId);
		if (a === null) return refused('notFound', 'No approval request has this id.');
		const auth =
			x.authority.actor.kind === 'member'
				? yield* currentMember(x.authority.actor, x.authority.preview, x.authority.admin)
				: x.authority;
		if (auth === null)
			return refused('forbidden', 'You are no longer authorized to act on this request.');
		const roles = rolesOf(a, auth),
			move = moveOf(x.decision, roles),
			reason = x.reason?.trim() ?? '';
		const t = transition(a, a.route.steps.length, move, roles, reason);
		if ('refused' in t)
			return t.refused === 'forbidden'
				? refused('forbidden', t.message)
				: refused('invalidInput', t.message, t.refused === 'reason' ? 'reason' : undefined);
		const readGuards =
			move === 'approve' || move === 'supersede' ? a.route.__boltReadGuards : undefined;
		if (readGuards !== undefined && readGuards.sourceEpoch !== options.sourceEpoch)
			return refused(
				'sourceChanged',
				'This request was prepared by another source release. Reject it and start a fresh request.'
			);
		const { next, edge } = t;
		const now = x.now,
			by = actorRef(auth.actor),
			open = OPEN.includes(next.state),
			stands = next.state === 'Approved' || next.state === 'Superseded';
		const b = yield* options.bindings(now);
		const plan =
			edge.rollback === true
				? yield* rollbackPlan(m, db, a.records, b)
				: {
						writes: [],
						restored: [],
						rolledBack: [] as RolledBack[],
						skipped: [] as Skipped[],
						observations: []
					};
		if (plan.skipped.some((record) => record.field === '*' && record.reason !== 'modelRemoved'))
			return refused(
				'invalidInput',
				'An approval checkpoint cannot be restored. The request and its records remain held.'
			);
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
		const runs = notified(a, a.route, move, next, notifies(a.model) ? yield* current(a) : [], now);
		const refreshKey = `approval:${a.id}:${a.log.length}`;
		const mint = minter(`approval:${a.id}:${a.log.length}`, now);
		const shown = face(a.route, next);
		const statement = compileCommit(m, cat, {
			key: `approval:${a.id}:${a.log.length}`,
			digest: canonical({ request: a.id, at: a.log.length, move, by }),
			issuedAt: now,
			now,
			today: b.today,
			actor: auth.actor,
			writer: writerOf(auth),
			writes: plan.writes,
			owned: [],
			rate: [],
			runs: runs.map((run) => ({ ...run, id: mint() })),
			notices: [],
			output: null,
			restored: plan.restored,
			approvalDecision: { request: a.id },
			...(readGuards === undefined ? {} : { fingerprints: readGuards.fingerprints }),
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
				c.cte(
					'up',
					`UPDATE bolt_approvals SET state = ${c.p(next.state)}, step = ${next.step}, log = log || jsonb_build_array(${c.p(entry)}::jsonb),
	closed_at = ${c.p(open ? null : now)}::timestamptz${readGuards === undefined ? '' : `, route = jsonb_set(route, '{__boltReadGuardRefresh}', to_jsonb(${c.p(refreshKey)}::text))`} WHERE id IN (SELECT id FROM ap_authorize) RETURNING id`
				);
				c.cte(
					'pr',
					`UPDATE approval_request SET status = ${c.p(STATUS[next.state])}, step = ${next.step},
	approver_teams = ${c.p(shown.teams)}::jsonb, approver_users = ${c.p(shown.users)}::jsonb, superseder_teams = ${c.p(shown.superseders)}::jsonb,
	closed_at = ${c.p(open ? null : now)}::timestamptz, closed_by = ${c.p(open ? null : by)}, revision = revision + 1 WHERE id IN (SELECT id FROM up)`
				);
				if (stands) standing(c, a, auth.actor, now);
				c.assert(
					'(SELECT count(*) FROM up) = 1',
					'conflict',
					JSON.stringify({ model: 'approval_request', ids: [a.id] })
				);
			}
		});
		const lockedTables = [
			...new Set([
				...(readGuards?.tables ?? []),
				...plan.observations.map((observation) => observation.model),
				...affectedTables(m, cat, plan.writes),
				'bolt_approvals',
				'approval_request'
			])
		].sort();
		const decisionLock: Lock | undefined =
			readGuards === undefined && plan.observations.length === 0
				? undefined
				: { tables: lockedTables, mode: 'SHARE ROW EXCLUSIVE' };
		const result = yield* Effect.result(
			db
				.transaction({
					statements: [
						...statement,
						...(readGuards === undefined
							? []
							: [readGuardBaseline(a.id, readGuards, readGuards.sourceEpoch, refreshKey)])
					],
					...(decisionLock === undefined ? {} : { lock: decisionLock })
				})
				.pipe(
					Effect.flatMap((answers) =>
						decodeRows(CommitAnswer, answers[statement.length - 1] ?? { rows: [], affected: 0 })
					)
				)
		);
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
		return { kind: 'decided', requestId: a.id, status: next.state };
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
				filter.model ?? null,
				filter.records === undefined ? null : JSON.stringify(filter.records),
				filter.all === true
			]
		});
		const me = actorRef(auth.actor);
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
		const who = (ref: string): Who => ({
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
			teamNames: Object.fromEntries(
				[...new Set([...a.route.steps.flatMap((s) => s.teams), ...a.route.superseded_by])].map(
					(handle) => [
						handle,
						Object.hasOwn(teamCatalogue, handle) ? (teamCatalogue[handle]?.name ?? handle) : handle
					]
				)
			),
			userNames: Object.fromEntries(
				[...new Set(a.route.steps.flatMap((s) => s.users))].map((id) => [id, name.get(id) ?? id])
			),
			requestor: who(a.requestor),
			log: a.log.map((d) => ({
				move: d.move,
				by: who(d.by),
				at: d.at,
				from: d.from,
				to: d.to,
				step: d.step,
				reason: d.reason,
				changed: d.changed,
				rolledBack: d.rolledBack,
				skipped: d.skipped
			})),
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
		return bindingsAt(now, m.workspace.tz);
	});
/** Source routing is a direct planner dependency; it never acquires Approvals or Writes. */
export const approvalHook = (manifest: EngineManifest, db: TenantDbShape): ApprovalHook =>
	makeApprovals(manifest, db, { bindings: (at) => bindingOf(manifest, at) }).hook;
export const ApprovalsLive = Layer.effect(
	Approvals,
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			audit = yield* Audit,
			activation = yield* Activation,
			db = yield* TenantDb,
			live = yield* Live,
			context = yield* Effect.context<Effect.Services<ReturnType<typeof committed>>>();
		const area = makeApprovals(manifest, db, {
			sourceEpoch: activation.release,
			bindings: (at) => bindingOf(manifest, at),
			committed: (answer) => committed(answer).pipe(Effect.provideContext(context), Effect.asVoid),
			changed: (requestId, records) =>
				Effect.sync(() => {
					live.syncChanged('approval_request', [requestId]);
					for (const [model, rows] of Map.groupBy(records, (r) => r.model))
						live.syncChanged(
							model,
							rows.map((r) => r.id)
						);
				})
		});
		return Approvals.of({
			decide: (input: DecideInput) =>
				audited(
					db,
					{
						category: 'approval',
						action: input.decision,
						actor: auditActor(input.authority.actor),
						approval: input.requestId,
						payload: encodeWire({
							requestId: input.requestId,
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
