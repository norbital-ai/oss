import { Deferred, Effect, Fiber, Queue, Schema, Stream, SubscriptionRef } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from '@effect/vitest';
import { Decimal } from '@norbital-ai/std/decimal';
import { input_schema } from '@norbital-ai/std/kind';
import { create_bolt } from '../src/page/bolt.ts';
import { liveStream, type EventSourceLike } from '../src/page/stream.ts';
import { browserTransport, updating } from '../src/protocol/client.ts';
import { HEADERS, status_of } from '../src/protocol/wire.ts';
import type { WireRead } from '../src/protocol/schema.ts';

const count_read: WireRead = { m: 'query', a: [{ jobs: { aggregate: { count: true } } }] };
const Count = Schema.Struct({ jobs: Schema.Struct({ count: Schema.Number }) });

it.effect('a fake HttpClient sees the act contract/key headers and reads revive decimals', () =>
	Effect.gen(function* () {
		const requests: Parameters<HttpClient.HttpClient['execute']>[0][] = [];
		const http_client = HttpClient.make((request) => {
			requests.push(request);
			return Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					Response.json(
						request.url.endsWith('/q')
							? { answers: [{ jobs: { rows: [{ id: 'r1', amount: { $dec: '1.50' } }], next: null, total: 1 } }] }
							: { outcome: { kind: 'committed', output: { 'jobs.create': null }, records: [] }, v: 0 }
					)
				)
			);
		});
		const bolt = yield* create_bolt({
			operation_outputs: { automations: {} },
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			http_client,
			uuid: () => 'request1',
			contract: 'contract1'
		});
		const answer = yield* bolt.native_query({ m: 'query', a: [{ jobs: { limit: 1 } }] }, Schema.Struct({
			jobs: Schema.Struct({
				rows: Schema.Array(Schema.Struct({ id: Schema.String, amount: input_schema({ kind: 'decimal', scale: 2 }) })),
				next: Schema.NullOr(Schema.String),
				total: Schema.Number
			})
		}));
		expect(answer.jobs.rows[0]?.amount).toBeInstanceOf(Decimal);
		yield* bolt.act({ 'jobs.create': [{}] });
		expect(requests[1]?.headers[HEADERS.key.toLowerCase()]).toBe('request1');
		expect(requests[1]?.headers[HEADERS.contract.toLowerCase()]).toBe('contract1');
	})
);

it.effect(
	'a snapshot reads on mount and explicit refresh, never on a timer or stream; unchanged answers are not repeated',
	() =>
		Effect.gen(function* () {
			let reads = 0,
				opened = 0;
			const counts = [1, 1, 2];
			const http_client = HttpClient.make((request) => {
				reads++;
				return Effect.succeed(
					HttpClientResponse.fromWeb(
						request,
						Response.json({ answers: [{ jobs: { count: counts[Math.min(reads, counts.length) - 1] } }] })
					)
				);
			});
			const bolt = yield* create_bolt({
				operation_outputs: { automations: {} },
				actor: null,
				locale: 'en',
				base: 'https://workspace.test',
				http_client,
				live: 'snapshot',
				open_stream: () => {
					opened++;
					return { onmessage: null, onerror: null, close() {} };
				}
			});
			const seen: unknown[] = [];
			const delivered = yield* Queue.unbounded<unknown>();
			yield* bolt.observe({ read: count_read }, Count).pipe(
				Stream.runForEach((value) => Effect.sync(() => seen.push(value)).pipe(Effect.andThen(Queue.offer(delivered, value)))),
				Effect.forkScoped
			);
			yield* Queue.take(delivered);
			yield* TestClock.adjust('1 hour');
			expect({ reads, opened, seen }).toEqual({ reads: 1, opened: 0, seen: [{ jobs: { count: 1 } }] });
			yield* bolt.refresh();
			expect({ reads, seen }).toEqual({ reads: 2, seen: [{ jobs: { count: 1 } }] });
			yield* bolt.refresh();
			expect({ reads, opened, seen }).toEqual({
				reads: 3,
				opened: 0,
				seen: [{ jobs: { count: 1 } }, { jobs: { count: 2 } }]
			});
		})
);

it.effect('snapshot refresh waits until a mounted reader consumes its new answer', () =>
	Effect.gen(function* () {
		let count = 1;
		const bolt = yield* create_bolt({
			operation_outputs: { automations: {} },
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			live: 'snapshot',
			fetch: async () => Response.json({ answers: [{ jobs: { count } }] })
		});
		const delivered = yield* Queue.unbounded<number>();
		const release = yield* Deferred.make<void>();
		yield* bolt.observe({ read: count_read }, Count).pipe(
			Stream.runForEach((answer) => Queue.offer(delivered, answer.jobs.count).pipe(
				Effect.andThen(answer.jobs.count === 1 ? Effect.void : Deferred.await(release))
			)),
			Effect.forkScoped
		);
		expect(yield* Queue.take(delivered)).toBe(1);
		count = 2;
		const refresh = yield* bolt.refresh().pipe(Effect.forkScoped);
		expect(yield* Queue.take(delivered)).toBe(2);
		expect(refresh.pollUnsafe()).toBeUndefined();
		yield* Deferred.succeed(release, undefined);
		yield* Fiber.join(refresh);
	})
);

it.effect('snapshot refresh surfaces a refused read instead of retaining stale success', () =>
	Effect.gen(function* () {
		let refused = false;
		const bolt = yield* create_bolt({
			operation_outputs: { automations: {} },
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			live: 'snapshot',
			fetch: async () => refused
				? Response.json({ error: { code: 'forbidden', message: 'No access' } }, { status: 403 })
				: Response.json({ answers: [{ jobs: { count: 1 } }] })
		});
		const delivered = yield* Queue.unbounded<number>();
		const observed = yield* bolt.observe({ read: count_read }, Count).pipe(
			Stream.runForEach((answer) => Queue.offer(delivered, answer.jobs.count)),
			Effect.result,
			Effect.forkScoped
		);
		expect(yield* Queue.take(delivered)).toBe(1);
		refused = true;
		expect(yield* Effect.flip(bolt.refresh())).toMatchObject({ _tag: 'ReadFailed', code: 'forbidden', message: 'No access' });
		expect(yield* Fiber.join(observed)).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ReadFailed', code: 'forbidden' } });
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
	const http_client = HttpClient.make((request) => {
		keys.push(request.headers[HEADERS.key.toLowerCase()]);
		return Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				keys.length === 1 ? first : Response.json({ outcome: 'done' })
			)
		);
	});
	return { keys, transport: browserTransport({ base: 'https://workspace.test', http_client }) };
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
		// the fake fetch answers on microtasks: yield until it lands before reading the notice count
		for (let i = 0; i < 50 && SubscriptionRef.getUnsafe(updating) === 0; i++) yield* Effect.yieldNow;
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

it.effect('a running reply is the act answer, carrying its run id', () =>
	Effect.gen(function* () {
		const fetch: typeof globalThis.fetch = async () =>
			Response.json({ outcome: { kind: 'running', run: 'r1' }, v: 0 }, { status: 202 });
		const bolt = yield* create_bolt({ operation_outputs: { automations: {} }, base: 'https://workspace.test', actor: null, locale: 'en', fetch });
		expect(yield* bolt.act({ 'jobs.create': [{ title: 'slow' }] })).toEqual({ kind: 'running', run: 'r1' });
		expect(status_of({ kind: 'running', run: 'r1' })).toBe(202);
	})
);
