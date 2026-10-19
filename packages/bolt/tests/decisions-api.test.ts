// `decisionsSystem1` (P35, P37) against a fake fetch standing in for OpenRouter's Decisions API: the port's request goes
// out as `{ model, state, questions }` field for field (a text-only state), the answers come back as given with a
// score's `level` added and `usage.cost` as `costUsd`; a context refusal is `tooLarge`; a slow, failing or malformed
// answer rejects (the client never falls back).
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { decisionsSystem1, type System1Request } from '../src/engine/decisions/index.ts';

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

const request: System1Request = {
	state: {
		pending: [
			{
				from: 'Ann',
				text: 'the pump at Kismis',
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
	decisionsSystem1(
		{
			url: 'https://decisions.test/api/alpha/decisions',
			model: 'vendor/model',
			apiKey: 'k',
			timeoutMillis: 150
		},
		{ fetch: transport }
	).ask(request);

describe('the Decisions API sys_1 client', () => {
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
					costUsd: 0.00004,
					provider: 'typesafe',
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
				const headers = seen[0]!.headers;
				const [, traceId, spanId] = headers.traceparent!.split('-');
				expect(headers.b3!.split('-').slice(0, 3)).toEqual([traceId, spanId, '1']);
			})
	);

	it.live('names the model as the provider when the answer names none', () =>
		Effect.gen(function* () {
			const { provider: _, ...rest } = answerBody('ok');
			const transport: typeof fetch = async () => Response.json(rest);
			const r = yield* decisionsSystem1(
				{ url: 'https://decisions.test/api/alpha/decisions', model: 'vendor/model', apiKey: 'k' },
				{ fetch: transport }
			).ask(request);
			expect(r.provider).toBe('vendor/model');
		})
	);

	it.live('a context-limit refusal is tooLarge', () =>
		Effect.gen(function* () {
			expect(yield* Effect.flip(ask(fake('context').transport))).toMatchObject({
				kind: 'tooLarge'
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
