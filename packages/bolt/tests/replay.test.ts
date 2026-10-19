import { expect, it } from '@effect/vitest';
import { Effect, Result } from 'effect';
import { replayOnce } from '../src/engine/write/replay.ts';

it.effect('preserves unexpected error identity without replaying the attempt', () =>
	Effect.gen(function* () {
		let calls = 0;
		const error = new Error('unexpected');
		const result = yield* Effect.result(
			replayOnce<never, Error, never>(() =>
				Effect.gen(function* () {
					calls++;
					return yield* Effect.fail(error);
				})
			)
		);
		expect(Result.isFailure(result) && result.failure).toBe(error);
		expect(calls).toBe(1);
	})
);

it.effect('does not replay a failing terminal outcome record', () =>
	Effect.gen(function* () {
		let calls = 0,
			records = 0;
		const error = new Error('record unavailable');
		const result = yield* Effect.result(
			replayOnce<never, Error, never>((replay) =>
				Effect.gen(function* () {
					calls++;
					return yield* replay(
						Effect.gen(function* () {
							records++;
							return yield* Effect.fail(error);
						})
					);
				})
			)
		);
		expect(Result.isFailure(result) && result.failure).toBe(error);
		expect(calls).toBe(2);
		expect(records).toBe(1);
	})
);
