import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from '@effect/vitest';
import { createBolt } from '../src/page/bolt.ts';

it.effect('a stalled describe fails visibly and aborts; a retry succeeds', () =>
	Effect.gen(function* () {
		let signal: AbortSignal | null | undefined;
		let calls = 0;
		const fetch: typeof globalThis.fetch = async (_url, init) => {
			calls++;
			signal = init?.signal;
			if (calls === 1) return new Promise<Response>(() => {});
			return Response.json({
				outcome: { kind: 'committed', output: { where: { kind: { eq: 'nda' } } }, records: [] },
				v: 0
			});
		};
		const bolt = yield* createBolt({
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			fetch,
			describe: true
		});
		if (bolt.describe === undefined) throw new Error('expected describe');
		const describe = yield* Effect.flip(
			bolt.describe('template_documents', 'show latest version only')
		).pipe(Effect.forkScoped);
		yield* TestClock.adjust('15 seconds');
		expect(signal?.aborted).toBe(true);
		const error = yield* Fiber.join(describe);
		expect(error).toMatchObject({ _tag: 'DescribeTimeout' });
		expect(error.message).toContain('Try again');
		expect(yield* bolt.describe('template_documents', 'NDA templates')).toEqual({
			where: { kind: { eq: 'nda' } }
		});
	})
);
it.effect('describe bounds a stalled response body as well as fetch', () =>
	Effect.gen(function* () {
		const fetch: typeof globalThis.fetch = async () =>
			new Response(new ReadableStream<Uint8Array>({ start() {} }), {
				headers: { 'content-type': 'application/json' }
			});
		const bolt = yield* createBolt({
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			fetch,
			describe: true
		});
		if (bolt.describe === undefined) throw new Error('expected describe');
		const describe = yield* Effect.flip(bolt.describe('jobs', 'open jobs')).pipe(Effect.forkScoped);
		yield* TestClock.adjust('15 seconds');
		expect(yield* Fiber.join(describe)).toMatchObject({ _tag: 'DescribeTimeout' });
	})
);
it.effect('the describe deadline never aborts a mutating act', () =>
	Effect.gen(function* () {
		let signal: AbortSignal | null | undefined;
		const fetch: typeof globalThis.fetch = async (_url, init) => {
			signal = init?.signal;
			return new Promise<Response>(() => {});
		};
		const bolt = yield* createBolt({
			actor: null,
			locale: 'en',
			base: 'https://workspace.test',
			fetch,
			describe: true
		});
		const act = yield* bolt
			.act('jobs.update', { id: 'job1', status: 'done' })
			.pipe(Effect.forkScoped);
		yield* TestClock.adjust('15 seconds');
		expect(act.pollUnsafe() === undefined).toBe(true);
		expect(signal?.aborted).toBe(false);
	})
);
