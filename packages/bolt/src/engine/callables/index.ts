import { actor_id, actor_ref } from '../access/actor.ts';
import { UUID_PATTERN } from '@norbital-ai/store/kind';
// Generated-verb batches and queued run starts are reachable only by policy. A batch plans guarded generated verbs and
// commits their writes in one statement under its idempotency key. A start queues runs without executing them.
import { Array as EffectArray, Effect, Layer, Predicate, Result, Schema } from 'effect';

import { audited, auditActor } from '../audit-operation.ts';
import { Audit } from '../audit.ts';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import { CapturedResult, nativeCommit } from '../db/captured.ts';
import { storedRow } from '../db/stored.ts';
import {
	Callables,
	Guest,
	Live,
	Manifest,
	Reads,
	Wake,
	Links,
	Telemetry,
	type CallerContext,
	type InvocationEvents,
	type CallResult,
	type StartRequest,
	type SyncControlRequest,
	type AutomationRequest,
	type PlannedCommit,
	type ReadsShape,
	type CallablesShape,
	type ShapeOf,
	acts_json
} from '../services.ts';
import type { EngineManifest } from '../manifest.ts';
import { enqueue, holderOf, next_due, writerOf } from '../runs/queue.ts';
import { due_at as roundedDueAt } from '../runs/time.ts';
import { approval_hook } from '../approvals/approvals.ts';
import { FileSyncInput, fileSyncAdmits } from '../sync/file.ts';
import { WriteOutcome as importedOutcome } from '../../protocol/schema.ts';
import { replayOnce } from '../write/replay.ts';
import type { Json } from '../../decl/values.ts';
import {
	LIMITS,
	utf8Bytes,
	type Authority,
	type EngineActor,
	type NativeWriteConflict,
	type Outcome,
	type RowData,
	type RunTrigger
} from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';
import { RATE_LIMITED } from '../../protocol/wire.ts';
import { parse_rate, RateWindows, type Charge } from '../access/rate.ts';
import { catalog_of } from '../access/pred.ts';
import { readsAny, viewOutput } from '../access/authority.ts';

import * as ir from '../../protocol/reads.ts';
import { constraintIndex } from '../schema/plan.ts';
import { coalescing } from '../query/engine.ts';
import { act, dry_run, transformBridge, type Verb, type WriteEngine } from '../write/act.ts';
import { compileCommit, executeCommit, compile_outcome_record, CommitAnswer, committed, type Commit, type RateCharge } from '../write/commit.ts';
import { settleCommit } from '../write/result.ts';
import { canonical, sha256_hex } from '@norbital-ai/store';
import { Chain, decided, KEY_REUSE, storedOutcome } from '../write/sql.ts';
import { decodeInput, decodeAutomationInput, type Decoded } from './decode.ts';
export { parse_callable, decode_acts, VERBS } from './parse.ts';

type Caller = CallerContext & {};
type ActsRequest = import('../services.ts').ActsRequest;
type CallablesConfig = {
	engine: WriteEngine & { read: ReadsShape['run'] };
	live: ShapeOf<typeof Live>;
	wake: ShapeOf<typeof Wake>;
	links: ShapeOf<typeof Links>;
	telemetry: ShapeOf<typeof Telemetry>;
};

type Refused = Extract<Outcome, { kind: 'refused' }>;
type Planned = PlannedCommit;
/** Planned generated verbs share their outer batch's commit and pending created rows. */
type Recorder = {
	commits: Planned[];
	/** Rows created by earlier planned verbs, keyed `model␀id`. */
	pending: Map<string, RowData>;
	/** Whether any act ran guest code: only a refusal guest code decided is recorded for a retry to answer. */
	guest: boolean;
};
type Performed = { output: Json; preview?: true } | { outcome: Outcome; guest: boolean } | { error: BoltError };

const refused = (code: Refused['code'], message: string, field?: string): Refused => ({
	kind: 'refused',
	code,
	message,
	...(field === undefined ? {} : { field })
});
const HOUR = 3_600_000;
const problems = (d: Decoded) => d.problems.map((p) => `${p.path}: ${p.message}`).join('; ');
/** The `Holder` a started run records (`sys_run.starter`): a sync's authority, who may read an automation run's result. */
const starterOf = (a: Authority): Json => holderOf(a);
/** A start's trigger (`sys_run.trigger`): the person, and the agent conversation they started it through; a run's code is a schedule. */
export const triggerOf = (
	a: Authority,
	agent: { readonly conversation: string } | undefined
): RunTrigger =>
	a.actor.kind === 'system'
		? {
				kind: 'system',
				cause: 'schedule',
				by: {
					automation:
						'automation' in a.actor.by
							? a.actor.by.automation
							: 'platform' in a.actor.by
								? a.actor.by.platform
								: a.actor.by.sync,
					run: a.actor.run
				}
			}
		: {
				kind: 'person',
				actor: a.actor,
				...(agent === undefined ? {} : { agent: { conversation: agent.conversation } })
			};
/** A start's due time: now, rounded as every due time is. */
function scheduledAt(now: string): string {
	const time = Date.parse(now);
	return new Date(roundedDueAt(time, time)).toISOString();
}
const START_LIMIT = '30/min';
/** Manual starts are limited per automation and starter. */
export const startCharge = (automation: string, authority: Authority): Charge => ({
	rule: `start:${automation}:${START_LIMIT}`,
	bucket: actor_ref(authority.actor),
	...parse_rate(START_LIMIT)
});

/** What a batch commits through: the write engine over the request's tenant, the live sequence and the commit's publication. */
export type BatchEngine = WriteEngine & {
	readonly v: Effect.Effect<number>;
	readonly publish: (answer: CommitAnswer) => Effect.Effect<number>;
};
/**
 * The one act pipeline: every generated verb, however it is called, is a batch planned by `act` and committed here.
 * Each act records into the one commit; the first (in order) that does not commit is the outcome, recorded (it ran
 * guest code). Independent acts are planned at once over one coalesced reader — one round trip, one statement per step
 * for the whole batch. A batch that creates a row under a writer-minted `id` is planned in order instead, each act
 * seeing the rows the acts before it create, so a later act's ref may name one.
 */
export const commitActs = (
	e: BatchEngine,
	r: ActsRequest,
	log?: InvocationEvents
): Effect.Effect<CallResult, import('../errors.ts').EngineError> => {
	const m = e.manifest,
		cat = catalog_of(m);
	/** One generated verb through the act pipeline, its planned commit recorded (`sink`), its creates readable by later acts. */
	const recordVerb = Effect.fn('Callables.recordVerb')(function* (
		model: string,
		verb: Verb,
		input: Json,
		c: Caller,
		rec: Recorder,
		on_conflict: NativeWriteConflict | undefined,
		batch: { db: TenantDbShape; into: (planned: Recorder['commits'][number]) => void },
		one: Pick<ActsRequest, 'restored' | 'sync'>
	): Effect.fn.Return<Outcome, import('../errors.ts').EngineError> {
		let planned: Planned | undefined;
		const guest = e.guest;
		const outcome = yield* act(
			{
				...e,
				db: batch.db,
				...(log === undefined ? {} : { log }),
				...(guest === undefined
					? {}
					: {
							guest: {
								invoke: (invocation, bridge) => (rec.guest = true, guest.invoke(invocation, bridge)),
								invokeEach: (invocation, parts, bridge) => (rec.guest = true, guest.invokeEach(invocation, parts, bridge)),
								invokeProgram: (program, invocation, bridge) => (rec.guest = true, guest.invokeProgram(program, invocation, bridge))
							}
						})
			},
			{
				model,
				verb,
				input,
				key: c.invocationId,
				authority: c.authority,
				observed: c.observed,
				readGuards: c.readGuards,
				bindings: c.bindings,
				invocationId: c.invocationId,
				on_conflict,
				...(one.restored === undefined ? {} : { restored: one.restored }),
				mode: {
					...(one.sync === undefined ? {} : { sync: one.sync }),
					pending: rec.pending,
					sink: (value) => {
						planned = value;
						batch.into(value);
						for (const write of value.commit.writes)
							if (write.op === 'create')
								rec.pending.set(`${write.model}\u0000${write.id}`, {
									...storedRow(cat, write.model, write.values),
									id: write.id,
									revision: 1,
									created_by: actor_id(c.authority.actor)
								});
					}
				}
			}
		);
		// The recorder already simulates successful writes until its outer statement; a routed one too (it commits there).
		if (outcome.kind === 'pending_approval' && planned !== undefined)
			return {
				kind: 'committed',
				output: planned.commit.output,
				records: planned.commit.writes.map((write) => ({
					model: write.model,
					id: write.id,
					revision: write.op === 'create' ? 1 : write.revision + 1
				}))
			};
		return outcome;
	});

	/** One act of recorded writes under one idempotency key: `body` records into the recorder, committed as one statement. */
	const atomic = Effect.fn('Callables.atomic')(function* (
		r: Caller & {
			key: string;
			issuedAt: string;
			retry?: boolean | undefined;
			rate?: readonly RateCharge[] | undefined;
			input: Json;
		},
		callable: string,
		input: Json,
		body: (rec: Recorder) => Effect.Effect<Performed, import('../errors.ts').EngineError>
	): Effect.fn.Return<CallResult, import('../errors.ts').EngineError> {
		const currentV = yield* e.v;
		const none = (outcome: Outcome, error?: BoltError): CallResult => ({
			outcome,
			captured: [],
			v: currentV,
			...(error === undefined ? {} : { error })
		});
		const age = Date.parse(r.bindings.now) - Date.parse(r.issuedAt);
		if (!(age <= 23 * HOUR && age >= -5 * 60_000))
			return none(refused('expired', 'The request expired; send it again.'));
		const actor = r.authority.actor;
		const key = sha256_hex(
			`${canonical({ actor: actor.kind === 'member' ? actor.id : actor, callable })}\u0000${r.key}`
		);
		const digest = sha256_hex(canonical({ callable, input }));
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
		const common = { key, digest, issuedAt: r.issuedAt, rate: r.rate ?? [] };
		const record = Effect.fn('Callables.recordOutcome')(function* (outcome: Outcome) {
			const answer = (yield* e.db.returning(
				CommitAnswer,
				compile_outcome_record(common, outcome)
			))[0];
			return none(answer?.outcome ?? outcome);
		});

		// a serialization failure replays the body once with the same clock and minted ids
		return yield* replayOnce<CallResult, import('../errors.ts').EngineError, never>(
			Effect.fn('Callables.replay')(function* (replay) {
				const rec: Recorder = { commits: [], pending: new Map(), guest: false };
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
					utf8Bytes(JSON.stringify(writes)) > LIMITS.changeSetBytes
				)
					return yield* record(refused('overflow', 'The batch exceeds its native change budget.'));
				const seen = new Set<string>();
				const twice = writes.find((w) => seen.size === seen.add(`${w.model}\u0000${w.id}`).size);
				if (twice !== undefined)
					return yield* record(
						refused(
							'invalid_input',
							`The batch writes ${twice.model} ${twice.id} twice; one act writes a row once.`
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
							'approval_split',
							'These changes need different approvals; submit them separately.'
						)
					);
				const resubmits = rec.commits.flatMap((planned) =>
					planned.commit.resubmit === undefined ? [] : [planned.commit.resubmit]
				);
				if (new Set(resubmits.map((resubmit) => resubmit.request)).size > 1)
					return yield* record(refused('approval_split', 'Save each approval request separately.'));
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

				const unchanged = rec.commits.flatMap((x) => x.commit.unchanged ?? []);
				const pieces = rec.commits.flatMap((x) => x.commit.pieces ?? []);
				const restored = rec.commits.flatMap((x) => x.commit.restored ?? []);
				const commit: Commit = {
					...common,
					now: r.bindings.now,
					today: r.bindings.today,
					actor,
					writer: writerOf(r.authority),
					writes,
					fingerprints: rec.commits.flatMap((x) => x.commit.fingerprints ?? []),
					...(r.readGuards === undefined ? {} : { readGuards: r.readGuards }),
					erasures,
					// each act's queued platform runs (a stale embedding's `bolt.embed`) commit with the batch
					runs: rec.commits.flatMap((x) => x.commit.runs),
					output: p.output,
					// every field a recorded act plans reaches the one statement, so a verb answers alike whoever calls it
					...(writes.length === 0 && unchanged.length > 0 ? { unchanged } : {}),
					...(restored.length === 0 ? {} : { restored }),
					...(pieces.length === 0 ? {} : { pieces: (c) => pieces.forEach((piece) => piece(c)) }),
					...(rec.commits.some((x) => x.commit.joined === true) ? { joined: true as const } : {}),
					...(approval === undefined ? {} : { approval }),
					...(resubmits[0] === undefined ? {} : { resubmit: resubmits[0] })
				};
				const lock = tables.length > 0 ? { tables, mode: 'SHARE ROW EXCLUSIVE' as const } : undefined;
				if (p.preview === true)
					return none(yield* dry_run(e.db, [yield* compileCommit(m, cat, commit)], lock, yield* constraintIndex(m)));
				if (log !== undefined) yield* log.emit('info', 'act.settled', { callable, writes: writes.length });
				const result = yield* Effect.result(
					executeCommit(
						e.db,
						m,
						cat,
						commit,
						lock
					)
				);
				if (Result.isFailure(result)) {
					const decision = decided(result.failure, yield* constraintIndex(m));
					const settle = decision.record
						? record(decision.outcome)
						: Effect.succeed(none(decision.outcome));
					// a keep upsert that lost a race to create its row replays and finds it kept
					const lost = decision.outcome.kind === 'refused' && decision.outcome.code === 'unique' &&
						rec.commits.some((x) => x.commit.kept === true);
					if (decision.replay || lost) return yield* replay(settle);
					return yield* settle;
				}
				return yield* settleCommit(result.success[0], stored, e.publish, {
					code: 'internal',
					message: 'the commit returned no answer'
				});
			})
		);
	});

	const input = r.outputs === undefined ? acts_json(r.acts) : { acts: acts_json(r.acts), outputs: r.outputs };
	if (r.acts.length !== 1 && (r.restored !== undefined || r.sync !== undefined))
		return Effect.fail(BoltError.make('invalid', 'decode', 'A restore or sync page is one act.'));
	// one authority admits, plans and queues a sync page's effects: the sync's workspace authority, outside any run
	if (r.sync !== undefined && (!r.authority.admin || r.authority.run !== undefined))
		return Effect.fail(BoltError.make('invalid', 'decode', 'A sync page is written as its sync, an admin outside any run.'));
	return atomic(
		{ ...r, input },
		r.name,
		input,
		Effect.fn('Callables.body')(function* (rec) {
			const roots = r.acts.reduce((count, act) => {
				if (EffectArray.isArray(act.input)) return count + act.input.length;
				if (!Predicate.isObject(act.input)) return count;
				const rows = act.verb === 'import' ? act.input['rows'] : act.verb === 'erase' ? act.input['target'] : undefined;
				return count + (EffectArray.isArray(rows) ? rows.length : rows === undefined ? 0 : 1);
			}, 0);
			if (roots > LIMITS.act.rows || utf8Bytes(JSON.stringify(input)) > LIMITS.act.inputBytes)
				return { outcome: refused('overflow', 'The batch exceeds its native input budget.'), guest: false };
			const previews = r.acts.filter((act) => act.verb === 'import' &&
				Predicate.isObject(act.input) && act.input['dry_run'] === true);
			const preview = previews.length > 0 && previews.length === r.acts.length;
			if (previews.length > 0 && !preview)
				return {
					outcome: refused('invalid_input', 'A dry-run import is previewed in a batch of dry runs only.'),
					guest: false
				};
			const invalid = r.acts.findIndex((act) =>
				act.verb === 'upsert' ? act.on_conflict === undefined : act.on_conflict !== undefined
			);
			if (invalid >= 0)
				return {
					outcome: refused(
						'invalid_input',
						'A batch upsert requires on_conflict; other verbs do not take it.',
						`${invalid}.on_conflict`
					),
					guest: false
				};
			// a writer-minted id is the only way a later act names a row an earlier one creates
			const ordered = r.acts.length > 1 && r.acts.some((act) => act.verb === 'create' &&
				EffectArray.isArray(act.input) && act.input.some((row) => Predicate.isObject(row) && typeof row['id'] === 'string'));
			const db = yield* coalescing(e.db, ordered ? undefined : r.acts.length);
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
						a.on_conflict,
						{
							db,
							into: (p) => {
								plans[i] = p;
							}
						},
						r
					).pipe(Effect.ensuring(db.done)),
				{ concurrency: ordered ? 1 : 'unbounded' }
			);
			const bad = outcomes.find((o) => o.kind !== 'committed');
			if (bad !== undefined) return { outcome: bad, guest: rec.guest && !preview };
			for (const p of plans) if (p !== undefined) rec.commits.push(p);
			const outputs = outcomes.map((outcome) => outcome.kind === 'committed' ? outcome.output : null);
			const output = r.outputs === undefined ? outputs
				: Object.fromEntries(r.outputs.map((name, index) => [name, outputs[index] ?? null]));
			return { output, ...(preview ? { preview: true as const } : {}) };
		})
	);
};

function makeCallables(config: CallablesConfig): CallablesShape {
	const e = config.engine,
		m = e.manifest,
		cat = catalog_of(m);
	// only manual starts (the `start` callable, Run now, the agent) come through here; cron and model effect
	// runs, and the acts a run's body performs, are never rate limited
	const starts = new RateWindows();
	const publish = (answer: CommitAnswer) =>
		committed(answer).pipe(
			Effect.provideService(Live, config.live),
			Effect.provideService(Wake, config.wake),
			Effect.provideService(Links, config.links)
		);

	/** Rule 33: a start or schedule needs the automation in `capabilities.automations`; its input decodes. */
	function startable(name: string, auth: Authority): Refused | null {
		if (auth.actor.kind === 'visitor') return refused('forbidden', 'Visitors may not start runs.');
		const spec = m.automations[name];
		if (spec === undefined) return refused('not_found', `'${name}' is not an automation.`);
		if (!auth.admin && !auth.automations.includes(name))
			return refused('forbidden', `You may not start '${name}'.`);
		return null;
	}

	const admitAutomation = Effect.fn('Callables.admitAutomation')(function* (
		r: Omit<AutomationRequest, 'input'> & { readonly inputs: readonly Json[] }
	): Effect.fn.Return<readonly Json[] | Refused, import('../errors.ts').EngineError> {
		if (!starts.charge([startCharge(r.automation, r.authority)], Date.parse(r.bindings.now)).ok)
			return refused('rate_limited', RATE_LIMITED);
		const inputs: Json[] = [];
		for (const input of r.inputs) {
			const no = startable(r.automation, r.authority);
			if (no !== null) return no;
			const spec = m.automations[r.automation];
			const decoded = spec === undefined ? undefined : decodeAutomationInput(spec.input, input);
			if (decoded !== undefined && decoded.problems.length > 0)
				return refused('invalid_input', problems(decoded), decoded.problems[0]?.path);
			const refs = decoded?.refs ?? [];
			if (refs.length > 0) {
				// an id input names a record the starter reads, in any output it holds (its view output)
				const found = yield* e.read(
					yield* Effect.forEach(refs, (ref) =>
						Effect.map(
							ir.read(cat, ref.model, {
								where:
									ref.where === undefined || Object.keys(ref.where).length === 0
										? { id: { eq: ref.id } }
										: { and: [{ id: { eq: ref.id } }, ref.where] },
								select: { id: true },
								limit: 1
							}),
							(read) => {
								const output = viewOutput(m, r.authority, ref.model);
								return read.kind === 'read' && output !== undefined ? { ...read, output } : read;
							}
						)
					),
					{ as: 'caller', authority: r.authority },
					r.bindings
				);
				const missing = refs.find((_, index) => {
					const page = found[index];
					const rows = Predicate.isObject(page) ? page['rows'] : undefined;
					return !EffectArray.isArray(rows) || rows.length === 0;
				});
				if (missing !== undefined)
					return refused('not_found', `No readable ${missing.model} has this id.`, missing.field);
			}
			inputs.push(decoded?.value === undefined ? input : decoded.value);
		}
		return inputs;
	});

	/** Both admissions use the same durable ids, capture, retry and wake protocol. */
	const queue = Effect.fn('Callables.queue')(function* (
		r: StartRequest
	): Effect.fn.Return<Outcome, import('../errors.ts').EngineError> {
		const first = r.runs[0];
		if (first === undefined)
			return refused('invalid_input', 'A start names at least one run.', 'runs');
		for (const run of r.runs)
			if (!UUID_PATTERN.test(run.id))
				return refused('invalid_input', 'A run id is a client-minted uuid.', 'id');
		const due = yield* Effect.try({
			try: () => scheduledAt(r.bindings.now),
			catch: (error) =>
				error instanceof BoltError ? error : BoltError.make('invalid_input', 'decode', String(error))
		});
		// the starter: a sync runs as them; an automation run records them as its trigger and runs as the system
		const starter = starterOf(r.authority),
			trigger = triggerOf(r.authority, r.agent ?? r.authority.agent);
		const actor = actor_ref(r.authority.actor);
		const chain = new Chain();
		const inserted = enqueue(
			chain,
			r.runs.map((run) => ({
				id: run.id,
				automation: r.automation,
				input: run.input,
				due_at: due,
				cause: 'start' as const,
				depth: 0,
				actor,
				starter,
				trigger
			})),
			{ conflict: 'keep' }
		);
		// each run is new, or the same run already queued (a retried start): any other id clash is a key reuse
		const result = yield* nativeCommit(e.db.write, config.live.publish, chain,
			Schema.Struct({
				...CapturedResult.fields,
				created: Schema.Number,
				same: Schema.Number,
				next_due: Schema.NullOr(Schema.String)
			}),
				`(SELECT count(*)::int FROM ${inserted}) AS created, (SELECT count(*)::int FROM sys_run s JOIN jsonb_to_recordset(${chain.p(r.runs.map((run) => ({ id: run.id, input: run.input })))}::jsonb) x(id text, input jsonb) ON s.id = x.id WHERE s.automation = ${chain.p(r.automation)} AND s.actor = ${chain.p(actor)} AND s.input = x.input) AS same, ${next_due(chain)} AS next_due`
		);
		if (result.next_due !== null)
			yield* config.wake.at(result.next_due);
		return result.created + result.same === r.runs.length
			? {
					kind: 'committed',
					output: { id: first.id, automation: r.automation, ids: r.runs.map((run) => run.id) },
					records: []
				}
			: KEY_REUSE;
	});
	const start = Effect.fn('Callables.start')(function* (r: StartRequest) {
		if (m.automations[r.automation]?.mode === 'call')
			return refused('invalid_input', 'Call-mode automations execute in the request.');
		const admitted = yield* admitAutomation({ ...r, inputs: r.runs.map((run) => run.input) });
		if ('kind' in admitted) return admitted;
		const runs: StartRequest['runs'][number][] = [];
		for (const [index, run] of r.runs.entries()) {
			const input = admitted[index];
			if (input === undefined)
				return yield* BoltError.make('internal', 'admission', 'The admitted run has no input.');
			runs.push({ ...run, input });
		}
		return yield* queue({ ...r, runs });
	});
	const sync_control = Effect.fn('Callables.sync_control')(function* (r: SyncControlRequest) {
		if (r.authority.actor.kind !== 'member')
			return refused('forbidden', 'Only members may use manual sync controls.');
		const entry = m.exposures[r.model]?.syncs?.[r.sync];
		if (entry === undefined) return refused('not_found', 'This model has no such sync.');
		const automation = `${r.model}.sync.${r.sync}`;
		if (!starts.charge([startCharge(automation, r.authority)], Date.parse(r.bindings.now)).ok)
			return refused('rate_limited', RATE_LIMITED);
		let input: Json;
		if (entry.with === 'file') {
			if (!fileSyncAdmits(r.authority, r.model, r.input))
				return refused('forbidden', `You may not transfer '${r.model}'.`);
			const decoded = yield* Effect.result(Schema.decodeUnknownEffect(FileSyncInput, { onExcessProperty: 'error' })(r.input));
			if (Result.isFailure(decoded)) return refused('invalid_input', decoded.failure.message);
			input = decoded.success;
		} else {
			if (entry.read !== true || !readsAny(r.authority, r.model) ||
				(!r.authority.admin && !r.authority.capabilities.syncs.includes(`${r.model}.${r.sync}`)))
				return refused('forbidden', `You may not refresh '${r.model}.${r.sync}'.`);
			const decoded = decodeInput(
				{ instance: { kind: 'text', optional: true }, partition: { kind: 'text', optional: true } }, r.input
			);
			if (decoded.problems.length > 0)
				return refused('invalid_input', problems(decoded), decoded.problems[0]?.path);
			input = decoded.value ?? r.input;
		}
		return yield* queue({
			automation, runs: [{ id: r.id, input }], authority: r.authority, bindings: r.bindings,
			...(r.agent === undefined ? {} : { agent: r.agent })
		});
	});

	return {
		admitAutomation,
		sync_control: (request: SyncControlRequest) => audited(
			e.db,
			{
				category: 'automation', action: `${request.model}.${request.sync}.sync_control`,
				actor: auditActor(request.authority.actor), payload: { model: request.model, sync: request.sync, id: request.id, input: request.input }
			},
			sync_control(request)
		),
		acts: (request: ActsRequest) =>
			Effect.scoped(Effect.gen(function* () {
				const log = yield* config.telemetry.open({ invocation: request.invocationId });
				// whether the batch sent a statement that may carry its audit receipt: a refusal decided before any
				// statement settles its audit operation without reading the tenant
				let issued = false;
				const tracked = TenantDb.typed({
					...e.db,
					write: (statement, lock) => Effect.suspend(() => {
						issued = true;
						return e.db.write(statement, lock);
					}),
					transaction: (batch) => Effect.suspend(() => {
						issued = true;
						return e.db.transaction(batch);
					})
				});
				return yield* audited(
				e.db,
				{
					category: 'write',
					// named after its writes (`orders.update`), each distinct model and verb once
					action: [...new Set(request.acts.map((a) => `${a.model}.${a.verb}`))].join(', '),
					actor: auditActor(request.authority.actor),
					invocation: request.invocationId,
					payload: acts_json(request.acts),
					outcomeKey: sha256_hex(
						`${canonical({ actor: request.authority.actor.kind === 'member' ? request.authority.actor.id : request.authority.actor, callable: request.name })}\u0000${request.key}`
					),
					digest: sha256_hex(canonical({ callable: request.name, input: request.outputs === undefined ? request.acts : { acts: request.acts, outputs: request.outputs } }))
				},
				commitActs({ ...e, db: tracked, v: config.live.v, publish }, request, log),
				() => issued
			);
			})),
		start: (request: StartRequest) =>
			audited(
				e.db,
				{
					category: 'automation',
					action: `${request.automation}.start`,
					actor: auditActor(request.authority.actor),
					payload: { automation: request.automation, runs: request.runs }
				},
				start(request)
			)
	};
}

// ── visitors and what an outcome may say to whom ──

/** The surfaces a visitor request may reach: `read`/`get` of granted reads and generated `create` only. */
type Surface = { read: string } | { act: string; verb: string } | { other: string };
export function admit_visitor(auth: Authority, s: Surface): Refused | null {
	if (auth.actor.kind !== 'visitor') return null;
	const ok =
		'read' in s
			? readsAny(auth, s.read)
			: 'act' in s
				? s.verb === 'create' && (auth.models[s.act]?.create.length ?? 0) > 0
				: false;
	return ok ? null : refused('forbidden', 'Visitors may not do this.');
}
/**
 * Rule 32: only `ctx.refuse` and mapped constraint messages reach members; public and API-key actors receive codes
 * only. Rule 38d (d): a visitor gets codes and messages, and a proposed create no request id.
 */
export function for_actor(
	o: Outcome,
	actor: EngineActor
): Outcome | { kind: 'pending_approval'; records: import('../contracts.ts').Written } {
	if (o.kind === 'refused' && (actor.kind === 'envoy' || actor.kind === 'api_key'))
		return { kind: 'refused', code: o.code, message: o.code };
	if (o.kind === 'pending_approval' && actor.kind === 'visitor')
		return { kind: 'pending_approval', records: o.records };
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
			links = yield* Links,
			telemetry = yield* Telemetry;
		const native: WriteEngine & { read: ReadsShape['run'] } = {
			manifest,
			db,
			guest,
			approval: approval_hook(manifest, db, live.publish),
			bridge: (invocation, over = db) => transformBridge(manifest, over, invocation),
			read: reader.run
		};
		const callables = makeCallables({
			engine: native,
			live,
			wake,
			links,
			telemetry
		});
		return Callables.of({
			admitAutomation: callables.admitAutomation,
			sync_control: (request) => callables.sync_control(request).pipe(Effect.provideService(Audit, audit)),
			acts: (request) => callables.acts(request).pipe(Effect.provideService(Audit, audit)),
			start: (request) => callables.start(request).pipe(Effect.provideService(Audit, audit))
		});
	})
);
