import { Effect, Fiber, Stream, SubscriptionRef } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from '@effect/vitest';
import { Decimal } from '@norbital-ai/std/decimal';
import { createBolt } from '../src/page/bolt.ts';
import { liveStream, type EventSourceLike } from '../src/page/stream.ts';
import { browserTransport, updating } from '../src/protocol/client.ts';
import { HEADERS } from '../src/protocol/wire.ts';

it.effect('a fake HttpClient sees the act contract/key headers and reads revive decimals', () =>
	Effect.gen(function* () {
		const requests: Parameters<HttpClient.HttpClient['execute']>[0][] = [];
		const httpClient = HttpClient.make((request) => {
			requests.push(request);
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					Response.json(
						request.url.endsWith('/q')
							? { answers: [{ jobs: { rows: [{ id: 'r1', amount: { $dec: '1.50' } }], next: null } }] }
							: { outcome: { kind: 'committed', output: null, records: [] }, v: 0 }
					)
				)
			);
		});
		const bolt = yield* createBolt({
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			httpClient,
			uuid: () => 'request1',
			contract: 'contract1'
		});
		const answer = yield* bolt.query<{ jobs: { rows: { amount: Decimal }[] } }>({ jobs: { limit: 1 } });
		expect(answer.jobs.rows[0]?.amount).toBeInstanceOf(Decimal);
		yield* bolt.act('jobs.create', [{}]);
		expect(requests[1]?.headers[HEADERS.key.toLowerCase()]).toBe('request1');
		expect(requests[1]?.headers[HEADERS.contract.toLowerCase()]).toBe('contract1');
	})
);

it.effect(
	'with poll set, a current read is read again each interval over plain requests; an unchanged answer is not repeated',
	() =>
		Effect.gen(function* () {
			let reads = 0,
				opened = 0;
			const counts = [1, 1, 2];
			const httpClient = HttpClient.make((request) => {
				reads++;
				return Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						Response.json({ answers: [{ count: counts[Math.min(reads, counts.length) - 1] }] })
					)
				);
			});
			const bolt = yield* createBolt({
				actor: null,
				locale: 'en',
				base: 'https://workspace.test',
				httpClient,
				poll: '2 seconds',
				openStream: () => {
					opened++;
					return { onmessage: null, onerror: null, close() {} };
				}
			});
			const seen: unknown[] = [];
			yield* bolt.observe(bolt.query({ jobs: { aggregate: { count: true } } })).pipe(
				Stream.runForEach((value) => Effect.sync(() => seen.push(value))),
				Effect.forkScoped
			);
			yield* Effect.yieldNow;
			yield* TestClock.adjust('2 seconds');
			yield* TestClock.adjust('2 seconds');
			expect({ reads, opened, seen }).toEqual({
				reads: 3,
				opened: 0,
				seen: [{ count: 1 }, { count: 2 }]
			});
		})
);

it.effect('every reconnect is bounded by thirty seconds and closing interrupts its wait', () =>
	Effect.gen(function* () {
		const sources: EventSourceLike[] = [];
		const frames = liveStream(() => {
			const source: EventSourceLike = { onmessage: null, onerror: null, close() {} };
			sources.push(source);
			return source;
		});
		const fiber = yield* Stream.runDrain(frames).pipe(Effect.forkScoped);
		yield* Effect.yieldNow;
		for (let attempt = 0; attempt < 14; attempt++) {
			const opened = sources.length;
			sources.at(-1)?.onerror?.(new Event('error'));
			yield* TestClock.adjust('30 seconds');
			expect(sources.length).toBe(opened + 1);
		}
		const opened = sources.length;
		yield* Fiber.interrupt(fiber);
		yield* TestClock.adjust('30 seconds');
		expect(sources).toHaveLength(opened);
	})
);

const answering = (first: Response) => {
	const keys: Array<string | undefined> = [];
	const httpClient = HttpClient.make((request) => {
		keys.push(request.headers[HEADERS.key.toLowerCase()]);
		return Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				keys.length === 1 ? first : Response.json({ outcome: 'done' })
			)
		);
	});
	return { keys, transport: browserTransport({ base: 'https://workspace.test', httpClient }) };
};
const refused = (code: string) =>
	Response.json(
		{ error: { code, message: 'a release cutover holds admission closed' } },
		{ status: 503, headers: { 'retry-after': '1' } }
	);

it.effect('a cutover busy refusal is resent with its key after retry-after, never surfaced', () =>
	Effect.gen(function* () {
		const { keys, transport } = answering(refused('busy'));
		const fiber = yield* transport
			.request('POST', '/__bolt/act', {}, { [HEADERS.key]: 'k1' })
			.pipe(Effect.forkScoped);
		// the fake fetch answers on a real promise: let it land before reading the notice count
		for (let i = 0; i < 50 && SubscriptionRef.getUnsafe(updating) === 0; i++)
			yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
		expect(SubscriptionRef.getUnsafe(updating)).toBe(1);
		yield* TestClock.adjust('1 second');
		expect(yield* Fiber.join(fiber)).toEqual({ status: 200, body: { outcome: 'done' } });
		expect(keys).toEqual(['k1', 'k1']);
		expect(SubscriptionRef.getUnsafe(updating)).toBe(0);
	})
);

it.effect('any other 503 is answered as is', () =>
	Effect.gen(function* () {
		const { keys, transport } = answering(refused('unavailable'));
		const reply = yield* transport.request('GET', '/__bolt/shell');
		expect(reply.status).toBe(503);
		expect(keys).toHaveLength(1);
	})
);
