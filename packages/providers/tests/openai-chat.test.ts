// The OpenAI-compatible adapter preserves streamed text, reasoning, tools and usage.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, FiberSet, Schema, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { type AiRequest, type OpenAiChat, Port } from '@norbital-ai/host-api';
import { pixelSize } from '@norbital-ai/host-api';
import { fileParts } from '../src/openai/files.ts';
import { open_ai_chat, session_of } from '../src/openai/index.ts';
import { open_router_chat } from '../src/openrouter/chat.ts';
import { ai_models } from '../src/openrouter/models.ts';

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
	reasoning_effort: Schema.optionalKey(Schema.String),
	response_format: Schema.optionalKey(Schema.Json),
	usage: Schema.optionalKey(Schema.Json),
	session_id: Schema.optionalKey(Schema.String),
	prompt_cache_key: Schema.optionalKey(Schema.String),
	provider: Schema.optionalKey(Schema.Json)
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

describe('open_ai_chat', () => {
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
					yield* collect(open_ai_chat(config, { fetch: temporary.f })).pipe(Effect.flip)
				).toMatchObject({
					kind: 'rate_limited',
					status: 402,
					retry_after_ms: 120_000
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
					yield* collect(open_ai_chat(config, { fetch: rate.f })).pipe(Effect.flip)
				).toMatchObject({
					kind: 'rate_limited',
					status: 429,
					retry_after_ms: 30_000
				});
				const unpaid = capture(() =>
					Response.json({ error: { message: 'Insufficient credits' } }, { status: 402 })
				);
				expect(
					yield* collect(open_ai_chat(config, { fetch: unpaid.f })).pipe(Effect.flip)
				).toMatchObject({
					kind: 'upstream',
					status: 402
				});
			})
	);

	it.effect('headers have a 60-second response deadline that aborts the native fetch', () =>
		Effect.gen(function* () {
			const started = yield* Deferred.make<void>();
			// the native fetch is aborted as the timed-out call is interrupted, a tick after its failure answers
			const aborted = yield* Deferred.make<void>();
			const run = yield* FiberSet.makeRuntimePromise();
			// the client's own signal: a Request's copy follows it only weakly, so a collected Request never hears the abort
			const f: typeof fetch = (_input, options) => {
				const signal = options?.signal ?? undefined;
				signal?.addEventListener('abort', () => Deferred.doneUnsafe(aborted, Effect.void));
				return run(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), {
					...(signal === undefined ? {} : { signal })
				});
			};
			const pending = yield* collect(open_ai_chat(config, { fetch: f })).pipe(
				Effect.flip,
				Effect.forkChild
			);
			yield* Deferred.await(started);
			yield* TestClock.adjust(59_999);
			expect(pending.pollUnsafe()).toBeUndefined();
			yield* TestClock.adjust(1);
			expect(yield* Fiber.join(pending)).toMatchObject({
				kind: 'upstream',
				message: 'ai.headers did not answer within 60000 ms'
			});
			yield* Deferred.await(aborted);
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
				const pending = yield* open_ai_chat(config, { fetch: f })(request).pipe(
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
		'meters estimated prompt and streamed output cost when a caller aborts a stream before usage arrives',
		() =>
			Effect.gen(function* () {
				let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
				const fetched = Promise.withResolvers<void>();
				const arrived = yield* Deferred.make<void>();
				const metered: { cost: number; id: string }[] = [];
				const f: typeof fetch = async () => {
					const body = new ReadableStream<Uint8Array>({
						start(c) {
							controller = c;
						}
					});
					fetched.resolve();
					return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
				};
				const fiber = yield* open_ai_chat(
					{
						endpoint: 'https://llm.test/v1',
						credential: 'k',
						models: { default: 'frontier-x' },
						price: () => ({ input: 10, output: 30 }),
						meter: (cost, id) => {
							metered.push({ cost, id });
						}
					},
					{ fetch: f }
				)({
					model: 'default',
					system: 'answer thoroughly',
					messages: [{ role: 'user', content: { text: 'hello world' } }]
				}).pipe(
					Stream.tap((event) =>
						event._tag === 'Delta' ? Deferred.succeed(arrived, undefined) : Effect.void
					),
					Stream.runDrain,
					Effect.forkChild
				);
				yield* Port.attempt('fixture.fetch', () => fetched.promise);
				if (controller === undefined) return yield* Effect.die(new Error('stream did not start'));
				controller.enqueue(
					new TextEncoder().encode(
						'data: {"id":"gen-abort-1","choices":[{"delta":{"content":"Here is the expensive answer"}}]}\n\n'
					)
				);
				yield* Deferred.await(arrived);
				yield* Fiber.interrupt(fiber);
				expect(metered.length).toBe(1);
				expect(metered[0]?.id).toBe('gen-abort-1');
				expect(metered[0]?.cost).toBeGreaterThan(0);
			})
	);
	it.effect(
		'reconciles exact OpenRouter generation cost on stream abort and falls back cleanly on error or timeout',
		() =>
			Effect.gen(function* () {
				const runAbort = (
					generationId: string,
					reconcileAnswer: (url: string, auth: string | null, signal?: AbortSignal) => Promise<Response>
				) =>
					Effect.gen(function* () {
						let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
						const fetched = Promise.withResolvers<void>();
						const arrived = yield* Deferred.make<void>();
						const metered: { cost: number; id: string }[] = [];
						const queried: { url: string; auth: string | null }[] = [];
						const f: typeof fetch = async (input, init) => {
							const req = new Request(input, init);
							if (req.method === 'GET') {
								const auth = req.headers.get('authorization');
								queried.push({ url: req.url, auth });
								return reconcileAnswer(req.url, auth, init?.signal ?? undefined);
							}
							const body = new ReadableStream<Uint8Array>({
								start(c) {
									controller = c;
								}
							});
							fetched.resolve();
							return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
						};
						const fiber = yield* open_ai_chat(
							{
								endpoint: 'https://openrouter.ai/api/v1/',
								credential: 'or-secret',
								models: { default: 'anthropic/claude-sonnet' },
								price: () => ({ input: 10, output: 30 }),
								meter: (cost, id) => {
									metered.push({ cost, id });
								}
							},
							{ fetch: f }
						)({
							model: 'default',
							system: 'answer thoroughly',
							messages: [{ role: 'user', content: { text: 'hello world' } }]
						}).pipe(
							Stream.tap((event) =>
								event._tag === 'Delta' ? Deferred.succeed(arrived, undefined) : Effect.void
							),
							Stream.runDrain,
							Effect.forkChild
						);
						yield* Port.attempt('fixture.fetch', () => fetched.promise);
						if (controller === undefined) return yield* Effect.die(new Error('stream did not start'));
						controller.enqueue(
							new TextEncoder().encode(
								`data: {"id":${JSON.stringify(generationId)},"choices":[{"delta":{"content":"Partial output"}}]}\n\n`
							)
						);
						yield* Deferred.await(arrived);
						return { fiber, metered, queried };
					});

				// 1. Exact OpenRouter total_cost overrides conservative estimate
				const exact = yield* runAbort('gen-or/1', async () =>
					Response.json({ data: { id: 'gen-or/1', total_cost: 0.00425 } })
				);
				yield* Fiber.interrupt(exact.fiber);
				expect(exact.queried).toEqual([
					{
						url: 'https://openrouter.ai/api/v1/generation?id=gen-or%2F1',
						auth: 'Bearer or-secret'
					}
				]);
				expect(exact.metered).toEqual([{ id: 'gen-or/1', cost: 0.00425 }]);

				// 2. HTTP error from /generation falls back to conservative estimate
				const failed = yield* runAbort('gen-or-err', async () =>
					new Response('unavailable', { status: 503 })
				);
				yield* Fiber.interrupt(failed.fiber);
				expect(failed.queried[0]?.url).toBe(
					'https://openrouter.ai/api/v1/generation?id=gen-or-err'
				);
				expect(failed.metered.length).toBe(1);
				expect(failed.metered[0]?.id).toBe('gen-or-err');
				expect(failed.metered[0]?.cost).toBeGreaterThan(0);
				expect(failed.metered[0]?.cost).not.toBe(0.00425);

				// 3. Stalled /generation times out at 1.5s, aborts fetch, and falls back to estimate
				const started = yield* Deferred.make<void>();
				const aborted = yield* Deferred.make<void>();
				const run = yield* FiberSet.makeRuntimePromise();
				const stalled = yield* runAbort('gen-or-slow', (_url, _auth, signal) => {
					signal?.addEventListener('abort', () => Deferred.doneUnsafe(aborted, Effect.void));
					return run(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), {
						...(signal === undefined ? {} : { signal })
					});
				});
				const interrupting = yield* Fiber.interrupt(stalled.fiber).pipe(Effect.forkChild);
				yield* Deferred.await(started);
				yield* TestClock.adjust(1_500);
				yield* Fiber.join(interrupting);
				yield* Deferred.await(aborted);
				expect(stalled.metered.length).toBe(1);
				expect(stalled.metered[0]?.id).toBe('gen-or-slow');
				expect(stalled.metered[0]?.cost).toBeGreaterThan(0);
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
				const infer = open_ai_chat(
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
					tool_calls: [{ id: 't1', name: 'read_messages', input: { limit: 3 } }],
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
				const { response } = yield* collect(open_ai_chat(config, { fetch: f }));
				expect(response.tool_calls).toEqual([
					{ id: 't1', name: 'read_model', input: {}, invalid: expect.stringMatching(/JSON/) }
				]);
			})
	);
	it.effect('a length finish is a cut reply, not a stop', () =>
		Effect.gen(function* () {
			const sse = [
				'data: {"id":"gen-1","choices":[{"delta":{"content":"Half"}}]}',
				'data: {"id":"gen-1","choices":[{"delta":{},"finish_reason":"length"}]}',
				'data: [DONE]',
				''
			].join('\n\n');
			const { f } = capture(() => stream([sse]));
			const { response, deltas } = yield* collect(open_ai_chat(config, { fetch: f }));
			expect(deltas).toEqual(['Half']);
			expect(response.finish).toBe('cut');
		})
	);
	it.effect(
		'an empty tool-call id is bound to the assistant call before it, and a missing stream id is replaced',
		() =>
			Effect.gen(function* () {
				const { f, seen } = capture(() =>
					stream([
						[
							'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"x","arguments":"{}"}}]}}]}',
							'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
							'data: [DONE]',
							''
						].join('\n\n')
					])
				);
				const { response } = yield* collect(open_ai_chat(config, { fetch: f }), {
					model: 'default',
					messages: [
						{ role: 'user', content: 'hi' },
						{
							role: 'assistant',
							content: { text: '', toolCalls: [{ id: 't9', name: 'x', input: {} }] }
						},
						{ role: 'tool', content: { id: '', name: 'x', result: { ok: true } } }
					]
				});
				expect(first(response.tool_calls).id).toMatch(/^call_/);
				expect(first(seen).sent.messages.at(-1)).toMatchObject({
					role: 'tool',
					tool_call_id: 't9',
					content: '{"ok":true}'
				});
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
				const infer = open_ai_chat(
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
					tool_calls: [{ id: 't1', name: 'read_model', input: { aggregate: {} } }],
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
						open_ai_chat(config, { fetch: f })(request).pipe(
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
		'sends loose files on the first user message so later turns preserve the prefix, parses structured output, and rejects a refusal with its status',
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
				const infer = open_ai_chat({ ...config, strict: true }, { fetch: f });
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
				expect(first(sent.messages).content).toEqual([
					{ type: 'text', text: 'look' },
					{ type: 'text', text: 'attachment-1' },
					{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
					{
						type: 'text',
						text: 'attachment-2 (application/pdf): read_file reads it'
					}
				]);
				expect(sent.messages[2]?.content).toBe('again');
				expect(
					yield* collect(infer, {
						...request,
						messages: [{ role: 'user', content: 'too long' }]
					}).pipe(Effect.flip)
				).toMatchObject({ status: 400, message: expect.stringMatching(/maximum context length/) });
			})
	);
	it.effect(
		"a file a call opened follows that call's results, in the same place on every later step; a stranded one rides the last user message",
		() =>
			Effect.gen(function* () {
				const { f, seen } = capture(() =>
					Response.json({ choices: [{ message: { content: 'ok' } }], usage: {} })
				);
				const infer = open_ai_chat(config, { fetch: f });
				const step = (id: string) => ({
					role: 'tool' as const,
					content: { id, name: 'read_file', result: { attached: 'shown' } }
				});
				yield* collect(infer, {
					model: 'default',
					messages: [
						{ role: 'user', content: 'read these' },
						{
							role: 'assistant',
							content: {
								text: '',
								toolCalls: [
									{ id: 'c1', name: 'read_file', input: { id: 'a' } },
									{ id: 'c2', name: 'read_file', input: { id: 'b' } }
								]
							}
						},
						step('c1'),
						step('c2'),
						{ role: 'assistant', content: 'next' },
						{ role: 'user', content: '[conversation state: …]' }
					],
					files: [
						{ mime: 'image/jpeg', bytes: new Uint8Array([2]), call: 'c1' },
						{ mime: 'image/png', bytes: new Uint8Array([1]), call: 'gone' }
					]
				});
				const { sent } = first(seen);
				expect(sent).not.toHaveProperty('reasoning_effort');
				expect(sent.messages.map((m) => m.role)).toEqual([
					'user',
					'assistant',
					'tool',
					'tool',
					'user',
					'assistant',
					'user'
				]);
				expect(sent.messages[4]?.content).toEqual([
					{ type: 'text', text: 'attachment-1' },
					{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,Ag==' } }
				]);
				expect(sent.messages[6]?.content).toEqual([
					{ type: 'text', text: '[conversation state: …]' },
					{ type: 'text', text: 'attachment-2' },
					{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } }
				]);
			})
	);
	it.effect(
		'sends text as text parts, never as file parts providers refuse; any other type is named for read_file, not sent, and the call goes on',
		() =>
			Effect.gen(function* () {
				const { f, seen } = capture(() =>
					Response.json({ choices: [{ message: { content: 'ok' } }], usage: {} })
				);
				const infer = open_ai_chat(config, { fetch: f }),
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
				expect(parts[3]?.text).toBe(
					'attachment-3 (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet): read_file reads it'
				);
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
						text: 'attachment-1 (application/vnd.openxmlformats-officedocument.wordprocessingml.document): read_file reads it'
					}
				]);
				expect(seen).toHaveLength(2);
			})
	);
	it('a PDF, an office document or a zip is never a file part: read_file reads it', () => {
		for (const mime of [
			'application/pdf',
			'application/vnd.openxmlformats-officedocument.presentationml.presentation',
			'application/zip'
		])
			expect(fileParts({ mime, bytes: new Uint8Array([1]) }, 'a')).toEqual([
				{
					type: 'text',
					text: `a (${mime}): read_file reads it`
				}
			]);
	});
	it('an image is introduced by its pixel size, so a crop can be worked out', () => {
		const png = new Uint8Array(
				readFileSync(new URL('./fixtures/files/photo.png', import.meta.url))
			),
			jpeg = new Uint8Array(readFileSync(new URL('./fixtures/files/photo.jpg', import.meta.url)));
		expect(pixelSize(png)).toEqual({ width: 32, height: 24 });
		expect(pixelSize(jpeg)).toEqual({ width: 80, height: 60 });
		expect(pixelSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
		expect(fileParts({ mime: 'image/png', bytes: png }, 'attachment-1')[0]).toEqual({
			type: 'text',
			text: 'attachment-1: 32×24 px'
		});
	});
	it.effect(
		'a request opens with the one before it, byte for byte: reasoning, images and later turns included',
		() =>
			Effect.gen(function* () {
				const call = (id: string) => ({ id, name: 'read', input: {} }),
					image = { mime: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) };
				const first_ = [
					{ role: 'user' as const, content: 'q' },
					{
						role: 'assistant' as const,
						content: { text: '', toolCalls: [call('c1')], reasoning: 'First.' }
					},
					{ role: 'tool' as const, content: { id: 'c1', name: 'read', result: 1 } }
				];
				const second = [
					...first_,
					{
						role: 'assistant' as const,
						content: { text: 'Done.', toolCalls: [], reasoning: 'Second.' }
					},
					{ role: 'user' as const, content: 'a new turn' },
					{
						role: 'assistant' as const,
						content: { text: '', toolCalls: [call('c2')], reasoning: 'Third.' }
					},
					{ role: 'tool' as const, content: { id: 'c2', name: 'read', result: 2 } }
				];
				const sent = (
					messages: typeof second,
					files: readonly (typeof image & { call: string })[]
				) =>
					Effect.gen(function* () {
						const { f, seen } = capture(() =>
							stream([
								'data: {"id":"gen-9","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
							])
						);
						yield* collect(open_ai_chat(config, { fetch: f }), { ...request, messages, files });
						return first(seen).sent.messages.map((m) => JSON.stringify(m));
					});
				const kept = { ...image, call: 'c1' },
					before = yield* sent(first_, [kept]),
					// a file past the turn's room rides this one request, after the last result, and is gone on the next
					once = yield* sent(second, [kept, { ...image, call: 'c2' }]),
					after = yield* sent(second, [kept]);
				expect(once.slice(0, before.length)).toEqual(before);
				expect(after.slice(0, before.length)).toEqual(before);
				expect(once.slice(0, after.length)).toEqual(after);
				expect(once.length).toBe(after.length + 1);
			})
	);
	it.effect(
		"reasoning streams and comes back verbatim, an earlier turn's too; a switched call id is refused (L-BOLT-412, L-BOLT-432)",
		() =>
			Effect.gen(function* () {
				const { f, seen } = capture(() =>
					stream([
						'data: {"id":"gen-2","choices":[{"delta":{"reasoning":"None."}}]}\n\n',
						'data: {"id":"gen-2","choices":[{"delta":{"content":"Balanced."}}]}\n\ndata: [DONE]\n\n'
					])
				);
				const { response, thought } = yield* collect(open_ai_chat(config, { fetch: f }), {
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
				expect(first(seen).sent.messages[1]).toEqual({
					role: 'assistant',
					content: 'a',
					reasoning: 'Earlier.'
				});
				// within a turn every step keeps its reasoning: a sent message never changes, so the cached prefix holds
				const steps = capture(() =>
					stream([
						'data: {"id":"gen-5","choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
					])
				);
				const call = (id: string) => ({ id, name: 'read', input: {} });
				yield* collect(open_ai_chat(config, { fetch: steps.f }), {
					...request,
					messages: [
						{ role: 'user', content: 'q' },
						{
							role: 'assistant',
							content: { text: '', toolCalls: [call('c1')], reasoning: 'First.' }
						},
						{ role: 'tool', content: { id: 'c1', name: 'read', result: 1 } },
						{
							role: 'assistant',
							content: { text: '', toolCalls: [call('c2')], reasoning: 'Second.' }
						},
						{ role: 'tool', content: { id: 'c2', name: 'read', result: 2 } }
					]
				});
				expect(first(steps.seen).sent.messages.map((m) => m.reasoning ?? null)).toEqual([
					null,
					'First.',
					null,
					'Second.',
					null
				]);
				const mixed = capture(() =>
					stream([
						'data: {"id":"gen-3","choices":[{"delta":{"content":"a"}}]}\n\n',
						'data: {"id":"gen-4","choices":[{"delta":{"content":"b"}}]}\n\n'
					])
				);
				expect(
					yield* collect(open_ai_chat(config, { fetch: mixed.f }), {
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
			const events = yield* Stream.runCollect(open_ai_chat(config, { fetch: f })(request));
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
			const done = yield* Effect.forkChild(collect(open_ai_chat(config, { fetch: f })));
			yield* Port.attempt('fixture.fetch', () => fetched.promise);
			if (controller === undefined) return yield* Effect.die(new Error('stream did not start'));
			controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
			yield* Fiber.interrupt(done);
			expect(Exit.hasInterrupts(yield* Fiber.await(done))).toBe(true);
		})
	);

	it.effect(
		'multi-step infer nudges keep loose files anchored on the first user message byte-for-byte',
		() =>
			Effect.gen(function* () {
				const { f, seen } = capture(() =>
					Response.json({ choices: [{ message: { content: 'ok' } }], usage: {} })
				);
				const infer = open_ai_chat(config, { fetch: f });
				const files = [{ mime: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }];
				const base = {
					model: 'default',
					system: 'Extract fields',
					files
				};
				yield* collect(infer, {
					...base,
					messages: [{ role: 'user', content: 'Extract invoice' }]
				});
				yield* collect(infer, {
					...base,
					messages: [
						{ role: 'user', content: 'Extract invoice' },
						{ role: 'assistant', content: 'partial' },
						{ role: 'user', content: 'Build the answer with edit and submit' }
					]
				});
				expect(seen).toHaveLength(2);
				expect(seen[1]?.sent.messages.slice(0, 2)).toEqual(seen[0]?.sent.messages);
				expect(seen[1]?.sent.messages[3]?.content).toBe('Build the answer with edit and submit');
			})
	);

	it.effect(
		'Anthropic models emit ephemeral cache_control on system, last tool, and penultimate non-system message',
		() =>
			Effect.gen(function* () {
				const { f, seen } = capture(() =>
					Response.json({ choices: [{ message: { content: 'ok' } }], usage: {} })
				);
				const tools = [
					{ name: 'read', description: 'Read record', input: { type: 'object' } },
					{ name: 'write', description: 'Write record', input: { type: 'object' } }
				];
				const anthropic = open_ai_chat(
					{ endpoint: 'https://openrouter.ai/api/v1', models: { default: 'anthropic/claude-sonnet-4' } },
					{ fetch: f }
				);
				// >=2 conversation messages: system + last tool + penultimate non-system message
				yield* collect(anthropic, {
					model: 'default',
					system: 'You are Norbius.',
					tools,
					messages: [
						{ role: 'user', content: 'first question' },
						{ role: 'assistant', content: 'first answer' },
						{ role: 'user', content: 'follow up' }
					]
				});
				const multi = seen[0]?.sent;
				expect(multi?.messages[0]).toEqual({
					role: 'system',
					content: [{ type: 'text', text: 'You are Norbius.', cache_control: { type: 'ephemeral' } }]
				});
				expect(multi?.tools?.[0]).not.toHaveProperty('cache_control');
				expect(multi?.tools?.[1]).toMatchObject({
					type: 'function',
					cache_control: { type: 'ephemeral' }
				});
				expect(multi?.messages[2]).toEqual({
					role: 'assistant',
					content: [{ type: 'text', text: 'first answer', cache_control: { type: 'ephemeral' } }]
				});
				expect(multi?.messages[3]).toEqual({ role: 'user', content: 'follow up' });

				// single conversation message: system + last tool cached, no message breakpoint
				yield* collect(anthropic, {
					model: 'default',
					system: 'You are Norbius.',
					tools,
					messages: [{ role: 'user', content: 'only message' }]
				});
				expect(seen[1]?.sent.messages[1]).toEqual({ role: 'user', content: 'only message' });

				// empty assistant tool-call penultimate message: walks back to non-empty prior message
				yield* collect(anthropic, {
					model: 'default',
					system: 'You are Norbius.',
					messages: [
						{ role: 'user', content: 'check' },
						{
							role: 'assistant',
							content: { text: '', toolCalls: [{ id: 'c1', name: 'read', input: {} }] }
						},
						{ role: 'tool', content: { id: 'c1', name: 'read', result: { ok: true } } }
					]
				});
				expect(seen[2]?.sent.messages[1]).toEqual({
					role: 'user',
					content: [{ type: 'text', text: 'check', cache_control: { type: 'ephemeral' } }]
				});
				expect(seen[2]?.sent.messages[2]?.content).toBe('');

				// direct claude model id also receives cache_control; non-Anthropic model does not
				yield* collect(
					open_ai_chat(
						{ endpoint: 'https://llm.test/v1', models: { default: 'claude-3-5-sonnet' } },
						{ fetch: f }
					),
					{ model: 'default', system: 'Sys', messages: [{ role: 'user', content: 'hi' }] }
				);
				expect(seen[3]?.sent.messages[0]).toEqual({
					role: 'system',
					content: [{ type: 'text', text: 'Sys', cache_control: { type: 'ephemeral' } }]
				});
				yield* collect(
					open_ai_chat(
						{ endpoint: 'https://openrouter.ai/api/v1', models: { default: 'deepseek/deepseek-v3' } },
						{ fetch: f }
					),
					{
						model: 'default',
						system: 'Sys',
						tools,
						messages: [
							{ role: 'user', content: 'a' },
							{ role: 'assistant', content: 'b' },
							{ role: 'user', content: 'c' }
						]
					}
				);
				expect(seen[4]?.sent.messages[0]).toEqual({ role: 'system', content: 'Sys' });
				expect(seen[4]?.sent.tools?.[1]).not.toHaveProperty('cache_control');
				expect(seen[4]?.sent.messages[2]).toEqual({ role: 'assistant', content: 'b' });
			})
	);

	it.effect('OpenAI models emit prompt_cache_key derived from session_of, and OpenRouter sends session_id for all models', () =>
		Effect.gen(function* () {
			const { f, seen } = capture(() =>
				Response.json({ choices: [{ message: { content: 'ok' } }], usage: {} })
			);
			const req1: AiRequest = {
				model: 'default',
				system: 'You are Norbius.',
				messages: [{ role: 'user', content: 'hello' }]
			};
			const req2: AiRequest = {
				...req1,
				messages: [
					{ role: 'user', content: 'hello' },
					{ role: 'assistant', content: 'hi' },
					{ role: 'user', content: 'next' }
				]
			};
			const expectedSession = session_of(req1);

			for (const model of ['openai/gpt-4.1', 'gpt-4o', 'o3-mini']) {
				const chat = open_router_chat(
					{ endpoint: 'https://openrouter.ai/api/v1', models: { default: model } },
					{ fetch: f }
				);
				yield* collect(chat, req1);
				yield* collect(chat, req2);
			}
			for (let i = 0; i < 6; i++) {
				expect(seen[i]?.sent.prompt_cache_key).toBe(expectedSession);
				expect(seen[i]?.sent.session_id).toBe(expectedSession);
				expect(seen[i]?.sent.provider).toBeUndefined();
			}

			// Anthropic on OpenRouter gets session_id + cache_control, no prompt_cache_key and no DeepSeek provider pinning
			yield* collect(
				open_router_chat(
					{
						endpoint: 'https://openrouter.ai/api/v1',
						models: { default: 'anthropic/claude-sonnet-4' }
					},
					{ fetch: f }
				),
				req1
			);
			expect(seen[6]?.sent.session_id).toBe(expectedSession);
			expect(seen[6]?.sent.prompt_cache_key).toBeUndefined();
			expect(seen[6]?.sent.provider).toBeUndefined();

			// DeepSeek on OpenRouter keeps both session_id AND explicit provider pinning
			yield* collect(
				open_router_chat(
					{ endpoint: 'https://openrouter.ai/api/v1', models: { default: 'deepseek/deepseek-v3' } },
					{ fetch: f }
				),
				req1
			);
			expect(seen[7]?.sent.session_id).toBe(expectedSession);
			expect(seen[7]?.sent.prompt_cache_key).toBeUndefined();
			expect(seen[7]?.sent.provider).toMatchObject({
				only: ['together', 'relace/fast', 'deepinfra/fp8', 'baseten'],
				sort: 'latency',
				require_parameters: true
			});

			// Non-OpenRouter endpoint does not get session_id, while OpenAI direct model still gets prompt_cache_key
			yield* collect(
				open_router_chat(
					{ endpoint: 'https://api.openai.com/v1', models: { default: 'gpt-4.1' } },
					{ fetch: f }
				),
				req1
			);
			expect(seen[8]?.sent.session_id).toBeUndefined();
			expect(seen[8]?.sent.prompt_cache_key).toBe(expectedSession);
		})
	);
});

describe('what a provider lists and charges', () => {
	it.effect('an endpoint that reports no charge is charged its tokens at the listed price; its own charge wins', () =>
		Effect.gen(function* () {
			const usage = (cost?: number) =>
				capture(() =>
					stream([
						`data: ${JSON.stringify({
							id: 'gen-1',
							choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
							usage: {
								prompt_tokens: 1_000_000,
								completion_tokens: 100_000,
								prompt_tokens_details: { cached_tokens: 400_000 },
								...(cost === undefined ? {} : { cost })
							}
						})}\n\n`,
						'data: [DONE]\n\n'
					])
				);
			const priced = { ...config, price: () => ({ input: 2, output: 10, cached: 0.5 }) };
			// 600k fresh at $2/M, 400k cached at $0.50/M, 100k out at $10/M
			expect((yield* collect(open_ai_chat(priced, { fetch: usage().f }))).response.usage).toMatchObject({
				cost: 1.2 + 0.2 + 1,
				call: 'gen-1'
			});
			expect((yield* collect(open_ai_chat(priced, { fetch: usage(0.5).f }))).response.usage.cost).toBe(0.5);
			expect('cost' in (yield* collect(open_ai_chat(config, { fetch: usage().f }))).response.usage).toBe(false);
		})
	);
	it('lists what each system can run, priced per million tokens, never a free or batch variant', () => {
		const model = (id: string, parameters: string[], input = ['text', 'image']) => ({
			id,
			name: `Acme: ${id}`,
			context_length: 1000,
			architecture: { input_modalities: input, output_modalities: ['text'] },
			supported_parameters: parameters,
			pricing: { prompt: '0.000002', completion: '0.00001', input_cache_read: '-1' }
		});
		const listed = ai_models({
			chat: [
				model('a/agent', ['tools', 'tool_choice', 'structured_outputs']),
				model('a/decider', ['structured_outputs']),
				model('a/agent:free', ['tools', 'tool_choice']),
				model('a/agent:batch', ['tools', 'tool_choice']),
				model('a/text', ['tools', 'tool_choice'], ['text'])
			],
			embeddings: [],
			unread: false
		});
		expect(listed.sys_2).toEqual([
			{ id: 'a/agent', label: 'a/agent', provider: 'Acme', context: 1000, price: { input: 2, output: 10 } }
		]);
		expect(listed.sys_1.map((m) => m.id)).toEqual(['a/agent', 'a/decider']);
	});
});
