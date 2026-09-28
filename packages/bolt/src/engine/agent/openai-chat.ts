// Hosts: `sys_2.infer` over any OpenAI-compatible `/chat/completions` endpoint (bolt-server's `openai` provider, another host's
// OpenRouter). One call is one streamed completion: text deltas reach `onDelta` as they arrive, so the engine's 60 s wall
// (`modelCall`) cuts a long generation into a continued step instead of a `timeout` (rule 63); tool calls assemble from
// their pieces and usage comes from the last chunk. A refusal rejects with the HTTP `status` (the engine spots context
// overflow by it). An endpoint that ignores `stream` and answers `application/json` is read whole.
import type { Json } from '../../decl/values.ts';
import type { AiPort, AiRequest, AiResponse } from '../contracts.ts';

export type OpenAiChatConfig = {
	/** The API base, e.g. `https://openrouter.ai/api/v1`. */
	endpoint: string;
	credential?: string | undefined;
	/** Model class → provider model id; any other `r.model` (a catalog id the engine already checked) goes as is. */
	models: { readonly [modelClass: string]: string };
	/** Extra request fields the provider takes (OpenRouter's `usage: { include: true }`). */
	body?: { readonly [k: string]: Json };
	/** `response_format.json_schema.strict` for structured output. */
	strict?: boolean;
	/** The provider's charge for one call (`usage.cost`, USD) under its generation id, awaited before `infer` resolves. */
	meter?: (costUsd: number, generationId: string) => Promise<void> | void;
};

type Wire = { [k: string]: unknown };
const isObj = (v: unknown): v is Wire => v !== null && typeof v === 'object' && !Array.isArray(v);
const textOf = (c: Json): string => typeof c === 'string' ? c : isObj(c) && typeof c['text'] === 'string' ? c['text'] : JSON.stringify(c);
const dataUrl = (f: { mime: string; bytes: Uint8Array }) => `data:${f.mime};base64,${Buffer.from(f.bytes).toString('base64')}`;

/** Engine messages (`{ text, toolCalls }` assistant rows, `{ id, name, result }` tool rows) as chat messages; files ride the last user message. */
function messagesOf(r: AiRequest): Wire[] {
	const out: Wire[] = r.system === undefined ? [] : [{ role: 'system', content: r.system }];
	for (const m of r.messages) {
		const c = isObj(m.content) ? m.content : {};
		if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: String(c['id'] ?? ''), content: JSON.stringify(c['result'] ?? null) });
		else if (m.role === 'assistant') {
			const calls = Array.isArray(c['toolCalls']) ? c['toolCalls'].filter(isObj) : [];
			// L-BOLT-412: the stored reasoning goes back with its reply (OpenRouter's `reasoning` on an assistant message)
			out.push({ role: 'assistant', content: textOf(m.content), ...(typeof c['reasoning'] === 'string' && c['reasoning'] !== '' ? { reasoning: c['reasoning'] } : {}),
				...(calls.length === 0 ? {} : { tool_calls: calls.map((t) =>
				({ id: t['id'], type: 'function', function: { name: t['name'], arguments: JSON.stringify(t['input'] ?? {}) } })) }) });
		} else out.push({ role: 'user', content: textOf(m.content) });
	}
	const files = r.files ?? [];
	if (files.length > 0) {
		// images as image parts, anything else (a PDF) as a file part
		const parts = files.map((f, n) => f.mime.startsWith('image/') ? { type: 'image_url', image_url: { url: dataUrl(f) } }
			: { type: 'file', file: { filename: `attachment-${n + 1}`, file_data: dataUrl(f) } });
		const last = out.findLast((m) => m['role'] === 'user');
		if (last === undefined) out.push({ role: 'user', content: parts });
		else last['content'] = [{ type: 'text', text: last['content'] }, ...parts];
	}
	return out;
}

type Call = { id: string; name: string; args: string };
type Usage = { prompt_tokens?: number; completion_tokens?: number; cost?: number };
/** The completion's text, reasoning, tool calls, usage and generation id: one JSON body when the endpoint answers JSON, else an SSE stream read delta by delta. */
async function read(res: Response, onDelta: ((text: string) => void) | undefined, signal: AbortSignal, onProgress?: (reasoning?: string) => void) {
	let text = '', reasoning = '', id = '', usage: Usage = {};
	const calls: Call[] = [];
	if ((res.headers.get('content-type') ?? '').includes('application/json') || res.body === null) {
		const j = JSON.parse(await res.text()) as { id?: string; choices?: { message?: { content?: string | null; reasoning?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]; usage?: Usage };
		const choice = j.choices?.[0];
		text = choice?.message?.content ?? '';
		if (text !== '') onDelta?.(text);
		return { text, reasoning: choice?.message?.reasoning ?? '', id: j.id ?? '', usage: j.usage ?? {},
			calls: (choice?.message?.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, args: t.function.arguments })) };
	}
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
		signal.throwIfAborted(); // keep-alive comments can hold a stalled stream open past the wall
		buffer += decoder.decode(chunk, { stream: true });
		for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
			const line = buffer.slice(0, i).trim();
			buffer = buffer.slice(i + 1);
			if (!line.startsWith('data:')) continue; // `:` comments are keep-alives
			const data = line.slice(5).trim();
			if (data === '[DONE]') continue;
			const j = JSON.parse(data) as { id?: string; error?: { message?: string; code?: number }; usage?: Usage | null;
				choices?: { delta?: { content?: string | null; reasoning?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
			if (j.error !== undefined) throw Object.assign(new Error(j.error.message ?? 'the model stream failed'), typeof j.error.code === 'number' ? { status: j.error.code } : {});
			// L-BOLT-432: one stream is one provider call; a chunk under another id would meter the wrong call
			if (typeof j.id === 'string') { if (id !== '' && j.id !== id) throw new Error(`the model stream switched call id from ${id} to ${j.id}`); id = j.id; }
			if (j.usage != null) usage = j.usage;
			const delta = j.choices?.[0]?.delta;
			if (typeof delta?.content === 'string' && delta.content !== '') { text += delta.content; onDelta?.(delta.content); }
			if (typeof delta?.reasoning === 'string' && delta.reasoning !== '') { reasoning += delta.reasoning; onProgress?.(delta.reasoning); }
			if ((delta?.tool_calls?.length ?? 0) > 0) onProgress?.();
			for (const t of delta?.tool_calls ?? []) {
				const call = calls[t.index ?? calls.length] ??= { id: '', name: '', args: '' };
				if (t.id !== undefined) call.id = t.id;
				call.name += t.function?.name ?? '';
				call.args += t.function?.arguments ?? '';
			}
		}
	}
	return { text, reasoning, id, usage, calls: calls.filter((c) => c !== undefined) };
}

/** `AiPort['sys_2']['infer']` on one OpenAI-compatible endpoint, streamed. */
export function openAiChat(config: OpenAiChatConfig, f: typeof fetch = fetch): AiPort['sys_2']['infer'] {
	return async (r, signal, onDelta, onProgress): Promise<AiResponse> => {
		const res = await f(`${config.endpoint.replace(/\/$/, '')}/chat/completions`, { method: 'POST', signal,
			headers: { 'content-type': 'application/json', ...(config.credential === undefined ? {} : { authorization: `Bearer ${config.credential}` }) },
			body: JSON.stringify({
				...config.body, model: config.models[r.model] ?? r.model, messages: messagesOf(r), stream: true, stream_options: { include_usage: true },
				...(r.tools === undefined || r.tools.length === 0 ? {} : { tools: r.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input } })) }),
				...(r.output === undefined ? {} : { response_format: { type: 'json_schema', json_schema: { name: 'output', ...(config.strict === true ? { strict: true } : {}), schema: r.output } } }),
			}) });
		if (!res.ok) throw Object.assign(new Error(`the model provider refused the request (HTTP ${res.status}): ${(await res.text()).slice(0, 500)}`), { status: res.status });
		const { text, reasoning, id, usage, calls } = await read(res, onDelta, signal, onProgress);
		if (typeof usage.cost === 'number' && id !== '') await config.meter?.(usage.cost, id);
		// a model can stream malformed arguments (staging: "Expected double-quoted property name"); the call answers it, the turn goes on
		const toolCalls = calls.map((c) => {
			try { return { id: c.id, name: c.name, input: (c.args === '' ? {} : JSON.parse(c.args)) as Json }; }
			catch (e) { return { id: c.id, name: c.name, input: {}, invalid: e instanceof Error ? e.message : String(e) }; }
		});
		let content: Json = text;
		if (r.output !== undefined && toolCalls.length === 0) try { content = JSON.parse(text) as Json; } catch { /* the caller reads the text */ }
		return { content, toolCalls, finish: toolCalls.length > 0 ? 'tool' : 'stop', ...(reasoning === '' ? {} : { reasoning }),
			usage: { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0, ...(typeof usage.cost === 'number' ? { cost: usage.cost } : {}), ...(id === '' ? {} : { call: id }) } };
	};
}
