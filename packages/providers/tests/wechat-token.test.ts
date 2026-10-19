import { Effect, Fiber, Queue } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from '@effect/vitest';
import { wechat } from '../src/wechat/index.ts';
import { fakeFetch, host, json } from './kit.ts';

const cred = {
	appId: 'wx0123456789abcdef',
	appSecret: 'secret',
	token: 'tok123',
	encodingAesKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
};
const message = { to: 'openid', text: 'hello' };

it.effect('an old token completing after re-pair does not become the new account token', () =>
	Effect.gen(function* () {
		const entered = yield* Queue.unbounded<void>();
		let release: ((response: Response) => void) | undefined;
		const fetch = fakeFetch([
			(call) => {
				if (!call.url.includes('/cgi-bin/token')) return undefined;
				if (new URL(call.url).searchParams.get('appid') === cred.appId) {
					Queue.offerUnsafe(entered, undefined);
					return new Promise<Response>((resolve) => {
						release = resolve;
					});
				}
				return json({ access_token: 'new', expires_in: 7200 });
			},
			(call) => (call.url.includes('/message/custom/') ? json({ errcode: 0 }) : undefined)
		]);
		const instance = yield* host(wechat(), fetch, { credential: cred });
		const old = yield* instance.link.send!(message, undefined).pipe(Effect.forkChild);
		yield* Queue.take(entered);
		yield* instance.link.pair!({ ...cred, appId: 'wx1111111111111111' });
		yield* Effect.sync(() => release?.(json({ access_token: 'old', expires_in: 7200 })));
		yield* Fiber.join(old);
		yield* instance.link.send!(message, undefined);
		const sends = fetch.calls.filter((call) => call.url.includes('/message/custom/'));
		expect(new URL(sends.at(-1)?.url ?? '').searchParams.get('access_token')).toBe('new');
	})
);

it.effect('token expiry uses the Clock and refreshes at the five-minute margin', () =>
	Effect.gen(function* () {
		let tokens = 0;
		const fetch = fakeFetch([
			(call) =>
				call.url.includes('/cgi-bin/token')
					? json({ access_token: `t${++tokens}`, expires_in: 600 })
					: undefined,
			(call) => (call.url.includes('/message/custom/') ? json({ errcode: 0 }) : undefined)
		]);
		const instance = yield* host(wechat(), fetch, { credential: cred });
		yield* instance.link.send!(message, undefined);
		yield* TestClock.adjust(299999);
		yield* instance.link.send!(message, undefined);
		expect(tokens).toBe(1);
		yield* TestClock.adjust(1);
		yield* instance.link.send!(message, undefined);
		expect(tokens).toBe(2);
	})
);

it.effect('concurrent sends share one token lookup and retain both sends', () =>
	Effect.gen(function* () {
		const entered = yield* Queue.unbounded<void>();
		let tokens = 0,
			release: ((response: Response) => void) | undefined;
		const fetch = fakeFetch([
			(call) => {
				if (!call.url.includes('/cgi-bin/token')) return undefined;
				tokens += 1;
				Queue.offerUnsafe(entered, undefined);
				return new Promise<Response>((resolve) => {
					release = resolve;
				});
			},
			(call) => (call.url.includes('/message/custom/') ? json({ errcode: 0 }) : undefined)
		]);
		const instance = yield* host(wechat(), fetch, { credential: cred });
		const first = yield* instance.link.send!(message, undefined).pipe(Effect.forkChild);
		yield* Queue.take(entered);
		const second = yield* instance.link.send!(message, undefined).pipe(Effect.forkChild);
		yield* Effect.yieldNow;
		const count = tokens;
		yield* Effect.sync(() => release?.(json({ access_token: 'shared', expires_in: 7200 })));
		yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
		expect(count).toBe(1);
		expect(fetch.calls.filter((call) => call.url.includes('/message/custom/'))).toHaveLength(2);
	})
);

it.effect('malformed expiry still returns a token and refreshes on the next call', () =>
	Effect.gen(function* () {
		let tokens = 0;
		const fetch = fakeFetch([
			(call) =>
				call.url.includes('/cgi-bin/token')
					? json({ access_token: `t${++tokens}`, expires_in: 'bad' })
					: undefined,
			(call) => (call.url.includes('/message/custom/') ? json({ errcode: 0 }) : undefined)
		]);
		const instance = yield* host(wechat(), fetch, { credential: cred });
		yield* instance.link.send!(message, undefined);
		yield* instance.link.send!(message, undefined);
		expect(tokens).toBe(2);
	})
);
