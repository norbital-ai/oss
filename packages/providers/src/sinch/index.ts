// Sinch transactional email, SMS and phone verification share one decoded HTTP boundary.
import { Effect, Schema } from 'effect';
import type { Json } from '@norbital-ai/bolt/engine';
import { HttpClientRequest } from 'effect/http';
import {
	decodeMessage,
	Email,
	invalid,
	providerJson,
	strings,
	Text,
	type PhoneVerifierDef,
	type TransportDef
} from '../transport.ts';

export const SINCH_REGIONS = ['us', 'eu', 'au', 'br', 'ca'] as const;
export type SinchRegion = (typeof SINCH_REGIONS)[number];
const mailgunHost = (region: SinchRegion = 'us') =>
	region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
const basic = (user: string, secret: string) =>
	`Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
const Sent = Schema.Struct({ id: Schema.NonEmptyString });
const Status = Schema.Struct({ status: Schema.optionalKey(Schema.String) });

export function sinchMail(options: {
	readonly key: string;
	readonly domain: string;
	readonly region?: SinchRegion;
}): TransportDef {
	return {
		send: Effect.fn('Sinch.mail')(function* (message: Json) {
			const mail = yield* decodeMessage(Email, message, 'an email needs `to` and `subject`');
			const to = strings(mail.to);
			if (to.length === 0) return yield* Effect.fail(invalid('an email needs `to` and `subject`'));
			if (mail.text === undefined && mail.html === undefined)
				return yield* Effect.fail(invalid('an email needs `text` or `html`'));
			const form = new URLSearchParams({
				from: mail.from ?? `noreply@${options.domain}`,
				subject: mail.subject
			});
			for (const value of to) form.append('to', value);
			for (const value of strings(mail.cc)) form.append('cc', value);
			if (mail.text !== undefined) form.set('text', mail.text);
			if (mail.html !== undefined) form.set('html', mail.html);
			if (mail.thread !== undefined) form.set('h:X-Bolt-Thread', mail.thread);
			if (mail.inReplyTo !== undefined) {
				form.set('h:In-Reply-To', mail.inReplyTo);
				form.set('h:References', strings(mail.references).join(' '));
			}
			const sent = yield* providerJson(
				'mailgun',
				Sent,
				HttpClientRequest.post(
					`https://${mailgunHost(options.region)}/v3/${options.domain}/messages`,
					{
						headers: { authorization: basic('api', options.key) }
					}
				).pipe(HttpClientRequest.bodyUrlParams(form))
			);
			return { providerId: sent.id };
		})
	};
}

export function sinchSms(options: {
	readonly planId: string;
	readonly token: string;
	readonly from: string;
	readonly region?: SinchRegion;
}): TransportDef {
	return {
		send: Effect.fn('Sinch.sms')(function* (message: Json) {
			const text = yield* decodeMessage(
				Text,
				message,
				'a text needs `to` (+ and its digits) and `text`'
			);
			const sent = yield* providerJson(
				'sinch sms',
				Sent,
				HttpClientRequest.post(
					`https://${options.region ?? 'us'}.sms.api.sinch.com/xms/v1/${options.planId}/batches`,
					{
						headers: { authorization: `Bearer ${options.token}` }
					}
				).pipe(
					HttpClientRequest.bodyJsonUnsafe({ from: options.from, to: [text.to], body: text.text })
				)
			);
			return { providerId: sent.id };
		})
	};
}

export function sinchVerification(options: {
	readonly key: string;
	readonly secret: string;
}): PhoneVerifierDef {
	const base = 'https://verification.api.sinch.com/verification/v1/verifications';
	const headers = { authorization: basic(options.key, options.secret) };
	const methods = new Map<string, 'sms' | 'whatsapp'>();
	return {
		via: ['sms', 'whatsapp'],
		start: (to, via) =>
			providerJson(
				'sinch verification',
				Schema.Unknown,
				HttpClientRequest.post(base, { headers }).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						identity: { type: 'number', endpoint: to },
						method: via
					})
				)
			).pipe(
				Effect.tap(() => Effect.sync(() => methods.set(to, via))),
				Effect.asVoid
			),
		check: (to, code) =>
			Effect.gen(function* () {
				const via = methods.get(to) ?? 'sms';
				const status = yield* providerJson(
					'sinch verification',
					Status,
					HttpClientRequest.put(`${base}/number/${encodeURIComponent(to)}`, { headers }).pipe(
						HttpClientRequest.bodyJsonUnsafe({ method: via, [via]: { code } })
					)
				);
				if (status.status === 'SUCCESSFUL') methods.delete(to);
				return status.status === 'SUCCESSFUL';
			}).pipe(
				Effect.catchTag('ProviderRefused', (error) =>
					error.code === '404' ? Effect.succeed(false) : Effect.fail(error)
				)
			)
	};
}
