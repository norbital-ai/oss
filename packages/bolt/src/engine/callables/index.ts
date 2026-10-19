// Collection queries and actions, and run starts (rules 31, 33, 33a, 38d, 51): each reachable only by policy. A query is
// a `/q` read: one guest invocation reading as its caller, nothing recorded. An action is one act: its body runs in one
// invocation per target (reads as its caller), every `ctx.act` it makes passes the generated-verb pipeline as the caller
// and is recorded, not written (`sink`), and the recorded writes, `ctx.schedule` runs and `ctx.notify` rows commit in the
// action's one statement under its idempotency key; a refusal after guest code is the outcome record (rule 20). `start`
// is one `sys_run` insert keyed by the client-minted run id.
import { Effect, Layer, Option, Predicate, Result, Schema } from 'effect';
import { encodeWire } from '@norbital-ai/std/wire';
import { TenantDb, type TenantDbShape } from '../db/tenant-db.ts';
import {
	Activation,
	Callables,
	Guest,
	Live,
	Manifest,
	Reads,
	Wake,
	Links,
	type Bridge,
	type CrossCall,
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
import type { ReadIR } from '../../protocol/ir-types.ts';
import { enqueue, nextDue } from '../runs/queue.ts';
import { dueAt as roundedDueAt, offsetMs } from '../runs/time.ts';
import { readEngine } from '../query/engine.ts';
import { approvalHook } from '../approvals/approvals.ts';
import { collectionNotices } from '../notifications/rules.ts';
import { Outcome as importedOutcome } from '../../protocol/schema.ts';
import { replayOnce } from '../write/replay.ts';
import { delegatedVerbAuthority, type AutomationDelegation } from '../access/delegation.ts';
import type { Json } from '../../decl/values.ts';
import {
	LIMITS,
	type Authority,
	type Bindings,
	type CrossAnswer,
	type EngineActor,
	type Invocation,
	type NoticeRow,
	type Outcome,
	type RowData
} from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';
import { catalogOf } from '../access/pred.ts';

import * as ir from '../../protocol/ir.ts';
import { constraintIndex } from '../schema/ddl.ts';
import { schemaSlice } from '../schema/plan.ts';
import { coalescing, memoReads } from '../query/engine.ts';
import { act, transformBridge, type Verb, type WriteEngine } from '../write/act.ts';
import {
	actorId,
	actorRef,
	compileCommit,
	compileOutcomeRecord,
	CommitAnswer,
	committed,
	type Commit,
	type RateCharge
} from '../write/commit.ts';
import {
	canonical,
	Chain,
	decided,
	fingerprinting,
	KEY_REUSE,
	minter,
	sha256Hex,
	storedOutcome,
	type Fingerprint
} from '../write/sql.ts';
import { decodeInput, type Decoded, type InputSpec } from './decode.ts';

type Caller = CallerContext & {
	delegation?: AutomationDelegation | undefined;
};
type Sink = (planned: PlannedCommit) => void;
type ActionRequest = Caller & {
	collection: string;
	action: string;
	input: Json;
	key: string;
	issuedAt: string;
	retry?: boolean | undefined;
	rate?: readonly RateCharge[] | undefined;
	sink?: Sink | undefined;
};
type ActsRequest = Caller & {
	name: string;
	acts: readonly { collection: string; verb: Verb; input: Json }[];
	key: string;
	issuedAt: string;
	sink?: Sink | undefined;
};
type QueryRequest = Caller & { collection: string; query: string; input: Json };
type CallablesConfig = {
	engine: WriteEngine & { read: ReadsShape['run'] };
	guest: GuestShape;
	reads: (db: TenantDbShape) => ReadsShape['run'];
	live: ShapeOf<typeof Live>;
	wake: ShapeOf<typeof Wake>;
	links: ShapeOf<typeof Links>;
};

type Refused = Extract<Outcome, { kind: 'refused' }>;
type Planned = PlannedCommit;
/** What one action act has recorded so far; nested `ctx.act` actions record into their caller's. */
type Recorder = {
	commits: Planned[];
	runs: Commit['runs'][number][];
	notices: (NoticeRow & { id: string })[];
	refusals: Map<string, Outcome>;
	issuedAt: string;
	db: TenantDbShape;
	reads: ReadsShape['run'];
	fingerprints: () => readonly Fingerprint[];
	tables: Set<string>;
	/** Rows created by earlier `ctx.act` calls of this act, readable as refs by later ones (keyed `collection␀id`). */
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
const split = (callable: string) => {
	const dot = callable.lastIndexOf('.');
	return [callable.slice(0, dot), callable.slice(dot + 1)] as const;
};

/** Rules 33, 33a, 38d: a declared callable, reachable by this caller from this entry. */
function reach(
	m: EngineManifest,
	auth: Authority,
	c: string,
	part: 'queries' | 'actions',
	name: string,
	from: Entry
): Refused | null {
	const spec = m.collections[c]?.[part]?.[name];
	if (spec === undefined)
		throw BoltError.make(
			'unknownCallable',
			'decode',
			`'${c}.${name}' is not a declared ${part === 'queries' ? 'query' : 'action'}`
		);
	if (auth.actor.kind === 'visitor') return refused('forbidden', 'Visitors may not call this.');
	if ('internal' in spec && spec.internal === true && from === 'Client')
		return refused('forbidden', `'${c}.${name}' is callable only from server code.`);
	return auth.admin || (auth.collections[c]?.[part] ?? []).includes(name)
		? null
		: refused('forbidden', `You may not call '${c}.${name}'.`);
}

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
		collection = callable.slice(0, dot),
		member = callable.slice(dot + 1);
	const verb = VERBS.find((verb) => verb === member);
	if (verb !== undefined && manifest.collections[collection] !== undefined)
		return Result.succeed({ _tag: 'Verb', collection, verb });
	if (manifest.collections[collection]?.actions?.[member] !== undefined)
		return Result.succeed({ _tag: 'Action', collection, action: member });
	if (member === 'pipeline' && manifest.pipelines[collection] !== undefined)
		return Result.succeed({ _tag: 'Pipeline', collection });
	if (manifest.integrations[collection]?.feeds?.[member] !== undefined)
		return Result.succeed({ _tag: 'Feed', integration: collection, feed: member });
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
	const constraints = constraintIndex(schemaSlice(m));

	const read = Effect.fn('Callables.read')(function* (
		batch: readonly ReadIR[],
		c: Caller,
		rec: Recorder | null
	): Effect.fn.Return<readonly Json[], import('../errors.ts').EngineError> {
		for (const r of batch) if (rec !== null && 'collection' in r) rec.tables.add(r.collection);
		return yield* (rec?.reads ?? e.read)(
			batch,
			{ as: 'caller', authority: c.authority },
			c.bindings
		);
	});

	/** Rule 36: every ref the input names must be readable by the caller, before any guest code. */
	const unreadable = Effect.fn('Callables.unreadable')(function* (
		refs: Decoded['refs'],
		c: Caller,
		rec: Recorder | null = null
	): Effect.fn.Return<Refused | null, import('../errors.ts').EngineError> {
		if (refs.length === 0) return null;
		const rows = yield* read(
			refs.map((ref) => ir.get(cat, ref.collection, ref.id, {})),
			c,
			rec
		).pipe(Effect.catch(() => Effect.succeed(refs.map(() => null))));
		const i = rows.findIndex((r) => r === null);
		return i < 0
			? null
			: refused('notFound', `No readable ${refs[i]!.collection} has this id.`, refs[i]!.field);
	});

	const invoke = Effect.fn('Callables.invoke')(function* (
		kind: 'query' | 'action',
		target: string,
		input: Json,
		c: Caller,
		id: string,
		rec: Recorder | null,
		row?: Json
	): Effect.fn.Return<import('../contracts.ts').GuestOutcome, import('../errors.ts').EngineError> {
		const decodedRow =
			row === undefined
				? undefined
				: yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(row).pipe(
						Effect.mapError((error) => BoltError.make('internal', 'decode', error.message))
					);
		const inv: Invocation = {
			id,
			kind,
			target,
			input,
			ctx: {
				actor: c.authority.actor,
				policies: c.authority.policies,
				admin: c.authority.admin,
				now: c.bindings.now,
				today: c.bindings.today,
				tz: c.bindings.tz,
				seed: id,
				...(decodedRow === undefined ? {} : { row: decodedRow })
			},
			budget: {
				cpuMs: LIMITS.guestCpuMs,
				crossings: LIMITS.crossings.sync,
				readBytes: LIMITS.readBytes
			}
		};
		return yield* guest.invoke(inv, bridge(c, id, rec, kind === 'action'));
	});

	/** Reads as the caller (rule 15), one round trip per crossing; inside an action, `act`/`schedule`/`notify` are recorded. */
	function bridge(c: Caller, id: string, rec: Recorder | null, writable: boolean): Bridge {
		let n = 0;
		const one = Effect.fn('Callables.crossOne')(function* (
			call: CrossCall,
			sub: string
		): Effect.fn.Return<CrossAnswer, import('../errors.ts').EngineError> {
			if (call._tag === 'read' && call.read.kind === 'query') {
				const queryRead = call.read;
				return {
					ok: true,
					value: yield* query(
						{
							...c,
							from: 'Server',
							invocationId: sub,
							collection: queryRead.collection,
							query: queryRead.query,
							input: queryRead.input
						},
						rec
					)
				};
			}
			if (rec === null || !writable)
				return fail(
					'unsupported',
					`a collection query cannot ${call._tag}; queue an automation (rule 31)`
				);
			switch (call._tag) {
				case 'act':
					return {
						ok: true,
						value: yield* recordAct(
							call.callable,
							call.input,
							{
								...c,
								observed: { ...call.options?.observed, ...c.observed },
								from: 'Server',
								invocationId: sub
							},
							rec,
							call.options?.onConflict
						)
					};
				case 'acts': {
					const output: Json[] = [];
					for (const act of call.acts) {
						const result = yield* recordAct(
							act.callable,
							act.input,
							{ ...c, from: 'Server', invocationId: sub },
							rec
						);
						if (result.kind !== 'committed') return { ok: true, value: result };
						output.push(result.output);
					}
					return { ok: true, value: { kind: 'committed', output, records: [] } };
				}
				case 'notify': {
					const Notice = Schema.Struct({
						to: Schema.Json,
						title: Schema.String,
						body: Schema.optionalKey(Schema.String),
						link: Schema.optionalKey(
							Schema.Struct({ collection: Schema.String, id: Schema.String })
						),
						once: Schema.optionalKey(Schema.String)
					});
					const notes = yield* Schema.decodeUnknownEffect(Schema.Array(Notice))(
						Array.isArray(call.notices) ? call.notices : [call.notices]
					).pipe(
						Effect.mapError((error) => BoltError.make('invalidInput', 'decode', error.message))
					);
					const mint = minter(sub, c.bindings.now);
					rec.notices.push(...notes.map((note) => ({ ...note, id: mint() })));
					return { ok: true, value: null };
				}
				case 'schedule':
					return yield* schedule(call, c, sub, rec);
				default:
					return fail(
						'unsupported',
						`a collection action cannot ${call._tag}; queue an automation (rule 31)`
					);
			}
		});
		return {
			cross: Effect.fn('Callables.cross')(function* (calls) {
				const plain = calls.flatMap((call) =>
					call._tag === 'read' && call.read.kind !== 'query' ? [call.read] : []
				);
				const answers = yield* read(plain, c, rec).pipe(
					Effect.match({
						onSuccess: (values) => values.map((value): CrossAnswer => ({ ok: true, value })),
						onFailure: (error) => plain.map(() => failed(error))
					})
				);
				let at = 0;
				const output: CrossAnswer[] = [];
				for (const call of calls)
					output.push(
						call._tag === 'read' && call.read.kind !== 'query'
							? (answers[at++] ?? fail('internal', 'a read answer is missing'))
							: yield* one(call, `${id}/${n++}`).pipe(
									Effect.catch((error) => Effect.succeed(failed(error)))
								)
					);
				return output;
			})
		};
	}

	/** `ctx.schedule` inside an action: a queued-run piece of the act's statement (rule 49), started as the caller (rule 33). */
	const schedule = Effect.fn('Callables.schedule')(function* (
		x: Extract<CrossCall, { _tag: 'schedule' }>,
		c: Caller,
		sub: string,
		rec: Recorder
	): Effect.fn.Return<CrossAnswer, import('../errors.ts').EngineError> {
		const no = startable(x.automation, c.authority, x.input);
		if (no !== null) {
			rec.refusals.set(no.message, no);
			return { ok: false, error: { kind: 'refused', code: no.code, message: no.message } };
		}
		const spec = m.automations[x.automation];
		const key =
			x.key === undefined
				? undefined
				: spec?.runAs === 'trigger'
					? `${actorRef(c.authority.actor)}\u0000${x.key}`
					: x.key;
		const id = minter(sub, c.bindings.now)();
		const due = yield* Effect.try({
			try: () => scheduledAt(c.bindings.now, x.at),
			catch: (error) =>
				error instanceof BoltError ? error : BoltError.make('invalidInput', 'decode', String(error))
		});
		rec.runs.push({
			id,
			automation: x.automation,
			input: x.input,
			dueAt: due,
			cause: 'schedule',
			depth: 0,
			actor: actorRef(c.authority.actor),
			...(spec?.runAs === 'trigger' ? { starter: starterOf(c.authority) } : {}),
			...(key === undefined ? {} : { key })
		});
		return { ok: true, value: { id, automation: x.automation } };
	});

	/** Rule 33: a start or schedule needs the automation in `policy.automations`; its input decodes (rule 23). */
	function startable(name: string, auth: Authority, input: Json): Refused | null {
		const [c, v] = split(name);
		const pipe = v === 'pipeline' ? m.pipelines[c] : undefined;
		// a feed run (`<def>.<feed>`, §4.1) takes no input
		const spec: { readonly input?: InputSpec | undefined } | undefined =
			m.integrations[c]?.feeds?.[v] !== undefined
				? { input: {} }
				: pipe !== undefined
					? {
							input: {
								mode: {
									kind: 'enum',
									values: [
										...(pipe.import === undefined ? [] : ['import', 'template']),
										...(pipe.export === undefined ? [] : ['export'])
									]
								},
								file: { kind: 'text', optional: true },
								accept: { kind: 'bool', optional: true },
								context: { kind: 'json', optional: true }
							}
						}
					: m.automations[name];
		if (spec === undefined) return refused('notFound', `'${name}' is not an automation.`);
		if (auth.actor.kind === 'visitor') return refused('forbidden', 'Visitors may not start runs.');
		// a pipeline is gated by the caller's grants on its collection (§3.3.5: its rows enter as the caller); the act judges each row again
		if (pipe !== undefined) {
			const g = auth.collections[c],
				mode = Predicate.isObject(input) ? input['mode'] : undefined;
			if (
				!auth.admin &&
				(mode === 'export' ? (g?.read.length ?? 0) === 0 : (g?.create.length ?? 0) === 0)
			)
				return refused('forbidden', `You may not ${String(mode)} ${c}.`);
		} else if (!auth.admin && !auth.automations.includes(name))
			return refused('forbidden', `You may not start '${name}'.`);
		const d = decodeInput(spec.input, input);
		return d.problems.length > 0 ? refused('invalidInput', problems(d), d.problems[0]!.path) : null;
	}

	/** One generated verb through the act pipeline, its planned commit recorded (`sink`), its creates readable by later acts. */
	const recordVerb = Effect.fn('Callables.recordVerb')(function* (
		collection: string,
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
				collection,
				verb,
				input,
				key: c.invocationId,
				issuedAt: rec.issuedAt,
				authority: delegatedVerbAuthority(m, c.authority, c.delegation, `${collection}.${verb}`),
				observed: c.observed,
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
								rec.pending.set(`${write.collection}\u0000${write.id}`, {
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
					collection: write.collection,
					id: write.id,
					revision: write.op === 'create' ? 1 : write.revision + 1
				}))
			};
		return result.outcome;
	});

	/** One `ctx.act` inside an action: a generated verb through the act pipeline with `sink`, or a nested action. */
	const recordAct = Effect.fn('Callables.recordAct')(function* (
		callable: Callable | string,
		input: Json,
		c: Caller,
		rec: Recorder,
		onConflict?: 'update' | 'keep'
	): Effect.fn.Return<Outcome, import('../errors.ts').EngineError> {
		const parsed =
			typeof callable === 'string' ? parseCallable(callable, m) : Result.succeed(callable);
		if (Result.isFailure(parsed)) return yield* Effect.fail(parsed.failure);
		const target = parsed.success;
		let outcome: Outcome;
		if (target._tag === 'Verb')
			outcome = yield* recordVerb(target.collection, target.verb, input, c, rec, onConflict);
		else if (target._tag === 'Action') {
			const result = yield* perform(
				{
					...c,
					collection: target.collection,
					action: target.action,
					input,
					key: c.invocationId,
					issuedAt: rec.issuedAt
				},
				rec
			);
			if ('error' in result) return yield* Effect.fail(result.error);
			outcome =
				'output' in result
					? { kind: 'committed', output: result.output, records: [] }
					: result.outcome;
		} else
			return refused('forbidden', 'An action may record only a generated verb or another action.');
		if (outcome.kind === 'refused') rec.refusals.set(outcome.message, outcome);
		else if (outcome.kind !== 'committed' && outcome.kind !== 'pendingApproval')
			rec.refusals.set(JSON.stringify(outcome), outcome);
		return outcome;
	});

	/** The body of one action, once per target, recording into `rec`; `guest` says whether a refusal came after guest code. */
	const perform = Effect.fn('Callables.perform')(function* (
		r: ActionRequest,
		rec: Recorder
	): Effect.fn.Return<Performed, import('../errors.ts').EngineError> {
		const no = yield* Effect.try({
			try: () => reach(m, r.authority, r.collection, 'actions', r.action, r.from),
			catch: (error) =>
				error instanceof BoltError ? error : BoltError.make('internal', 'decode', String(error))
		});
		if (no !== null) return { outcome: no, guest: false };
		const spec = m.collections[r.collection]?.actions?.[r.action];
		if (spec === undefined)
			return yield* Effect.fail(
				BoltError.make(
					'unknownCallable',
					'decode',
					`'${r.collection}.${r.action}' is not a declared action`
				)
			);
		const record = spec.target === 'record';
		const arg =
			(record ? (Predicate.isObject(r.input) ? r.input['input'] : undefined) : r.input) ?? null;
		const d = decodeInput(spec.input, arg);
		if (d.problems.length > 0)
			return { outcome: refused('invalidInput', problems(d), d.problems[0]!.path), guest: false };
		const bad = yield* unreadable(d.refs, r, rec);
		if (bad !== null) return { outcome: bad, guest: false };
		const target = record && Predicate.isObject(r.input) ? r.input['target'] : undefined;
		let ids: readonly (string | undefined)[] = [undefined];
		let rows: readonly Json[] = [];
		if (record) {
			const decodedIds = Schema.decodeUnknownResult(
				Schema.Array(Schema.String).check(Schema.isMinLength(1))
			)(Array.isArray(target) ? target : [target]);
			if (Result.isFailure(decodedIds))
				return {
					outcome: refused('invalidInput', 'target: expected an id or a list of ids', 'target'),
					guest: false
				};
			ids = decodedIds.success;
			rows = yield* read(
				decodedIds.success.map((id) => ir.get(cat, r.collection, id, {})),
				r,
				rec
			).pipe(Effect.catch(() => Effect.succeed(decodedIds.success.map(() => null))));
			if (rows.includes(null))
				return {
					outcome: refused('notFound', 'The record does not exist.', 'target'),
					guest: false
				};
		}
		const outputs: Json[] = [];
		for (const [i] of ids.entries()) {
			const g = yield* invoke(
				'action',
				`${r.collection}.${r.action}`,
				encodeWire(d.value),
				r,
				ids.length > 1 ? `${r.invocationId}/${i}` : r.invocationId,
				rec,
				rows[i]
			);
			if (g.kind === 'failed')
				return g.error.code === 'readBudgetExceeded'
					? { outcome: refused('readBudgetExceeded', g.error.message), guest: true }
					: { error: g.error };
			if (g.kind === 'refused')
				return {
					outcome: rec.refusals.get(g.message) ?? {
						...refused('refused', g.message, g.field),
						rule: `${r.collection}.${r.action}`
					},
					guest: true
				};
			outputs.push(g.output);
		}
		const notification = yield* Effect.result(
			Effect.gen(function* () {
				const decodedRows = yield* Schema.decodeUnknownEffect(
					Schema.Array(Schema.Record(Schema.String, Schema.Json))
				)(rows).pipe(
					Effect.mapError((error) => BoltError.make('internal', 'decode', error.message))
				);
				const records = decodedRows.flatMap((values) => {
					return typeof values['id'] === 'string' ? [{ id: values['id'], values }] : [];
				});
				rec.notices.push(
					...(yield* collectionNotices(guest, m, {
						collection: r.collection,
						event: 'committed',
						records: records.map((x) => ({ ...x, action: r.action })),
						requestor: r.authority.actor.kind === 'member' ? r.authority.actor.id : null,
						approvers: [],
						actor: r.authority.actor,
						bindings: r.bindings,
						id: (() => {
							const mint = minter(`${r.invocationId}:action-notices`, r.bindings.now);
							return () => mint();
						})(),
						named: r.action
					}))
				);
			})
		);
		if (Result.isFailure(notification))
			return {
				error:
					notification.failure instanceof BoltError
						? notification.failure
						: BoltError.make(
								'guestError',
								'guest',
								'invalid action notification',
								notification.failure
							)
			};
		return { output: record && Array.isArray(target) ? outputs : (outputs[0] ?? null) };
	});

	const query = (
		request: QueryRequest,
		recorder: Recorder | null = null
	): Effect.Effect<Json, import('../errors.ts').EngineError> =>
		readQuery(
			{
				manifest: m,
				guest,
				read: (batch, reader, bindings) => read(batch, { ...request, bindings }, recorder)
			},
			request
		);

	const action = (
		r: ActionRequest
	): Effect.Effect<CallResult, import('../errors.ts').EngineError> =>
		atomic(r, `${r.collection}.${r.action}`, r.input, (rec) => perform(r, rec));
	/** Each act records into the one commit; the first that does not commit is the outcome, recorded (it ran guest code). */
	/**
	 * Each act records into the one commit; the first (in order) that does not commit is the outcome, recorded (it ran
	 * guest code). The acts are planned at once over one coalesced reader — one round trip, one statement per step for
	 * the whole batch — so they are independent: one names no row another creates (rule 36 sees the stored rows).
	 */
	const acts = (r: ActsRequest): Effect.Effect<CallResult, import('../errors.ts').EngineError> =>
		atomic(
			{ ...r, input: r.acts },
			r.name,
			r.acts,
			Effect.fn('Callables.body')(function* (rec) {
				const db = yield* coalescing(e.db, r.acts.length);
				const plans: (Recorder['commits'][number] | undefined)[] = r.acts.map(() => undefined);
				// each act its own invocation: its minted ids are its own (two creates of one collection mint apart)
				const outcomes = yield* Effect.forEach(
					r.acts,
					(a, i) =>
						recordVerb(
							a.collection,
							a.verb,
							a.input,
							{ ...r, invocationId: `${r.invocationId}/${i}` },
							rec,
							undefined,
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
		// One action owns its first read answers across replay, including generated child verbs.
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
				const fp = fingerprinting(db);
				const rec: Recorder = {
					commits: [],
					runs: [],
					notices: [],
					refusals: new Map(),
					issuedAt: r.issuedAt,
					db,
					pending: new Map(),
					reads: config.reads(fp.db),
					fingerprints: fp.fingerprints,
					tables: new Set()
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
					return yield* record(refused('overflow', 'The action exceeds its native change budget.'));
				const seen = new Set<string>();
				const twice = writes.find(
					(w) => seen.size === seen.add(`${w.collection}\u0000${w.id}`).size
				);
				if (twice !== undefined)
					return yield* record(
						refused(
							'invalidInput',
							`The action writes ${twice.collection} ${twice.id} twice; one act writes a row once (rule 21).`
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
				const tables = [
					...new Set([...rec.tables, ...rec.commits.flatMap((x) => x.lock?.tables ?? [])])
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
					fingerprints: [
						...rec.fingerprints(),
						...rec.commits.flatMap((x) => x.commit.fingerprints ?? [])
					],
					erasures,
					runs: rec.runs,
					notices: [...rec.notices, ...rec.commits.flatMap((x) => x.commit.notices)],
					output: p.output,
					...(approval === undefined ? {} : { approval })
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
							collection: write.collection,
							id: write.id,
							revision: write.op === 'create' ? 1 : write.revision + 1
						}))
					});
				}
				const result = yield* Effect.result(
					e.db.returning(
						CommitAnswer,
						compileCommit(m, cat, commit),
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
				return { outcome, captured: answer.captured, v };
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
			(Result.isSuccess(parsed) && parsed.success._tag === 'Pipeline')
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

	return { query, action, acts, start };
}

// ── visitors (rule 38d, §3.9) and what an outcome may say to whom (rule 32) ──

/** The surfaces a visitor request may reach (rule 38d (a)): `read`/`get` of granted reads and generated `create` only. */
type Surface = { read: string } | { act: string; verb: string } | { other: string };
export function admitVisitor(auth: Authority, s: Surface): Refused | null {
	if (auth.actor.kind !== 'visitor') return null;
	const ok =
		'read' in s
			? (auth.collections[s.read]?.read.length ?? 0) > 0
			: 'act' in s
				? s.verb === 'create' && (auth.collections[s.act]?.create.length ?? 0) > 0
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
			db = yield* TenantDb,
			guest = yield* Guest,
			activation = yield* Activation,
			reader = yield* Reads;
		const live = yield* Live,
			wake = yield* Wake,
			links = yield* Links;
		const native: WriteEngine & { read: ReadsShape['run'] } = {
			manifest,
			db,
			guest,
			transforms: activation.transforms,
			approval: approvalHook(manifest, db, guest),
			bridge: (invocation, over = db) => transformBridge(manifest, over, invocation),
			read: reader.run
		};
		return Callables.of(
			makeCallables({
				engine: native,
				guest,
				live,
				wake,
				links,
				reads: (db) => readEngine({ manifest, db }).run
			})
		);
	})
);

/** The query path shared with ReadsLive; explicit read recursion avoids a Reads/Callables layer cycle. */
export const readQuery = Effect.fn('Callables.readQuery')(function* (
	config: {
		readonly manifest: EngineManifest;
		readonly guest: GuestShape;
		readonly read: ReadsShape['run'];
	},
	request: import('../services.ts').QueryRequest
): Effect.fn.Return<Json, import('../errors.ts').EngineError> {
	const m = config.manifest,
		cat = catalogOf(m);
	const no = yield* Effect.try({
		try: () =>
			reach(m, request.authority, request.collection, 'queries', request.query, request.from),
		catch: (error) =>
			error instanceof BoltError ? error : BoltError.make('internal', 'decode', String(error))
	});
	if (no !== null) return yield* Effect.fail(BoltError.make(no.code, 'admission', no.message));
	const spec = m.collections[request.collection]?.queries?.[request.query];
	if (spec === undefined)
		return yield* Effect.fail(
			BoltError.make(
				'unknownCallable',
				'decode',
				`'${request.collection}.${request.query}' is not a declared query`
			)
		);
	const decoded = decodeInput(spec.input, request.input);
	if (decoded.problems.length > 0)
		return yield* Effect.fail(BoltError.make('invalidInput', 'decode', problems(decoded)));
	if (decoded.refs.length > 0) {
		const refs = yield* config
			.read(
				decoded.refs.map((ref) => ir.get(cat, ref.collection, ref.id)),
				{ as: 'caller', authority: request.authority },
				request.bindings
			)
			.pipe(Effect.catch(() => Effect.succeed(decoded.refs.map(() => null))));
		const missing = refs.findIndex((row) => row === null),
			ref = decoded.refs[missing];
		if (ref !== undefined)
			return yield* Effect.fail(
				BoltError.make(
					'notFound',
					'admission',
					`${ref.field}: No readable ${ref.collection} has this id.`
				)
			);
	}
	let nested = 0;
	const bridge: Bridge = {
		cross: Effect.fn('Callables.queryCross')(function* (calls) {
			const reads = calls.flatMap((call) =>
				call._tag === 'read' && call.read.kind !== 'query' ? [call.read] : []
			);
			const plain = yield* config
				.read(reads, { as: 'caller', authority: request.authority }, request.bindings)
				.pipe(
					Effect.match({
						onSuccess: (values) => values.map((value): CrossAnswer => ({ ok: true, value })),
						onFailure: (error) => reads.map(() => failed(error))
					})
				);
			let at = 0;
			const answers: CrossAnswer[] = [];
			for (const call of calls) {
				if (call._tag === 'read' && call.read.kind !== 'query')
					answers.push(plain[at++] ?? fail('internal', 'a read answer is missing'));
				else if (call._tag === 'read' && call.read.kind === 'query') {
					const read = call.read;
					answers.push(
						yield* readQuery(config, {
							...request,
							collection: read.collection,
							query: read.query,
							input: read.input,
							from: 'Server',
							invocationId: `${request.invocationId}/${nested++}`
						}).pipe(
							Effect.match({
								onSuccess: (value): CrossAnswer => ({ ok: true, value }),
								onFailure: failed
							})
						)
					);
				} else
					answers.push(
						fail(
							'unsupported',
							`a collection query cannot ${call._tag}; queue an automation (rule 31)`
						)
					);
			}
			return answers;
		})
	};
	const result = yield* config.guest.invoke(
		{
			id: request.invocationId,
			kind: 'query',
			target: `${request.collection}.${request.query}`,
			input: encodeWire(decoded.value),
			ctx: {
				actor: request.authority.actor,
				policies: request.authority.policies,
				admin: request.authority.admin,
				now: request.bindings.now,
				today: request.bindings.today,
				tz: request.bindings.tz,
				seed: request.invocationId
			},
			budget: {
				cpuMs: LIMITS.guestCpuMs,
				crossings: LIMITS.crossings.sync,
				readBytes: LIMITS.readBytes
			}
		},
		bridge
	);
	return result.kind === 'ok'
		? result.output
		: yield* Effect.fail(
				result.kind === 'failed' ? result.error : BoltError.make('refused', 'guest', result.message)
			);
});
