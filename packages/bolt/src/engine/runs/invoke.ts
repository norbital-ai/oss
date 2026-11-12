import { actor_ref } from '../access/actor.ts';
import { runPiece } from './rows.ts';
// One body execution path for queued attempts and request calls. Only a durable attempt supplies ledger controls.
import { Cache, Cause, Clock, Context, Crypto, Deferred, Effect, Exit, Layer, Option, Predicate, Result, Schema, Semaphore } from 'effect';
import * as EffectArray from 'effect/Array';
import { canonical, sha256_hex } from '@norbital-ai/store';
import { encode_wire } from '@norbital-ai/std/wire';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import { WriteOutcome } from '../../protocol/schema.ts';
import type { ReadIR } from '../../protocol/reads.ts';
import { type Holder } from '../access/authority.ts';
import { AgentHost } from '../agent/index.ts';
import { inferArgsOf, infer_facility, type InferTool } from '../agent/ai.ts';
import { automationBrowserProfile } from '../agent/browser.ts';
import { SaidContent, StepContent } from '../agent/schema.ts';
import type { ToolBehavior } from '../../protocol/schema.ts';
import { readInferTool } from '../agent/tools.ts';
import { triggerOf } from '../callables/index.ts';
import { decodeAutomationInput } from '../callables/decode.ts';
import { decodeOutput } from '../callables/output.ts';
import { LIMITS, cross_failure, type AiMessage, type CrossAnswer, type GuestOutcome, type Outcome, type RunTrigger } from '../contracts.ts';
import { prepareSend, sendPiece } from '../conversations/outbound.ts';
import { preview, stableId } from '../conversations/store.ts';
import { SqlReadCapture, TenantDb } from '../db/tenant-db.ts';
import { CapturedResult, nativeCommit } from '../db/captured.ts';
import { DecisionTrace, readableFile } from '../decision.ts';
import { is_transient, type EngineError } from '../errors.ts';
import { EmbedInputs, ImageOptions, Reference } from '../facilities.ts';
import { makeParking } from '../parking.ts';
import { instanceRequest } from '../integrations/instances.ts';
import type { EngineManifest } from '../manifest.ts';
import { noticeRows } from '../notifications/notify.ts';
import { Port, uuid, type PortFailure } from '../port.ts';
import { Ai, Browser, Drivers, Logs } from '../ports.ts';
import { ReadDeps } from '../query/engine.ts';
import { bindingsAt } from '../query/reader.ts';
import { Activation, Approvals, Automations, Callables, Facilities, Guest, Identity, Live, Manifest, Reads, Wake,
 type AutomationExecution, type AutomationJob, type AutomationRequest, type CrossCall, type FacilityCall } from '../services.ts';

import { Chain, GATED, makeReadGuards, noticeInsert } from '../write/sql.ts';
import { effectOf, enqueue, next_due } from './queue.ts';
import { effectImages, loadInputRows } from './input.ts';
import { due_at, duration, iso, materialize } from './time.ts';
type Starter = Holder;
type CallScope = { readonly guards?: ReturnType<typeof makeReadGuards>; readonly readOnly?: boolean; readonly cacheKey?: string };
const CallDepth = Context.Reference<number>('bolt/CallDepth', { defaultValue: () => 0 });
const EFFECTS = new Set(['run', 'act', 'withdraw', 'schedule', 'notify', 'send', 'request', 'progress']);
/**
 * What a facility call is to a run's gates, decoded once from its arguments with the shapes the dispatcher takes: the
 * stored files it reads (each must be the run's to read), whether it stores a new one (then the run's own),
 * and the host tools an inference names. Arguments of another shape gate nothing; the dispatcher refuses them.
 */
type CallFacts = {
	readonly reads: readonly string[];
	readonly stores: boolean;
	readonly tools: readonly string[] | undefined;
};
const NO_FACTS: CallFacts = { reads: [], stores: false, tools: undefined };
function factsOf(call: FacilityCall): CallFacts {
	// built per call: `facilities.ts` reaches this module through `decisions`, so its schemas are not there at load
	const [first, options] = call.args,
		referenceOf = Schema.decodeUnknownOption(Reference);
	const ids = (refs: readonly (string | { readonly id: string })[]) =>
		refs.flatMap((ref) => (typeof ref === 'string' ? [] : [ref.id]));
	switch (call._tag) {
		case 'files.put':
		case 'browser.download':
			return { ...NO_FACTS, stores: true };
		case 'files.image':
			return {
				...NO_FACTS,
				reads: ids(Option.toArray(referenceOf(first))),
				stores: Option.exists(
					Schema.decodeUnknownOption(ImageOptions)(options ?? {}),
					(o) => o.jpeg !== undefined
				)
			};
		case 'files.meta':
		case 'files.get':
		case 'files.url':
			return { ...NO_FACTS, reads: ids(Option.toArray(referenceOf(first))) };
		case 'convert.ingest':
			return {
				...NO_FACTS,
				reads: ids(Option.toArray(referenceOf(first))),
				stores: Option.exists(
					Schema.decodeUnknownOption(Schema.Struct({ for: Schema.optionalKey(Schema.String) }))(
						options ?? {}
					),
					(o) => o.for !== undefined
				)
			};
		case 'convert.document':
			return {
				...NO_FACTS,
				reads: ids(
					Option.toArray(
						Schema.decodeUnknownOption(Schema.Struct({ reference: Schema.optionalKey(Reference) }))(
							options
						)
					).flatMap((o) => (o.reference === undefined ? [] : [o.reference]))
				),
				stores: true
			};
		case 'ai.embed':
			return {
				...NO_FACTS,
				reads: ids(Option.getOrElse(Schema.decodeUnknownOption(EmbedInputs)(first), () => []))
			};
		case 'ai.sys_2.infer': {
			const a = Option.getOrUndefined(inferArgsOf(first ?? {}));
			return { ...NO_FACTS, reads: ids(a?.files ?? []), tools: a?.tools };
		}
		default:
			return NO_FACTS;
	}
}
/** An inference's messages as its transcript rows hold them: a tool step, or a prompt's or reply's words. */
const stepOf = Schema.decodeUnknownOption(StepContent),
	saidOf = Schema.decodeUnknownOption(SaidContent);
const failure = (error: EngineError): CrossAnswer =>
	cross_failure(error._tag === 'BoltError' ? error.code : 'internal', error.message);
const CreatedFile = Schema.Struct({
	id: Schema.String.check(Schema.isUUID()),
	name: Schema.String,
	mime: Schema.String,
	bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
});
/**
 * Who a run's schedule records as its starter, the person who may read its result: an effect's writer (the holder it
 * runs as), else this run's own starter.
 */
const starterOf = (run: AutomationExecution, holder: Holder): Starter | null =>
	holder.actor.kind === 'system' ? run.starter : holder;
/** What a run's schedule records as the scheduled run's trigger: the effect and its rows, or the scheduling run. */
function scheduledBy(m: EngineManifest, run: AutomationExecution, durable: boolean): RunTrigger {
	const effect = effectOf(m, run.automation);
	const images = effect === undefined ? Option.none() : effectImages(run.input);
	if (!durable) return { kind: 'system', cause: 'schedule', by: { automation: run.automation, invocation: run.id } };
	return effect !== undefined && Option.isSome(images)
		? {
				kind: 'system',
				cause: 'effect',
				model: effect.model,
				verb: effect.verb,
				records: images.value.ids
			}
		: { kind: 'system', cause: 'schedule', by: { automation: run.automation, run: run.id } };
}
export const AutomationsLive = Layer.effect(Automations, Effect.gen(function* () {
	const m = yield* Manifest, db = yield* TenantDb, activation = yield* Activation,
		guest = yield* Guest, reads = yield* Reads, calls = yield* Callables, identity = yield* Identity,
		approvals = yield* Approvals,
		live = yield* Live, facilities = yield* Facilities, browser = yield* Browser,
		drivers = yield* Drivers, wake = yield* Wake, ai = yield* Ai, logs = yield* Logs, agentHost = yield* AgentHost;
	const crypto = yield* Crypto.Crypto;
	const newId = uuid(crypto);
	const parking = makeParking();
	// Pending cache dependencies must stay acyclic even when different callers own the two lookups.
	const waiting = new Map<string, Map<string, number>>();
		const invoke = (
			run: AutomationExecution,
			holder: Holder,
			input: Json,
			job?: AutomationJob,
			inherited: CallScope = {}
		) =>
			Effect.gen(function* () {
				const modelEffect = effectOf(m, run.automation);
				if (modelEffect !== undefined && job?.event === undefined)
					return yield* BoltError.make('invalid_input', 'decode', 'The effect run has no decoded event.');
				// A run's browser tab is its own: closed by this scope on success, failure or interruption.
				const browseProfile = automationBrowserProfile(run.automation, run.id);
				yield* browser.scoped(browseProfile).pipe(Effect.mapError((error) => BoltError.make(error._tag === 'Unavailable' ? 'unavailable' : 'upstream', 'facility', error.message, error)));
				const cause = yield* Schema.decodeUnknownEffect(
					Schema.Literals(['cron', 'effect', 'schedule', 'start', 'retry'])
				)(run.cause).pipe(
					Effect.mapError(() =>
						BoltError.make('invalid_input', 'admission', 'The automation run has an unknown cause.')
					)
				);
				const record = job?.record ?? Effect.succeed(true);
				const cached = m.automations[run.automation]?.cache !== undefined;
				const readOnly = cached || inherited.readOnly === true;
				const now = yield* Clock.currentTimeMillis,
					b = bindingsAt(now, m.workspace.tz),
					// the run's writes queue model effects one deeper, as this holder (`writerOf`)
					authority = { ...(yield* identity.authority(holder)), run: { depth: run.depth, holder } };
				// One optimistic read boundary per confirmed commit, retained across failures within this attempt.
				const priorReads = inherited.guards ?? makeReadGuards(activation.release);
				// Only native write admission is sequenced; inference and other facilities remain parallel.
				const writeLane = yield* Semaphore.make(1);
				const nativeTables = new Set([
					...Object.keys(m.models),
					'bolt_schema',
					'bolt_history',
					'bolt_seq',
					'bolt_idem',
					'bolt_idem_outcome',
					'bolt_rate',
					'bolt_push_subscriptions',
					'bolt_host_nonce',
					'bolt_credential',
					'bolt_approvals'
				]);
				const readCaller = Effect.fn('Runs.readCaller')(function* (requests: readonly ReadIR[]) {
					if (requests.length === 0) return [];
					const tables = new Set<string>();
					const observation = priorReads.begin(tables);
					const capture = {
						read: (
							statements: Parameters<typeof observation.capture.read>[0],
							execute: Parameters<typeof observation.capture.read>[1]
						) => {
							// Native SQL may also read approval, history, sync or agent metadata outside the business IR.
							// Restrict conservative identifier matches to existing native tables; no authored SQL is admitted.
							for (const statement of statements)
								for (const match of statement.text.matchAll(
									/\b(?:FROM|JOIN)\s+(?:"((?:[^"]|"")*)"|([a-z_][a-z0-9_]*))/gi
								)) {
									const table =
										match[1] === undefined
											? match[2]?.toLowerCase()
											: match[1].replaceAll('""', '"');
									if (table !== undefined && nativeTables.has(table)) tables.add(table);
								}
							return observation.capture.read(statements, execute);
						}
					};
					return yield* reads.run(requests, { as: 'caller', authority }, b, 'Server').pipe(
						Effect.provideService(SqlReadCapture, capture),
						Effect.provideService(ReadDeps, tables),
						Effect.tap(() =>
							Effect.try({
								try: observation.finish,
								catch: (error) =>
									error instanceof BoltError
										? error
										: BoltError.make('internal', 'admission', String(error), error)
							})
						)
					);
				});
				const hydrated = yield* Effect.result(loadInputRows(m, m.automations[run.automation]?.input, input, readCaller));
				if (Result.isFailure(hydrated)) {
					const error = hydrated.failure;
					return { kind: 'failed' as const, error: error._tag === 'BoltError' ? error
						: BoltError.make(is_transient(error) ? 'upstream' : 'internal', 'admission', error.message, error) };
				}
				input = hydrated.success;
				const createdFiles = new Set<string>();
				// keys are per attempt: a rerun starts from the beginning and writes again (no replay)
				const seen = new Map<string, number>();
				const keyOf = (kind: string, target: string, args: Json) => {
					const digest = sha256_hex(canonical([kind, target, args])),
						ordinal = seen.get(digest) ?? 0;
					seen.set(digest, ordinal + 1);
					return `${run.id}:${run.attempts}:${digest}:${ordinal}`;
				};
				/** One statement of a run's own effect (schedule, notify, send), ungated. */
				const effect = (pieces: (c: Chain) => void, outcome: (c: Chain) => string) =>
					Effect.gen(function* () {
						const c = new Chain();
						c.cte('idem', 'SELECT 1 AS active');
						pieces(c);
						const result = yield* nativeCommit(db.write, live.publish, c,
							Schema.Struct({
								...CapturedResult.fields,
								outcome: Schema.Json,
								next_due: Schema.NullOr(Schema.String)
							}),
							`${outcome(c)} AS outcome, (${next_due(c)})::text AS next_due`
						);
						if (result.next_due !== null) yield* wake.at(result.next_due);
						return result.outcome;
					});
				const rememberFile = (facts: CallFacts, answer: CrossAnswer) =>
					Effect.gen(function* () {
						if (!answer.ok || !facts.stores) return;
						// a FileRef, or an ingest's stored images
						const created = yield* Schema.decodeUnknownEffect(
							Schema.Union([CreatedFile, Schema.Struct({ images: Schema.Array(CreatedFile) })])
						)(answer.value).pipe(
							Effect.mapError(() =>
								BoltError.make('corrupt', 'guest', 'a file creation answered an invalid FileRef')
							)
						);
						for (const file of 'images' in created ? created.images : [created])
							createdFiles.add(file.id);
					});
				const checkFiles = (facts: CallFacts) =>
					Effect.gen(function* () {
						for (const id of facts.reads) {
							const found = yield* db.one(Schema.Struct({ field: Schema.String }), {
								text: `SELECT coalesce(field, '') AS field FROM sys_file WHERE id = $1`,
								params: [id]
							});
							if (Option.isNone(found)) return false;
							if (createdFiles.has(id)) continue;
							const field = found.value.field;
							const allowed = field.includes('.')
								? yield* readableFile(
										{ manifest: m, db, read: reads.run, authority, bindings: b },
										id,
										field
									)
								: authority.admin ||
									field === run.automation ||
									authority.automations.includes(field);
							if (!allowed) return false;
						}
						return true;
					});
				/** A facility call, gated by its `facts`; `key` names an infer's session. */
				const facility = (call: FacilityCall, facts: CallFacts, key: string) =>
					Effect.gen(function* (): Effect.fn.Return<CrossAnswer, PortFailure> {
						const withProfile = call._tag.startsWith('browser.')
							? { ...call, args: [browseProfile, ...call.args] }
							: call;
						if (call._tag === 'ai.sys_1.decide')
							return yield* facilities.dispatch(call).pipe(
								Effect.provideService(DecisionTrace, {
									invocation: `${run.id}:${run.attempts}`,
									run: job === undefined ? null : run.id,
									automation: run.automation
								})
							);
						if (call._tag !== 'ai.sys_2.infer') return yield* facilities.dispatch(withProfile);
						const names = [...new Set(facts.tools ?? [])];
						const host_tools = agentHost.host_tools;
						const hosted =
							typeof host_tools === 'function'
								? yield* Port.attempt('host_tools', () => host_tools(authority, run.id))
								: (host_tools ?? []);
						// `read`: workspace records as the run's policies, through the agent's own read tool (rule 58)
						const reader =
							names.includes('read') && m.automations[run.automation] !== undefined
								? readInferTool({
										engine: { manifest: m, read: (requests) => readCaller(requests) },
										authority,
										bindings: b
									})
								: undefined;
						const records: InferTool[] = reader === undefined ? [] : [reader];
						const missing = names.find((name) =>
							(readOnly && name !== 'read' && !hosted.some((tool) => tool.name === name && tool.read_only)) ||
							(name === 'read'
								? reader === undefined
								: !(authority.admin || authority.capabilities.tools.includes(name)) ||
									![...records, ...hosted].some((tool) => tool.name === name))
						);
						if (missing !== undefined)
							return {
								ok: false,
								error: {
									kind: 'unavailable',
									facility: `tool ${missing}`,
									reason:
										missing === 'read'
											? "'read' needs an automation's policies that grant a read"
											: `'${missing}' is not a host tool this run's policies name`
								}
							} satisfies CrossAnswer;
						// one browsing session per inference: inferences side by side in one run never share a page
						const session = stableId('infer', key);
						const tools: InferTool[] = hosted
							.filter((tool) => names.includes(tool.name))
							.map((tool) => ({
								name: tool.name,
								description: tool.description,
								input: tool.input,
								behavior: tool.behavior,
								call: (input) =>
									Effect.gen(function* () {
										const callId = yield* crypto
											.randomUUIDv4()
											.pipe(Effect.mapError(Port.failure(`tool ${tool.name}`)));
										return yield* Port.attempt(`tool ${tool.name}`, (signal) =>
											tool.call(
												input,
												{
													actor: authority.actor,
													conversation: `${run.id}:${session}`,
													turn: run.id,
													call_id: callId,
													attach: () => {}
												},
												signal
											)
										);
									})
							}));
						// each tool step is one `infer.tool` event on the run (what it read, searched, opened or edited), as
						// `decision.made` traces a sys_1 call: the run's own record of the research it did
						const recorded = (name: string, input: Json, error?: string) =>
							Effect.gen(function* () {
								yield* logs.write({
									at: new Date(yield* Clock.currentTimeMillis).toISOString(),
									severity: error === undefined ? 'info' : 'warn',
									event: 'infer.tool',
									invocation: `${run.id}:${run.attempts}`,
									run: job === undefined ? null : run.id,
									conversation: null,
									turn: null,
									attributes: {
										automation: run.automation,
										tool: name,
										input: JSON.stringify(input).slice(0, 500),
										...(error === undefined ? {} : { error })
									}
								});
							}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
						const traced = (tool: InferTool): InferTool => ({
							...tool,
							call: (input) =>
								tool
									.call(input)
									.pipe(
										Effect.onExit((exit) =>
											recorded(
												tool.name,
												input,
												Exit.isFailure(exit)
													? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.message
													: undefined
											)
										)
									)
						});
						// the inference's whole transcript is a conversation of its own, as an agent's is: labelled, read-only, for
						// administrators (the run's own `session` names it)
						const named = Schema.decodeUnknownOption(
							Schema.Struct({
								label: Schema.optionalKey(Schema.String),
								model: Schema.optionalKey(Schema.String)
							})
						)(call.args[0]);
						const label = Option.isSome(named) ? named.value.label : undefined;
						if (job !== undefined) yield* db
							.write({
								text: "INSERT INTO sys_conversation (id, title, run, status, model) VALUES ($1, $2, $3, 'running', $4) ON CONFLICT (id) DO UPDATE SET status = 'running', updated_at = now()",
								params: [
									session,
									label === undefined ? run.automation : `${run.automation} · ${label}`,
									run.id,
									(Option.isSome(named) ? named.value.model : undefined) ?? 'default'
								]
							})
							.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
						// a tool row carries the call's input as the panel shows a step (its query, address or path), as an
						// agent's does; the model's own messages keep it once, in its call
						const asked = new Map<string, string>(), parents = new Map<string, string>();
						const transcribe = (message: AiMessage, index: number, behavior: ToolBehavior) => {
							// the message's content decoded as a transcript row's, by its role
							const step =
									message.role === 'tool'
										? Option.getOrUndefined(stepOf(message.content))
										: undefined,
								words =
									message.role === 'tool'
										? undefined
										: Option.getOrUndefined(saidOf(message.content));
							if (typeof words === 'object' && words !== null)
								for (const c of words.toolCalls ?? []) { asked.set(c.id, JSON.stringify(c.input)); parents.set(c.id, stableId(session, String(index))); }
							const args = step === undefined ? undefined : asked.get(step.id);
							const parent = step === undefined ? undefined : parents.get(step.id);
							if (message.role === 'tool' && (step === undefined || parent === undefined)) return Effect.logWarning('An inference tool result has no valid assistant call.');
							const content: Json = step === undefined ? message.content : { ...step, behavior, ...(args === undefined ? {} : { args }), ...(parent === undefined ? {} : { assistant: parent }) };
							const text =
								typeof words === 'string'
									? words
									: typeof words === 'object' && words?.text !== undefined
										? words.text
										: JSON.stringify(content);
							return db
								.write({
									text: "INSERT INTO sys_message (id, conversation, role, content, text, preview, mode, author) VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'agent', $7) ON CONFLICT (id) DO NOTHING",
									// the automation asked: its prompt is written by it, as a member writes theirs
									params: [
										stableId(session, String(index)),
										session,
										message.role,
										// a prompt is a bare string: encoded, it is JSON like every other content
										JSON.stringify(content),
										text,
										preview(text),
										message.role === 'user' ? run.automation : null
									]
								})
								.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
						};
						return yield* infer_facility(ai, {
							load: facilities.fileLoader,
							onDraft: recorded,
							...(job === undefined ? {} : { onMessage: transcribe })
						})(call, [...records, ...tools].map(traced)).pipe(
							Effect.ensuring(
								job === undefined ? Effect.void : db
									.write({
										text: "UPDATE sys_conversation SET status = 'idle', updated_at = now() WHERE id = $1",
										params: [session]
									})
									.pipe(Effect.ignore)
							)
						);
					}).pipe(
						Effect.catch((error) =>
							Effect.succeed({
								ok: false,
								error:
									error._tag === 'Unavailable'
										? { kind: 'unavailable', facility: error.facility, reason: error.reason }
										: { kind: error.kind, message: error.message }
							} satisfies CrossAnswer)
						)
					);
				const crossing = (
					call: Exclude<
						CrossCall,
						{
							_tag: 'read';
						}
					>
				): Effect.Effect<CrossAnswer, EngineError> => {
					const work = Effect.gen(function* (): Effect.fn.Return<CrossAnswer, EngineError> {
						if (job?.stopped() === true) return cross_failure('stopped', 'The run was stopped.');
						if (readOnly && (['act', 'withdraw', 'schedule', 'notify', 'send', 'browser.act', 'browser.evaluate'].includes(call._tag)))
							return cross_failure('forbidden', 'A cached call may not write.');
						if ((EFFECTS.has(call._tag) || call._tag.startsWith('ai.')) && !(yield* record))
							return cross_failure('stopped', 'This cron slot already ran.');
						switch (call._tag) {
							case 'progress': {
								if (job === undefined) return { ok: true, value: null };
								const decoded = yield* Schema.decodeUnknownEffect(
									Schema.Struct({
										ratio: Schema.optionalKey(
											Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
										),
										text: Schema.optionalKey(Schema.String)
									})
								)(call.progress).pipe(
									Effect.mapError(() =>
										BoltError.make(
											'invalid_input',
											'guest',
											'progress takes { ratio?: 0..1, text?: string }'
										)
									)
								);
								const c = new Chain();
								runPiece(c, 'progressed', `UPDATE sys_run SET progress = CASE WHEN state = 'running' THEN ${c.p({
										ratio: decoded.ratio ?? null,
										text: decoded.text?.slice(0, 500) ?? null
									})}::jsonb ELSE progress END WHERE id IN (SELECT jsonb_array_elements_text(${c.p(job.ids)}::jsonb))`);
								const result = yield* nativeCommit(db.write, live.publish, c, CapturedResult);
								if (result.captured.some((row) => row.new?.['state'] === 'stopped')) {
									job.stop();
									return cross_failure('stopped', 'The run was stopped.');
								}
								return { ok: true, value: null };
							}
							case 'act': {
								const proposed = keyOf('act', 'act', encode_wire({ acts: call.acts, outputs: call.outputs }));
								const key = call.options.key ?? proposed;
								const observedRead = priorReads.snapshot();
								const guards = observedRead.guards;
								const result = yield* calls.acts({
									name: 'act',
									acts: call.acts,
									outputs: call.outputs,
									...(guards.fingerprints.length === 0 && guards.inconsistent !== true ? {} : { readGuards: guards }),
									key,
									issuedAt: b.now,
									authority,
									bindings: b,
									invocationId: key,
									from: 'Server'
								});
								if (result.readGuardsConsumed === true) priorReads.consume(observedRead.generation);
								return { ok: true, value: result.outcome };
							}
							case 'withdraw': {
								const decision = yield* approvals.decide({
									request_id: call.request_id,
									decision: 'withdraw',
									...(call.reason === undefined ? {} : { reason: call.reason }),
									authority,
									now: b.now
								});
								return {
									ok: true,
									value:
										decision.kind === 'decided'
											? { request_id: decision.request_id, status: decision.status }
											: encode_wire(decision)
								};
							}
							case 'run': {
								const spec = m.automations[call.automation];
								if (spec === undefined) return cross_failure('not_found', `No automation '${call.automation}'.`);
								if (run.depth >= LIMITS.writeDepth) return cross_failure('depth', `Runs chain at most ${LIMITS.writeDepth} deep.`);
								if (spec.mode !== 'call') return readOnly ? cross_failure('forbidden', 'A cached call may not queue a job.') : yield* crossing({ _tag: 'schedule', automation: call.automation, input: call.input });
								const outcome = spec.cache === undefined
									? yield* execute(call.automation, call.input, scheduledBy(m, run, job !== undefined), run.depth + 1, { guards: priorReads, readOnly, ...(inherited.cacheKey === undefined ? {} : { cacheKey: inherited.cacheKey }) })
									: yield* cachedCall(call.automation, call.input, run.depth + 1, inherited.cacheKey);
								if (outcome.kind === 'committed') return { ok: true, value: outcome.output };
								return outcome.kind === 'refused' ? { ok: false, error: outcome } : cross_failure('internal', 'The call did not finish.');
							}
							case 'schedule': {
								const target = m.automations[call.automation];
								if (target === undefined || target.mode === 'call')
									return cross_failure('invalid_input', `no automation '${call.automation}'`);
								const self = call.automation === run.automation;
								// code schedules without a start grant: `automations` admits manual starts only
								if (self && call.at === undefined && canonical(call.input) === canonical(run.input))
									return cross_failure(
										'hotLoop',
										'A run cannot schedule itself at once with the same input.'
									);
								const depth = self ? run.depth : run.depth + 1;
								if (depth > LIMITS.writeDepth)
									return cross_failure('depth', `Runs chain at most ${LIMITS.writeDepth} deep.`);
								// `{ var }`: a time expression over `now` and `today` (`now + minutes(1)`), read where the run starts it
								const when = call.at;
								const at =
									when === undefined
										? now
										: typeof when === 'string'
											? Date.parse(when)
											: Result.match(
													Result.try(() => materialize(when, bindingsAt(now, m.workspace.tz))),
													{
														onSuccess: (v) => (typeof v === 'string' ? Date.parse(v) : Number.NaN),
														onFailure: () => Number.NaN
													}
												);
								if (!Number.isFinite(at))
									return cross_failure('invalid_input', 'schedule: at is not an instant');
								const due = iso(due_at(now, at)),
									runKey = call.key;
								const value = yield* effect(
									(c) => {
										const queued = enqueue(
											c,
											[
												{
													automation: call.automation,
													input: call.input,
													due_at: due,
													...(runKey === undefined ? {} : { key: runKey }),
													cause: 'schedule',
													depth,
													actor: actor_ref(holder.actor),
													starter: starterOf(run, holder),
													trigger: scheduledBy(m, run, job !== undefined)
												}
											],
											{ when: GATED, conflict: 'replace' }
										);
										c.cte('scheduled', `SELECT id FROM ${queued}`);
									},
									(c) =>
										`jsonb_build_object('id', (SELECT id FROM scheduled), 'automation', ${c.p(call.automation)}::text)`
								);
								job?.dues.push(Date.parse(due));
								return { ok: true, value };
							}
							case 'notify': {
								const key = keyOf('notify', '', call.notices);
								const report = (value: Json) => {
									if (Predicate.isObject(value) && EffectArray.isArray(value['unaddressed']))
										for (const title of value['unaddressed'])
											job?.warnings.push(`notify: '${String(title)}' reached no member`);
								};
								const event = job?.event;
								const approval = event?.kind === 'approval' ? event : undefined;
								const approvers = approval === undefined ? [] : yield* db.rows(Schema.Struct({ id: Schema.String }), {
									text: `SELECT u.id FROM bolt_approvals a JOIN sys_user u ON
									(a.route -> 'steps' -> a.step -> 'users' ? u.id OR
									(a.route -> 'steps' -> a.step -> 'teams' ? u.team AND u.team IN (SELECT jsonb_array_elements_text($2::jsonb))))
									WHERE a.id = $1::uuid AND a.state = 'Pending' AND u.active AND u.kind = 'staff'
									AND a.requestor <> 'member:' || u.id AND a.requestor_user IS DISTINCT FROM u.id`,
									params: [approval.request, JSON.stringify(Object.keys(m.teams))]
								});
								const first = approval?.records[0];
								const rows = yield* noticeRows(call.notices, {
									manifest: m,
									id: key,
									...(modelEffect === undefined || first === undefined ? {} : { link: { model: modelEffect.model, id: first.id } }),
									...(approval === undefined ? {} : { approval: {
										requester: approval.requester,
										approvers: { teams: [], users: approvers.map((user) => user.id) }
									} })
								}).pipe(Effect.provideService(TenantDb, db));
								report(
									yield* effect(
										(c) =>
											noticeInsert(
												c,
												'n',
												rows,
												b.now,
												undefined,
												m.teams,
												m.workspace.signup?.policies
											),
										() =>
											`jsonb_build_object('unaddressed', (SELECT coalesce(jsonb_agg(title), '[]'::jsonb) FROM n_to WHERE member IS NULL AND coalesce("to"->>'channel', 'inbox') = 'inbox'))`
									)
								);
								return { ok: true, value: null };
							}
							case 'send': {
								if (call.to === null)
									return cross_failure('invalid_input', 'ctx.send names its connection or instance');
								const prepared = yield* prepareSend(m, db, call.to, call.message, crypto);
								if ('error' in prepared) return cross_failure('invalid_input', prepared.error);
								const id = yield* newId;
								const value = yield* effect(
									(c) => {
										const sent = sendPiece(c, { ...prepared, id }, b.now, true);
										c.cte('sent', `SELECT id FROM ${sent}`);
									},
									() => 'to_jsonb((SELECT id FROM sent))'
								);
								return { ok: true, value };
							}
							case 'request': {
								if (call.to === null)
									return cross_failure('invalid_input', 'ctx.request names its connection or instance');
								return yield* instanceRequest(
									{ manifest: m, db, links: drivers, readOnly },
									call.to,
									call.operation
								);
							}
							default: {
								const facts = factsOf(call);
								if (readOnly && facts.stores) return cross_failure('forbidden', 'A cached call may not store files.');
								if (facts.stores && !(yield* record))
									return cross_failure('stopped', 'This cron slot already ran.');
								if (!(yield* checkFiles(facts)))
									return {
										ok: false,
										error: { kind: 'invalid', message: 'this run cannot read file' }
									};
								const got = yield* facility(call, facts, keyOf(call._tag, '', call.args));
								yield* rememberFile(facts, got);
								return got;
							}
						}
					});
					return call._tag === 'act' || call._tag === 'withdraw' ? writeLane.withPermit(work) : work;
				};
				return yield* guest
					.invoke(
						{
							id: `${run.id}:${run.attempts}`,
							...(job === undefined ? {} : { run: run.id }),
							kind: modelEffect === undefined ? 'automation' : 'effect',
							target: run.automation,
							input,
							ctx: {
								...(job?.event === undefined ? {} : { event: job.event }),
								actor: holder.actor,
								now: b.now,
								today: b.today,
								tz: b.tz,
								seed: run.id,
								cause,
								attempt: run.attempts,
								...(modelEffect === undefined &&
								m.automations[run.automation] !== undefined
									? {
											run: {
												...(job === undefined ? {} : { id: run.id }),
												// ponytail: a run queued before triggers were recorded reads as an unattributed schedule
												...(cached ? {} : { trigger: run.trigger ?? {
													kind: 'system' as const,
													cause: 'schedule' as const
													} })
											}
										}
									: {})
							},
							budget: {
								crossings: LIMITS.crossings.automation,
								readBytes: LIMITS.readBytes
							}
						},
						{
							cross: (batch) =>
								Effect.gen(function* () {
									const requests = batch.flatMap((call) =>
										call._tag === 'read' ? [call.read] : []
									);
									const answers = yield* readCaller(requests).pipe(
													Effect.map((values) =>
														values.map((value): CrossAnswer => ({ ok: true, value }))
													),
													Effect.catch((error): Effect.Effect<readonly CrossAnswer[]> =>
														Effect.succeed(requests.map(() => failure(error)))
													)
												);
									let index = 0;
									return yield* Effect.forEach(batch, (call): Effect.Effect<CrossAnswer> =>
										call._tag === 'read'
											? Effect.succeed(
													answers[index++] ?? cross_failure('internal', 'the read returned no answer')
												)
											: crossing(call).pipe(
													Effect.catch((error) => Effect.succeed(failure(error))),
													(work) => job === undefined ? work : Effect.raceFirst(work, Deferred.await(job.halt).pipe(Effect.as(cross_failure('stopped', 'The run was stopped.'))))
												)
									);
								})
						}
					);
			}).pipe(Effect.scoped);
	const execute = Effect.fn('Automations.callBody')(function* (automation: string, input: Json, trigger?: RunTrigger, depth = 0, inherited: CallScope = {}): Effect.fn.Return<Outcome, EngineError> {
		const spec = m.automations[automation];
		if (spec === undefined || spec.mode !== 'call')
			return yield* Effect.fail(BoltError.make('invalid_input', 'admission', `'${automation}' is not a call-mode automation.`));
		if (depth > LIMITS.writeDepth) return yield* Effect.fail(BoltError.make('invalid_input', 'admission', `Runs chain at most ${LIMITS.writeDepth} deep.`));
		const decoded = decodeAutomationInput(spec.input, input);
		if (decoded.problems.length > 0) return yield* Effect.fail(BoltError.make('invalid_input', 'decode', decoded.problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ')));
		input = encode_wire(decoded.value);
		const id = yield* newId;
		const holder: Holder = { actor: { kind: 'system', run: id, by: { automation } }, policies: spec.policies, admin: false };
		const outcome = yield* invoke({ id, automation, input, cause: 'start', depth, attempts: 1, starter: null, ...(trigger === undefined ? {} : { trigger }) }, holder, input, undefined, inherited);
		if (outcome.kind === 'failed') return yield* Effect.fail(outcome.error);
		if (outcome.kind === 'refused')
			return yield* Schema.decodeUnknownEffect(WriteOutcome)({ ...outcome, code: outcome.code ?? 'refused' }).pipe(Effect.mapError((error) => BoltError.make('corrupt', 'guest', error.message, error)));
		return { kind: 'committed' as const, output: yield* decodeOutput(m, spec.output, outcome.output), records: [] };
	});
	const CacheKey = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Json]));
	const cache = yield* Cache.makeWith((key: string) => Effect.gen(function* () {
		const [automation, input] = yield* Schema.decodeUnknownEffect(CacheKey)(key).pipe(Effect.mapError((error) => BoltError.make('internal', 'decode', error.message, error)));
		return { output: yield* execute(automation, input, undefined, yield* CallDepth, { cacheKey: key }), ttl: duration(m.automations[automation]?.cache ?? '0s') };
	}), { capacity: LIMITS.automationCache.entries, requireServicesAt: 'lookup', timeToLive: (exit) => Exit.isSuccess(exit) && exit.value.output.kind === 'committed' ? exit.value.ttl : 0 });
	const cachedCall = Effect.fn('Automations.cachedCall')(function* (
		automation: string, input: Json, depth: number, parent?: string
	): Effect.fn.Return<Outcome, EngineError> {
		const spec = m.automations[automation];
		const decoded = decodeAutomationInput(spec?.input, input);
		if (decoded.problems.length > 0)
			return yield* Effect.fail(BoltError.make('invalid_input', 'decode', decoded.problems.map((problem) => `${problem.path}: ${problem.message}`).join('; ')));
		const key = canonical([automation, encode_wire(decoded.value)]);
		const get = Cache.get(cache, key).pipe(Effect.provideService(CallDepth, depth), Effect.map((value) => value.output));
		if (parent === undefined) return yield* get;
		return yield* Effect.acquireUseRelease(
			Effect.try({
				try: () => {
					const pending = [key], visited = new Set<string>();
					for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
						if (next === parent) throw BoltError.make('invalid_input', 'admission', 'Cached calls may not wait on a cycle of calls.');
						if (visited.has(next)) continue;
						visited.add(next);
						pending.push(...(waiting.get(next)?.keys() ?? []));
					}
					const edges = waiting.get(parent) ?? new Map<string, number>();
					edges.set(key, (edges.get(key) ?? 0) + 1);
					waiting.set(parent, edges);
				},
				catch: (error) => error instanceof BoltError ? error : BoltError.make('internal', 'admission', String(error), error)
			}),
			() => get,
			() => Effect.sync(() => {
				const edges = waiting.get(parent), count = edges?.get(key) ?? 0;
				if (count > 1) edges?.set(key, count - 1);
				else edges?.delete(key);
				if (edges?.size === 0) waiting.delete(parent);
			})
		);
	});

	const callBody = Effect.fn('Automations.callBodyAdmission')(function* (request: AutomationRequest): Effect.fn.Return<Outcome, EngineError> {
		const spec = m.automations[request.automation];
		if (spec === undefined || spec.mode !== 'call')
			return yield* Effect.fail(BoltError.make('invalid_input', 'admission', `'${request.automation}' is not a call-mode automation.`));
		const admitted = yield* calls.admitAutomation({ ...request, inputs: [request.input] });
		if ('kind' in admitted) return admitted;
		const input = admitted[0];
		if (input === undefined) return yield* Effect.fail(BoltError.make('internal', 'admission', 'The admitted call has no input.'));
		return spec.cache === undefined
			? yield* execute(request.automation, input, triggerOf(request.authority, request.agent ?? request.authority.agent))
			: yield* cachedCall(request.automation, input, 0);
	});
	const call = Effect.fn('Automations.call')(function* (request: AutomationRequest) {
		const id = yield* newId;
		return yield* Effect.acquireUseRelease(
			Effect.sync(() => { if (parking.parked) return false; parking.enter(id); return true; }),
			(entered): Effect.Effect<Outcome, EngineError> => entered ? callBody(request) : Effect.succeed({ kind: 'refused', code: 'release_changed', message: 'The workspace is switching release; try again.' }),
			(entered) => Effect.sync(() => { if (entered) parking.leave(id); })
		);
	});
	return { invoke, call, park: parking.park };
}));
