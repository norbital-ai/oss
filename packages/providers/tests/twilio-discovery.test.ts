import { Effect, Fiber, Queue } from 'effect';
import { expect, it } from '@effect/vitest';
import { twilioMessages, twilioVerify } from '../src/index.ts';
import { withFetch } from '../src/util.ts';

for (const kind of ['sms', 'verify'] as const) {
	it.effect(`${kind} discovery is shared, forgets failure and retains success`, () =>
		Effect.gen(function* () {
			const entered = yield* Queue.unbounded<void>();
			let release: (() => void) | undefined;
			let discoveries = 0;
			const f: typeof fetch = async (url, init) => {
				if (String(url).includes('/Services?')) {
					discoveries += 1;
					if (discoveries === 1) {
						expect(init?.signal).toBeInstanceOf(AbortSignal);
						Queue.offerUnsafe(entered, undefined);
						await new Promise<void>((resolve) => {
							release = resolve;
						});
						throw new Error('discovery sentinel');
					}
					return Response.json({ services: [{ sid: 'service', friendly_name: 'Norbital' }] });
				}
				return Response.json({ sid: 'sent' });
			};
			const account = { accountSid: 'AC123', authToken: 'secret' };
			const sms = yield* twilioMessages(account),
				verify = yield* twilioVerify(account);
			const call = () =>
				withFetch(
					{ fetch: f },
					kind === 'sms'
						? sms.send({ to: '+6581234567', text: 'hello' }).pipe(Effect.asVoid)
						: verify.start('+6581234567', 'sms')
				);
			const a = yield* call().pipe(Effect.flip, Effect.forkChild);
			yield* Queue.take(entered);
			const b = yield* call().pipe(Effect.flip, Effect.forkChild);
			yield* Effect.yieldNow;
			expect(discoveries).toBe(1);
			yield* Effect.sync(() => release?.());
			expect(yield* Effect.all([Fiber.join(a), Fiber.join(b)])).toMatchObject([
				{ _tag: 'ProviderUnavailable', message: 'twilio: request failed' },
				{ _tag: 'ProviderUnavailable', message: 'twilio: request failed' }
			]);
			yield* call();
			yield* call();
			expect(discoveries).toBe(2);
		})
	);
}
