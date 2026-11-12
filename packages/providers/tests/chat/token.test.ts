import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { PlatformError } from '../../src/chat/adapter.ts';
import { loadToken, tokenCache } from '../../src/chat/token.ts';

describe('app token cache', () => {
	it.effect('shares a refresh and expires at the provider deadline', () =>
		Effect.gen(function* () {
			let calls = 0;
			const tokens = yield* tokenCache(() =>
				Effect.suspend(() => {
					calls++;
					return Effect.as(Effect.yieldNow, { token: `token-${calls}`, ttl: 100 });
				})
			);
			expect(yield* Effect.all([tokens.get(), tokens.get()], { concurrency: 2 })).toEqual([
				'token-1',
				'token-1'
			]);
			yield* TestClock.adjust(99);
			expect(yield* tokens.get()).toBe('token-1');
			yield* TestClock.adjust(1);
			expect(yield* tokens.get()).toBe('token-2');
			expect(calls).toBe(2);
		})
	);

	it.effect('fails a refused lookup with its PlatformError and asks again next time', () =>
		Effect.gen(function* () {
			const refused = new PlatformError('credentials refused', 401);
			let calls = 0;
			const tokens = yield* tokenCache(() =>
				loadToken(async () => {
					if (++calls === 1) throw refused;
					return { token: 'renewed', ttl: 1000 };
				})
			);
			expect(yield* Effect.flip(tokens.get())).toBe(refused);
			expect(yield* tokens.get()).toBe('renewed');
			expect(calls).toBe(2);
		})
	);

	it.effect('keeps an invalidated lookup from replacing its successor', () =>
		Effect.gen(function* () {
			const old = yield* Deferred.make<void>();
			let calls = 0;
			const tokens = yield* tokenCache(() =>
				Effect.suspend(() =>
					++calls === 1
						? Effect.as(Deferred.await(old), { token: 'old', ttl: 1000 })
						: Effect.succeed({ token: 'new', ttl: 1000 })
				)
			);
			const stale = yield* Effect.forkChild(tokens.get());
			yield* Effect.yieldNow;
			yield* tokens.invalidate;
			expect(yield* tokens.get()).toBe('new');
			yield* Deferred.succeed(old, undefined);
			expect(yield* Fiber.join(stale)).toBe('old');
			expect(yield* tokens.get()).toBe('new');
			expect(calls).toBe(2);
		})
	);

	it.effect('returns tokens with unusable expiry and refreshes on the next lookup', () =>
		Effect.gen(function* () {
			for (const ttl of [0, -1, Number.NaN]) {
				let calls = 0;
				const tokens = yield* tokenCache(() =>
					Effect.sync(() => ({ token: `token-${++calls}`, ttl }))
				);
				expect(yield* tokens.get()).toBe('token-1');
				expect(yield* tokens.get()).toBe('token-2');
				expect(calls).toBe(2);
			}
		})
	);
});
