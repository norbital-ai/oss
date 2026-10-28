// Twilio Messages (texted invitations) and Verify (a number's sign-in code): this host's sms and phone facilities.
// The sender and the Verify service are discovered once; failures are never retained by their caches.
import { Cache, Effect, Exit, Schema } from 'effect';
import type { HttpClient } from 'effect/http';
import type { Json } from '@norbital-ai/bolt/engine';
import {
	decodeMessage,
	ProviderUnavailable,
	Text,
	twilio,
	type ProviderRefused,
	type TwilioAccount
} from '@norbital-ai/providers';
import type { PhoneVerifierDef, TransportDef } from './mail.ts';

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

const VERIFY = 'https://verify.twilio.com/v2/Services';
const VerifyServices = Schema.Struct({
	services: Schema.optionalKey(
		Schema.Array(Schema.Struct({ sid: Schema.String, friendly_name: Schema.String }))
	)
});
const Created = Schema.Struct({ sid: Schema.NonEmptyString });
const Status = Schema.Struct({ status: Schema.optionalKey(Schema.String) });
export const twilioVerify = Effect.fn('Twilio.verify')(function* (
	account: TwilioAccount & { readonly name?: string }
) {
	const name = account.name ?? 'Norbital';
	const service = yield* Cache.makeWith(
		(_key: undefined) =>
			Effect.gen(function* () {
				const existing = (yield* twilio(
					account,
					VerifyServices,
					`${VERIFY}?PageSize=1000`
				)).services?.find((entry) => entry.friendly_name === name)?.sid;
				return existing ?? (yield* twilio(account, Created, VERIFY, { FriendlyName: name })).sid;
			}),
		{
			capacity: 1,
			requireServicesAt: 'lookup',
			timeToLive: (exit) => (Exit.isSuccess(exit) ? Infinity : 0)
		}
	);
	return {
		via: ['sms', 'whatsapp'],
		start: (to, via) =>
			Effect.gen(function* () {
				yield* twilio(
					account,
					Schema.Unknown,
					`${VERIFY}/${yield* Cache.get(service, undefined)}/Verifications`,
					{ To: to, Channel: via }
				);
			}),
		check: (to, code) =>
			Effect.gen(function* () {
				const status = yield* twilio(
					account,
					Status,
					`${VERIFY}/${yield* Cache.get(service, undefined)}/VerificationCheck`,
					{ To: to, Code: code }
				);
				return status.status === 'approved';
			}).pipe(
				Effect.catchTag('ProviderRefused', (error) =>
					error.code === '404' ? Effect.succeed(false) : Effect.fail(error)
				)
			)
	} satisfies PhoneVerifierDef;
});
