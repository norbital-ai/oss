import { Clock, Effect, Schema } from 'effect';
import { Port, Transport, loggedPhone } from '@norbital-ai/bolt/engine';
import { transactional } from '@norbital-ai/providers';
import type { Config } from './config.ts';

export type Sender = Transport['Service']['send'];
export function devSink() {
	const mail: Extract<Parameters<Sender>[0], { _tag: 'Mail' }>[] = [];
	return {
		mail,
		send: (message: Parameters<Sender>[0]) =>
			Effect.sync(() => {
				if (message._tag === 'Mail') mail.push(message);
				return { providerId: `dev-${mail.length}` };
			})
	};
}
export function logSink(kind: 'mail' | 'sms', log: (line: string) => void): Transport['Service'] {
	return {
		send: Effect.fn('server.logSink')(function* (message) {
			const text = message._tag === 'Push' ? (message.body ?? '') : message.text;
			const code = /\b(\d{6})\b/.exec(text)?.[1];
			const to = message._tag === 'Push' ? message.subscription.endpoint : message.to;
			log(
				`${kind} → ${to}: ${message._tag === 'Mail' ? message.subject : text}${code === undefined ? '' : ` (sign-in code ${code})`}`
			);
			return { providerId: `log-${yield* Clock.currentTimeMillis}` };
		})
	};
}
export const messaging = Effect.fn('server.messaging')(function* (
	config: Config,
	log: (line: string) => void
) {
	const configured =
		config.transactional === null ? {} : yield* transactional(config.transactional);
	const context = yield* Effect.context<import('effect/unstable/http/HttpClient').HttpClient>();
	const email = configured.email,
		sms = configured.sms,
		configuredPhone = configured.phone;
	const native = (port: NonNullable<typeof email>): Transport['Service'] => ({
		send: (message) =>
			port.send(message).pipe(Effect.provide(context), Effect.mapError(Port.failure('transport')))
	});
	const localPhone =
		config.mode === 'production' ? undefined : loggedPhone(log, config.mode === 'dev');
	const phone =
		configuredPhone === undefined
			? localPhone === undefined
				? undefined
				: {
						via: localPhone.via,
						start: (to: string, via: 'sms' | 'whatsapp') =>
							Port.attempt('phone', (signal) => localPhone.start(to, via, signal)),
						check: (to: string, code: string) =>
							Port.attempt('phone', (signal) => localPhone.check(to, code, signal))
					}
			: {
					via: configuredPhone.via,
					start: (to: string, via: 'sms' | 'whatsapp') =>
						configuredPhone
							.start(to, via)
							.pipe(Effect.provide(context), Effect.mapError(Port.failure('phone'))),
					check: (to: string, code: string) =>
						configuredPhone
							.check(to, code)
							.pipe(Effect.provide(context), Effect.mapError(Port.failure('phone')))
				};
	return {
		email:
			email === undefined
				? config.mode === 'production'
					? undefined
					: logSink('mail', log)
				: native(email),
		sms:
			sms === undefined
				? config.mode === 'production'
					? undefined
					: logSink('sms', log)
				: native(sms),
		phone
	};
});
