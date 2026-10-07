// The AI port's `sys_2` (the LLM) under the 60 s wall (rules 63, 72): each model request is one facility call. The wall is
// idle time: every token received (answer or reasoning) restarts it, so a model streaming its reasoning is never cut. A
// stream silent for the wall is closed and its partial output kept as a cut step the next request continues; a request
// that yields nothing within it is `timeout` (OD-13). `model` is a class or a catalog id; any other is `unavailable`.
import type { FacilityError } from '../../decl/runtime/facilities.ts';
import type { Json } from '../../decl/values.ts';
import { LIMITS, type AiMessage, type AiPort, type AiRequest, type AiResponse, type CrossAnswer, type CrossCall } from '../contracts.ts';
import { decodeInput } from '../callables/decode.ts';
import { bound } from './context.ts';
import { Validator } from '@cfworker/json-schema';
import { compile, context, evaluate } from '@norbital-ai/std/formula';

/** Rule 72: a platform budget checked before the provider's own limit. */
export const MODEL_FILES = { count: 8, bytes: 20 * 1024 * 1024 } as const;
/** What a message may carry (envoy and panel alike): images, text, and the documents `read_attachment` reads; 8 files / 20 MiB a message. */
export const ATTACHMENT_MIME = /^(image\/[\w.+-]+|text\/[\w.+-]+|application\/(pdf|json|(?:[\w.-]+\+)?xml|vnd\.openxmlformats-officedocument\.(?:wordprocessingml\.document|spreadsheetml\.sheet)))$/;
/** After the wall aborts, how long the adapter has to hand back what it streamed. */
const GRACE_MS = 2_000;

export const isFacilityError = (v: unknown): v is FacilityError =>
	v !== null && typeof v === 'object' && 'kind' in v && ['upstream', 'timeout', 'rateLimited', 'invalid', 'unavailable'].includes((v as { kind: string }).kind);

/** A provider's refusal of the prompt's size: compaction's second trigger (rule 62). */
export const overflow = (e: FacilityError): boolean => e.kind !== 'unavailable' && e.kind !== 'timeout'
	&& (e.status === 413 || /context|too long|maximum.*tokens|overflow/i.test(e.message));

/** Whether the host runs `model`: a class it maps, or one of its catalog's ids. */
export const servesModel = async (ai: AiPort, model: string): Promise<boolean> =>
	ai.sys_2.models.includes(model) || ((await ai.sys_2.catalog?.())?.models.some((x) => x.id === model) ?? false);

export async function modelCall(ai: AiPort | undefined, request: AiRequest, options: { wallMs?: number; signal?: AbortSignal; onDelta?: (text: string) => void; onReasoning?: (text: string) => void } = {}): Promise<AiResponse | FacilityError> {
	if (ai === undefined) return { kind: 'unavailable', facility: 'ai', reason: 'the host provides no ai' };
	if (!(await servesModel(ai, request.model))) return { kind: 'unavailable', facility: 'ai', reason: `no model is mapped to the class '${request.model}'` };
	const files = request.files ?? [];
	if (files.length > MODEL_FILES.count || files.reduce((n, f) => n + f.bytes.length, 0) > MODEL_FILES.bytes)
		return { kind: 'invalid', message: `a model call takes at most ${MODEL_FILES.count} files and 20 MiB` };
	const wallMs = options.wallMs ?? LIMITS.callMs.ai;
	const wall = new AbortController();
	const abort = () => wall.abort();
	options.signal?.addEventListener('abort', abort, { once: true });
	let partial = '', reasoning = '', progressed = false;
	let timer: ReturnType<typeof setTimeout> | undefined, settle: (v: 'hard') => void = () => {};
	const hard = new Promise<'hard'>((resolve) => { settle = resolve; });
	/** The wall, restarted by every token: only silence ends a call. */
	const arm = () => {
		if (wall.signal.aborted) return;
		clearTimeout(timer);
		timer = setTimeout(() => { wall.abort(); timer = setTimeout(() => settle('hard'), GRACE_MS); }, wallMs);
	};
	arm();
	try {
		const r = await Promise.race([ai.sys_2.infer(request, wall.signal, (d) => { arm(); partial += d; options.onDelta?.(d); },
			(x) => { arm(); progressed = true; if (x !== undefined && x !== '') { reasoning += x; options.onReasoning?.(x); } }), hard]);
		if (r !== 'hard') return r;
	} catch (e) {
		if (!wall.signal.aborted) {
			const status = (e as { status?: unknown }).status;
			return { kind: 'upstream', message: e instanceof Error && e.message !== '' ? e.message : 'the model request failed', ...(typeof status === 'number' ? { status } : {}) };
		}
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', abort);
	}
	if (options.signal?.aborted) return { kind: 'upstream', message: 'stopped' };
	// a tool call still being written at the wall: the next step asks for smaller calls (rule 63), never a silent fail
	if (partial === '' && progressed) return { kind: 'timeout', message: `the model was still writing a tool call at ${wallMs} ms`, cutTool: true } as FacilityError;
	return partial === '' ? { kind: 'timeout', message: `the model yielded nothing within ${wallMs} ms` }
		: { content: partial, toolCalls: [], finish: 'cut', ...(reasoning === '' ? {} : { reasoning }), usage: { input: 0, output: 0 } };
}

export const textOf = (content: Json): string => {
	if (typeof content === 'string') return content;
	const t = content !== null && typeof content === 'object' && !Array.isArray(content) ? (content as { text?: Json }).text : undefined;
	return typeof t === 'string' ? t : JSON.stringify(content);
};

/** A tool `ctx.ai.sys_2.infer` offers the model (rule 58: a host tool its run's `runAs` policies name); a throw is a failed result. */
export type InferTool = { name: string; description: string; input: Json; call(input: Json, signal: AbortSignal): Promise<Json> };
type Kind = { readonly kind: string; readonly optional?: true; readonly [k: string]: unknown };
/** The tools a structured inference builds its answer with: `patch` edits the draft, `submit` hands it in. */
export const PATCH = 'patch', SUBMIT = 'submit';
/** Consecutive empty (reasoning-only) replies, and prose replies that neither patch nor submit, tolerated before `invalid`. */
const PAUSES = 3, FAILURES = 3;

type PatchOp = { op: 'add' | 'replace' | 'remove'; path: string; value?: Json };
/** The empty answer a structured inference starts from, by the output's kind. */
const emptyOf = (k: Kind): Json => (k.kind === 'list' ? [] : k.kind === 'object' || k.kind === 'record' || k.kind === 'json' ? {} : null);
/**
 * RFC 6902 `add` / `replace` / `remove` at RFC 6901 JSON Pointers, applied to a copy (a batch applies whole or not at
 * all). `add` creates missing parent objects and `-` appends to a list, so a draft grows without first laying out its
 * containers. Throws the first operation that cannot apply, named by its index.
 */
export function applyPatch(doc: Json, ops: readonly PatchOp[]): Json {
	let root = structuredClone(doc);
	ops.forEach((o, i) => {
		const fail = (why: string): never => { throw new Error(`operation ${i} (${o.op} ${o.path}): ${why}`); };
		if (o.path === '') { if (o.op === 'remove') fail('cannot remove the whole answer'); root = structuredClone(o.value ?? null); return; }
		if (!o.path.startsWith('/')) fail('a path starts with "/"');
		const keys = o.path.slice(1).split('/').map((k) => k.replaceAll('~1', '/').replaceAll('~0', '~'));
		const last = keys.pop()!;
		let at: Json = root;
		for (const k of keys) {
			const holder = at as { [k: string]: Json } & Json[];
			if (Array.isArray(at)) { at = holder[Number(k)] ?? fail(`no item ${k}`); continue; }
			if (at === null || typeof at !== 'object') fail(`"${k}" is inside a value that is not an object or list`);
			if (holder[k] === undefined || holder[k] === null) { if (o.op !== 'add') fail(`nothing at "${k}"`); holder[k] = {}; }
			at = holder[k]!;
		}
		if (Array.isArray(at)) {
			const n = last === '-' ? at.length : Number(last);
			if (!Number.isInteger(n) || n < 0 || n > at.length || (o.op !== 'add' && n === at.length)) fail(`no list position ${last}`);
			if (o.op === 'add') at.splice(n, 0, structuredClone(o.value ?? null));
			else if (o.op === 'replace') at[n] = structuredClone(o.value ?? null);
			else at.splice(n, 1);
			return;
		}
		if (at === null || typeof at !== 'object') fail('the parent is not an object or list');
		const obj = at as { [k: string]: Json };
		if (o.op !== 'add' && !(last in obj)) fail(`nothing at "${last}"`);
		if (o.op === 'remove') delete obj[last];
		else obj[last] = structuredClone(o.value ?? null);
	});
	return root;
}

/** A declared output kind (§3.3.2) as the JSON Schema the provider constrains its answer by. */
export function jsonSchemaOf(k: Kind): Json {
	const values = (v: unknown) => v as readonly Json[];
	switch (k.kind) {
		case 'text': return { type: 'string', ...(k['max'] === undefined ? {} : { maxLength: Number(k['max']) }) };
		case 'int': return { type: 'integer' };
		case 'number': return { type: 'number' };
		case 'decimal': case 'money': return { type: ['number', 'string'] };
		case 'bool': return { type: 'boolean' };
		case 'date': return { type: 'string', format: 'date' };
		case 'instant': return { type: 'string', format: 'date-time' };
		case 'enum': return { enum: [...values(k['values'])] };
		case 'id': return { type: 'string', format: 'uuid' };
		case 'vector': return { type: 'array', items: { type: 'number' } };
		case 'list': return { type: 'array', items: jsonSchemaOf(k['of'] as Kind) };
		case 'record': return { type: 'object', additionalProperties: jsonSchemaOf(k['of'] as Kind) };
		case 'object': {
			const fields = Object.entries(k['fields'] as { readonly [f: string]: Kind });
			return { type: 'object', additionalProperties: false, properties: Object.fromEntries(fields.map(([f, x]) => [f, jsonSchemaOf(x)])),
				required: fields.filter(([, x]) => x.optional !== true && x['default'] === undefined).map(([f]) => f) };
		}
		case 'union': return Array.isArray(k['of']) ? { anyOf: (k['of'] as Kind[]).map(jsonSchemaOf) }
			: { anyOf: Object.entries(k['arms'] as { readonly [tag: string]: { readonly [f: string]: Kind } }).map(([tag, fields]) =>
				jsonSchemaOf({ kind: 'object', fields: { ...fields, [String(k['by'])]: { kind: 'enum', values: [tag] } } })) };
		default: return {};
	}
}

/**
 * An inference has no step budget: it goes on until it answers (a structured one, until a submission matches). What ends a
 * runaway is this ceiling, per batch of files the model reads (MODEL_FILES), and the stall guards (an empty or prose reply 3
 * times running).
 */
export const INFER_MS = 30 * 60_000;
/** The ceiling on one `sys_2.infer` call: INFER_MS for every batch of files it reads. ponytail: counts batches by file count only; a byte-split batch adds a step under the same ceiling. */
export const inferMs = (args: readonly Json[]): number =>
	INFER_MS * Math.max(1, Math.ceil(((args[0] as { files?: unknown[] } | null)?.files?.length ?? 0) / MODEL_FILES.count));

/** A rule the answer must hold beside its JSON Schema: CEL over the schema's top-level properties, and what to say when it fails. */
type Rule = { expression: string; message: string };
/** `output` as a JSON Schema (draft 2020-12) for the structure and CEL `rules` for the logic, instead of a declared kind. */
type SchemaOutput = { jsonSchema: Json; rules?: readonly Rule[] };
const isSchemaOutput = (o: unknown): o is SchemaOutput => o !== null && typeof o === 'object' && 'jsonSchema' in o;

/**
 * A checker for a schema output: the schema's own violations as JSON Pointers into the answer, then every rule that
 * evaluates to false. A rule that cannot evaluate (it reads a part the answer does not hold) does not apply. A rule that
 * does not compile is the caller's fault, returned as a string before any model call.
 */
export function schemaChecker(output: SchemaOutput): string | ((value: Json) => string[]) {
	const schema = output.jsonSchema as Record<string, unknown>;
	const validator = new Validator(schema as never, '2020-12', false);
	const properties = Object.keys((schema['properties'] as object | undefined) ?? {});
	const scope = context(Object.fromEntries(properties.map((p) => [p, { kind: 'json', optional: true } as const])), { numbers: 'float' });
	const rules: { rule: Rule; program: Exclude<ReturnType<typeof compile>, { error: string }> }[] = [];
	for (const rule of output.rules ?? []) {
		const program = compile(scope, rule.expression, 'bool');
		if ('error' in program) return `rule "${rule.message}" (${rule.expression}): ${program.error}`;
		rules.push({ rule, program });
	}
	return (value) => {
		// a container's error repeats its children's; the leaves name what to patch
		const shape = validator.validate(value).errors
			.filter((e) => !['properties', 'items', 'prefixItems', 'additionalProperties', 'allOf', '$ref', 'dependentSchemas'].includes(e.keyword))
			.map((e) => `${e.instanceLocation.replace(/^#/, '') || '/'}: ${e.error}`);
		const held = (value ?? {}) as Record<string, unknown>;
		const broken = rules.filter(({ program }) => {
			try { return evaluate(program, Object.fromEntries(properties.map((p) => [p, held[p] ?? null]))) === false; }
			catch { return false; }
		}).map(({ rule }) => `rule broken: ${rule.message} (${rule.expression})`);
		return [...new Set(shape), ...broken];
	};
}

/**
 * `ctx.ai.sys_2.infer` for automations (rule 63, L-BOLT-371/372): a prompt, optional files and an `output`, continued
 * across cut steps with no step budget (INFER_MS per batch bounds the call). Files are FileRefs the host loads. A
 * structured `output` — a declared kind, or `{ jsonSchema, rules }` — is built, not written in one piece: the model edits a
 * draft with `patch` (JSON Patch) as it finds each part, and hands it in with `submit`. A submission is checked against
 * `output`; one that does not match gets every offending field (and broken rule) back and the loop goes on until one
 * matches. More files than one model request carries (MODEL_FILES) are read in batches into the same draft: each batch
 * patches what its files add, and only the last submission is checked. With `tools` (host tools the engine resolved under
 * the run's policies) the model may call them too. An empty (reasoning-only) reply is asked to continue, at most 3 times
 * running.
 */
export function inferFacility(ai: AiPort | undefined, options: { load?: (fileId: string, signal: AbortSignal) => Promise<{ mime: string; bytes: Uint8Array }>; wallMs?: number } = {}) {
	return async (call: Extract<CrossCall, { op: 'facility' }>, signal: AbortSignal, tools: readonly InferTool[] = []): Promise<CrossAnswer> => {
		if (call.facility !== 'ai' || call.method !== 'sys_2.infer') return { ok: false, error: { kind: 'unavailable', facility: `ai.${call.method}`, reason: 'not an agent facility' } };
		const a = (call.args[0] ?? {}) as { model?: string; system?: string; prompt?: string; files?: { id: string }[]; output?: Kind | SchemaOutput };
		const invalid = (message: string): CrossAnswer => ({ ok: false, error: { kind: 'invalid', message } });
		const refs = a.files ?? [];
		if (refs.length > 0 && options.load === undefined) return { ok: false, error: { kind: 'unavailable', facility: 'files', reason: 'the host provides no file reads' } };
		const schemaOut = isSchemaOutput(a.output) ? a.output : undefined;
		const out = schemaOut === undefined && a.output !== undefined && (a.output as Kind).kind !== 'text' ? a.output as Kind : undefined;
		const structured = schemaOut !== undefined || out !== undefined;
		if (!structured && refs.length > MODEL_FILES.count) return invalid(`a text answer reads at most ${MODEL_FILES.count} files; ask for a structured output to read more`);
		let check: ((value: Json) => string[]) | undefined;
		if (schemaOut !== undefined) {
			const made = schemaChecker(schemaOut);
			if (typeof made === 'string') return invalid(made);
			check = made;
		}
		const root = (schemaOut?.jsonSchema ?? {}) as { type?: unknown; properties?: unknown };
		let draft: Json = out !== undefined ? emptyOf(out)
			: schemaOut === undefined ? null : root.type === 'array' ? [] : root.type === 'object' || root.properties !== undefined ? {} : null;
		const shape = out !== undefined ? jsonSchemaOf(out) : schemaOut?.jsonSchema;
		const rulesText = (schemaOut?.rules ?? []).length === 0 ? ''
			: `\n\nThe answer must also hold these rules (CEL over the top-level properties):\n${schemaOut!.rules!.map((r) => `- ${r.message}: ${r.expression}`).join('\n')}`;
		const building = !structured ? [] : [
			{ name: PATCH, description: 'Edit the answer you are building with JSON Patch operations (RFC 6902 add, replace, remove at RFC 6901 paths). "add" creates missing parent objects; "/list/-" appends to a list. One call may carry many operations: patch each part of the answer as you find it, a section at a time.',
				input: { type: 'object', additionalProperties: false, required: ['ops'], properties: { ops: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['op', 'path'],
					properties: { op: { enum: ['add', 'replace', 'remove'] }, path: { type: 'string' }, value: {} } } } } } as Json },
			{ name: SUBMIT, description: 'Hand in the answer as patched so far. It is checked against the required shape; anything wrong comes back by path, and you patch and submit again.',
				input: { type: 'object', additionalProperties: false, properties: {} } as Json },
		];
		const offered = [...tools.map(({ name, description, input }) => ({ name, description, input })), ...building];
		/** The draft checked against `output`: every offending field named (rule 23), as JSON Pointers the model patches with. */
		const decoded = (value: Json): CrossAnswer => {
			let problems: string[];
			if (check !== undefined) problems = check(value);
			else {
				const d = decodeInput({ output: out! }, { output: value });
				const at = (path: string) => `/${path.replace(/^output\.?/, '').replaceAll(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean).join('/')}`;
				problems = d.problems.map((p) => `${at(p.path)}: ${p.message}`);
			}
			return problems.length === 0 ? { ok: true, value } : invalid(`the answer does not match the output: ${problems.join('; ')}. Fix these with ${PATCH} (the paths are JSON Pointers into your draft), then call ${SUBMIT} again`);
		};

		/** One conversation over one batch of files; a batch before the last hands back its draft unchecked. */
		const read = async (files: { mime: string; bytes: Uint8Array }[], prompt: string, final: boolean): Promise<CrossAnswer> => {
			const settle = (value: Json): CrossAnswer => (final ? decoded(value) : { ok: true, value });
			const messages: AiMessage[] = [{ role: 'user', content: prompt }];
			let text = '', continuation: string | undefined, cutAt: number | undefined, pauses = 0, failures = 0, last: CrossAnswer | undefined;
			for (;;) {
				const r = await modelCall(ai, { model: a.model ?? 'default', ...(a.system === undefined ? {} : { system: a.system }), messages: [...messages],
					...(offered.length === 0 ? {} : { tools: offered }),
					...(files.length === 0 ? {} : { files }), ...(continuation === undefined ? {} : { continuation }) },
					{ signal, ...(options.wallMs === undefined ? {} : { wallMs: options.wallMs }) });
				// the ceiling on the whole call: the last failed submission says more than a bare timeout
				if (signal.aborted) return last !== undefined && !last.ok ? last : { ok: false, error: { kind: 'timeout', message: 'the inference did not finish within its ceiling' } };
				if (isFacilityError(r)) return { ok: false, error: r };
				if (r.finish === 'cut') {
					cutAt ??= messages.length;
					text += textOf(r.content);
					continuation = r.continuation;
					messages.splice(cutAt, messages.length - cutAt, { role: 'assistant', content: text });
					continue;
				}
				const whole: Json = text === '' ? r.content : text + textOf(r.content);
				if (cutAt !== undefined) messages.splice(cutAt);
				text = ''; continuation = undefined; cutAt = undefined;
				if (r.toolCalls.length > 0) {
					messages.push({ role: 'assistant', content: { text: typeof whole === 'string' ? whole : '', toolCalls: r.toolCalls as unknown as Json } });
					for (const c of r.toolCalls) {
						let result: Json;
						if (c.name === PATCH && structured) {
							try { draft = applyPatch(draft, ((c.input as { ops?: PatchOp[] } | null)?.ops ?? [])); result = { patched: true }; }
							catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
						} else if (c.name === SUBMIT && structured) {
							last = settle(draft);
							if (last.ok) return last;
							result = { error: last.error.kind === 'invalid' ? last.error.message : 'invalid' };
						} else {
							const tool = tools.find((t) => t.name === c.name);
							result = tool === undefined ? { error: `there is no tool '${c.name}'` }
								: await tool.call(c.input, signal).catch((e: unknown): Json => ({ error: e instanceof Error ? e.message : String(e) }));
						}
						messages.push({ role: 'tool', content: { id: c.id, name: c.name, result: bound(result) } });
					}
					continue;
				}
				if (typeof whole === 'string' && whole.trim() === '') {
					// a reply of reasoning alone: ask it to go on (L-BOLT-371)
					if (++pauses > PAUSES) return invalid(`the model answered nothing ${PAUSES + 1} times running`);
					messages.push({ role: 'user', content: 'Continue, and give your answer.' });
					continue;
				}
				pauses = 0;
				if (!structured) return { ok: true, value: textOf(whole) };
				// a structured answer written out as text instead: a well-formed one is taken as a submission of it
				let parsed: Json | undefined;
				try { parsed = typeof whole === 'string' ? JSON.parse(whole) as Json : whole; } catch { parsed = undefined; }
				if (parsed !== undefined) { last = settle(parsed); if (last.ok) return last; draft = parsed; }
				if (++failures > FAILURES) return last ?? invalid(`the model did not build its answer with ${PATCH} and ${SUBMIT}`);
				messages.push({ role: 'assistant', content: textOf(whole) }, { role: 'user', content: parsed === undefined
					? `Build the answer with ${PATCH} and hand it in with ${SUBMIT}; do not write it out.`
					: `${last!.ok ? '' : last!.error.kind === 'invalid' ? last!.error.message : 'That answer does not match the output'}. It is now your draft: fix it with ${PATCH}, then call ${SUBMIT}.` });
			}
		};

		const ask = (lead: string) => !structured ? a.prompt ?? ''
			: `${a.prompt ?? ''}\n\n${lead}Build your answer with ${PATCH}, starting from ${JSON.stringify(draft)}, into this JSON Schema, then call ${SUBMIT}:\n${JSON.stringify(shape)}${rulesText}`;
		if (refs.length === 0) return read([], ask(''), true);
		// files load a batch at a time, so a thousand scans are never all in memory at once
		let from = 0;
		while (from < refs.length) {
			const batch: { mime: string; bytes: Uint8Array }[] = [];
			let bytes = 0;
			while (from + batch.length < refs.length && batch.length < MODEL_FILES.count) {
				const file = await options.load!(refs[from + batch.length]!.id, signal);
				if (batch.length > 0 && bytes + file.bytes.length > MODEL_FILES.bytes) break; // ponytail: the file that overflows is loaded again with the next batch
				batch.push(file);
				bytes += file.bytes.length;
			}
			const to = from + batch.length, final = to === refs.length;
			const lead = refs.length <= batch.length ? ''
				: `You are reading ${refs.length} source files in batches; these are files ${from + 1}–${to}.${from === 0 ? '' : ` The draft below already holds what files 1–${from} gave: keep it, append to its lists, fill what it lacks, and change a value only where these files show it differently.`} ${final ? `These are the last files: call ${SUBMIT} when the whole answer is complete; it is then checked.` : `Patch in everything these files hold, then call ${SUBMIT} to move on to the next files; the answer is checked after the last batch.`}\n\n`;
			const answer = await read(batch, ask(lead), final);
			if (!answer.ok || final) return answer;
			draft = answer.value;
			from = to;
		}
		return invalid('no files were read');
	};
}
