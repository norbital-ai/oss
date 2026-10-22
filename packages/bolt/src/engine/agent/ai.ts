// The AI port's `sys_2` (the LLM) under the 20 s idle wall (rules 63, 72): each model request is one facility call. The wall is
// idle time: every token received (answer or reasoning) restarts it, so a model streaming its reasoning is never cut. A
// stream silent for the wall is closed and its partial output kept as a cut step the next request continues; a request
// that yields nothing within it is `timeout` (OD-13). `model` is a class or a catalog id; any other is `unavailable`.
import {
	Cause,
	Clock,
	Effect,
	Option,
	Predicate,
	Result,
	Schedule,
	Schema,
	Stream,
	type Scope
} from 'effect';
import { FacilityFailure, Unavailable } from '../../decl/errors.ts';
import type { Ai, AiEvent } from '../ports.ts';
import { Port, type PortFailure } from '../port.ts';
import type { FacilityCall } from '../services.ts';
import type { Json } from '../../decl/values.ts';
import { encodeWire } from '@norbital-ai/std/wire';
import {
	LIMITS,
	type AiMessage,
	type AiRequest,
	type AiResponse,
	type CrossAnswer
} from '../contracts.ts';
import { decodeInput } from '../callables/decode.ts';
import type { Kind } from '@norbital-ai/std/kind';
import { RequestOutput } from '../integrations/instances.ts';
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
import { compile, context, evaluate } from '@norbital-ai/std/formula';

/** Rule 72: a platform budget checked before the provider's own limit. */
export const MODEL_FILES = { count: 8, bytes: 20 * 1024 * 1024 } as const;
/** What a message may carry (envoy and panel alike): images, text, and the documents `read_attachment` reads; 8 files / 20 MiB a message. */
export const ATTACHMENT_MIME =
	/^(image\/[\w.+-]+|text\/[\w.+-]+|application\/(pdf|json|(?:[\w.-]+\+)?xml|vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.document|spreadsheetml\.sheet)))$/;
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
/** Silence interrupts the upstream pull; every response/progress event restarts the wall. */
export const modelCall = Effect.fn('Ai.modelCall')(function* (
	ai: Ai['Service'] | undefined,
	request: AiRequest,
	options: {
		wallMs?: number | undefined;
		onDelta?: ((text: string) => void) | undefined;
		onReasoning?: ((text: string) => void) | undefined;
	} = {}
) {
	if (ai === undefined)
		return yield* Effect.fail(
			new Unavailable({ facility: 'ai', reason: 'the host provides no ai' })
		);
	if (!(yield* servesModel(ai, request.model)))
		return yield* Effect.fail(
			new Unavailable({
				facility: 'ai',
				reason: `no model is mapped to the class '${request.model}'`
			})
		);
	const files = request.files ?? [];
	if (
		files.length > MODEL_FILES.count ||
		files.reduce((n, f) => n + f.bytes.length, 0) > MODEL_FILES.bytes
	)
		return yield* Effect.fail(
			new FacilityFailure({
				kind: 'invalid',
				message: `a model call takes at most ${MODEL_FILES.count} files and 20 MiB`
			})
		);
	const wallMs = options.wallMs ?? LIMITS.callMs.ai;
	let partial = '',
		reasoning = '',
		progressed = false;
	let response: AiResponse | undefined;
	// Each pull races a native sleep. Business time may be frozen or adjusted independently.
	yield* Stream.transformPull(ai.infer(request), (pull) => {
		let finished = false;
		const idle = (cause?: FacilityFailure): Effect.Effect<readonly [AiEvent], FacilityFailure> =>
			Effect.suspend(() => {
				finished = true;
				if (partial === '')
					return Effect.fail(
						progressed
							? new ModelIdle(`the model was still writing a tool call at ${wallMs} ms`, true)
							: (cause ?? new ModelIdle(`the model yielded nothing within ${wallMs} ms`))
					);
				const cut: AiResponse = {
					content: partial,
					toolCalls: [],
					finish: 'cut',
					...(reasoning === '' ? {} : { reasoning }),
					usage: { input: 0, output: 0 }
				};
				const events: readonly [AiEvent] = [{ _tag: 'Response', response: cut }];
				return Effect.succeed(events);
			});
		return Effect.succeed(
			Effect.suspend(() =>
				finished
					? Cause.done()
					: pull.pipe(
							Effect.catchTag('FacilityFailure', (cause) =>
								cause.kind === 'timeout' ? idle(cause) : Effect.fail(cause)
							),
							Effect.timeoutOrElse({
								duration: wallMs,
								orElse: () => idle()
							})
						)
			)
		);
	}).pipe(
		Stream.runForEach((event) =>
			Effect.sync(() => {
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
		)
	);
	if (response === undefined)
		return yield* Effect.fail(
			new FacilityFailure({
				kind: 'upstream',
				message: 'the model stream ended without a response'
			})
		);
	return response;
});

export const textOf = (content: Json): string => {
	if (typeof content === 'string') return content;
	const t =
		content !== null && typeof content === 'object' && !Array.isArray(content)
			? (content as { text?: Json }).text
			: undefined;
	return typeof t === 'string' ? t : JSON.stringify(content);
};

/** A tool `ctx.ai.sys_2.infer` offers the model (rule 58: a host tool its run's `runAs` policies name); a throw is a failed result. */
export type InferTool = {
	name: string;
	description: string;
	input: Json;
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
	k.kind === 'list'
		? []
		: k.kind === 'object' || k.kind === 'record' || k.kind === 'json'
			? {}
			: null;
/**
 * One `edit` operation on `draft` (never changed in place) against the output `kind` (ANY for a JSON Schema output),
 * returning the new draft. `set` replaces or creates the value at a keyed pointer, creating missing parent objects and
 * lists; `set` at `/list/KEY` of a keyed list adds or replaces that item and fills its key field. `append` adds to an
 * unkeyed list; `remove: true` deletes. A set or appended value is checked against its kind (quoted scalars read as the
 * kind) and a keyed item keeps a distinct key. Throws the operation's problem, led by its path.
 */
export function applyEdit(draft: Json, op: typeof EditOp.Type, kind: Kind): Json {
	function fail(why: string): never {
		throw new Error(`${op.path || '/'}: ${why}`);
	}
	if ([op.set, op.remove, op.append].filter((v) => v !== undefined).length !== 1)
		fail('give exactly one of set, remove and append');
	const segs = segments(op.path) ?? fail('a path is "" or starts with "/"');
	const fits = (k: Kind, value: Json, at: readonly string[]): Json => {
		const v = unquoted(k, value);
		const problems = decodeInput({ v: k }, { v }).problems;
		if (problems.length > 0)
			throw new Error(
				problems
					.map(
						(p) =>
							`${pointer(at) + keyedPath(v, k, p.path.split('.').slice(1)) || '/'}: ${p.message}`
					)
					.join('; ')
			);
		return v;
	};
	const target = (
		current: Json | undefined,
		k: Kind,
		keyed: string | undefined
	): Json | undefined => {
		if (op.remove === true) {
			if (segs.length === 0) fail('cannot remove the whole answer');
			if (current === undefined) fail('nothing is there');
			return undefined;
		}
		if (op.append !== undefined) {
			const list = current ?? [];
			if (!isList(list)) fail('append adds to a list, and this is not one');
			const key = keyOf(k);
			if (key !== undefined) fail(`a keyed list: add an item with set at ${op.path}/<its ${key}>`);
			return [
				...list,
				fits(childKind(k, '', list) ?? ANY, op.append, [...segs, String(list.length)])
			];
		}
		let value = op.set ?? null;
		const seg = segs.at(-1);
		if (keyed !== undefined && seg !== undefined && isObj(value)) {
			const own = keyText(value, keyed);
			if (own === undefined) value = { ...value, [keyed]: seg };
			else if (own !== seg) fail(`the item's ${keyed} is "${own}", not "${seg}"`);
		}
		return fits(k, value, segs);
	};
	const update = (
		current: Json | undefined,
		k: Kind,
		i: number,
		keyed?: string
	): Json | undefined => {
		const seg = segs[i];
		if (seg === undefined) return target(current, k, keyed);
		const here = pointer(segs.slice(0, i)) || '/';
		const holder =
			current ?? (op.remove === true ? fail(`nothing is at ${here}`) : k.kind === 'list' ? [] : {});
		const child =
			childKind(k, seg, holder) ??
			fail(`${pointer(segs.slice(0, i + 1))} is not part of the output`);
		if (isList(holder)) {
			const key = keyOf(k);
			const index = indexOf(holder, seg, key);
			if (index < 0 && !(key !== undefined && i === segs.length - 1 && op.set !== undefined))
				fail(`${here} has no item "${seg}"`);
			const next = update(index < 0 ? undefined : holder[index], child, i + 1, key);
			if (next === undefined) return holder.filter((_, j) => j !== index);
			if (key !== undefined) {
				const named = keyText(next, key);
				if (named === undefined) fail(`the item needs its ${key}`);
				if (holder.some((x, j) => j !== index && keyText(x, key) === named))
					fail(`another item of ${here} is keyed "${named}"`);
			}
			return index < 0 ? [...holder, next] : holder.map((x, j) => (j === index ? next : x));
		}
		if (isObj(holder)) {
			const next = update(Object.hasOwn(holder, seg) ? holder[seg] : undefined, child, i + 1);
			return next === undefined
				? Object.fromEntries(Object.entries(holder).filter(([f]) => f !== seg))
				: { ...holder, [seg]: next };
		}
		return fail(`${here} holds ${JSON.stringify(holder)}, not an object or list`);
	};
	return update(draft, kind, 0) ?? fail('cannot remove the whole answer');
}

/** A declared output kind (§3.3.2) as the JSON Schema the provider constrains its answer by. */
function jsonSchemaOf(k: Kind): Json {
	switch (k.kind) {
		case 'text':
			return { type: 'string', ...(k['max'] === undefined ? {} : { maxLength: Number(k['max']) }) };
		case 'int':
			return { type: 'integer' };
		case 'number':
			return { type: 'number' };
		case 'decimal':
		case 'money':
			return { type: ['number', 'string'] };
		case 'bool':
			return { type: 'boolean' };
		case 'date':
			return { type: 'string', format: 'date' };
		case 'instant':
			return { type: 'string', format: 'date-time' };
		case 'enum':
			return { enum: [...k.values] };
		case 'id':
			return { type: 'string', format: 'uuid' };
		case 'vector':
			return { type: 'array', items: { type: 'number' } };
		case 'list': {
			const key = keyOf(k);
			return {
				type: 'array',
				items: jsonSchemaOf(k.of),
				...(key === undefined
					? {}
					: {
							description: `Keyed by "${key}": an item's path is …/<its ${key}>, never its index.`
						})
			};
		}
		case 'record':
			return { type: 'object', additionalProperties: jsonSchemaOf(k.of) };
		case 'object': {
			const fields = Object.entries(k.fields);
			return {
				type: 'object',
				additionalProperties: k.rest === undefined ? false : jsonSchemaOf(k.rest),
				properties: Object.fromEntries(fields.map(([f, x]) => [f, jsonSchemaOf(x)])),
				required: fields
					.filter(([, x]) => x.optional !== true && x['default'] === undefined)
					.map(([f]) => f)
			};
		}
		case 'union':
			return 'of' in k
				? { anyOf: k.of.map(jsonSchemaOf) }
				: {
						anyOf: Object.entries(k.arms).map(([tag, fields]) =>
							jsonSchemaOf({
								kind: 'object',
								fields: { ...fields, [k.by]: { kind: 'enum', values: [tag] } }
							})
						)
					};
		default:
			return {};
	}
}

/**
 * Without the author's `steps`, an inference has no step budget: it goes on until it answers (a structured one, until a
 * submission matches). What ends a runaway is then this ceiling, per batch of files the model reads (MODEL_FILES) — at ANSWER_BY of it the tools end and one final turn answers — and the stall guards (an empty or prose reply 3
 * times running, or a draft-only turn that leaves the answer unchanged 3 times running).
 */
const INFER_MS = 30 * 60_000;
/** Past this share of INFER_MS a batch's tools end and its final turn answers, as when `steps` is spent. */
const ANSWER_BY = 0.8;
/** The ceiling on one `sys_2.infer` call: INFER_MS for every batch of files it reads. ponytail: counts batches by file count only; a byte-split batch adds a step under the same ceiling. */
export const inferMs = (args: readonly Json[]): number =>
	INFER_MS *
	Math.max(
		1,
		Math.ceil(((args[0] as { files?: unknown[] } | null)?.files?.length ?? 0) / MODEL_FILES.count)
	);

/** A rule the answer must hold beside its shape: CEL over the answer's top-level properties, and what to say when it fails. */
type Rule = { expression: string; message: string };
/** `output` as a JSON Schema (draft 2020-12) for the structure and CEL `rules` for the logic, instead of a declared kind. */
type SchemaOutput = { jsonSchema: Json; rules?: readonly Rule[] };
const isSchemaOutput = (o: unknown): o is SchemaOutput =>
	o !== null && typeof o === 'object' && 'jsonSchema' in o;

const Rules = Schema.Array(Schema.Struct({ expression: Schema.String, message: Schema.String }));
const InferOutput = Schema.Union([
	Schema.Struct({ jsonSchema: Schema.Json, rules: Schema.optionalKey(Rules) }),
	RequestOutput
]);
const InferArgs = Schema.Struct({
	model: Schema.optionalKey(Schema.String),
	system: Schema.optionalKey(Schema.String),
	prompt: Schema.optionalKey(Schema.String),
	files: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
	output: Schema.optionalKey(InferOutput),
	rules: Schema.optionalKey(Rules),
	initial: Schema.optionalKey(Schema.Json),
	steps: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_STEPS })))
});
/** A checker for a schema output: the schema's own violations as JSON Pointers into the answer. */
function schemaChecker(output: SchemaOutput): (value: Json) => string[] {
	const schema = output.jsonSchema;
	if (typeof schema !== 'boolean' && !Predicate.isObject(schema))
		throw new Error('jsonSchema must be an object or boolean');
	const validator = new Validator(schema, '2020-12', false);
	return (value) => [
		...new Set(
			validator
				.validate(value)
				// a container's error repeats its children's; the leaves name what to edit
				.errors.filter(
					(e) =>
						![
							'properties',
							'items',
							'prefixItems',
							'additionalProperties',
							'allOf',
							'$ref',
							'dependentSchemas'
						].includes(e.keyword)
				)
				.map((e) => `${e.instanceLocation.replace(/^#/, '') || '/'}: ${e.error}`)
		)
	];
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
 * `ctx.ai.sys_2.infer` for automations (rule 63, L-BOLT-371/372): a prompt, optional files and an `output`, continued
 * across cut steps (INFER_MS per batch bounds the call). Files are FileRefs the host loads. A
 * structured `output` — a declared kind, or `{ jsonSchema, rules }` — is built, not written in one piece: the model edits a
 * draft with `edit` (keyed pointers: a keyed list's items by key) as it finds each part, inspects it with `read`, `find`
 * and `diff`, and hands it in with `submit`. A submission is checked against `output` and every rule (the schema's and
 * the request's own `rules`); one that does not match gets every offending field (and broken rule) back and the loop goes
 * on until one matches. More files than one model request carries (MODEL_FILES) are read in batches into the same draft:
 * each batch edits in what its files add, and only the last submission is checked. With `tools` (host tools the engine
 * resolved under the run's policies) the model may call them too. `steps` bounds the turns that call tools, per batch, and
 * so does 80% of the time ceiling, whichever comes first: once spent, one final turn offers only the draft tools (none for
 * a text answer) and is told to answer; without a valid answer from it (or already in the draft) the call fails
 * `invalid`, naming the spent budget and what the draft still breaks. An empty (reasoning-only) reply is asked to
 * continue, at most 3 times running.
 */
const NUMERAL = /^-?\d+(\.\d+)?$/;
/** A model's quoted scalar (`"true"`, `"95"`) read as the kind's own value; anything else is left for the decode to refuse. */
function unquoted(kind: Kind, value: Json): Json {
	if (value === null) return value;
	switch (kind.kind) {
		case 'bool': {
			const t = typeof value === 'string' ? value.trim().toLowerCase() : undefined;
			return t === 'true' ? true : t === 'false' ? false : value;
		}
		case 'int':
		case 'number':
		case 'count':
		case 'duration':
			return typeof value === 'string' && NUMERAL.test(value.trim()) ? Number(value.trim()) : value;
		case 'json':
			return kind.shape === undefined ? value : unquoted(kind.shape, value);
		case 'list':
			return Array.isArray(value) ? value.map((item) => unquoted(kind.of, item)) : value;
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

export function inferFacility(
	ai: Ai['Service'] | undefined,
	options: {
		load?: (fileId: string) => Effect.Effect<{ mime: string; bytes: Uint8Array }, PortFailure>;
		wallMs?: number;
	} = {}
) {
	return Effect.fn('Ai.inferFacility')(function* (
		call: FacilityCall,
		tools: readonly InferTool[] = []
	): Effect.fn.Return<CrossAnswer, PortFailure, Scope.Scope> {
		const signal = yield* Effect.abortSignal;
		if (call._tag !== 'ai.sys_2.infer')
			return {
				ok: false,
				error: {
					kind: 'unavailable',
					facility: call._tag,
					reason: 'not an agent facility'
				}
			};
		const a = yield* Schema.decodeUnknownEffect(InferArgs)(call.args[0] ?? {}).pipe(
			Effect.mapError((error) => new FacilityFailure({ kind: 'invalid', message: error.message }))
		);
		const invalid = (message: string): CrossAnswer => ({
			ok: false,
			error: { kind: 'invalid', message }
		});
		const refs = a.files ?? [];
		if (refs.length > 0 && options.load === undefined)
			return {
				ok: false,
				error: { kind: 'unavailable', facility: 'files', reason: 'the host provides no file reads' }
			};
		const schemaOut = isSchemaOutput(a.output) ? a.output : undefined;
		const out =
			a.output !== undefined && 'kind' in a.output && a.output.kind !== 'text'
				? a.output
				: undefined;
		const structured = schemaOut !== undefined || out !== undefined;
		if (a.initial !== undefined && !structured)
			return invalid('initial requires a structured output');
		if (!structured && refs.length > MODEL_FILES.count)
			return invalid(
				`a text answer reads at most ${MODEL_FILES.count} files; ask for a structured output to read more`
			);
		let check: ((value: Json) => string[]) | undefined;
		if (schemaOut !== undefined)
			check = yield* Effect.try({
				try: () => schemaChecker(schemaOut),
				catch: (error) =>
					new FacilityFailure({
						kind: 'invalid',
						message: error instanceof Error ? error.message : String(error)
					})
			});
		const root = Predicate.isObject(schemaOut?.jsonSchema) ? schemaOut.jsonSchema : {};
		const rules = [...(schemaOut?.rules ?? []), ...(a.rules ?? [])];
		const ruled = ruleChecker(
			Object.keys(
				out?.kind === 'object'
					? out.fields
					: Predicate.isObject(root['properties'])
						? root['properties']
						: {}
			),
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
		const shape = out !== undefined ? jsonSchemaOf(out) : schemaOut?.jsonSchema;
		const rulesText =
			rules.length === 0
				? ''
				: `\n\nThe answer must also hold these rules (CEL over the top-level properties):\n${rules.map((r) => `- ${r.message}: ${r.expression}`).join('\n')}`;
		// the draft's reader yields its name to a workspace `read` tool
		const draftRead = tools.some((t) => t.name === 'read') ? 'read_answer' : 'read';
		const object = (
			properties: { [name: string]: Json },
			required: readonly string[] = []
		): Json => ({
			type: 'object',
			additionalProperties: false,
			required: [...required],
			properties
		});
		const finishing = !structured
			? []
			: [
					{
						name: EDIT,
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
						description: `Hand in the answer as edited so far, including any ${EDIT} earlier in this same reply (calls apply in order). It is checked against the required shape; anything wrong comes back by path, and you ${EDIT} and ${SUBMIT} again together in one reply.`,
						input: object({})
					},
					{
						name: draftRead,
						description: `Read the answer at a path (as in ${EDIT}; "" is the whole answer). fields narrows an object to those fields, and each item of a list to its key and those fields. Reading changes nothing. A value too large to return comes back as its outline: read a child path, or pass fields.`,
						input: object(
							{ path: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } } },
							['path']
						)
					},
					{
						name: FIND,
						description: `Search the answer for text, case-insensitively: the values and field names under path (default the whole answer). Returns each matching path (as in ${EDIT}) with a short excerpt, at most ${HITS}.`,
						input: object({ text: { type: 'string' }, path: { type: 'string' } }, ['text'])
					},
					{
						name: DIFF,
						description: `What has changed in the answer since it started, under path (default the whole answer): each change's path, whether it was added, removed or changed, and the values before and after (long ones shortened). Items of keyed lists are matched by key. Use it to check your work, and to describe your changes.`,
						input: object({ path: { type: 'string' } })
					}
				];
		const drafting = new Set(finishing.map((t) => t.name));
		const inspecting = new Set([draftRead, FIND, DIFF]);
		const offered = [
			...tools.map(({ name, description, input }) => ({ name, description, input })),
			...finishing
		];
		/** The draft checked against `output` and the rules: every offending field named (rule 23), as keyed pointers. */
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

		/** One conversation over one batch of files; a batch before the last hands back its draft unchecked. */
		const read = Effect.fn('Ai.inferBatch')(function* (
			files: { mime: string; bytes: Uint8Array }[],
			prompt: string,
			final: boolean
		): Effect.fn.Return<CrossAnswer, PortFailure> {
			const settle = (value: Json): CrossAnswer => (final ? decoded(value) : { ok: true, value });
			const messages: AiMessage[] = [{ role: 'user', content: prompt }];
			const answerBy = (yield* Clock.currentTimeMillis) + INFER_MS * ANSWER_BY;
			let text = '',
				continuation: string | undefined,
				cutAt: number | undefined,
				pauses = 0,
				failures = 0,
				stalls = 0,
				turns = 0,
				spent = false,
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
						`the tool budget (${a.steps ?? 'no'} steps, ${(INFER_MS * ANSWER_BY) / 60_000} minutes) was spent without a valid answer${why !== undefined && !why.ok && why.error.kind === 'invalid' ? `: ${why.error.message}` : ''}`
					);
				}
				const tooling = spent ? finishing : offered;
				const r = yield* modelCall(
					ai,
					{
						model: a.model ?? 'default',
						...(a.system === undefined ? {} : { system: a.system }),
						messages: [...messages],
						...(tooling.length === 0 ? {} : { tools: tooling }),
						...(files.length === 0 ? {} : { files }),
						...(continuation === undefined ? {} : { continuation })
					},
					{ ...(options.wallMs === undefined ? {} : { wallMs: options.wallMs }) }
				).pipe(
					Effect.retry({
						schedule: Schedule.spaced('250 millis'),
						times: 2,
						while: isTransientUpstream
					}),
					Effect.catch((e) => Effect.succeed(e))
				);
				// the ceiling on the whole call: the last failed submission says more than a bare timeout
				if (signal.aborted)
					return last !== undefined && !last.ok
						? last
						: {
								ok: false,
								error: {
									kind: 'timeout',
									message: 'the inference did not finish within its ceiling'
								}
							};
				if (isFacilityError(r))
					return {
						ok: false,
						error:
							r instanceof Unavailable
								? { kind: 'unavailable', facility: r.facility, reason: r.reason }
								: {
										kind: r.kind,
										message: r.message,
										...(r.status === undefined ? {} : { status: r.status })
									}
					};
				if (r.finish === 'cut') {
					cutAt ??= messages.length;
					text += textOf(r.content);
					continuation = r.continuation;
					messages.splice(cutAt, messages.length - cutAt, { role: 'assistant', content: text });
					continue;
				}
				finished = spent;
				const whole: Json = text === '' ? r.content : text + textOf(r.content);
				if (cutAt !== undefined) messages.splice(cutAt);
				text = '';
				continuation = undefined;
				cutAt = undefined;
				if (r.toolCalls.length > 0) {
					const before = JSON.stringify(draft);
					messages.push({
						role: 'assistant',
						content: {
							text: typeof whole === 'string' ? whole : '',
							toolCalls: encodeWire(r.toolCalls)
						}
					});
					for (const c of r.toolCalls) {
						let result: Json;
						if (c.name === EDIT && structured) {
							const ops = Option.getOrUndefined(
								Schema.decodeUnknownOption(EditInput)(c.input)
							)?.ops;
							if (ops === undefined)
								result = { error: `${EDIT} takes { ops: [{ path, set | remove | append }] }` };
							else {
								const errors: Json[] = [];
								for (const [i, op] of ops.entries()) {
									const edited = Result.try({
										try: () => applyEdit(draft, Schema.decodeUnknownSync(EditOp)(op), kind),
										catch: (cause) => (cause instanceof Error ? cause.message : String(cause))
									});
									if (Result.isSuccess(edited)) draft = edited.success;
									else errors.push({ op: i, error: edited.failure });
								}
								result = {
									applied: ops.length - errors.length,
									...(errors.length === 0 ? {} : { errors })
								};
							}
						} else if (c.name === draftRead && structured) {
							const input = Option.getOrUndefined(Schema.decodeUnknownOption(ReadInput)(c.input));
							const at =
								input === undefined
									? `${draftRead} takes { path, fields? }`
									: resolve(draft, input.path, kind);
							if (typeof at === 'string') result = { error: at };
							else {
								const value =
									input?.fields === undefined ? at.value : project(at.value, at.kind, input.fields);
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
								const hits =
									typeof at === 'string'
										? []
										: find(at.value, at.kind, input.path ?? '', input.text);
								result =
									typeof at === 'string'
										? { error: at }
										: {
												matches: hits.slice(0, HITS),
												...(hits.length > HITS
													? {
															more: `${hits.length - HITS} more: narrow with path or a longer text`
														}
													: {})
											};
							}
						} else if (c.name === DIFF && structured) {
							const path =
								Option.getOrUndefined(Schema.decodeUnknownOption(DiffInput)(c.input))?.path ?? '';
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
									...(changes.length > CHANGES
										? { more: `${changes.length - CHANGES} more: narrow with path` }
										: {})
								};
							}
						} else if (c.name === SUBMIT && structured) {
							last = settle(draft);
							if (last.ok) return last;
							result = { error: last.error.kind === 'invalid' ? last.error.message : 'invalid' };
						} else {
							const tool = spent ? undefined : tools.find((t) => t.name === c.name);
							result =
								tool === undefined
									? { error: `there is no tool '${c.name}'` }
									: yield* tool
											.call(c.input)
											.pipe(Effect.catch((e) => Effect.succeed({ error: e.message })));
						}
						messages.push({
							role: 'tool',
							content: { id: c.id, name: c.name, result: bound(result) }
						});
					}
					// a turn of only draft tools that leaves the draft as it was is no progress: 3 running end the call. Under a
					// `steps` budget a read-only turn is exploration the budget already bounds, not a stall.
					if (
						structured &&
						r.toolCalls.every((c) => drafting.has(c.name)) &&
						(a.steps === undefined || r.toolCalls.some((c) => !inspecting.has(c.name))) &&
						JSON.stringify(draft) === before
					) {
						// a model that re-edits instead of submitting: a draft that already holds is the answer
						const held = r.toolCalls.some((c) => c.name === EDIT) ? settle(draft) : undefined;
						if (held?.ok === true) return held;
						if (++stalls > FAILURES)
							return (
								last ?? invalid(`the model's last ${FAILURES + 1} turns left its answer unchanged`)
							);
					} else stalls = 0;
					// the step budget, or the time the ceiling leaves for one more answer, ends the tools: one final turn answers
					const outOfSteps = a.steps !== undefined && ++turns >= a.steps;
					if (!spent && (outOfSteps || (yield* Clock.currentTimeMillis) >= answerBy)) {
						spent = true;
						const budget = outOfSteps
							? `Your tool budget of ${a.steps} steps is spent`
							: 'Your time for tools is spent';
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
					// a reply of reasoning alone: ask it to go on (L-BOLT-371)
					if (++pauses > PAUSES)
						return invalid(`the model answered nothing ${PAUSES + 1} times running`);
					messages.push({ role: 'user', content: 'Continue, and give your answer.' });
					continue;
				}
				pauses = 0;
				if (!structured) return { ok: true, value: textOf(whole) };
				// a structured answer written out as text instead: a well-formed one is taken as a submission of it
				const parsed =
					typeof whole === 'string'
						? Option.getOrUndefined(
								Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(whole)
							)
						: whole;
				if (parsed !== undefined) {
					last = settle(parsed);
					if (last.ok) return last;
					draft = parsed;
				}
				if (++failures > FAILURES)
					return last ?? invalid(`the model did not build its answer with ${EDIT} and ${SUBMIT}`);
				messages.push(
					{ role: 'assistant', content: textOf(whole) },
					{
						role: 'user',
						content:
							parsed === undefined
								? `Build the answer with ${EDIT} and hand it in with ${SUBMIT}; do not write it out.`
								: `${last!.ok ? '' : last!.error.kind === 'invalid' ? last!.error.message : 'That answer does not match the output'}. It is now your draft: fix it with ${EDIT}, then call ${SUBMIT}.`
					}
				);
			}
		});

		const ask = (lead: string) =>
			!structured
				? (a.prompt ?? '')
				: `${a.prompt ?? ''}\n\n${lead}Use other tools and more turns whenever you need to check something; once the answer is complete, call ${SUBMIT} in the same reply as your last ${EDIT}. ${a.initial === undefined ? `Build your answer with ${EDIT}, starting from ${JSON.stringify(draft)}` : `Your answer is already initialized in memory. Use ${draftRead} and ${FIND} to inspect it and ${EDIT} to change only the paths that need it`}, into this JSON Schema, then call ${SUBMIT}:\n${JSON.stringify(shape)}${rulesText}`;
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
	}, Effect.scoped);
}
