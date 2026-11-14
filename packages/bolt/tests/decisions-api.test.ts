// `decisions_system_1` (P35, P37) against a fake fetch standing in for OpenRouter's Decisions API: the port's request goes
// out as `{ model, state, questions }` field for field (a text-only state), the answers come back as given with a
// score's `level` added and `usage.cost` as `cost_usd`; a context refusal is `too_large`; a slow, failing or malformed
// answer rejects (the client never falls back).
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema, Stream } from 'effect';
import {
	type DecisionRequest,
	DecisionRequestSchema,
	decisions_system_1,
	structured_system_1
} from '@norbital-ai/host-api';
import { decisionEvent } from '../src/engine/decision.ts';

type Mode = 'ok' | 'slow' | 'down' | 'context' | 'malformed';
const answerBody = (mode: Mode) => ({
	provider: 'typesafe',
	answers: {
		action: {
			type: 'choice',
			choice: 'wait',
			confidence: 0.92,
			probabilities: { respond: 0.05, wait: 0.92, ignore: 0.03 }
		},
		wait:
			mode === 'malformed'
				? { type: 'score' }
				: {
						type: 'score',
						score: 1.99,
						confidence: 0.8,
						probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 },
						legend: { 0: '0 s', 1: '1 s', 2: '2 s' }
					},
		sorted: { type: 'noul', noul: 0.7 }
	},
	usage: { input_tokens: 120, output_tokens: 0, cost: 0.00004 }
});
const fake = (mode: Mode) => {
	const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
	const transport: typeof fetch = async (input, init = {}) => {
		const native = new Request(input, init);
		seen.push({
			url: native.url,
			headers: Object.fromEntries(native.headers),
			body: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(await native.text())
		});
		if (mode === 'down') return new Response('boom', { status: 500 });
		if (mode === 'context')
			return new Response('{"error":{"message":"maximum context length is 32768 tokens"}}', {
				status: 400
			});
		if (mode === 'slow')
			await new Promise<void>((resolve, reject) => {
				const signal = init.signal ?? native.signal;
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				const aborted = () => {
					clearTimeout(timer);
					reject(signal.reason);
				};
				const timer = setTimeout(() => {
					signal.removeEventListener('abort', aborted);
					resolve();
				}, 400);
				signal.addEventListener('abort', aborted, { once: true });
			});
		return Response.json(answerBody(mode));
	};
	return { seen, transport };
};

const request: DecisionRequest = {
	state: {
		pending: [
			{
				from: 'Ann',
				text: 'the pump at Bismis',
				attachments: [{ name: 'p.png', mime: 'image/png', size: 2 }]
			}
		]
	},
	questions: {
		action: {
			type: 'choice',
			instructions: 'What now?',
			criteria: { respond: 'answer now', wait: 'more is coming', ignore: 'not for us' }
		},
		wait: { type: 'score', instructions: 'Seconds?', criteria: ['0 s', '1 s', '2 s'] },
		sorted: {
			type: 'noul',
			instructions: 'Does it ask for an order?',
			criteria: { true: 'it does', false: 'it does not' }
		}
	}
};
const ask = (transport: typeof fetch) =>
	decisions_system_1(
		{
			url: 'https://decisions.test/api/alpha/decisions',
			model: 'vendor/model',
			api_key: 'k',
			timeout_ms: 150
		},
		{ fetch: transport }
	).ask(request);

describe('the Decisions API sys_1 client', () => {
	it.live('sends actual inline image assets once and keeps their bytes out of decision logs', () =>
		Effect.gen(function* () {
			const { seen, transport } = fake('ok');
			const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } };
			const input = { ...request, state: ['message m0: attached image', image] };
			const result = yield* decisions_system_1(
				{ url: 'https://decisions.test', model: 'jev', api_key: 'k' },
				{ fetch: transport }
			).ask(input);
			const body = Schema.decodeUnknownSync(
				Schema.Struct({
					state: Schema.Array(Schema.Json),
					assets: Schema.Record(
						Schema.String,
						Schema.Struct({
							type: Schema.String,
							format: Schema.String,
							data_base64: Schema.String
						})
					)
				})
			)(seen[0]?.body);
			const [ref] = Object.keys(body.assets);
			expect(body.state).toEqual(['message m0: attached image', ref]);
			expect(Object.values(body.assets)).toEqual([
				{ type: 'image', format: 'png', data_base64: 'AQID' }
			]);
			expect(seen[0]?.headers['typesafe-danger-zone-images']).toBe('true');
			expect(JSON.stringify(decisionEvent('triage', input, result))).not.toContain('AQID');
			expect(seen).toHaveLength(1);
		})
	);
	it.live('rejects remote and oversized image inputs before sending a provider request', () =>
		Effect.gen(function* () {
			const { seen, transport } = fake('ok');
			const adapter = decisions_system_1(
				{ url: 'https://decisions.test', model: 'jev', api_key: 'k' },
				{ fetch: transport }
			);
			for (const url of [
				'https://private.invalid/picture.png',
				'data:image/png;base64,' + 'A'.repeat(29 * 1024 * 1024)
			])
				expect(
					yield* Effect.flip(
						adapter.ask({ ...request, state: [{ type: 'image_url', image_url: { url } }] })
					)
				).toBeInstanceOf(Error);
			expect(seen).toHaveLength(0);
		})
	);
	it.live('maps image evidence to native OpenAI image parts, never base64 text', () =>
		Effect.gen(function* () {
			let body: unknown;
			const transport: typeof fetch = async (input, init) => {
				body = await new Request(input, init).json();
				return Response.json({
					model: 'luna',
					answers: [{ name: 'visual', type: 'predicate', probability: 0.9 }],
					usage: { input_tokens: 1, output_tokens: 0 }
				});
			};
			const adapter = decisions_system_1(
				{ format: 'openai', url: 'https://openai.test/v1/decisions', model: 'luna', api_key: 'k' },
				{ fetch: transport }
			);
			yield* adapter.ask({
				state: ['m0', { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } }],
				questions: { visual: { type: 'noul', instructions: 'Does the image show a table?' } }
			});
			expect(body).toMatchObject({
				input: [
					{
						role: 'user',
						content: [
							{ type: 'input_text', text: JSON.stringify(['m0', 'image-1']) },
							{ type: 'input_text', text: 'image-1' },
							{ type: 'input_image', image_url: 'data:image/jpeg;base64,AQID' }
						]
					}
				]
			});
		})
	);
	it.live(
		'sends { model, state, questions } field for field and maps the answers back, a score gaining its level',
		() =>
			Effect.gen(function* () {
				const { seen, transport } = fake('ok');
				expect(yield* ask(transport)).toEqual({
					answers: {
						action: {
							type: 'choice',
							choice: 'wait',
							confidence: 0.92,
							probabilities: { respond: 0.05, wait: 0.92, ignore: 0.03 }
						},
						wait: {
							type: 'score',
							score: 1.99,
							level: 2,
							confidence: 0.8,
							probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 },
							legend: { 0: '0 s', 1: '1 s', 2: '2 s' }
						},
						sorted: { type: 'noul', noul: 0.7 }
					},
					cost_usd: 0.00004,
					provider: 'typesafe',
					model: 'vendor/model',
					tokens: { input: 120, output: 0 }
				});
				expect(seen).toEqual([
					{
						url: 'https://decisions.test/api/alpha/decisions',
						headers: {
							authorization: 'Bearer k',
							'content-type': 'application/json',
							traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
							b3: expect.stringMatching(/^[0-9a-f]{32}-[0-9a-f]{16}-1(?:-[0-9a-f]{16})?$/)
						},
						body: { model: 'vendor/model', questions: request.questions, state: request.state }
					}
				]);
				const headers = seen[0]?.headers;
				const [, traceId, spanId] = headers?.traceparent?.split('-') ?? [];
				expect(headers?.b3?.split('-').slice(0, 3)).toEqual([traceId, spanId, '1']);
			})
	);

	it.live('names the model as the provider when the answer names none', () =>
		Effect.gen(function* () {
			const { provider: _, ...rest } = answerBody('ok');
			const transport: typeof fetch = async () => Response.json(rest);
			const r = yield* decisions_system_1(
				{ url: 'https://decisions.test/api/alpha/decisions', model: 'vendor/model', api_key: 'k' },
				{ fetch: transport }
			).ask(request);
			expect(r.provider).toBe('vendor/model');
		})
	);

	it.live(
		'preserves structured questions in one HTTP call and restores a structured score legend',
		() =>
			Effect.gen(function* () {
				const structured: DecisionRequest = {
					state: [{ message: 'Refund the duplicate payment' }],
					questions: {
						action: {
							type: 'choice',
							instructions: { question: 'What next?', inspect: ['message'] },
							criteria: {
								wait: { description: 'Wait for evidence', where: { status: { eq: 'pending' } } },
								respond: ['Reply now'],
								ignore: null
							}
						},
						wait: { type: 'score', criteria: [{ delay: 0 }, { delay: 1 }, { delay: 2 }] },
						sorted: { type: 'noul', instructions: ['Does it ask for sorting?'] }
					}
				};
				const { seen, transport } = fake('ok');
				const result = yield* decisions_system_1(
					{ url: 'https://decisions.test/', model: 'jev', api_key: 'k' },
					{ fetch: transport }
				).ask(structured);
				expect(seen).toHaveLength(1);
				expect(seen[0]?.body).toEqual({ model: 'jev', ...structured });
				expect(result.answers.wait).toMatchObject({
					level: 2,
					legend: { 0: { delay: 0 }, 1: { delay: 1 }, 2: { delay: 2 } }
				});
			})
	);

	it.effect(
		'the structured chat adapter preserves JSON questions and structured rubrics in one call',
		() =>
			Effect.gen(function* () {
				const structured: DecisionRequest = {
					state: 'A duplicate charge',
					questions: {
						route: {
							type: 'choice',
							instructions: { question: 'Which route?' },
							criteria: { billing: { reason: 'money' }, other: null }
						},
						urgency: { type: 'score', criteria: [{ priority: 'low' }, { priority: 'high' }] },
						refund: { type: 'noul' }
					}
				};
				let calls = 0;
				const adapter = structured_system_1((request) => {
					calls++;
					expect(request.messages).toEqual([{ role: 'user', content: JSON.stringify(structured) }]);
					expect(request.output).toMatchObject({ type: 'object' });
					return Stream.make({
						_tag: 'Response',
						response: {
							content: {
								route: { probabilities: { billing: 1, other: 0 } },
								urgency: { probabilities: { 0: 0.1, 1: 0.9 } },
								refund: { noul: 0.8 }
							},
							tool_calls: [],
							finish: 'stop',
							usage: { input: 30, output: 10 }
						}
					});
				}, 'model');
				const result = yield* adapter.ask(structured);
				expect(calls).toBe(1);
				expect(result.answers.route).toMatchObject({ choice: 'billing' });
				expect(result.answers.urgency).toMatchObject({
					level: 1,
					legend: { 0: { priority: 'low' }, 1: { priority: 'high' } }
				});
			})
	);

	it('decodes the documented structured entry shapes and optional Noul criteria', () => {
		for (const state of ['text', [{ text: 'evidence' }], { text: 'evidence' }]) {
			const request = {
				state,
				questions: {
					q: { type: 'noul', instructions: null },
					partial: { type: 'noul', criteria: { true: { reason: 'yes' } } },
					absent: { type: 'noul' },
					nullCriteria: { type: 'noul', criteria: null }
				}
			};
			expect(Schema.decodeUnknownSync(DecisionRequestSchema)(request)).toEqual(request);
		}
		for (const instructions of [true, 42])
			expect(() =>
				Schema.decodeUnknownSync(DecisionRequestSchema)({
					state: {},
					questions: { q: { type: 'noul', instructions } }
				})
			).toThrow();
	});

	it.live('maps the unified contract to native OpenAI Decisions in one call', () =>
		Effect.gen(function* () {
			const structured: DecisionRequest = {
				state: { description: 'Open jobs' },
				questions: {
					filter: {
						type: 'choice',
						instructions: { question: 'Which filter?' },
						criteria: { open: { where: { status: { eq: 'open' } } }, none: null }
					},
					ready: {
						type: 'noul',
						instructions: 'Ready?',
						criteria: { true: { status: 'ready' }, false: ['pending'] }
					},
					urgency: {
						type: 'score',
						instructions: ['How urgent?'],
						criteria: [{ priority: 'low' }, { priority: 'high' }]
					}
				}
			};
			const seen: unknown[] = [];
			let refuse = false;
			const transport: typeof fetch = async (input, init) => {
				seen.push(await new Request(input, init).json());
				return Response.json({
					model: 'decision-model',
					answers: [
						refuse
							? { type: 'refusal', name: 'filter' }
							: {
									type: 'choice',
									name: 'filter',
									choice: 'open',
									confidence: 0.9,
									probabilities: [
										{ value: 'open', probability: 0.9 },
										{ value: 'none', probability: 0.1 }
									]
								},
						{ type: 'predicate', name: 'ready', probability: 0.8 },
						{
							type: 'score',
							name: 'urgency',
							score: 0.9,
							confidence: 0.9,
							probabilities: [
								{ value: 0, label: '0', probability: 0.1 },
								{ value: 1, label: '1', probability: 0.9 }
							]
						}
					],
					usage: { input_tokens: 80, output_tokens: 0 }
				});
			};
			const adapter = decisions_system_1(
				{
					format: 'openai',
					url: 'https://openai.test/v1/decisions',
					model: 'decision-model',
					api_key: 'k'
				},
				{ fetch: transport }
			);
			const result = yield* adapter.ask(structured);
			expect(seen).toEqual([
				{
					model: 'decision-model',
					input: JSON.stringify(structured.state),
					questions: [
						{
							name: 'filter',
							type: 'choice',
							instructions: JSON.stringify({ question: 'Which filter?' }),
							choices: [
								{
									value: 'open',
									description: JSON.stringify({ where: { status: { eq: 'open' } } })
								},
								{ value: 'none', description: 'null' }
							]
						},
						{
							name: 'ready',
							type: 'predicate',
							instructions: JSON.stringify({
								instructions: 'Ready?',
								criteria: { true: { status: 'ready' }, false: ['pending'] }
							})
						},
						{
							name: 'urgency',
							type: 'score',
							instructions: JSON.stringify(['How urgent?']),
							levels: [
								{ label: '0', description: JSON.stringify({ priority: 'low' }) },
								{ label: '1', description: JSON.stringify({ priority: 'high' }) }
							]
						}
					]
				}
			]);
			expect(result.answers).toMatchObject({
				filter: { type: 'choice', choice: 'open', probabilities: { open: 0.9, none: 0.1 } },
				ready: { type: 'noul', noul: 0.8 },
				urgency: {
					type: 'score',
					score: 0.9,
					level: 1,
					legend: { 0: { priority: 'low' }, 1: { priority: 'high' } }
				}
			});
			refuse = true;
			expect(yield* Effect.flip(adapter.ask(structured))).toMatchObject({ kind: 'invalid' });
			expect(seen).toHaveLength(2); // one call per invocation, including a refusal
		})
	);

	it.live('a context-limit refusal is too_large', () =>
		Effect.gen(function* () {
			expect(yield* Effect.flip(ask(fake('context').transport))).toMatchObject({
				kind: 'too_large'
			});
		})
	);

	it.live('rejects on a timeout, an HTTP error and a malformed answer; it never falls back', () =>
		Effect.gen(function* () {
			for (const m of ['slow', 'down', 'malformed'] as const) {
				const { seen, transport } = fake(m);
				expect(yield* Effect.flip(ask(transport))).toBeInstanceOf(Error);
				expect(seen).toHaveLength(1);
			}
		})
	);
});
