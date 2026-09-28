// `openAiChat` (rule 63, P39): the hosts' OpenAI-compatible `sys_2.infer` (bolt-server's `openai` provider, Colony's
// OpenRouter) against a fake fetch: classes map to models, the transcript and files to chat messages, a streamed answer's
// text deltas reach `onDelta` as they arrive, tool calls assemble from their pieces, usage and cost come from the last
// chunk, a refusal carries its HTTP status, and an abort stops a stream held open by keep-alives.
import { describe, expect, it } from 'vitest';
import { openAiChat } from '../src/engine/agent/openai-chat.ts';

type Sent = { model: string; stream?: boolean; messages: { role: string; content: unknown; tool_call_id?: string }[]; tools?: unknown[]; response_format?: unknown; usage?: unknown };
const capture = (answer: (sent: Sent) => Response) => {
	const seen: { url: string; sent: Sent }[] = [];
	const f = (async (u: string | URL, init?: RequestInit) => {
		const sent = JSON.parse(String(init?.body)) as Sent;
		seen.push({ url: String(u), sent });
		return answer(sent);
	}) as typeof fetch;
	return { f, seen };
};
const stream = (chunks: string[]) => new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } }),
	{ headers: { 'content-type': 'text/event-stream' } });

describe('openAiChat', () => {
	it('maps classes to models, the transcript to messages, and tool calls back from one JSON body', async () => {
		const { f, seen } = capture(() => Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: 't1', function: { name: 'read_messages', arguments: '{"limit":3}' } }] } }],
			usage: { prompt_tokens: 11, completion_tokens: 2 } }));
		const infer = openAiChat({ endpoint: 'https://llm.test/v1/', credential: 'k', models: { default: 'gpt-x', fast: 'gpt-y' } }, f);
		const r = await infer({ model: 'fast', system: 'be brief', tools: [{ name: 'read_messages', description: 'reads', input: { type: 'object' } }], messages: [
			{ role: 'user', content: { text: 'hi' } }, { role: 'assistant', content: { text: '', toolCalls: [{ id: 't0', name: 'x', input: {} }] } },
			{ role: 'tool', content: { id: 't0', name: 'x', result: { ok: true } } }] }, AbortSignal.timeout(1000));
		const { url, sent } = seen[0]!;
		expect(url).toBe('https://llm.test/v1/chat/completions');
		expect([sent.model, sent.stream]).toEqual(['gpt-y', true]);
		expect(sent.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
		expect(sent.messages[2]).toMatchObject({ tool_calls: [{ id: 't0', type: 'function', function: { name: 'x', arguments: '{}' } }] });
		expect(sent.messages[3]).toMatchObject({ tool_call_id: 't0', content: '{"ok":true}' });
		expect(r).toEqual({ content: '', toolCalls: [{ id: 't1', name: 'read_messages', input: { limit: 3 } }], finish: 'tool', usage: { input: 11, output: 2 } });
	});

	it('a tool call with malformed arguments comes back marked invalid, not thrown (the turn answers it and goes on)', async () => {
		const { f } = capture(() => Response.json({ choices: [{ message: { content: '', tool_calls: [{ id: 't1', function: { name: 'read_collection', arguments: '{"a":1,}' } }] } }], usage: {} }));
		const r = await openAiChat({ endpoint: 'https://llm.test/v1', models: { default: 'gpt-x' } }, f)({ model: 'default', messages: [{ role: 'user', content: { text: 'hi' } }] }, AbortSignal.timeout(1000));
		expect(r.toolCalls).toEqual([{ id: 't1', name: 'read_collection', input: {}, invalid: expect.stringMatching(/JSON/) }]);
	});

	it('streams: text deltas reach onDelta as they arrive, tool calls assemble from their pieces, usage and cost from the last chunk', async () => {
		const sse = [': OPENROUTER PROCESSING', 'data: {"id":"gen-1","choices":[{"delta":{"content":"Mar"}}]}', 'data: {"id":"gen-1","choices":[{"delta":{"content":"ch"}}]}',
			'data: {"id":"gen-1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"read_collection","arguments":"{\\"aggr"}}]}}]}',
			'data: {"id":"gen-1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"egate\\":{}}"}}]},"finish_reason":"tool_calls"}]}',
			'data: {"id":"gen-1","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"cost":0.001}}', 'data: [DONE]', ''].join('\n\n');
		const bytes = new TextEncoder().encode(sse);
		// split mid-line: the reader buffers partial lines across chunks
		const { f, seen } = capture(() => new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 41)); c.enqueue(bytes.slice(41)); c.close(); } }),
			{ headers: { 'content-type': 'text/event-stream' } }));
		const metered: [number, string][] = [];
		const infer = openAiChat({ endpoint: 'https://llm.test/v1', models: { default: 'gpt-x' }, body: { usage: { include: true } }, meter: (cost, id) => void metered.push([cost, id]) }, f);
		const deltas: string[] = [];
		const r = await infer({ model: 'default', messages: [{ role: 'user', content: 'why?' }] }, AbortSignal.timeout(1000), (d) => deltas.push(d));
		expect(seen[0]!.sent).toMatchObject({ stream: true, usage: { include: true } });
		expect(deltas).toEqual(['Mar', 'ch']);
		expect(r).toEqual({ content: 'March', toolCalls: [{ id: 't1', name: 'read_collection', input: { aggregate: {} } }], finish: 'tool', usage: { input: 9, output: 4, cost: 0.001, call: 'gen-1' } });
		expect(metered).toEqual([[0.001, 'gen-1']]);
	});

	it('delivers each delta before the stream ends (the engine\'s 60 s wall keeps what arrived)', async () => {
		let push: ((x: string) => void) | undefined, end: (() => void) | undefined;
		const f = (async () => new Response(new ReadableStream<Uint8Array>({ start(c) {
			push = (x) => c.enqueue(new TextEncoder().encode(x));
			end = () => c.close();
		} }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
		const deltas: string[] = [];
		const done = openAiChat({ endpoint: 'https://llm.test/v1', models: { default: 'gpt-x' } }, f)({ model: 'default', messages: [{ role: 'user', content: 'go' }] },
			AbortSignal.timeout(1000), (d) => deltas.push(d));
		await new Promise((r) => setImmediate(r));
		push!('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
		await new Promise((r) => setTimeout(r, 10));
		expect(deltas).toEqual(['first']);
		push!('data: [DONE]\n\n');
		end!();
		expect((await done).content).toBe('first');
	});

	it('sends files on the last user message, parses structured output, and rejects a refusal with its status', async () => {
		const { f, seen } = capture((sent) => JSON.stringify(sent).includes('too long')
			? new Response('This model\'s maximum context length is 8192 tokens', { status: 400 })
			: stream(['data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"true}"}}]}\n\ndata: [DONE]\n\n']));
		const infer = openAiChat({ endpoint: 'https://llm.test/v1', models: { default: 'gpt-x' }, strict: true }, f);
		const r = await infer({ model: 'default', output: { type: 'object' }, messages: [{ role: 'user', content: 'look' }, { role: 'assistant', content: 'hm' }, { role: 'user', content: 'again' }],
			files: [{ mime: 'image/png', bytes: new Uint8Array([1]) }, { mime: 'application/pdf', bytes: new Uint8Array([2]) }] }, AbortSignal.timeout(1000));
		expect(r.content).toEqual({ ok: true });
		const { sent } = seen[0]!;
		expect(sent.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'output', strict: true, schema: { type: 'object' } } });
		expect(sent.messages[0]!.content).toBe('look');
		expect(sent.messages[2]!.content).toEqual([{ type: 'text', text: 'again' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
			{ type: 'file', file: { filename: 'attachment-2', file_data: 'data:application/pdf;base64,Ag==' } }]);
		await expect(infer({ model: 'default', messages: [{ role: 'user', content: 'too long' }] }, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/maximum context length/) });
	});

	it('reasoning streams through onProgress, comes back verbatim, and is sent back with its reply; a switched call id is refused (L-BOLT-412, L-BOLT-432)', async () => {
		const { f, seen } = capture(() => stream(['data: {"id":"gen-2","choices":[{"delta":{"reasoning":"None."}}]}\n\n',
			'data: {"id":"gen-2","choices":[{"delta":{"content":"Balanced."}}]}\n\ndata: [DONE]\n\n']));
		const infer = openAiChat({ endpoint: 'https://llm.test/v1', models: { default: 'gpt-x' } }, f);
		const thought: (string | undefined)[] = [];
		const r = await infer({ model: 'default', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: { text: 'a', toolCalls: [], reasoning: 'Earlier.' } }, { role: 'user', content: 'q2' }] },
			AbortSignal.timeout(1000), undefined, (x) => thought.push(x));
		expect(thought).toEqual(['None.']);
		expect(r).toMatchObject({ content: 'Balanced.', reasoning: 'None.', usage: { call: 'gen-2' } });
		expect(seen[0]!.sent.messages[1]).toMatchObject({ role: 'assistant', content: 'a', reasoning: 'Earlier.' });
		const mixed = capture(() => stream(['data: {"id":"gen-3","choices":[{"delta":{"content":"a"}}]}\n\n', 'data: {"id":"gen-4","choices":[{"delta":{"content":"b"}}]}\n\n']));
		await expect(openAiChat({ endpoint: 'https://llm.test/v1', models: { default: 'gpt-x' } }, mixed.f)({ model: 'default', messages: [{ role: 'user', content: 'q' }] }, AbortSignal.timeout(1000)))
			.rejects.toThrow(/switched call id/);
	});

	it('an aborted signal stops a stream held open by keep-alives', async () => {
		const wall = new AbortController();
		let push: ((x: string) => void) | undefined;
		const f = (async () => new Response(new ReadableStream<Uint8Array>({ start(c) { push = (x) => c.enqueue(new TextEncoder().encode(x)); } }),
			{ headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
		const done = openAiChat({ endpoint: 'https://llm.test/v1', models: { default: 'gpt-x' } }, f)({ model: 'default', messages: [{ role: 'user', content: 'go' }] }, wall.signal);
		await new Promise((r) => setImmediate(r));
		wall.abort();
		push!(': keep-alive\n\n');
		await expect(done).rejects.toThrow();
	});
});
