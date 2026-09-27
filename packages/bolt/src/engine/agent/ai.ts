// The AI port's `sys_2` (the LLM) under the 60 s wall (rules 63, 72): each model request is one facility call. A stream still open at the
// wall is closed there and its partial output kept as a cut step the next request continues; a request that yields
// nothing within the wall is `timeout` (OD-13). `model` is a class or a catalog id; any other is `unavailable`.
import type { FacilityError } from '../../decl/runtime/facilities.ts';
import type { Json } from '../../decl/values.ts';
import { LIMITS, type AiMessage, type AiPort, type AiRequest, type AiResponse, type CrossAnswer, type CrossCall } from '../contracts.ts';
import { decodeInput } from '../callables/decode.ts';
import { bound } from './context.ts';

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
	let timer: ReturnType<typeof setTimeout> | undefined;
	const hard = new Promise<'hard'>((resolve) => { timer = setTimeout(() => { wall.abort(); timer = setTimeout(() => resolve('hard'), GRACE_MS); }, wallMs); });
	try {
		const r = await Promise.race([ai.sys_2.infer(request, wall.signal, (d) => { partial += d; options.onDelta?.(d); },
			(x) => { progressed = true; if (x !== undefined && x !== '') { reasoning += x; options.onReasoning?.(x); } }), hard]);
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
/** The name of the tool that carries a structured answer when the call also offers tools. */
export const SUBMIT = 'return_result';
/** Consecutive empty (reasoning-only) replies, and malformed submissions, tolerated before the call is `invalid`. */
const PAUSES = 3, FAILURES = 3;

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

/** An inference is up to `steps` model calls and their tool calls, each bounded on its own: its wall is their sum. */
export const inferWallMs = (args: readonly Json[]): number =>
	Math.min(Math.max(1, Number((args[0] as { steps?: Json } | null)?.steps ?? 8) || 8), 64) * (LIMITS.callMs.ai + LIMITS.callMs.tool);

/**
 * `ctx.ai.sys_2.infer` for automations (rule 63, L-BOLT-371/372): a prompt, optional files and a structured `output`,
 * continued across cut steps up to `steps` (8 by default, 64 at most). Files are FileRefs the host loads. With `tools`
 * (host tools the engine resolved under the run's policies) the model may call them first and submits a structured
 * answer through `return_result`. A structured answer is decoded against `output`; a mismatch names every offending field.
 * An empty (reasoning-only) reply is asked to continue, at most 3 times running.
 */
export function inferFacility(ai: AiPort | undefined, options: { load?: (fileId: string, signal: AbortSignal) => Promise<{ mime: string; bytes: Uint8Array }>; wallMs?: number } = {}) {
	return async (call: Extract<CrossCall, { op: 'facility' }>, signal: AbortSignal, tools: readonly InferTool[] = []): Promise<CrossAnswer> => {
		if (call.facility !== 'ai' || call.method !== 'sys_2.infer') return { ok: false, error: { kind: 'unavailable', facility: `ai.${call.method}`, reason: 'not an agent facility' } };
		const a = (call.args[0] ?? {}) as { model?: string; system?: string; prompt?: string; files?: { id: string }[]; output?: Kind; steps?: number };
		const steps = Math.min(Math.max(1, a.steps ?? 8), 64);
		const invalid = (message: string): CrossAnswer => ({ ok: false, error: { kind: 'invalid', message } });
		let files: { mime: string; bytes: Uint8Array }[] = [];
		if ((a.files ?? []).length > 0) {
			if (options.load === undefined) return { ok: false, error: { kind: 'unavailable', facility: 'files', reason: 'the host provides no file reads' } };
			files = await Promise.all(a.files!.map((f) => options.load!(f.id, signal)));
		}
		const out = a.output !== undefined && a.output.kind !== 'text' ? a.output : undefined;
		const submit = out !== undefined && tools.length > 0;
		const offered = tools.length === 0 ? undefined : [...tools.map(({ name, description, input }) => ({ name, description, input })),
			...(submit ? [{ name: SUBMIT, description: 'Submit the final structured result. Call it exactly once, when the work is done, and nothing else in that turn.',
				input: { type: 'object', additionalProperties: false, properties: { result: jsonSchemaOf(out) }, required: ['result'] } as Json }] : [])];
		/** The answer decoded against `output`: every offending field named (rule 23). */
		const decoded = (value: Json): CrossAnswer => {
			const d = decodeInput({ output: out! }, { output: value });
			return d.problems.length === 0 ? { ok: true, value } : invalid(`the model's answer does not match the output: ${d.problems.map((p) => `${p.path}: ${p.message}`).join('; ')}`);
		};
		const messages: AiMessage[] = [{ role: 'user', content: a.prompt ?? '' }];
		let text = '', continuation: string | undefined, cutAt: number | undefined, pauses = 0, failures = 0;
		for (let step = 0; step < steps; step++) {
			// the last step can only submit: a model still researching hands in what it has instead of running out
			const last = submit && step === steps - 1;
			if (last) messages.push({ role: 'user', content: `Your step budget is spent: call ${SUBMIT} now with what you have found, and say in it what remains unchecked.` });
			const r = await modelCall(ai, { model: a.model ?? 'default', ...(a.system === undefined ? {} : { system: a.system }), messages: [...messages],
				...(offered !== undefined ? { tools: last ? offered.filter((t) => t.name === SUBMIT) : offered } : out === undefined ? {} : { output: jsonSchemaOf(out) }),
				...(files.length === 0 ? {} : { files }), ...(continuation === undefined ? {} : { continuation }) },
				{ signal, ...(options.wallMs === undefined ? {} : { wallMs: options.wallMs }) });
			if (isFacilityError(r)) return { ok: false, error: r };
			if (r.finish === 'cut') {
				cutAt ??= messages.length;
				text += textOf(r.content);
				continuation = r.continuation;
				messages.splice(cutAt, messages.length - cutAt, { role: 'assistant', content: text });
				continue;
			}
			// a structured answer the provider already parsed stays a value; streamed pieces join as text
			const whole: Json = text === '' ? r.content : text + textOf(r.content);
			if (cutAt !== undefined) messages.splice(cutAt);
			text = ''; continuation = undefined; cutAt = undefined;
			if (r.toolCalls.length > 0) {
				messages.push({ role: 'assistant', content: { text: typeof whole === 'string' ? whole : '', toolCalls: r.toolCalls as unknown as Json } });
				for (const c of r.toolCalls) {
					if (c.name === SUBMIT && submit) {
						const got = decoded((c.input as { result?: Json } | null)?.result ?? null);
						if (got.ok) return got;
						if (++failures > FAILURES) return got;
						messages.push({ role: 'tool', content: { id: c.id, name: c.name, result: { error: got.error.kind === 'invalid' ? got.error.message : 'invalid' } } });
						continue;
					}
					const tool = tools.find((t) => t.name === c.name);
					const result = tool === undefined ? { error: `there is no tool '${c.name}'` }
						: await tool.call(c.input, signal).catch((e: unknown): Json => ({ error: e instanceof Error ? e.message : String(e) }));
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
			if (out === undefined) return { ok: true, value: textOf(whole) };
			if (submit) {
				if (++failures > FAILURES) return invalid(`the model did not submit its answer with ${SUBMIT}`);
				messages.push({ role: 'assistant', content: textOf(whole) }, { role: 'user', content: `Submit the result by calling ${SUBMIT}.` });
				continue;
			}
			if (typeof whole !== 'string') return decoded(whole);
			let parsed: Json;
			try { parsed = JSON.parse(whole) as Json; } catch { return invalid('the output is not JSON'); }
			return decoded(parsed);
		}
		return { ok: false, error: { kind: 'timeout', message: `the inference did not finish within ${steps} steps` } };
	};
}
