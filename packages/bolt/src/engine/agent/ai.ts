// The AI port's `sys_2` (the LLM) under the 20 s idle wall: each model request is one facility call. The wall is
// idle time: every token received (answer or reasoning) restarts it, so a model streaming its reasoning is never cut. A
// stream silent for the wall is closed and its partial output kept as a cut step the next request continues; a request
// that yields nothing within it is `timeout` (OD-13). `model` is a class or a catalog id; any other is `unavailable`.
// Chat, compaction, verification and structured inference send the native request through modelCall.
import { item_kind, json_schema, KindSchema } from '@norbital-ai/store/kind';
import {
	Cause,
	Clock,
	Duration,
	Effect,
	Option,
	Predicate,
	Result,
	Schedule,
	Schema,
	Stream,
	type Scope
} from 'effect';
import * as EffectArray from 'effect/Array';
import { model_step, run_calls, type ModelCarry } from './step.ts';
import { textOf } from './schema.ts';
import { FacilityFailure, Unavailable } from '../../decl/errors.ts';
import type { ToolBehavior } from '../../protocol/schema.ts';
import type { Ai, AiEvent } from '../ports.ts';
import { Port, type PortFailure } from '../port.ts';
import type { FacilityCall } from '../services.ts';
import type { Json } from '../../decl/values.ts';

import {
	LIMITS,
	type AiMessage,
	type AiRequest,
	type AiResponse,
	type CrossAnswer
} from '../contracts.ts';
import { decodeInput } from '../callables/decode.ts';
import type { Kind } from '@norbital-ai/store/kind';
import { bound, BOUNDS, size } from './context.ts';
import {
	ANY,
	childKind,
	diffAt,
	find,
	indexOf,
	isList,
	isObj,
	keyedPath,
	keyOf,
	keyText,
	pointer,
	project,
	resolve,
	segments,
	type JsonChange
} from './draft.ts';
import { Validator } from '@cfworker/json-schema';
import { compile, context, evaluate } from '@norbital-ai/store/formula';

const MiB = 1024 * 1024;
/** Rule 72: a platform budget checked before the provider's own limit: files and bytes a call, bytes one file. */
export const MODEL_FILES = { count: 24, bytes: 20 * MiB, fileBytes: 8 * MiB } as const;
/** What a message may carry (envoy and panel alike): images, text, recordings and any document, parsed or read by a tool, within `MODEL_FILES`. */
export const ATTACHMENT_MIME = /^(image|text|audio|application)\/[\w.+-]+$/;
class ModelIdle extends FacilityFailure {
	declare readonly cutTool?: true;
	constructor(message: string, cutTool?: true) {
		super({ kind: 'timeout', message });
		if (cutTool === true) this.cutTool = true;
	}
}
export const isFacilityError = (v: unknown): v is FacilityFailure | Unavailable =>
	v instanceof FacilityFailure || v instanceof Unavailable;
/** A provider's refusal of the prompt's size triggers compaction. */
export const overflow = (e: FacilityFailure | Unavailable): boolean =>
	e instanceof FacilityFailure &&
	e.kind !== 'timeout' &&
	(e.status === 413 || /context|too long|maximum.*tokens|overflow/i.test(e.message));
const isTransientUpstream = (e: PortFailure): boolean =>
	e instanceof FacilityFailure &&
	e.kind === 'upstream' &&
	(e.status === undefined || e.status === 408 || e.status === 429 || e.status >= 500);
/** Six retries, with the provider's delay as a floor on exponential backoff. */
const TRANSIENT_RETRIES = 6;
const retryBackoff: Schedule.Schedule<Duration.Duration, PortFailure> = Schedule.exponential(
	'1 second'
).pipe(
	Schedule.modifyDelay(({ input, duration }) =>
		Effect.succeed(
			input instanceof FacilityFailure && input.retry_after_ms !== undefined
				? Duration.max(duration, Duration.millis(input.retry_after_ms))
				: duration
		)
	)
);
export const servesModel = (
	ai: Ai['Service'],
	model: string
): Effect.Effect<boolean, FacilityFailure> =>
	ai.models.includes(model)
		? Effect.succeed(true)
		: ai.catalog.pipe(
				Port.call('ai.catalog', LIMITS.callMs.ai),
				Effect.map((catalog) => catalog.models.some((x) => x.id === model)),
				Effect.catchTag('Unavailable', () => Effect.succeed(false))
			);
/** How long a model call may take to its first event (time to first byte on an uncached long prompt). */
const FIRST_EVENT_MS = 60_000;
/** Silence interrupts the upstream pull; every response/progress event restarts the wall. */
export const modelCall = Effect.fn('Ai.modelCall')(function* (
	ai: Ai['Service'] | undefined,
	request: AiRequest,
	options: {
		wallMs?: number | undefined;
		/** Utility calls may retry upstream failures before a response, including their private streamed progress. */
		retryUpstream?: number;
		onDelta?: ((text: string) => void) | undefined;
		onReasoning?: ((text: string) => void) | undefined;
		onRequest?: (request: AiRequest) => Effect.Effect<void>;
	} = {}
) {
	if (options.onRequest !== undefined) yield* options.onRequest(request);
	if (ai === undefined) return yield* new Unavailable({ facility: 'ai', reason: 'the host provides no ai' });
	if (!(yield* servesModel(ai, request.model)))
		return yield* new Unavailable({ facility: 'ai', reason: `no model is mapped to the class '${request.model}'` });
	const files = request.files ?? [];
	if (files.length > MODEL_FILES.count || files.reduce((n, f) => n + f.bytes.length, 0) > MODEL_FILES.bytes)
		return yield* new FacilityFailure({
			kind: 'invalid',
			message: `a model call takes at most ${MODEL_FILES.count} files and ${MODEL_FILES.bytes / MiB} MiB`
		});
	const wallMs = options.wallMs ?? LIMITS.callMs.ai,
		// a long prompt no provider has cached takes 20–30 s to its first byte; after that the idle wall holds
		firstMs = options.wallMs ?? FIRST_EVENT_MS;
	let partial = '',
		reasoning = '',
		progressed = false,
		begun = false;
	let response: AiResponse | undefined;
	let upstreamRetries = 0;
	// Each pull races a native sleep. Business time may be frozen or adjusted independently.
	yield* Stream.transformPull(
		Stream.suspend(() => {
			partial = '';
			reasoning = '';
			progressed = false;
			begun = false;
			response = undefined;
			return ai.infer(request);
		}),
		(pull) => {
			let finished = false;
			const idle = (cause?: FacilityFailure): Effect.Effect<readonly [AiEvent], FacilityFailure> =>
				Effect.suspend(() => {
					finished = true;
					if (partial === '')
						return Effect.fail(
							progressed
								? new ModelIdle(`the model was still writing a tool call at ${wallMs} ms`, true)
								: (cause ?? new ModelIdle(`the model yielded nothing within ${begun ? wallMs : firstMs} ms`))
						);
					const cut: AiResponse = {
						content: partial,
						tool_calls: [],
						finish: 'cut',
						...(reasoning === '' ? {} : { reasoning }),
						usage: { input: 0, output: 0 }
					};
					return Effect.succeed<readonly [AiEvent]>([{ _tag: 'Response', response: cut }]);
				});
			return Effect.succeed(
				Effect.suspend(() =>
					finished
						? Cause.done()
						: pull.pipe(
								Effect.catchTag('FacilityFailure', (cause) => (cause.kind === 'timeout' ? idle(cause) : Effect.fail(cause))),
								Effect.timeoutOrElse({ duration: begun ? wallMs : firstMs, orElse: () => idle() })
							)
				)
			);
		}
	).pipe(
		Stream.runForEach((event) =>
			Effect.sync(() => {
				begun = true;
				switch (event._tag) {
					case 'Delta':
						partial += event.text;
						options.onDelta?.(event.text);
						break;
					case 'Progress':
						progressed = true;
						if (event.reasoning !== undefined) {
							reasoning += event.reasoning;
							options.onReasoning?.(event.reasoning);
						}
						break;
					case 'Response':
						response = event.response;
						break;
				}
			})
		),
		// Capacity retries require no output. Utility calls carry their own upstream retry allowance.
		Effect.retry({
			schedule: retryBackoff,
			times: TRANSIENT_RETRIES,
			while: (error) => {
				if (error instanceof FacilityFailure && error.kind === 'rate_limited')
					return partial === '' && !progressed && response === undefined;
				if (!isTransientUpstream(error) || upstreamRetries >= (options.retryUpstream ?? 0))
					return false;
				upstreamRetries++;
				return true;
			}
		})
	);
	if (response === undefined)
		return yield* new FacilityFailure({ kind: 'upstream', message: 'the model stream ended without a response' });
	return {
		...response,
		usage: {
			...response.usage,
			prompt: {
				system: request.system?.length ?? 0,
				messages: JSON.stringify(request.messages).length,
				tools: request.tools === undefined || request.tools.length === 0 ? 0 : JSON.stringify(request.tools).length
			}
		}
	};
});

/** `confirm`: an in-app call the person must approve first; it executes later under key `(turn, callId)`. */
/** `bounded`: the tool already bounded its result, so the loop does not clip it again; `full` is what it cut it from. */
export const ToolAnswer = Schema.Union([
	Schema.Struct({
		result: Schema.Json,
		bounded: Schema.optionalKey(Schema.Literal(true)),
		full: Schema.optionalKey(Schema.Json)
	}),
	Schema.Struct({ confirm: Schema.Literal(true) })
]);
export type ToolAnswer = typeof ToolAnswer.Type;
/** A tool `ctx.ai.sys_2.infer` offers the model (a host tool its automation's policies name); a throw is a failed result. */
export type InferTool = {
	name: string;
	description: string;
	input: Json;
	behavior: ToolBehavior;
	call(input: Json): Effect.Effect<Json, PortFailure>;
};
/**
 * The tools a structured inference builds its answer with: `edit` changes the draft, `read`, `find` and `diff` inspect it,
 * `submit` hands it in.
 */
const EDIT = 'edit',
	FIND = 'find',
	DIFF = 'diff',
	SUBMIT = 'submit';
/** Consecutive empty (reasoning-only) replies, and prose replies that neither edit nor submit, tolerated before `invalid`. */
const PAUSES = 3,
	FAILURES = 3;
/** The most tool turns an author's `steps` may grant one inference. */
const MAX_STEPS = 1000;
/** The most `find` matches and `diff` changes one call returns, and the longest value (JSON characters) a change shows whole. */
const HITS = 50,
	CHANGES = 100,
	SHOWN = 200;

const EditInput = Schema.Struct({ ops: Schema.Array(Schema.Unknown) });
const ReadInput = Schema.Struct({
	path: Schema.String,
	fields: Schema.optionalKey(Schema.Array(Schema.String))
});
const FindInput = Schema.Struct({
	text: Schema.NonEmptyString,
	path: Schema.optionalKey(Schema.String)
});
const DiffInput = Schema.Struct({ path: Schema.optionalKey(Schema.String) });
const EditOp = Schema.Struct({
	path: Schema.String,
	set: Schema.optionalKey(Schema.Json),
	remove: Schema.optionalKey(Schema.Literal(true)),
	append: Schema.optionalKey(Schema.Json)
});
/** The empty answer a structured inference starts from, by the output's kind. */
const emptyOf = (k: Kind): Json =>
	k.many === true
		? []
		: k.kind === 'object' || k.kind === 'record' || k.kind === 'json'
			? {}
			: null;
/**
 * One `edit` operation on `draft` (never changed in place) against the output `kind` (ANY for a JSON Schema output),
 * returning the new draft. `set` replaces or creates the value at a keyed pointer, creating missing parent objects and
 * lists; `set` at `/list/KEY` of a keyed list adds or replaces that item and fills its key field. `append` adds to an
 * unkeyed list; `remove: true` deletes. A set or appended value is checked against its kind (quoted scalars read as the
 * kind) and a keyed item keeps a distinct key. Fails with the operation's problem, led by its path.
 */
export class EditRefused extends Schema.TaggedError<EditRefused>()('EditRefused', {
	message: Schema.String
}) {}
type Edited = Result.Result<Json | undefined, EditRefused>;
export function applyEdit(draft: Json, op: typeof EditOp.Type, kind: Kind): Result.Result<Json, EditRefused> {
	const refused = (message: string) => Result.fail(new EditRefused({ message }));
	const fail = (why: string) => refused(`${op.path || '/'}: ${why}`);
	if ([op.set, op.remove, op.append].filter((v) => v !== undefined).length !== 1)
		return fail('give exactly one of set, remove and append');
	const segs = segments(op.path);
	if (segs === undefined) return fail('a path is "" or starts with "/"');
	const fits = (k: Kind, value: Json, at: readonly string[]): Result.Result<Json, EditRefused> => {
		const v = unquoted(k, value);
		const problems = decodeInput({ v: k }, { v }).problems;
		return problems.length > 0
			? refused(
					problems
						.map(
							(p) =>
								`${pointer(at) + keyedPath(v, k, p.path.split('.').slice(1)) || '/'}: ${p.message}`
						)
						.join('; ')
				)
			: Result.succeed(v);
	};
	const target = (current: Json | undefined, k: Kind, keyed: string | undefined): Edited => {
		if (op.remove === true) {
			if (segs.length === 0) return fail('cannot remove the whole answer');
			if (current === undefined) return fail('nothing is there');
			return Result.succeed(undefined);
		}
		if (op.append !== undefined) {
			const list = current ?? [];
			if (!isList(list)) return fail('append adds to a list, and this is not one');
			const key = keyOf(k);
			if (key !== undefined) return fail(`a keyed list: add an item with set at ${op.path}/<its ${key}>`);
			const item = fits(childKind(k, '', list) ?? ANY, op.append, [...segs, String(list.length)]);
			return Result.isFailure(item) ? item : Result.succeed([...list, item.success]);
		}
		let value = op.set ?? null;
		const seg = segs.at(-1);
		if (keyed !== undefined && seg !== undefined && isObj(value)) {
			const own = keyText(value, keyed);
			if (own === undefined) value = { ...value, [keyed]: seg };
			else if (own !== seg) return fail(`the item's ${keyed} is "${own}", not "${seg}"`);
		}
		return fits(k, value, segs);
	};
	const update = (current: Json | undefined, k: Kind, i: number, keyed?: string): Edited => {
		const seg = segs[i];
		if (seg === undefined) return target(current, k, keyed);
		const here = pointer(segs.slice(0, i)) || '/';
		if ((current === undefined || current === null) && op.remove === true)
			return fail(`nothing is at ${here}`);
		const holder: Json = current ?? (k.many === true ? [] : {});
		const child = childKind(k, seg, holder);
		if (child === undefined) return fail(`${pointer(segs.slice(0, i + 1))} is not part of the output`);
		if (isList(holder)) {
			const key = keyOf(k);
			const index = indexOf(holder, seg, key);
			if (index < 0 && !(key !== undefined && i === segs.length - 1 && op.set !== undefined))
				return fail(`${here} has no item "${seg}"`);
			const updated = update(index < 0 ? undefined : holder[index], child, i + 1, key);
			if (Result.isFailure(updated)) return updated;
			const next = updated.success;
			if (next === undefined) return Result.succeed(holder.filter((_, j) => j !== index));
			if (key !== undefined) {
				const named = keyText(next, key);
				if (named === undefined) return fail(`the item needs its ${key}`);
				if (holder.some((x, j) => j !== index && keyText(x, key) === named))
					return fail(`another item of ${here} is keyed "${named}"`);
			}
			return Result.succeed(
				index < 0 ? [...holder, next] : holder.map((x, j) => (j === index ? next : x))
			);
		}
		if (isObj(holder)) {
			const updated = update(Object.hasOwn(holder, seg) ? holder[seg] : undefined, child, i + 1);
			if (Result.isFailure(updated)) return updated;
			const next = updated.success;
			return Result.succeed(
				next === undefined
					? Object.fromEntries(Object.entries(holder).filter(([f]) => f !== seg))
					: { ...holder, [seg]: next }
			);
		}
		return fail(`${here} holds ${JSON.stringify(holder)}, not an object or list`);
	};
	const edited = update(draft, kind, 0);
	if (Result.isFailure(edited)) return Result.fail(edited.failure);
	return edited.success === undefined
		? fail('cannot remove the whole answer')
		: Result.succeed(edited.success);
}

/** A declared output kind as the JSON Schema the provider constrains its answer by. */
/**
 * Without the author's `steps`, an inference has no step budget and no time limit: it goes on while it progresses, until
 * it answers (a structured one, until a submission matches). What ends a runaway is the stall window — no model token,
 * reply or tool result for STALL_MS (one liveness clock) — and the stall guards (an empty or prose
 * reply 3 times running, or a draft-only turn that leaves the answer unchanged 3 times running).
 */
export const STALL_MS = 5 * 60_000;
/** Turns that may finish the answer once tools end: a submission the output or rules refuse is repaired, not lost. */
const FINAL_TURNS = 3;
/** A rule the answer must hold beside its shape: CEL over the answer's top-level properties, and what to say when it fails. */
type Rule = { expression: string; message: string };
/** `output` as a JSON Schema (draft 2020-12) for the structure and CEL `rules` for the logic, instead of a declared kind. */
type SchemaOutput = { json_schema: Json; rules?: readonly Rule[] };

const Rules = Schema.Array(Schema.Struct({ expression: Schema.String, message: Schema.String }));
const InferOutput = Schema.Union([
	Schema.StructWithRest(
		Schema.Struct({ json_schema: Schema.Json, rules: Schema.optionalKey(Rules) }),
		[
			Schema.Record(
				Schema.String.check(Schema.makeFilter((key) => key !== 'json_schema' && key !== 'rules')),
				Schema.Never
			)
		]
	),
	KindSchema
]);
/** `ai.sys_2.infer`'s arguments; `tools` names the host tools a run lends it (the run's gate, `runs/index.ts`). */
export const InferArgs = Schema.Struct({
	tools: Schema.optionalKey(Schema.Array(Schema.String)),
	model: Schema.optionalKey(Schema.String),
	system: Schema.optionalKey(Schema.String),
	prompt: Schema.optionalKey(Schema.String),
	files: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
	output: Schema.optionalKey(InferOutput),
	rules: Schema.optionalKey(Rules),
	initial: Schema.optionalKey(Schema.Json),
	steps: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_STEPS }))),
	label: Schema.optionalKey(Schema.String)
});
export const inferArgsOf = Schema.decodeUnknownOption(InferArgs);
/** Keywords whose error repeats its children's. */
const CONTAINERS = new Set(['properties', 'items', 'prefixItems', 'additionalProperties', 'allOf', '$ref', 'dependentSchemas']);
/** A checker for a schema output: the schema's own violations as JSON Pointers into the answer. */
function schemaChecker(
	output: SchemaOutput
): Effect.Effect<(value: Json) => string[], FacilityFailure> {
	const schema = output.json_schema;
	if (typeof schema !== 'boolean' && !Predicate.isObject(schema))
		return Effect.fail(FacilityFailure.invalid('json_schema must be an object or boolean'));
	return Effect.try({
		try: () => new Validator(schema, '2020-12', false),
		catch: (error) => FacilityFailure.invalid(error instanceof Error ? error.message : String(error))
	}).pipe(
		Effect.map((validator) => (value: Json): string[] => [
			...new Set(
				validator
					.validate(value)
					// a container's error repeats its children's; the leaves name what to edit
					.errors.filter((e) => !CONTAINERS.has(e.keyword))
					.map((e) => `${e.instanceLocation.replace(/^#/, '') || '/'}: ${e.error}`)
			)
		])
	);
}
/**
 * A checker for `rules` over the answer's top-level `properties`: every rule that evaluates to false. A rule that cannot
 * evaluate (it reads a part the answer does not hold) does not apply. A rule that does not compile is the caller's fault,
 * returned as a string before any model call.
 */
function ruleChecker(
	properties: readonly string[],
	rules: readonly Rule[]
): string | ((value: Json) => string[]) {
	const scope = context(
		Object.fromEntries(properties.map((p) => [p, { kind: 'json', optional: true } as const])),
		{ numbers: 'float' }
	);
	const programs: {
		rule: Rule;
		program: Exclude<ReturnType<typeof compile>, { error: string }>;
	}[] = [];
	for (const rule of rules) {
		const program = compile(scope, rule.expression, 'bool');
		if ('error' in program) return `rule "${rule.message}" (${rule.expression}): ${program.error}`;
		programs.push({ rule, program });
	}
	return (value) => {
		const held = Predicate.isObject(value) ? value : {};
		return programs
			.filter(({ program }) =>
				Result.getOrElse(
					Result.try({
						try: () =>
							evaluate(program, Object.fromEntries(properties.map((p) => [p, held[p] ?? null]))) ===
							false,
						catch: (cause) => cause
					}),
					() => false
				)
			)
			.map(({ rule }) => `rule broken: ${rule.message} (${rule.expression})`);
	};
}

/**
 * `ctx.ai.sys_2.infer` for automations (L-BOLT-371/372): a prompt, optional files and an `output`, continued
 * across cut steps while it progresses (STALL_MS of silence ends it). Files are FileRefs the host loads. A
 * structured `output` — a declared kind, or `{ json_schema, rules }` — is built, not written in one piece: the model edits a
 * draft with `edit` (keyed pointers: a keyed list's items by key) as it finds each part, inspects it with `read`, `find`
 * and `diff`, and hands it in with `submit`. A submission is checked against `output` and every rule (the schema's and
 * the request's own `rules`); one that does not match gets every offending field (and broken rule) back and the loop goes
 * on until one matches. More files than one model request carries (MODEL_FILES) are read in batches into the same draft:
 * each batch edits in what its files add, and only the last submission is checked. With `tools` (host tools the engine
 * resolved under the run's policies) the model may call them too. `steps` bounds the turns that call tools, per batch:
 * once spent, up to FINAL_TURNS turns offer only the draft tools
 * (none for a text answer) and are told to answer, each refused submission coming back to be fixed; without a valid answer
 * from them (or already in the draft) the call fails
 * `invalid`, naming the spent budget and what the draft still breaks. An empty (reasoning-only) reply is asked to
 * continue, at most 3 times running.
 */
const NUMERAL = /^-?\d+(\.\d+)?$/;
/** A model's quoted scalar (`"true"`, `"95"`) read as the kind's own value; anything else is left for the decode to refuse. */
function unquoted(kind: Kind, value: Json): Json {
	if (value === null) return value;
	if (kind.many === true)
		return EffectArray.isArray<typeof value>(value)
			? value.map((item) => unquoted(item_kind(kind), item))
			: value;
	switch (kind.kind) {
		case 'bool': {
			const t = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
			return t === 'true' ? true : t === 'false' ? false : value;
		}
		case 'int':
		case 'number':
		case 'count':
			return typeof value === 'string' && NUMERAL.test(value.trim()) ? Number(value.trim()) : value;
		case 'json':
			return kind.shape === undefined ? value : unquoted(kind.shape, value);
		case 'record':
		case 'object':
		case 'union': {
			if (!Predicate.isObject(value) || Array.isArray(value)) return value;
			const tag = kind.kind === 'union' && 'arms' in kind ? value[kind.by] : undefined;
			const fields =
				kind.kind === 'object'
					? kind.fields
					: kind.kind === 'union' && 'arms' in kind && typeof tag === 'string'
						? kind.arms[tag]
						: undefined;
			const of = kind.kind === 'record' ? kind.of : kind.kind === 'object' ? kind.rest : undefined;
			if (fields === undefined && of === undefined) return value;
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => {
					const k = fields?.[key] ?? of;
					return [key, k === undefined ? item : unquoted(k, item)];
				})
			);
		}
		default:
			return value;
	}
}

export function infer_facility(
	ai: Ai['Service'] | undefined,
	options: {
		load?: (fileId: string) => Effect.Effect<{ mime: string; bytes: Uint8Array }, PortFailure>;
		wallMs?: number;
		/** Each answer-changing call (`edit`, `submit`) as the model makes it: the host's record of the draft's progress. */
		onDraft?: (name: string, input: Json) => Effect.Effect<void>;
		/** Each message of the transcript as it is written: the host keeps the inference's whole conversation. */
		onMessage?: (message: AiMessage, index: number, behavior: ToolBehavior) => Effect.Effect<void>;
	} = {}
) {
	return Effect.fn('Ai.inferFacility')(function* (
		call: FacilityCall,
		tools: readonly InferTool[] = []
	): Effect.fn.Return<CrossAnswer, PortFailure, Scope.Scope> {
		const signal = yield* Effect.abortSignal;
		if (call._tag !== 'ai.sys_2.infer')
			return { ok: false, error: { kind: 'unavailable', facility: call._tag, reason: 'not an agent facility' } };
		const a = yield* Schema.decodeUnknownEffect(InferArgs)(call.args[0] ?? {}).pipe(
			Effect.mapError((error) => new FacilityFailure({ kind: 'invalid', message: error.message }))
		);
		const invalid = (message: string): CrossAnswer => ({ ok: false, error: { kind: 'invalid', message } });
		const refs = a.files ?? [];
		if (refs.length > 0 && options.load === undefined)
			return {
				ok: false,
				error: { kind: 'unavailable', facility: 'files', reason: 'the host provides no file reads' }
			};
		const schemaOut = a.output !== undefined && 'json_schema' in a.output ? a.output : undefined;
		const out = a.output !== undefined && 'kind' in a.output && a.output.kind !== 'text' ? a.output : undefined;
		const structured = schemaOut !== undefined || out !== undefined;
		if (a.initial !== undefined && !structured)
			return invalid('initial requires a structured output');
		if (!structured && refs.length > MODEL_FILES.count)
			return invalid(
				`a text answer reads at most ${MODEL_FILES.count} files; ask for a structured output to read more`
			);
		const check = schemaOut === undefined ? undefined : yield* schemaChecker(schemaOut);
		const root = Predicate.isObject(schemaOut?.json_schema) ? schemaOut.json_schema : {};
		const rules = [...(schemaOut?.rules ?? []), ...(a.rules ?? [])];
		const ruled = ruleChecker(
			Object.keys(out?.kind === 'object' ? out.fields : Predicate.isObject(root['properties']) ? root['properties'] : {}),
			rules
		);
		if (typeof ruled === 'string') return invalid(ruled);
		/** The output's kind, against which edits resolve keyed pointers and check their values; ANY for a JSON Schema. */
		const kind = out ?? ANY;
		let draft: Json =
			a.initial !== undefined
				? structuredClone(a.initial)
				: out !== undefined
					? emptyOf(out)
					: schemaOut === undefined
						? null
						: root.type === 'array'
							? []
							: root.type === 'object' || root.properties !== undefined
								? {}
								: null;
		/** What `diff` compares against: the draft the call started from. */
		const original = draft;
		const onMessage = options.onMessage;
		let messageIndex = 0;
		const clock = yield* Clock.Clock;
		/** The last progress (a model token, a reply, a tool result): STALL_MS after it the inference ends. */
		let progressed = clock.currentTimeMillisUnsafe();
		const beat = () => {
			progressed = clock.currentTimeMillisUnsafe();
		};
		const shape = out !== undefined ? json_schema(out) : schemaOut?.json_schema;
		const rulesText =
			rules.length === 0
				? ''
				: `\n\nThe answer must also hold these rules (CEL over the top-level properties):\n${rules.map((r) => `- ${r.message}: ${r.expression}`).join('\n')}`;
		// the draft's reader yields its name to a workspace `read` tool
		const draftRead = tools.some((t) => t.name === 'read') ? 'read_answer' : 'read';
		const object = (properties: { [name: string]: Json }, required: readonly string[] = []): Json => ({
			type: 'object',
			additionalProperties: false,
			required: [...required],
			properties
		});
		const finishing: readonly Pick<InferTool, 'name' | 'description' | 'input' | 'behavior'>[] = !structured
			? []
			: [
					{
						name: EDIT,
						behavior: {},
						description: `Change the answer you are building. Each op names a path and exactly one of: set (replace or create the value there; missing parent objects and lists are created), remove: true, or append (add an item to the end of a list that has no key). A path is a JSON Pointer ("/a/b"), except that an item of a keyed list is addressed by its key, never its index ("/items/ANNUAL/days"; set "/items/NEW" adds the item NEW); a list without a key uses indices. Ops apply in order and each is checked on its own: the result counts those applied and names each failed op with its path, and later ops still apply. Send only what changes. Take as many turns as the answer needs (tools to check facts, more reading); when it is complete, call ${SUBMIT} in the same reply as your last ${EDIT}.`,
						input: object(
							{
								ops: {
									type: 'array',
									items: object(
										{ path: { type: 'string' }, set: {}, remove: { const: true }, append: {} },
										['path']
									)
								}
							},
							['ops']
						)
					},
					{
						name: SUBMIT,
						behavior: {},
						description: `Hand in the answer as edited so far, including any ${EDIT} earlier in this same reply (calls apply in order). It is checked against the required shape; anything wrong comes back by path, and you ${EDIT} and ${SUBMIT} again together in one reply.`,
						input: object({})
					},
					{
						name: draftRead,
						behavior: draftRead === 'read' ? { data: true } : {},
						description: `Read the answer at a path (as in ${EDIT}; "" is the whole answer). fields narrows an object to those fields, and each item of a list to its key and those fields. Reading changes nothing. A value too large to return comes back as its outline: read a child path, or pass fields.`,
						input: object(
							{ path: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } } },
							['path']
						)
					},
					{
						name: FIND,
						behavior: {},
						description: `Search the answer for text, case-insensitively: the values and field names under path (default the whole answer). Returns each matching path (as in ${EDIT}) with a short excerpt, at most ${HITS}.`,
						input: object({ text: { type: 'string' }, path: { type: 'string' } }, ['text'])
					},
					{
						name: DIFF,
						behavior: {},
						description: `What has changed in the answer since it started, under path (default the whole answer): each change's path, whether it was added, removed or changed, and the values before and after (long ones shortened). Items of keyed lists are matched by key. Use it to check your work, and to describe your changes.`,
						input: object({ path: { type: 'string' } })
					}
				];
		const drafting = new Set(finishing.map((t) => t.name));
		const inspecting = new Set([draftRead, FIND, DIFF]);
		const definitions = [...tools, ...finishing];
		const offered = definitions.map(({ name, description, input }) => ({ name, description, input }));
		const finishingOffers = finishing.map(({ name, description, input }) => ({ name, description, input }));
		const behaviorOf = new Map(definitions.map((tool): [string, ToolBehavior] => [tool.name, tool.behavior]));
		/** The draft checked against `output` and the rules: every offending field named, as keyed pointers. */
		const decoded = (raw: Json): CrossAnswer => {
			let problems: string[];
			let value = raw;
			if (check !== undefined) problems = check(value);
			else {
				if (out === undefined) return invalid('the structured output is not configured');
				const v = unquoted(out, raw);
				value = v;
				problems = decodeInput({ output: out }, { output: v }).problems.map(
					(p) => `${keyedPath(v, out, p.path.split('.').slice(1)) || '/'}: ${p.message}`
				);
			}
			problems.push(...ruled(value));
			return problems.length === 0
				? { ok: true, value }
				: invalid(
						`the answer does not match the output: ${problems.join('; ')}. Fix these with ${EDIT} at those paths and call ${SUBMIT} again in the same reply`
					);
		};

		// the transcript reaches the host as it grows: each batch's new messages before every model turn and at its end
		const recorded = new WeakMap<AiMessage[], number>();
		const record = (messages: AiMessage[]) =>
			Effect.suspend(() => {
				const from = recorded.get(messages) ?? 0;
				recorded.set(messages, messages.length);
				return onMessage === undefined
					? Effect.void
					: Effect.forEach(messages.slice(from), (message) => onMessage(message, messageIndex++,
						message.role === 'tool' && isObj(message.content) && typeof message.content['name'] === 'string'
							? behaviorOf.get(message.content['name']) ?? {} : {}), {
							discard: true
						});
			});
		const read = (files: { mime: string; bytes: Uint8Array }[], prompt: string, final: boolean) => {
			const messages: AiMessage[] = [{ role: 'user', content: prompt }];
			return batch(files, messages, final).pipe(Effect.ensuring(record(messages)));
		};
		/** One conversation over one batch of files; a batch before the last hands back its draft unchecked. */
		const batch = Effect.fn('Ai.inferBatch')(function* (
			files: { mime: string; bytes: Uint8Array }[],
			messages: AiMessage[],
			final: boolean
		): Effect.fn.Return<CrossAnswer, PortFailure> {
			const settle = (value: Json): CrossAnswer => (final ? decoded(value) : { ok: true, value });
			let carry: ModelCarry | undefined,
				pauses = 0,
				failures = 0,
				stalls = 0,
				idles = 0,
				turns = 0,
				spent = false,
				finals = 0,
				finished = false,
				last: CrossAnswer | undefined;
			for (;;) {
				// `steps` spent and the final, tool-less turn answered without a valid answer: a draft that holds one still stands
				if (finished) {
					const held = structured ? settle(draft) : undefined;
					if (held?.ok === true) return held;
					// what the draft still breaks (an unmet rule among it), else the last failed answer
					const why = held ?? last;
					return invalid(
						`the tool budget (${a.steps ?? 0} steps) was spent without a valid answer${why !== undefined && !why.ok && why.error.kind === 'invalid' ? `: ${why.error.message}` : ''}`
					);
				}
				yield* record(messages);
				const offeredTools = spent ? finishingOffers : offered;
				const stepped = yield* model_step(modelCall(
					ai,
					{
						model: a.model ?? 'default',
						...(a.system === undefined ? {} : { system: a.system }),
						messages: [...messages],
						...(offeredTools.length === 0 ? {} : { tools: offeredTools }),
						...(files.length === 0 ? {} : { files }),
						...(carry?.continuation === undefined ? {} : { continuation: carry.continuation })
					},
					{
						...(options.wallMs === undefined ? {} : { wallMs: options.wallMs }),
						retryUpstream: TRANSIENT_RETRIES,
						onDelta: beat,
						onReasoning: beat
					}
				), carry).pipe(Effect.catch((e) => Effect.succeed(e)));
				beat();
				// ended from outside (a stop, the caller's own wall): the last failed submission says more than a bare timeout
				if (signal.aborted)
					return last !== undefined && !last.ok
						? last
						: { ok: false, error: { kind: 'timeout', message: 'the inference was ended before it answered' } };
				// a silent model call stalls one turn, never the whole inference: ask again (for smaller calls when it went
				// silent writing one); past the last try a draft that already holds is the answer
				if (stepped instanceof ModelIdle) {
					if (++idles <= PAUSES) {
						if (stepped.cutTool === true)
							messages.push({
								role: 'user',
								content: `Your last reply went silent while you were still writing a tool call. Make smaller calls: one row, or a few fields, per ${EDIT}.`
							});
						continue;
					}
					const held = structured ? settle(draft) : undefined;
					if (held?.ok === true) return held;
				}
				if (isFacilityError(stepped))
					return {
						ok: false,
						error:
							stepped instanceof Unavailable
								? { kind: 'unavailable', facility: stepped.facility, reason: stepped.reason }
								: {
										kind: stepped.kind,
										message: stepped.message,
										...(stepped.status === undefined ? {} : { status: stepped.status })
									}
					};
				const { response: r, content: whole, calls } = stepped;
				idles = 0;
				if (r.finish === 'cut') {
					carry = stepped.carry;
					messages.push({ role: 'assistant', content: stepped.segment.text });
					continue;
				}
				finished = spent && (calls.length === 0 || ++finals >= FINAL_TURNS);
				carry = undefined;
				if (r.tool_calls.length > 0) {
					const before = JSON.stringify(draft);
					messages.push({
						role: 'assistant',
						content: {
							text: typeof r.content === 'string' ? r.content : '',
							toolCalls: calls
						}
					});
					const completed = yield* run_calls<CrossAnswer, PortFailure, never>(calls, Effect.fn('Ai.inferCall')(function* (c, invalid, stopped) {
						let result: Json, submitted: CrossAnswer | undefined;
						if (!stopped && invalid === undefined && (c.name === EDIT || c.name === SUBMIT) && structured && options.onDraft !== undefined)
							yield* options.onDraft(c.name, c.input);
						if (stopped) result = { skipped: 'An earlier call submitted this step; no later operation ran.' };
						else if (invalid !== undefined) result = invalid;
						else if (c.name === EDIT && structured) {
							const ops = Option.getOrUndefined(Schema.decodeUnknownOption(EditInput)(c.input))?.ops;
							if (ops === undefined)
								result = { error: `${EDIT} takes { ops: [{ path, set | remove | append }] }` };
							else {
								const errors: Json[] = [];
								for (const [i, op] of ops.entries()) {
									const edited = yield* Schema.decodeUnknownEffect(EditOp)(op).pipe(
										Effect.flatMap((decoded) => Effect.fromResult(applyEdit(draft, decoded, kind))),
										Effect.result
									);
									if (Result.isSuccess(edited)) draft = edited.success;
									else errors.push({ op: i, error: edited.failure.message });
								}
								result = { applied: ops.length - errors.length, ...(errors.length === 0 ? {} : { errors }) };
							}
						} else if (c.name === draftRead && structured) {
							const input = Option.getOrUndefined(Schema.decodeUnknownOption(ReadInput)(c.input));
							const at = input === undefined ? `${draftRead} takes { path, fields? }` : resolve(draft, input.path, kind);
							if (typeof at === 'string') result = { error: at };
							else {
								const value = input?.fields === undefined ? at.value : project(at.value, at.kind, input.fields);
								const key = keyOf(at.kind);
								// too large to return: its outline, so the model reads a narrower path
								result =
									size(value) <= BOUNDS.resultBytes - 200
										? { value }
										: {
												clipped: `the value is ${size(value)} bytes, too large to return: read a child path, or pass fields`,
												...(isList(value)
													? {
															items: value.length,
															...(key === undefined
																? {}
																: { keys: value.slice(0, 200).map((x) => keyText(x, key) ?? null) })
														}
													: isObj(value)
														? { fields: Object.keys(value) }
														: {})
											};
							}
						} else if (c.name === FIND && structured) {
							const input = Option.getOrUndefined(Schema.decodeUnknownOption(FindInput)(c.input));
							if (input === undefined) result = { error: `${FIND} takes { text, path? }` };
							else {
								const at = resolve(draft, input.path ?? '', kind);
								const hits = typeof at === 'string' ? [] : find(at.value, at.kind, input.path ?? '', input.text);
								result =
									typeof at === 'string'
										? { error: at }
										: {
												matches: hits.slice(0, HITS),
												...(hits.length > HITS ? { more: `${hits.length - HITS} more: narrow with path or a longer text` } : {})
											};
							}
						} else if (c.name === DIFF && structured) {
							const path = Option.getOrUndefined(Schema.decodeUnknownOption(DiffInput)(c.input))?.path ?? '';
							const now = resolve(draft, path, kind),
								then = resolve(original, path, kind);
							if (typeof now === 'string' && typeof then === 'string') result = { error: now };
							else {
								const changes: JsonChange[] = [];
								diffAt(
									typeof then === 'string' ? undefined : then.value,
									typeof now === 'string' ? undefined : now.value,
									typeof now !== 'string' ? now.kind : typeof then !== 'string' ? then.kind : ANY,
									path,
									changes
								);
								const shown = (v: Json): Json => {
									const t = JSON.stringify(v);
									return t.length <= SHOWN ? v : `${t.slice(0, SHOWN)}… (shortened: read the path)`;
								};
								result = {
									changes: changes.slice(0, CHANGES).map((change) => ({
										path: change.path,
										kind: change.kind,
										...(change.before === undefined ? {} : { before: shown(change.before) }),
										...(change.after === undefined ? {} : { after: shown(change.after) })
									})),
									...(changes.length > CHANGES ? { more: `${changes.length - CHANGES} more: narrow with path` } : {})
								};
							}
						} else if (c.name === SUBMIT && structured) {
							last = settle(draft);
							if (last.ok) { submitted = last; result = { submitted: true }; }
							else result = { error: last.error.kind === 'invalid' ? last.error.message : 'invalid' };
						} else {
							const tool = spent ? undefined : tools.find((t) => t.name === c.name);
							result =
								tool === undefined
									? { error: `there is no tool '${c.name}'` }
									: yield* tool.call(c.input).pipe(Effect.catch((e) => Effect.succeed({ error: e.message })));
						}
						messages.push({ role: 'tool', content: { id: c.id, name: c.name, result: bound(result) } });
						beat();
						return submitted === undefined ? Option.none() : Option.some(submitted);
					}));
					if (Option.isSome(completed)) return completed.value;
					// a turn of only draft tools that leaves the draft as it was is no progress: 3 running end the call. Under a
					// `steps` budget a read-only turn is exploration the budget already bounds, not a stall.
					if (
						structured &&
						r.tool_calls.every((c) => drafting.has(c.name)) &&
						(a.steps === undefined || r.tool_calls.some((c) => !inspecting.has(c.name))) &&
						JSON.stringify(draft) === before
					) {
						// a model that re-edits instead of submitting: a draft that already holds is the answer
						const held = r.tool_calls.some((c) => c.name === EDIT) ? settle(draft) : undefined;
						if (held?.ok === true) return held;
						if (++stalls > FAILURES) return last ?? invalid(`the model's last ${FAILURES + 1} turns left its answer unchanged`);
					} else stalls = 0;
					// the step budget ends the tools: one final turn answers
					if (!spent && a.steps !== undefined && ++turns >= a.steps) {
						spent = true;
						const budget = `Your tool budget of ${a.steps} steps is spent`;
						messages.push({
							role: 'user',
							content: structured
								? `${budget}: no more tools. Finish the answer now with ${EDIT} from what you have found, and call ${SUBMIT} in this reply.`
								: `${budget}: no more tools. Give your answer now from what you have found.`
						});
					}
					continue;
				}
				if (typeof whole === 'string' && whole.trim() === '') {
					// a reply of reasoning alone: ask it to go on
					if (++pauses > PAUSES) return invalid(`the model answered nothing ${PAUSES + 1} times running`);
					messages.push({ role: 'user', content: 'Continue, and give your answer.' });
					continue;
				}
				pauses = 0;
				if (!structured) { messages.push({ role: 'assistant', content: textOf(r.content) }); return { ok: true, value: textOf(whole) }; }
				// a structured answer written out as text instead: a well-formed one is taken as a submission of it
				const parsed =
					typeof whole === 'string' ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(whole)) : whole;
				let feedback: string | undefined;
				if (parsed !== undefined) {
					last = settle(parsed);
					if (last.ok) { messages.push({ role: 'assistant', content: textOf(r.content) }); return last; }
					feedback = last.error.kind === 'invalid' ? last.error.message : 'That answer does not match the output';
					draft = parsed;
				}
				if (++failures > FAILURES)
					return last ?? invalid(`the model did not build its answer with ${EDIT} and ${SUBMIT}`);
				messages.push(
					{ role: 'assistant', content: textOf(r.content) },
					{
						role: 'user',
						content:
							feedback === undefined
								? `Build the answer with ${EDIT} and hand it in with ${SUBMIT}; do not write it out.`
								: `${feedback}. It is now your draft: fix it with ${EDIT}, then call ${SUBMIT}.`
					}
				);
			}
		});

		const ask = (lead: string) =>
			!structured
				? (a.prompt ?? '')
				: `${a.prompt ?? ''}\n\n${lead}Use other tools and more turns whenever you need to check something; once the answer is complete, call ${SUBMIT} in the same reply as your last ${EDIT}. ${a.initial === undefined ? `Build your answer with ${EDIT}, starting from ${JSON.stringify(draft)}` : `Your answer is already initialized in memory. Use ${draftRead} and ${FIND} to inspect it and ${EDIT} to change only the paths that need it`}, into this JSON Schema, then call ${SUBMIT}:\n\n\`\`\`json\n${JSON.stringify(shape, null, 2)}\n\`\`\`${rulesText}`;
		const answering = Effect.gen(function* (): Effect.fn.Return<CrossAnswer, PortFailure> {
			if (refs.length === 0) return yield* read([], ask(''), true);
			// files load a batch at a time, so a thousand scans are never all in memory at once
			let from = 0;
			while (from < refs.length) {
				const batch: { mime: string; bytes: Uint8Array }[] = [];
				let bytes = 0;
				while (from + batch.length < refs.length && batch.length < MODEL_FILES.count) {
					const loader = options.load;
					if (loader === undefined) return invalid('the host provides no file reads');
					const ref = refs[from + batch.length];
					if (ref === undefined) break;
					const file = yield* loader(ref.id);
					if (batch.length > 0 && bytes + file.bytes.length > MODEL_FILES.bytes) break; // ponytail: the file that overflows is loaded again with the next batch
					batch.push(file);
					bytes += file.bytes.length;
				}
				const to = from + batch.length,
					final = to === refs.length;
				const lead =
					refs.length <= batch.length
						? ''
						: `You are reading ${refs.length} source files in batches; these are files ${from + 1}–${to}.${from === 0 ? '' : ` The draft below already holds what files 1–${from} gave: keep it, append to its lists, fill what it lacks, and change a value only where these files show it differently.`} ${final ? `These are the last files: call ${SUBMIT} when the whole answer is complete; it is then checked.` : `Add everything these files hold with ${EDIT}, then call ${SUBMIT} to move on to the next files; the answer is checked after the last batch.`}\n\n`;
				const answer = yield* read(batch, ask(lead), final);
				if (!answer.ok || final) return answer;
				draft = answer.value;
				from = to;
			}
			return invalid('no files were read');
		});
		// the stall window: STALL_MS without progress ends the inference, with the answer its draft already holds if any
		const stalled = Effect.gen(function* (): Effect.fn.Return<CrossAnswer> {
			for (;;) {
				const quiet = clock.currentTimeMillisUnsafe() - progressed;
				if (quiet >= STALL_MS) break;
				yield* Effect.sleep(STALL_MS - quiet);
			}
			const held = structured ? decoded(draft) : undefined;
			return held?.ok === true
				? held
				: { ok: false, error: { kind: 'timeout', message: `the inference made no progress for ${STALL_MS / 60_000} minutes` } };
		});
		return yield* Effect.raceFirst(answering, stalled);
	}, Effect.scoped);
}
