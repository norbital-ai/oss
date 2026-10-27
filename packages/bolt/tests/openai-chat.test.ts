// The OpenAI-compatible adapter preserves streamed text, reasoning, tools and usage.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, FiberSet, Schema, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import type { AiRequest } from '../src/engine/contracts.ts';
import { Port } from '../src/engine/port.ts';
import { openAiChat, type OpenAiChat } from '../src/engine/agent/openai-chat.ts';

const Sent = Schema.Struct({
	model: Schema.String,
	stream: Schema.optionalKey(Schema.Boolean),
	messages: Schema.Array(
		Schema.Struct({
			role: Schema.String,
			content: Schema.Json,
			tool_call_id: Schema.optionalKey(Schema.String),
			tool_calls: Schema.optionalKey(Schema.Array(Schema.Json)),
			reasoning: Schema.optionalKey(Schema.String)
		})
	),
	tools: Schema.optionalKey(Schema.Array(Schema.Json)),
	response_format: Schema.optionalKey(Schema.Json),
	usage: Schema.optionalKey(Schema.Json)
});
const capture = (answer: (sent: typeof Sent.Type) => Response) => {
	const seen: { url: string; sent: typeof Sent.Type }[] = [];
	const f: typeof fetch = async (u, init) => {
		const native = new Request(u, init);
		const sent = Schema.decodeUnknownSync(Schema.fromJsonString(Sent))(await native.text());
		seen.push({ url: native.url, sent });
		return answer(sent);
	};
	return { f, seen };
};
const first = <A>(items: readonly A[]): A => {
	const item = items[0];
	if (item === undefined) throw new Error('fixture produced no item');
	return item;
};
const stream = (chunks: readonly string[]) =>
	new Response(
		new ReadableStream<Uint8Array>({
			start(c) {
				for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
				c.close();
			}
		}),
		{ headers: { 'content-type': 'text/event-stream' } }
	);
const config = { endpoint: 'https://llm.test/v1', models: { default: 'gpt-x' } };
const request: AiRequest = { model: 'default', messages: [{ role: 'user', content: 'hi' }] };
const collect = (infer: OpenAiChat, input: AiRequest = request) =>
	Effect.gen(function* () {
		const events = yield* Stream.runCollect(infer(input));
		const final = events.find((event) => event._tag === 'Response');
		if (final === undefined) return yield* Effect.die(new Error('model emitted no response'));
		return {
			response: final.response,
			deltas: events.flatMap((event) => (event._tag === 'Delta' ? [event.text] : [])),
			thought: events.flatMap((event) =>
				event._tag === 'Progress' && event.reasoning !== undefined ? [event.reasoning] : []
			)
		};
	});

describe('openAiChat', () => {
	it.effect(
		'decodes temporary budget and rate refusals with their retry hints, preserving permanent 402s',
		() =>
			Effect.gen(function* () {
				const temporary = capture(() =>
					Response.json(
						{
							error: {
								metadata: {
									reason: 'in_flight_budget_exhausted',
									headers: { 'Retry-After': '120' }
								}
							}
						},
						{ status: 402 }
					)
				);
				expect(
					yield* collect(openAiChat(config, { fetch: temporary.f })).pipe(Effect.flip)
				).toMatchObject({
					kind: 'rateLimited',
					status: 402,
					retryAfterMs: 120_000
				});
				yield* TestClock.setTime(Date.UTC(2026, 9, 26));
				const rate = capture(
					() =>
						new Response('busy', {
							status: 429,
							headers: {
								'retry-after': new Date(Date.UTC(2026, 9, 26) + 30_000).toUTCString()
							}
						})
				);
				expect(
					yield* collect(openAiChat(config, { fetch: rate.f })).pipe(Effect.flip)
				).toMatchObject({
					kind: 'rateLimited',
					status: 429,
					retryAfterMs: 30_000
				});
				const unpaid = capture(() =>
					Response.json({ error: { message: 'Insufficient credits' } }, { status: 402 })
				);
				expect(
					yield* collect(openAiChat(config, { fetch: unpaid.f })).pipe(Effect.flip)
				).toMatchObject({
					kind: 'upstream',
					status: 402
				});
			})
	);

	it.effect('headers have a 20-second response deadline that aborts the native fetch', () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			const run = yield* FiberSet.makeRuntimePromise();
			let signal: AbortSignal | undefined;
			const f: typeof fetch = (input, options) => {
				const request = new Request(input, options);
				signal = request.signal;
				return run(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), {
					signal: request.signal
				});
			};
			const pending = yield* collect(openAiChat(config, { fetch: f })).pipe(
				Effect.flip,
				Effect.forkChild
			);
			yield* Deferred.await(started);
			yield* TestClock.adjust(19_999);
			expect(pending.pollUnsafe()).toBeUndefined();
			yield* TestClock.adjust(1);
			expect(yield* Fiber.join(pending)).toMatchObject({
				kind: 'timeout',
				message: 'ai.headers did not answer within 20000 ms'
			});
			expect(signal?.aborted).toBe(true);
		})
	);
	it.effect(
		'valid empty protocol chunks count as progress and a silent body is cancelled at its idle deadline',
		() =>
			Effect.gen(function* () {
				const fetched = Promise.withResolvers<void>();
				const arrived = yield* Deferred.make<void>();
				let controller: ReadableStreamDefaultController<Uint8Array> | undefined,
					cancelled = false;
				const body = new ReadableStream<Uint8Array>({
					start(value) {
						controller = value;
					},
					cancel() {
						cancelled = true;
					}
				});
				const f: typeof fetch = async () => {
					fetched.resolve();
					return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
				};
				const events: string[] = [];
				const pending = yield* openAiChat(config, { fetch: f })(request).pipe(
					Stream.tap((event) =>
						Effect.sync(() => {
							events.push(event._tag);
						}).pipe(Effect.andThen(Deferred.succeed(arrived, undefined)))
					),
					Stream.runDrain,
					Effect.flip,
					Effect.forkChild
				);
				yield* Port.attempt('fixture.fetch', () => fetched.promise);
				if (controller === undefined) return yield* Effect.die(new Error('stream did not start'));
				controller.enqueue(
					new TextEncoder().encode('data: {"id":"call-1","choices":[{"delta":{}}]}\n\n')
				);
				yield* Deferred.await(arrived);
				expect(events).toEqual(['Progress']);
				yield* TestClock.adjust(19_999);
				expect(pending.pollUnsafe()).toBeUndefined();
				yield* TestClock.adjust(1);
				expect(yield* Fiber.join(pending)).toMatchObject({
					kind: 'timeout',
					message: 'ai.stream did not answer within 20000 ms'
				});
				expect(cancelled).toBe(true);
			})
	);
	it.effect(
		'maps classes to models, the transcript to messages, and tool calls back from one JSON body',
		() =>
			Effect.gen(function* () {
				const { f, seen } = capture(() =>
					Response.json({
						choices: [
							{
								message: {
									content: '',
									tool_calls: [
										{ id: 't1', function: { name: 'read_messages', arguments: '{"limit":3}' } }
									]
								}
							}
						],
						usage: { prompt_tokens: 11, completion_tokens: 2 }
					})
				);
				const infer = openAiChat(
					{
						endpoint: 'https://llm.test/v1/',
						credential: 'k',
						models: { default: 'gpt-x', fast: 'gpt-y' }
					},
					{ fetch: f }
				);
				const { response } = yield* collect(infer, {
					model: 'fast',
					system: 'be brief',
					tools: [{ name: 'read_messages', description: 'reads', input: { type: 'object' } }],
					messages: [
						{ role: 'user', content: { text: 'hi' } },
						{
							role: 'assistant',
							content: { text: '', toolCalls: [{ id: 't0', name: 'x', input: {} }] }
						},
						{ role: 'tool', content: { id: 't0', name: 'x', result: { ok: true } } }
					]
				});
				const { url, sent } = first(seen);
				expect(url).toBe('https://llm.test/v1/chat/completions');
				expect([sent.model, sent.stream]).toEqual(['gpt-y', true]);
				expect(sent.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
				expect(sent.messages[2]).toMatchObject({
					tool_calls: [{ id: 't0', type: 'function', function: { name: 'x', arguments: '{}' } }]
				});
				expect(sent.messages[3]).toMatchObject({ tool_call_id: 't0', content: '{"ok":true}' });
				expect(response).toEqual({
					content: '',
					toolCalls: [{ id: 't1', name: 'read_messages', input: { limit: 3 } }],
					finish: 'tool',
					usage: { input: 11, output: 2 }
				});
			})
	);
	it.effect(
		'a tool call with malformed arguments comes back marked invalid, not thrown (the turn answers it and goes on)',
		() =>
			Effect.gen(function* () {
				const { f } = capture(() =>
					Response.json({
						choices: [
							{
								message: {
									content: '',
									tool_calls: [
										{ id: 't1', function: { name: 'read_model', arguments: '{"a":1,}' } }
									]
								}
							}
						],
						usage: {}
					})
				);
				const { response } = yield* collect(openAiChat(config, { fetch: f }));
				expect(response.toolCalls).toEqual([
					{ id: 't1', name: 'read_model', input: {}, invalid: expect.stringMatching(/JSON/) }
				]);
			})
	);
	it.effect(
		'streams: text deltas arrive, tool calls assemble from their pieces, usage and cost from the last chunk',
		() =>
			Effect.gen(function* () {
				const sse = [
					': OPENROUTER PROCESSING',
					'data: {"id":"gen-1","choices":[{"delta":{"content":"Mar"}}]}',
					'data: {"id":"gen-1","choices":[{"delta":{"content":"ch"}}]}',
					'data: {"id":"gen-1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"read_model","arguments":"{\\"aggr"}}]}}]}',
					'data: {"id":"gen-1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"egate\\":{}}"}}]},"finish_reason":"tool_calls"}]}',
					'data: {"id":"gen-1","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"cost":0.001}}',
					'data: [DONE]',
					''
				].join('\n\n');
				const bytes = new TextEncoder().encode(sse);
				const { f, seen } = capture(
					() =>
						new Response(
							new ReadableStream<Uint8Array>({
								start(c) {
									c.enqueue(bytes.slice(0, 41));
									c.enqueue(bytes.slice(41));
									c.close();
								}
							}),
							{ headers: { 'content-type': 'text/event-stream' } }
						)
				);
				const metered: [number, string][] = [];
				const infer = openAiChat(
					{
						...config,
						body: { usage: { include: true } },
						meter: (cost, id) => {
							metered.push([cost, id]);
						}
					},
					{ fetch: f }
				);
				const { response, deltas } = yield* collect(infer, {
					...request,
					messages: [{ role: 'user', content: 'why?' }]
				});
				expect(first(seen).sent).toMatchObject({ stream: true, usage: { include: true } });
				expect(deltas).toEqual(['Mar', 'ch']);
				expect(response).toEqual({
					content: 'March',
					toolCalls: [{ id: 't1', name: 'read_model', input: { aggregate: {} } }],
					finish: 'tool',
					usage: { input: 9, output: 4, cost: 0.001, call: 'gen-1' }
				});
				expect(metered).toEqual([[0.001, 'gen-1']]);
			})
	);
	it.effect(
		"delivers each delta before the stream ends (the engine's idle wall keeps what arrived)",
		() =>
			Effect.gen(function* () {
				let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
				const body = new ReadableStream<Uint8Array>({
					start(c) {
						controller = c;
					}
				});
				const fetched = Promise.withResolvers<void>();
				const f: typeof fetch = async () => {
					fetched.resolve();
					return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
				};
				const arrived = yield* Deferred.make<void>();
				const deltas: string[] = [];
				const done = yield* Effect.forkChild(
					Stream.runCollect(
						openAiChat(config, { fetch: f })(request).pipe(
							Stream.tap((event) =>
								event._tag === 'Delta'
									? Effect.sync(() => {
											deltas.push(event.text);
										}).pipe(Effect.andThen(Deferred.succeed(arrived, undefined)))
									: Effect.void
							)
						)
					)
				);
				yield* Port.attempt('fixture.fetch', () => fetched.promise);
				if (controller === undefined) return yield* Effect.die(new Error('stream did not start'));
				controller.enqueue(
					new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n')
				);
				yield* Deferred.await(arrived);
				expect(deltas).toEqual(['first']);
				controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
				controller.close();
				const events = yield* Fiber.join(done);
				expect(events.find((event) => event._tag === 'Response')?.response.content).toBe('first');
			})
	);
	it.effect(
		'sends files on the last user message, parses structured output, and rejects a refusal with its status',
		() =>
			Effect.gen(function* () {
				const { f, seen } = capture((sent) =>
					JSON.stringify(sent).includes('too long')
						? new Response("This model's maximum context length is 8192 tokens", { status: 400 })
						: stream([
								'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n',
								'data: {"choices":[{"delta":{"content":"true}"}}]}\n\ndata: [DONE]\n\n'
							])
				);
				const infer = openAiChat({ ...config, strict: true }, { fetch: f });
				const { response } = yield* collect(infer, {
					model: 'default',
					output: { type: 'object' },
					messages: [
						{ role: 'user', content: 'look' },
						{ role: 'assistant', content: 'hm' },
						{ role: 'user', content: 'again' }
					],
					files: [
						{ mime: 'image/png', bytes: new Uint8Array([1]) },
						{ mime: 'application/pdf', bytes: new Uint8Array([2]) }
					]
				});
				expect(response.content).toEqual({ ok: true });
				const { sent } = first(seen);
				expect(sent.response_format).toEqual({
					type: 'json_schema',
					json_schema: { name: 'output', strict: true, schema: { type: 'object' } }
				});
				expect(first(sent.messages).content).toBe('look');
				expect(sent.messages[2]?.content).toEqual([
					{ type: 'text', text: 'again' },
					{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
					{
						type: 'file',
						file: { filename: 'attachment-2', file_data: 'data:application/pdf;base64,Ag==' }
					}
				]);
				expect(
					yield* collect(infer, {
						...request,
						messages: [{ role: 'user', content: 'too long' }]
					}).pipe(Effect.flip)
				).toMatchObject({ status: 400, message: expect.stringMatching(/maximum context length/) });
			})
	);
	it.effect(
		'sends text and an xlsx as text parts, never as file parts providers refuse; an unreadable type is described, not sent, and the call goes on',
		() =>
			Effect.gen(function* () {
				const { f, seen } = capture(() =>
					Response.json({ choices: [{ message: { content: 'ok' } }], usage: {} })
				);
				const infer = openAiChat(config, { fetch: f }),
					book = new Uint8Array(
						readFileSync(new URL('./fixtures/files/items.xlsx', import.meta.url))
					);
				yield* collect(infer, {
					...request,
					messages: [{ role: 'user', content: 'read' }],
					files: [
						{ mime: 'text/plain', bytes: new TextEncoder().encode('hello') },
						{ mime: 'application/json', bytes: new TextEncoder().encode('{"a":1}') },
						{
							mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
							bytes: book
						}
					]
				});
				const parts = yield* Schema.decodeUnknownEffect(
					Schema.Array(
						Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })
					)
				)(first(first(seen).sent.messages).content);
				expect(parts.map((part) => part.type)).toEqual(['text', 'text', 'text', 'text']);
				expect(parts[1]?.text).toBe('attachment-1 (text/plain):\nhello');
				expect(parts[2]?.text).toBe('attachment-2 (application/json):\n{"a":1}');
				expect(parts[3]?.text).toMatch(/^attachment-3 sheet 0 ".+" \(CSV\):\n.+,/);
				yield* collect(infer, {
					...request,
					messages: [{ role: 'user', content: 'read' }],
					files: [
						{
							mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
							bytes: new Uint8Array([1])
						}
					]
				});
				expect(seen[1]?.sent.messages[0]?.content).toEqual([
					{ type: 'text', text: 'read' },
					{
						type: 'text',
						text: 'attachment-1: a application/vnd.openxmlformats-officedocument.wordprocessingml.document file cannot be shown to you; ask for a photo, a PDF or a text version'
					}
				]);
				expect(seen).toHaveLength(2);
			})
	);
	it.effect(
		'reasoning streams, comes back verbatim, and is sent back with its reply; a switched call id is refused (L-BOLT-412, L-BOLT-432)',
		() =>
			Effect.gen(function* () {
				const { f, seen } = capture(() =>
					stream([
						'data: {"id":"gen-2","choices":[{"delta":{"reasoning":"None."}}]}\n\n',
						'data: {"id":"gen-2","choices":[{"delta":{"content":"Balanced."}}]}\n\ndata: [DONE]\n\n'
					])
				);
				const { response, thought } = yield* collect(openAiChat(config, { fetch: f }), {
					...request,
					messages: [
						{ role: 'user', content: 'q' },
						{ role: 'assistant', content: { text: 'a', toolCalls: [], reasoning: 'Earlier.' } },
						{ role: 'user', content: 'q2' }
					]
				});
				expect(thought).toEqual(['None.']);
				expect(response).toMatchObject({
					content: 'Balanced.',
					reasoning: 'None.',
					usage: { call: 'gen-2' }
				});
				expect(first(seen).sent.messages[1]).toMatchObject({
					role: 'assistant',
					content: 'a',
					reasoning: 'Earlier.'
				});
				const mixed = capture(() =>
					stream([
						'data: {"id":"gen-3","choices":[{"delta":{"content":"a"}}]}\n\n',
						'data: {"id":"gen-4","choices":[{"delta":{"content":"b"}}]}\n\n'
					])
				);
				expect(
					yield* collect(openAiChat(config, { fetch: mixed.f }), {
						...request,
						messages: [{ role: 'user', content: 'q' }]
					}).pipe(Effect.flip)
				).toMatchObject({ message: expect.stringMatching(/switched call id/) });
			})
	);
	it.effect('a keep-alive comment is progress while the provider holds back a tool call', () =>
		Effect.gen(function* () {
			const f: typeof fetch = async () =>
				stream([
					': OPENROUTER PROCESSING\n\n',
					'data: {"id":"c","choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"set","arguments":"{}"}}]}}]}\n\n',
					'data: [DONE]\n\n'
				]);
			const events = yield* Stream.runCollect(openAiChat(config, { fetch: f })(request));
			expect(events.map((event) => event._tag)).toEqual(['Progress', 'Progress', 'Response']);
		})
	);
	it.effect('interruption stops a stream held open by keep-alives', () =>
		Effect.gen(function* () {
			const fetched = Promise.withResolvers<void>();
			let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
				}
			});
			const f: typeof fetch = async () => {
				fetched.resolve();
				return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
			};
			const done = yield* Effect.forkChild(collect(openAiChat(config, { fetch: f })));
			yield* Port.attempt('fixture.fetch', () => fetched.promise);
			if (controller === undefined) return yield* Effect.die(new Error('stream did not start'));
			controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
			yield* Fiber.interrupt(done);
			expect(Exit.hasInterrupts(yield* Fiber.await(done))).toBe(true);
		})
	);
});
