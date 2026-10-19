import { Effect, Fiber, Stream } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { TestClock } from 'effect/testing';
import { expect, it } from '@effect/vitest';
import { Decimal } from '@norbital-ai/std/decimal';
import { createBolt } from '../src/page/bolt.ts';
import { liveStream, type EventSourceLike } from '../src/page/stream.ts';
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
							? { answers: [{ rows: [{ id: 'r1', amount: { $dec: '1.50' } }], next: null }] }
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
		const answer = yield* bolt.read<{ rows: { amount: Decimal }[] }>('jobs', { limit: 1 });
		expect(answer.rows[0]?.amount).toBeInstanceOf(Decimal);
		yield* bolt.act('jobs.create', {});
		expect(requests[1]?.headers[HEADERS.key.toLowerCase()]).toBe('request1');
		expect(requests[1]?.headers[HEADERS.contract.toLowerCase()]).toBe('contract1');
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
