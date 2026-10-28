// Embeddings and P39 on an OpenAI-compatible endpoint, as both hosts' copies did them: batches of the model's size, a
// file in the multimodal shape, vectors in input order, a rate limit retried after `retry-after`, the provider's charge
// metered; a model that does not take images refused unless its listing did not answer and the host tolerates that.
import { describe, expect, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Crypto, Effect, Fiber, Layer, PlatformError, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { ProviderUnavailable } from '../src/errors.ts';
import { aiModalityRefusals, openAiEmbeddings } from '../src/openrouter/embeddings.ts';
import { openRouterChat } from '../src/openrouter/chat.ts';

type Seen = { url: string; body: unknown; authorization: string | undefined };
/** An HttpClient answering each request with `answer(seen)`; every request is recorded. */
const fake = (answer: (seen: Seen, n: number) => Response) => {
	const seen: Seen[] = [];
	const client = HttpClient.make((request, url) =>
		Effect.sync(() => {
			const body =
				request.body._tag === 'Uint8Array'
					? JSON.parse(new TextDecoder().decode(request.body.body))
					: null;
			const s = { url: url.toString(), body, authorization: request.headers['authorization'] };
			seen.push(s);
			return HttpClientResponse.fromWeb(request, answer(s, seen.length));
		})
	);
	return {
		client,
		seen,
		provide: Effect.provide(
			Layer.merge(NodeCrypto.layer, Layer.succeed(HttpClient.HttpClient, client))
		)
	};
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});

it.effect(
	'DeepSeek chat preserves provider privacy preferences while resolving model classes',
	() =>
		Effect.gen(function* () {
			const http = fake(() => json({ choices: [{ message: { content: 'ok' } }] }));
			const chat = openRouterChat(
				{
					endpoint: 'https://openrouter.ai/api/v1',
					models: { default: 'deepseek/fixture' },
					body: { provider: { data_collection: 'deny', zdr: true, sort: 'latency' } }
				},
				{ httpClient: http.client }
			);
			yield* Stream.runDrain(
				chat({ model: 'default', messages: [{ role: 'user', content: 'hi' }] })
			);
			expect(http.seen[0]).toMatchObject({
				url: 'https://openrouter.ai/api/v1/chat/completions',
				body: {
					model: 'deepseek/fixture',
					provider: {
						data_collection: 'deny',
						zdr: true,
						sort: 'latency',
						require_parameters: true
					}
				}
			});
		})
);

describe('openAiEmbeddings', () => {
	it.effect(
		'batches by the model, sends a file as a content part, answers in input order and meters the charge',
		() =>
			Effect.gen(function* () {
				const metered: [number, string][] = [];
				const reads: [string, number][] = [];
				const http = fake((s) => {
					const input = (s.body as { input: unknown[] }).input;
					// out of order: the vectors follow `index`
					return json({
						id: `call-${input.length}`,
						data: input.map((_, i) => ({ index: i, embedding: [i] })).reverse(),
						usage: { cost: 0.5 }
					});
				});
				const embed = openAiEmbeddings({
					baseUrl: 'https://ai.example/v1/',
					files: (key, max) =>
						Effect.sync(() => {
							reads.push([key, max]);
							return new Uint8Array([1, 2]);
						}),
					apiKey: 'k',
					model: (name) => (name === 'scene' ? { id: 'vendor/embed', batch: 2 } : undefined),
					meter: (cost, id) =>
						Effect.sync(() => {
							metered.push([cost, id]);
						})
				});
				const vectors = yield* embed(
					[
						'a',
						'b',
						{ $stored: { key: 'stored-photo', name: 'p.png', mime: 'image/png', bytes: 2 } }
					],
					'scene',
					8
				).pipe(http.provide);
				expect(vectors).toEqual([[0], [1], [0]]);
				expect(reads).toEqual([['stored-photo', 2]]);
				expect(http.seen.map((s) => s.url)).toEqual([
					'https://ai.example/v1/embeddings',
					'https://ai.example/v1/embeddings'
				]);
				expect(http.seen[0]).toMatchObject({
					authorization: 'Bearer k',
					body: { model: 'vendor/embed', input: ['a', 'b'], dimensions: 8 }
				});
				expect(http.seen[1]!.body).toEqual({
					model: 'vendor/embed',
					dimensions: 8,
					input: [
						{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQI=' } }] }
					]
				});
				expect(metered).toEqual([
					[0.5, 'call-2'],
					[0.5, 'call-1']
				]);
				expect(yield* Effect.flip(embed(['a'], 'other').pipe(http.provide))).toMatchObject({
					_tag: 'ProviderUnavailable',
					message: "no model is mapped to the embedding 'other'"
				});
			})
	);

	it.effect('retries a rate limit after its retry-after, and refuses a 4xx for good', () =>
		Effect.gen(function* () {
			const http = fake((_s, n) =>
				n === 1
					? json({ error: 'slow down' }, 429, { 'retry-after': '2' })
					: json({ data: [{ embedding: [1] }] })
			);
			const embed = openAiEmbeddings({
				baseUrl: 'https://ai.example/v1',
				model: () => ({ id: 'm', batch: 8 })
			});
			const fiber = yield* Effect.forkChild(embed(['a'], 'default').pipe(http.provide));
			yield* TestClock.adjust('2 seconds');
			expect(yield* Fiber.join(fiber)).toEqual([[1]]);
			expect(http.seen).toHaveLength(2);
			const refused = fake(() => json({ error: 'bad model' }, 400));
			expect(yield* Effect.flip(embed(['a'], 'default').pipe(refused.provide))).toMatchObject({
				_tag: 'ProviderRefused',
				permanent: true,
				code: '400'
			});
			expect(refused.seen).toHaveLength(1);
			const short = fake(() => json({ data: [] }));
			expect(yield* Effect.flip(embed(['a'], 'default').pipe(short.provide))).toMatchObject({
				_tag: 'ProviderUnavailable',
				message: 'the AI provider answered 0 embeddings for 1 inputs'
			});
		})
	);

	it.effect('uses secure fallback billing ids and keeps vectors when metering fails', () =>
		Effect.gen(function* () {
			const http = fake(() => json({ data: [{ embedding: [1] }], usage: { cost: 0.5 } }));
			const ids: string[] = [];
			let failing = false;
			const embed = openAiEmbeddings({
				baseUrl: 'https://ai.example/v1',
				model: () => ({ id: 'm', batch: 8 }),
				meter: (_cost, id) =>
					Effect.gen(function* () {
						ids.push(id);
						if (failing) return yield* new ProviderUnavailable({ message: 'billing unavailable' });
					})
			});
			expect(yield* embed(['a'], 'default').pipe(http.provide)).toEqual([[1]]);
			expect(ids[0]).toMatch(
				/^embed:[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/
			);
			failing = true;
			expect(yield* embed(['a'], 'default').pipe(http.provide)).toEqual([[1]]);
			expect(ids).toHaveLength(2);
			expect(ids[1]).not.toBe(ids[0]);
		})
	);

	it.effect('keeps vectors when a fallback billing id fails and retains provider ids', () =>
		Effect.gen(function* () {
			const crypto = yield* Crypto.Crypto.pipe(Effect.provide(NodeCrypto.layer));
			const unavailable: Crypto.Crypto = {
				...crypto,
				randomUUIDv4: () =>
					Effect.fail(
						PlatformError.systemError({
							_tag: 'Unknown',
							module: 'Crypto',
							method: 'randomUUIDv4',
							description: 'secure random source unavailable'
						})
					)
			};
			let id: string | undefined;
			const http = fake(() =>
				json({
					...(id === undefined ? {} : { id }),
					data: [{ embedding: [1] }],
					usage: { cost: 0.5 }
				})
			);
			const metered: string[] = [];
			const embed = openAiEmbeddings({
				baseUrl: 'https://ai.example/v1',
				model: () => ({ id: 'm', batch: 8 }),
				meter: (_cost, key) =>
					Effect.sync(() => {
						metered.push(key);
					})
			});
			const call = () =>
				embed(['a'], 'default').pipe(
					Effect.provideService(Crypto.Crypto, unavailable),
					http.provide
				);
			expect(yield* call()).toEqual([[1]]);
			expect(metered).toEqual([]);
			id = 'provider-id';
			expect(yield* call()).toEqual([[1]]);
			expect(metered).toEqual(['provider-id']);
		})
	);
});

describe('aiModalityRefusals (P39)', () => {
	const endpoint = { baseUrl: 'https://ai.example/v1', apiKey: 'k' };
	const checks = [
		{
			system: 'sys_2' as const,
			endpoint,
			models: ['vendor/chat']
		},
		{
			system: 'embed' as const,
			endpoint,
			models: ['vendor/embed']
		}
	];
	const listing = (mods: readonly string[]) => (s: Seen) =>
		json({
			data: [
				{
					id: s.url.endsWith('/embeddings/models') ? 'vendor/embed' : 'vendor/chat',
					architecture: { input_modalities: mods }
				}
			]
		});

	it.effect(
		'passes models that take images, refuses one that does not, reading each listing once',
		() =>
			Effect.gen(function* () {
				const ok = fake(listing(['text', 'image']));
				expect(
					yield* aiModalityRefusals(checks, { tolerateUnread: false }).pipe(ok.provide)
				).toEqual([]);
				expect(ok.seen.map((s) => s.url)).toEqual([
					'https://ai.example/v1/models',
					'https://ai.example/v1/embeddings/models'
				]);
				const textOnly = fake(listing(['text']));
				expect(
					yield* aiModalityRefusals(checks, { tolerateUnread: false }).pipe(textOnly.provide)
				).toEqual([
					"sys_2 model 'vendor/chat' takes text: it must take image (P39)",
					"embed model 'vendor/embed' takes text: it must take image (P39)"
				]);
			})
	);

	it.effect(
		'lets a model through a listing that did not answer only when tolerated',
		() =>
			Effect.gen(function* () {
				const down = () => fake(() => json({ error: 'down' }, 503));
				expect(
					yield* aiModalityRefusals(checks, { tolerateUnread: true }).pipe(down().provide)
				).toEqual([]);
				expect(
					yield* aiModalityRefusals(checks, { tolerateUnread: false }).pipe(down().provide)
				).toEqual([
					"sys_2 model 'vendor/chat' has no published input modalities: it must take image (P39)",
					"embed model 'vendor/embed' has no published input modalities: it must take image (P39)"
				]);
			})
	);
});
