// Generated-verb batches and queued run starts are reachable only by policy. A batch plans guarded generated verbs and
// commits their writes in one statement under its idempotency key. A start queues runs without executing them.
import { Array as EffectArray, Effect, Layer, Predicate, Result, Schema } from 'effect';
import { encodeWire } from '@norbital-ai/std/wire';
import { audited, auditActor } from '../audit-operation.ts';
import { Audit } from '../audit.ts';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import {
	Callables,
	Guest,
	Live,
	Manifest,
	Reads,
	Wake,
	Links,
	type Bridge,
	type Entry,
	type CallerContext,
	type CallResult,
	type StartRequest,
	type PlannedCommit,
	type ReadsShape,
	type GuestShape,
	type Callable,
	type CallablesShape,
	type ShapeOf
} from '../services.ts';
import type { EngineManifest } from '../manifest.ts';
import { enqueue, nextDue } from '../runs/queue.ts';
import { dueAt as roundedDueAt, offsetMs } from '../runs/time.ts';
import { approvalHook } from '../approvals/approvals.ts';
import { FILE_SYNC_INPUT, fileSyncAdmits } from '../sync/file.ts';
import { WriteOutcome as importedOutcome } from '../../protocol/schema.ts';
import { replayOnce } from '../write/replay.ts';
import { delegatedVerbAuthority, type AutomationDelegation } from '../access/delegation.ts';
import type { Json } from '../../decl/values.ts';
import {
	LIMITS,
	type Authority,
	type CrossAnswer,
	type EngineActor,
	type Outcome,
	type RowData
} from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';
import { catalogOf } from '../access/pred.ts';

import * as ir from '../../protocol/reads.ts';
import { constraintIndex } from '../schema/plan.ts';
import { coalescing, memoReads } from '../query/engine.ts';
import { act, transformBridge, type Verb, type WriteEngine } from '../write/act.ts';
import {
	actorId,
	actorRef,
	executeCommit,
	compileOutcomeRecord,
	CommitAnswer,
	committed,
	type Commit,
	type RateCharge
} from '../write/commit.ts';
import { canonical, sha256Hex } from '@norbital-ai/store';
import { Chain, decided, KEY_REUSE, storedOutcome } from '../write/sql.ts';
import { decodeInput, type Decoded } from './decode.ts';

type Caller = CallerContext & {
	delegation?: AutomationDelegation | undefined;
};
type Sink = (planned: PlannedCommit) => void;
type ActsRequest = Caller & {
	name: string;
	acts: readonly {
		model: string;
		verb: Verb;
		input: Json;
		observed?: Readonly<Record<string, number>> | undefined;
		onConflict?: 'update' | 'keep' | undefined;
	}[];
	key: string;
	issuedAt: string;
	sink?: Sink | undefined;
};
type CallablesConfig = {
	engine: WriteEngine & { read: ReadsShape['run'] };
	guest: GuestShape;
	live: ShapeOf<typeof Live>;
	wake: ShapeOf<typeof Wake>;
	links: ShapeOf<typeof Links>;
};

type Refused = Extract<Outcome, { kind: 'refused' }>;
type Planned = PlannedCommit;
/** Planned generated verbs share their outer batch's commit and pending created rows. */
type Recorder = {
	commits: Planned[];
	issuedAt: string;
	db: TenantDbShape;
	/** Rows created by earlier planned verbs, keyed `model␀id`. */
	pending: Map<string, RowData>;
};
type Performed = { output: Json } | { outcome: Outcome; guest: boolean } | { error: BoltError };

const refused = (code: Refused['code'], message: string, field?: string): Refused => ({
	kind: 'refused',
	code,
	message,
	...(field === undefined ? {} : { field })
});
const HOUR = 3_600_000;
export const VERBS: readonly Verb[] = ['create', 'update', 'delete', 'upsert', 'erase', 'import'];
/** The generated verbs admitted by both typed and dynamically checked atomic batches. */
export function isBatchCallable(callable: Callable): callable is Extract<
	Callable,
	{ _tag: 'Verb' }
> & {
	verb: 'create' | 'update' | 'upsert' | 'delete';
} {
	return (
		callable._tag === 'Verb' &&
		(callable.verb === 'create' ||
			callable.verb === 'update' ||
			callable.verb === 'upsert' ||
			callable.verb === 'delete')
	);
}
const fail = (code: string, message: string): CrossAnswer => ({
	ok: false,
	error: { kind: 'bolt', code, message }
});
const failed = (e: unknown): CrossAnswer =>
	fail(e instanceof BoltError ? e.code : 'internal', e instanceof Error ? e.message : String(e));
const problems = (d: Decoded) => d.problems.map((p) => `${p.path}: ${p.message}`).join('; ');
/** The `Holder` a `'trigger'` run is recompiled from (`sys_run.starter`, read by the runs area). */
const starterOf = (a: Authority): Json =>
	Schema.encodeSync(Schema.Json)({
		actor: a.actor,
		policies: a.policies,
		admin: a.admin,
		teamTree: a.teamTree,
		scopes: a.scopes
	});
function scheduledAt(now: string, at?: Json): string {
	const time = Date.parse(now);
	const target =
		at == null
			? time
			: typeof at === 'string'
				? Date.parse(at)
				: Predicate.isObject(at) && typeof at['now'] === 'string'
					? time + offsetMs(at['now'])
					: Number.NaN;
	if (Number.isNaN(target)) throw BoltError.make('invalidInput', 'decode', 'at is not an instant');
	return new Date(roundedDueAt(time, target)).toISOString();
}
export function parseCallable(
	callable: string,
	manifest: EngineManifest
): Result.Result<Callable, BoltError> {
	const dot = callable.lastIndexOf('.'),
		model = callable.slice(0, dot),
		member = callable.slice(dot + 1);
	const verb = VERBS.find((verb) => verb === member);
	if (verb !== undefined && manifest.exposures[model] !== undefined)
		return Result.succeed({ _tag: 'Verb', model, verb });
	const syncAt = callable.indexOf('.sync.');
	if (syncAt > 0) {
		const owner = callable.slice(0, syncAt),
			sync = callable.slice(syncAt + 6);
		if (manifest.exposures[owner]?.syncs?.[sync] !== undefined)
			return Result.succeed({ _tag: 'Sync', model: owner, sync });
	}
	if (manifest.automations[callable] !== undefined)
		return Result.succeed({ _tag: 'Automation', automation: callable });
	return Result.fail(
		BoltError.make('unknownCallable', 'decode', `'${callable}' is not a declared callable`)
	);
}
function makeCallables(config: CallablesConfig): CallablesShape {
	const e = config.engine,
		m = e.manifest,
		cat = catalogOf(m);
	const guest = config.guest;
	const constraints = constraintIndex(m);

	/** Rule 33: a start or schedule needs the automation in `policy.automations`; its input decodes (rule 23). */
	function startable(name: string, auth: Authority, input: Json): Refused | null {
		const parsed = parseCallable(name, m);
		if (auth.actor.kind === 'visitor') return refused('forbidden', 'Visitors may not start runs.');
		if (Result.isSuccess(parsed) && parsed.success._tag === 'Sync') {
			const { model, sync } = parsed.success,
				entry = m.exposures[model]?.syncs?.[sync];
			if (entry?.with === 'file') {
				if (!fileSyncAdmits(auth, model, input))
					return refused('forbidden', `You may not run '${name}'.`);
				const decoded = decodeInput(FILE_SYNC_INPUT, input);
				return decoded.problems.length > 0
					? refused('invalidInput', problems(decoded), decoded.problems[0]?.path)
					: null;
			}
			if (entry?.read !== true) return refused('forbidden', `'${name}' has no read.`);
			if (!auth.admin && (auth.models[model]?.read[model]?.length ?? 0) === 0)
				return refused('forbidden', `You may not sync '${model}'.`);
			const decoded = decodeInput(
				{ instance: { kind: 'text', optional: true }, partition: { kind: 'text', optional: true } },
				input
			);
			return decoded.problems.length > 0
				? refused('invalidInput', problems(decoded), decoded.problems[0]?.path)
				: null;
		}
		const spec = m.automations[name];
		if (spec === undefined) return refused('notFound', `'${name}' is not an automation or sync.`);
		if (!auth.admin && !auth.automations.includes(name))
			return refused('forbidden', `You may not start '${name}'.`);
		return null;
	}

	/** One generated verb through the act pipeline, its planned commit recorded (`sink`), its creates readable by later acts. */
	const recordVerb = Effect.fn('Callables.recordVerb')(function* (
		model: string,
		verb: Verb,
		input: Json,
		c: Caller,
		rec: Recorder,
		onConflict?: 'update' | 'keep',
		batch?: { db: TenantDbShape; into: (planned: Recorder['commits'][number]) => void }
	): Effect.fn.Return<Outcome, import('../errors.ts').EngineError> {
		let planned: Planned | undefined;
		const result = yield* act(
			{ ...e, db: batch?.db ?? rec.db },
			{
				model,
				verb,
				input,
				key: c.invocationId,
				issuedAt: rec.issuedAt,
				authority: delegatedVerbAuthority(m, c.authority, c.delegation, `${model}.${verb}`),
				observed: c.observed,
				readGuards: c.readGuards,
				bindings: c.bindings,
				invocationId: c.invocationId,
				onConflict,
				mode: {
					_tag: 'Record',
					pending: rec.pending,
					sink: (value) => {
						planned = value;
						if (batch === undefined) rec.commits.push(value);
						else batch.into(value);
						for (const write of value.commit.writes)
							if (write.op === 'create')
								rec.pending.set(`${write.model}\u0000${write.id}`, {
									...write.values,
									id: write.id,
									revision: 1,
									created_by: actorId(c.authority.actor)
								});
					}
				}
			}
		);
		// The recorder already simulates successful writes until its outer statement; a routed one too (it commits there).
		if (result.outcome.kind === 'pendingApproval' && planned !== undefined)
			return {
				kind: 'committed',
				output: planned.commit.output,
				records: planned.commit.writes.map((write) => ({
					model: write.model,
					id: write.id,
					revision: write.op === 'create' ? 1 : write.revision + 1
				}))
			};
		return result.outcome;
	});

	/**
	 * Each act records into the one commit; the first (in order) that does not commit is the outcome, recorded (it ran
	 * guest code). The acts are planned at once over one coalesced reader — one round trip, one statement per step for
	 * the whole batch — so they are independent: one names no row another creates (rule 36 sees the stored rows).
	 */
	const acts = (r: ActsRequest): Effect.Effect<CallResult, import('../errors.ts').EngineError> =>
		atomic(
			{ ...r, input: encodeWire(r.acts) },
			r.name,
			encodeWire(r.acts),
			Effect.fn('Callables.body')(function* (rec) {
				const invalid = r.acts.findIndex((act) =>
					act.verb === 'upsert' ? act.onConflict === undefined : act.onConflict !== undefined
				);
				if (invalid >= 0)
					return {
						outcome: refused(
							'invalidInput',
							'A batch upsert requires onConflict; other verbs do not take it.',
							`${invalid}.onConflict`
						),
						guest: false
					};
				const db = yield* coalescing(e.db, r.acts.length);
				const plans: (Recorder['commits'][number] | undefined)[] = r.acts.map(() => undefined);
				// each act its own invocation: its minted ids are its own (two creates of one model mint apart)
				const outcomes = yield* Effect.forEach(
					r.acts,
					(a, i) =>
						recordVerb(
							a.model,
							a.verb,
							a.input,
							{ ...r, observed: a.observed, invocationId: `${r.invocationId}/${i}` },
							rec,
							a.onConflict,
							{
								db,
								into: (p) => {
									plans[i] = p;
								}
							}
						).pipe(Effect.ensuring(db.done)),
					{ concurrency: 'unbounded' }
				);
				const bad = outcomes.find((o) => o.kind !== 'committed');
				if (bad !== undefined) return { outcome: bad, guest: true };
				for (const p of plans) if (p !== undefined) rec.commits.push(p);
				return { output: plans.map((p) => p?.commit.output ?? null) };
			})
		);

	/** One act of recorded writes under one idempotency key: `body` records into the recorder, committed as one statement. */
	const atomic = Effect.fn('Callables.atomic')(function* (
		r: Caller & {
			key: string;
			issuedAt: string;
			retry?: boolean | undefined;
			rate?: readonly RateCharge[] | undefined;
			input: Json;
			sink?: Sink | undefined;
		},
		callable: string,
		input: Json,
		body: (rec: Recorder) => Effect.Effect<Performed, import('../errors.ts').EngineError>
	): Effect.fn.Return<CallResult, import('../errors.ts').EngineError> {
		const currentV = yield* config.live.v;
		const none = (outcome: Outcome, error?: BoltError): CallResult => ({
			outcome,
			captured: [],
			v: currentV,
			...(error === undefined ? {} : { error })
		});
		const age = Date.parse(r.bindings.now) - Date.parse(r.issuedAt);
		if (!(age <= 23 * HOUR && age >= -5 * 60_000))
			return none(refused('invalidInput', 'The request expired; send it again.'));
		const actor = r.authority.actor;
		const key = sha256Hex(
			`${canonical({ actor: actor.kind === 'member' ? actor.id : actor, callable })}\u0000${r.key}`
		);
		const digest = sha256Hex(canonical({ callable, input }));
		const stored = Effect.fn('Callables.stored')(function* () {
			return yield* e.db.value(Schema.NullOr(importedOutcome), {
				text: `SELECT ${storedOutcome('$1', '$2')} AS outcome`,
				params: [key, digest]
			});
		});
		if (r.retry) {
			const previous = yield* stored();
			if (previous !== null) return none(previous);
		}
		// One batch owns its first read answers across replay.
		const db = yield* memoReads(yield* coalescing(e.db));
		const common = { key, digest, issuedAt: r.issuedAt, rate: r.rate ?? [] };
		const record = Effect.fn('Callables.recordOutcome')(function* (outcome: Outcome) {
			if (r.sink !== undefined) return none(outcome);
			const answer = (yield* e.db.returning(
				CommitAnswer,
				compileOutcomeRecord(common, outcome)
			))[0];
			return none(answer?.outcome ?? outcome);
		});

		// rule 26: a serialization failure replays the body once with the same clock and minted ids
		return yield* replayOnce<CallResult, import('../errors.ts').EngineError, never>(
			Effect.fn('Callables.replay')(function* (replay) {
				const rec: Recorder = {
					commits: [],
					issuedAt: r.issuedAt,
					db,
					pending: new Map()
				};
				const p = yield* body(rec);
				if ('error' in p) {
					// the wire outcome is only `unknown`: the cause is logged here and rides `CallResult.error`
					yield* Effect.logError(
						`${callable} settled unknown (${r.invocationId}): ${p.error.code}: ${p.error.message}`
					);
					return none({ kind: 'unknown', invocation: r.invocationId }, p.error);
				}
				if ('outcome' in p) return p.guest ? yield* record(p.outcome) : none(p.outcome);
				const writes = rec.commits.flatMap((plan) =>
					plan.commit.writes.map((write) => ({
						...write,
						erased: write.erased ?? plan.commit.erase !== undefined
					}))
				);
				if (
					writes.length > LIMITS.changesPerAct ||
					JSON.stringify(writes).length > LIMITS.changeSetBytes
				)
					return yield* record(refused('overflow', 'The batch exceeds its native change budget.'));
				const seen = new Set<string>();
				const twice = writes.find(
					(w) => seen.size === seen.add(`${w.model}\u0000${w.id}`).size
				);
				if (twice !== undefined)
					return yield* record(
						refused(
							'invalidInput',
							`The batch writes ${twice.model} ${twice.id} twice; one act writes a row once (rule 21).`
						)
					);
				const approvals = rec.commits.flatMap((x) =>
					x.commit.approval === undefined ? [] : [x.commit.approval]
				);
				// one statement opens one request: the first routed act's, holding every row the statement touches
				const approval = approvals[0];
				const routes = new Set(approvals.map((a) => canonical(a.route)));
				if (routes.size > 1)
					return yield* record(
						refused(
							'approvalSplit',
							'These changes need different approvals; submit them separately.'
						)
					);
				const resubmits = rec.commits.flatMap((planned) =>
					planned.commit.resubmit === undefined ? [] : [planned.commit.resubmit]
				);
				if (new Set(resubmits.map((resubmit) => resubmit.request)).size > 1)
					return yield* record(refused('approvalSplit', 'Save each approval request separately.'));
				const tables = [
					...new Set([
						...rec.commits.flatMap((x) => x.lock?.tables ?? []),
						...(r.readGuards?.tables ?? []),
						...(r.readGuards === undefined ? [] : writes.map((write) => write.model))
					])
				].sort();
				const erasures = rec.commits.flatMap(
					(plan) =>
						plan.commit.erasures ?? (plan.commit.erase === undefined ? [] : [plan.commit.erase])
				);

				const commit: Commit = {
					...common,
					now: r.bindings.now,
					today: r.bindings.today,
					actor,
					writes,
					owned: rec.commits.flatMap((x) => x.commit.owned),
					fingerprints: rec.commits.flatMap((x) => x.commit.fingerprints ?? []),
					...(r.readGuards === undefined ? {} : { readGuards: r.readGuards }),
					erasures,
					runs: [],
					notices: rec.commits.flatMap((x) => x.commit.notices),
					output: p.output,
					...(approval === undefined ? {} : { approval }),
					...(resubmits[0] === undefined ? {} : { resubmit: resubmits[0] })
				};
				if (r.sink !== undefined) {
					r.sink({
						commit,
						...(tables.length > 0 ? { lock: { tables, mode: 'SHARE ROW EXCLUSIVE' as const } } : {})
					});
					return none({
						kind: 'committed',
						output: p.output,
						records: writes.map((write) => ({
							model: write.model,
							id: write.id,
							revision: write.op === 'create' ? 1 : write.revision + 1
						}))
					});
				}
				const result = yield* Effect.result(
					executeCommit(
						e.db,
						m,
						cat,
						commit,
						tables.length > 0 ? { tables, mode: 'SHARE ROW EXCLUSIVE' } : undefined
					)
				);
				if (Result.isFailure(result)) {
					const decision = decided(result.failure, constraints);
					const settle = decision.record
						? record(decision.outcome)
						: Effect.succeed(none(decision.outcome));
					if (decision.replay) return yield* replay(settle);
					return yield* settle;
				}
				const answer = result.success[0];
				if (answer === undefined)
					return yield* Effect.fail(
						BoltError.make('internal', 'commit', 'the commit returned no answer')
					);
				const outcome =
					answer.outcome ?? (yield* stored()) ?? refused('refused', 'The outcome was lost.');
				const v = yield* committed(answer, outcome).pipe(
					Effect.provideService(Live, config.live),
					Effect.provideService(Wake, config.wake),
					Effect.provideService(Links, config.links)
				);
				return {
					outcome,
					captured: answer.captured,
					v,
					...(answer.read_guards_applied === true &&
					(outcome.kind === 'committed' || outcome.kind === 'pendingApproval')
						? { readGuardsConsumed: true as const }
						: {})
				};
			})
		);
	});

	const start = Effect.fn('Callables.start')(function* (
		r: StartRequest
	): Effect.fn.Return<Outcome, import('../errors.ts').EngineError> {
		if (r.runs.length === 0)
			return refused('invalidInput', 'A start names at least one run.', 'runs');
		for (const run of r.runs) {
			const no = startable(r.automation, r.authority, run.input);
			if (no !== null) return no;
			const spec = m.automations[r.automation];
			const decoded = spec === undefined ? undefined : decodeInput(spec.input, run.input);
			if (decoded !== undefined && decoded.problems.length > 0)
				return refused('invalidInput', problems(decoded), decoded.problems[0]?.path);
			const refs = decoded?.refs ?? [];
			if (refs.length > 0) {
				const found = yield* e
					.read(
						refs.map((ref) =>
							ir.read(cat, ref.model, {
								where:
									ref.where === undefined || Object.keys(ref.where).length === 0
										? { id: { eq: ref.id } }
										: { and: [{ id: { eq: ref.id } }, ref.where] },
								select: { id: true },
								limit: 1
							})
						),
						{ as: 'caller', authority: r.authority },
						r.bindings
					)
					.pipe(Effect.catch(() => Effect.succeed(refs.map(() => null))));
				const missing = refs.find((_, index) => {
					const page = found[index];
					const rows = Predicate.isObject(page) ? page['rows'] : undefined;
					return !EffectArray.isArray(rows) || rows.length === 0;
				});
				if (missing !== undefined)
					return refused(
						'notFound',
						`No readable ${missing.model} has this id.`,
						missing.field
					);
			}
			if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(run.id))
				return refused('invalidInput', 'A run id is a client-minted uuid.', 'id');
		}
		const due = yield* Effect.try({
			try: () => scheduledAt(r.bindings.now),
			catch: (error) =>
				error instanceof BoltError ? error : BoltError.make('invalidInput', 'decode', String(error))
		});
		const parsed = parseCallable(r.automation, m);
		const starter =
			m.automations[r.automation]?.runAs === 'trigger' ||
			(Result.isSuccess(parsed) && parsed.success._tag === 'Sync')
				? starterOf(r.authority)
				: null;
		const actor = actorRef(r.authority.actor);
		const chain = new Chain();
		const inserted = enqueue(
			chain,
			r.runs.map((run) => ({
				id: run.id,
				automation: r.automation,
				input: run.input,
				dueAt: due,
				cause: 'start' as const,
				depth: 0,
				actor,
				starter
			})),
			{ conflict: 'keep' }
		);
		// each run is new, or the same run already queued (a retried start): any other id clash is a key reuse
		const result = (yield* e.db.returning(
			Schema.Struct({
				created: Schema.Number,
				same: Schema.Number,
				next_due: Schema.NullOr(Schema.String)
			}),
			chain.sql(
				`(SELECT count(*)::int FROM ${inserted}) AS created, (SELECT count(*)::int FROM sys_run s JOIN jsonb_to_recordset(${chain.p(r.runs.map((run) => ({ id: run.id, input: run.input })))}::jsonb) x(id text, input jsonb) ON s.id = x.id WHERE s.automation = ${chain.p(r.automation)} AND s.input = x.input) AS same, ${nextDue(chain)} AS next_due`
			)
		))[0];
		if (result?.next_due !== null && result?.next_due !== undefined)
			yield* config.wake.at(result.next_due);
		return (result?.created ?? 0) + (result?.same ?? 0) === r.runs.length
			? {
					kind: 'committed',
					output: { id: r.runs[0]!.id, automation: r.automation, ids: r.runs.map((run) => run.id) },
					records: []
				}
			: KEY_REUSE;
	});

	return {
		acts: (request: ActsRequest) =>
			audited(
				e.db,
				{
					category: 'write',
					action: 'act.many',
					actor: auditActor(request.authority.actor),
					invocation: request.invocationId,
					payload: encodeWire(request.acts),
					outcomeKey: sha256Hex(
						`${canonical({ actor: request.authority.actor.kind === 'member' ? request.authority.actor.id : request.authority.actor, callable: request.name })}\u0000${request.key}`
					),
					digest: sha256Hex(canonical({ callable: request.name, input: encodeWire(request.acts) }))
				},
				acts(request)
			),
		start: (request: StartRequest) =>
			audited(
				e.db,
				{
					category: 'automation',
					action: 'start',
					actor: auditActor(request.authority.actor),
					payload: encodeWire({ automation: request.automation, runs: request.runs })
				},
				start(request)
			)
	};
}

// ── visitors (rule 38d, §3.9) and what an outcome may say to whom (rule 32) ──

/** The surfaces a visitor request may reach (rule 38d (a)): `read`/`get` of granted reads and generated `create` only. */
type Surface = { read: string } | { act: string; verb: string } | { other: string };
export function admitVisitor(auth: Authority, s: Surface): Refused | null {
	if (auth.actor.kind !== 'visitor') return null;
	const ok =
		'read' in s
			? (auth.models[s.read]?.read[s.read]?.length ?? 0) > 0
			: 'act' in s
				? s.verb === 'create' && (auth.models[s.act]?.create.length ?? 0) > 0
				: false;
	return ok ? null : refused('forbidden', 'Visitors may not do this.');
}
/**
 * Rule 32: only `ctx.refuse` and mapped constraint messages reach members; public and API-key actors receive codes
 * only. Rule 38d (d): a visitor gets codes and messages, and a proposed create no request id.
 */
export function forActor(
	o: Outcome,
	actor: EngineActor
): Outcome | { kind: 'pendingApproval'; records: import('../contracts.ts').Written } {
	if (o.kind === 'refused' && (actor.kind === 'envoy' || actor.kind === 'apiKey'))
		return { kind: 'refused', code: o.code, message: o.code };
	if (o.kind === 'pendingApproval' && actor.kind === 'visitor')
		return { kind: 'pendingApproval', records: o.records };
	return o;
}

export const CallablesLive = Layer.effect(
	Callables,
	Effect.gen(function* () {
		const manifest = yield* Manifest,
			audit = yield* Audit,
			db = yield* TenantDb,
			guest = yield* Guest,
			reader = yield* Reads;
		const live = yield* Live,
			wake = yield* Wake,
			links = yield* Links;
		const native: WriteEngine & { read: ReadsShape['run'] } = {
			manifest,
			db,
			guest,
			approval: approvalHook(manifest, db),
			bridge: (invocation, over = db) => transformBridge(manifest, over, invocation),
			read: reader.run
		};
		const callables = makeCallables({
			engine: native,
			guest,
			live,
			wake,
			links
		});
		return Callables.of({
			acts: (request) => callables.acts(request).pipe(Effect.provideService(Audit, audit)),
			start: (request) => callables.start(request).pipe(Effect.provideService(Audit, audit))
		});
	})
);
