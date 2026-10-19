// Twilio Messages discovers a sender once; failures are never retained by its cache.
import { Cache, Effect, Exit, Schema } from 'effect';
import type { Json } from '@norbital-ai/bolt/engine';
import { HttpClientRequest, type HttpClient } from 'effect/unstable/http';
import { ProviderUnavailable, type ProviderRefused } from '../errors.ts';
import { decodeMessage, providerJson, Text, type TransportDef } from '../transport.ts';

export type TwilioAccount = { readonly accountSid: string; readonly authToken: string };
export const twilio = <A>(
	account: TwilioAccount,
	schema: Schema.Decoder<A>,
	url: string,
	form?: { readonly [k: string]: string }
) => {
	const request = HttpClientRequest.make(form === undefined ? 'GET' : 'POST')(url, {
		headers: {
			authorization: `Basic ${Buffer.from(`${account.accountSid}:${account.authToken}`).toString('base64')}`
		}
	});
	return providerJson(
		'twilio',
		schema,
		form === undefined ? request : request.pipe(HttpClientRequest.bodyUrlParams(form))
	);
};
const Services = Schema.Struct({
	services: Schema.optionalKey(Schema.Array(Schema.Struct({ sid: Schema.String })))
});
const Numbers = Schema.Struct({
	incoming_phone_numbers: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				phone_number: Schema.String,
				capabilities: Schema.optionalKey(Schema.Struct({ sms: Schema.optionalKey(Schema.Boolean) }))
			})
		)
	)
});
const Sent = Schema.Struct({ sid: Schema.NonEmptyString });

export const twilioMessages = Effect.fn('Twilio.messages')(function* (account: TwilioAccount) {
	const sender = yield* Cache.makeWith(
		(_key: undefined) =>
			Effect.gen(function* (): Effect.fn.Return<
				Readonly<Record<string, string>>,
				ProviderRefused | ProviderUnavailable,
				HttpClient.HttpClient
			> {
				const service = (yield* twilio(
					account,
					Services,
					'https://messaging.twilio.com/v1/Services?PageSize=1'
				)).services?.[0]?.sid;
				if (service !== undefined) return { MessagingServiceSid: service };
				const numbers = yield* twilio(
					account,
					Numbers,
					`https://api.twilio.com/2010-04-01/Accounts/${account.accountSid}/IncomingPhoneNumbers.json?PageSize=1000`
				);
				const from = numbers.incoming_phone_numbers?.find(
					(number) => number.capabilities?.sms === true
				)?.phone_number;
				if (from === undefined)
					return yield* Effect.fail(
						new ProviderUnavailable({
							message:
								'twilio: the account has no Messaging Service and no SMS-capable number to send from'
						})
					);
				return { From: from };
			}),
		{
			capacity: 1,
			requireServicesAt: 'lookup',
			timeToLive: (exit) => (Exit.isSuccess(exit) ? Infinity : 0)
		}
	);
	return {
		send: Effect.fn('Twilio.send')(function* (message: Json) {
			const text = yield* decodeMessage(
				Text,
				message,
				'a text needs `to` (+ and its digits) and `text`'
			);
			const from = yield* Cache.get(sender, undefined);
			const sent = yield* twilio(
				account,
				Sent,
				`https://api.twilio.com/2010-04-01/Accounts/${account.accountSid}/Messages.json`,
				{ To: text.to, Body: text.text, ...from }
			);
			return { providerId: sent.sid };
		})
	} satisfies TransportDef;
});
