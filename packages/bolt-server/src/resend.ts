// Resend's verified sender backs the host transactional email facility.
import { Effect, Schema } from 'effect';
import type { Json } from 'effect/Schema';
import { HttpClientRequest } from 'effect/http';
import { decodeMessage, Email, invalid, providerJson, strings } from '@norbital-ai/providers';
import type { TransportDef } from './mail.ts';

type ResendMail = { readonly key: string; readonly from: string };
const Sent = Schema.Struct({ id: Schema.NonEmptyString });
export function resendMail(options: ResendMail): TransportDef {
	return {
		send: Effect.fn('Resend.send')(function* (message: Json) {
			const mail = yield* decodeMessage(Email, message, 'an email needs `to` and `subject`');
			const to = strings(mail.to),
				cc = strings(mail.cc),
				bcc = strings(mail.bcc);
			if (to.length === 0) return yield* Effect.fail(invalid('an email needs `to` and `subject`'));
			if (!mail.text && !mail.html)
				return yield* Effect.fail(invalid('an email needs `text` or `html`'));
			const headers = {
				...(mail.thread === undefined ? {} : { 'X-Bolt-Thread': mail.thread }),
				...(mail.reply_to === undefined
					? {}
					: { 'In-Reply-To': mail.reply_to, References: strings(mail.references).join(' ') })
			};
			const sent = yield* providerJson(
				'resend',
				Sent,
				HttpClientRequest.post('https://api.resend.com/emails', {
					headers: { authorization: `Bearer ${options.key}` }
				}).pipe(
					HttpClientRequest.bodyJsonUnsafe({
						from: mail.from ?? options.from,
						to,
						subject: mail.subject,
						...(cc.length === 0 ? {} : { cc }),
						...(bcc.length === 0 ? {} : { bcc }),
						...(mail.text === undefined ? {} : { text: mail.text }),
						...(mail.html === undefined ? {} : { html: mail.html }),
						...(Object.keys(headers).length === 0 ? {} : { headers })
					})
				)
			);
			return { provider_id: sent.id };
		})
	};
}
