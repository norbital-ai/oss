import { describe, expect, it } from '@effect/vitest';
import { afterEach, vi } from 'vitest';
import { PlatformError } from '../../src/chat/adapter.ts';
import { tokenCache } from '../../src/chat/token.ts';

afterEach(() => vi.restoreAllMocks());

describe('app token cache', () => {
	it('shares a refresh and expires at the provider deadline', async () => {
		let now = 1000;
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		let calls = 0;
		const tokens = tokenCache(async () => ({ token: `token-${++calls}`, ttl: 100 }));
		const first = tokens.get();
		const second = tokens.get();
		expect(first).toBe(second);
		expect(await Promise.all([first, second])).toEqual(['token-1', 'token-1']);
		now = 1099;
		expect(await tokens.get()).toBe('token-1');
		now = 1100;
		expect(await tokens.get()).toBe('token-2');
		expect(calls).toBe(2);
	});

	it('preserves a rejected lookup and allows the next lookup', async () => {
		const refused = new PlatformError('credentials refused', 401);
		let calls = 0;
		const tokens = tokenCache(async () => {
			if (++calls === 1) throw refused;
			return { token: 'renewed', ttl: 1000 };
		});
		const first = tokens.get();
		expect(tokens.get()).toBe(first);
		await expect(first).rejects.toBe(refused);
		expect(await tokens.get()).toBe('renewed');
		expect(calls).toBe(2);
	});

	it('keeps an invalidated lookup from replacing or clearing its successor', async () => {
		for (const oldFinishesFirst of [true, false]) {
			const old = Promise.withResolvers<{ token: string; ttl: number }>();
			const renewed = Promise.withResolvers<{ token: string; ttl: number }>();
			let calls = 0;
			const tokens = tokenCache(() => (++calls === 1 ? old.promise : renewed.promise));
			const stale = tokens.get();
			tokens.invalidate();
			const current = tokens.get();
			if (oldFinishesFirst) {
				old.resolve({ token: 'old', ttl: 1000 });
				expect(await stale).toBe('old');
				expect(tokens.get()).toBe(current);
			}
			renewed.resolve({ token: 'new', ttl: 1000 });
			expect(await current).toBe('new');
			if (!oldFinishesFirst) {
				old.resolve({ token: 'old', ttl: 1000 });
				expect(await stale).toBe('old');
			}
			expect(await tokens.get()).toBe('new');
			expect(calls).toBe(2);
		}
	});

	it('returns tokens with unusable expiry and refreshes on the next lookup', async () => {
		for (const ttl of [0, -1, Number.NaN]) {
			let calls = 0;
			const tokens = tokenCache(async () => ({ token: `token-${++calls}`, ttl }));
			expect(await tokens.get()).toBe('token-1');
			expect(await tokens.get()).toBe('token-2');
			expect(calls).toBe(2);
		}
	});
});
