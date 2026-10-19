import { Cache, Effect, Exit, Schema } from 'effect';
import { twilio, type TwilioAccount } from './messages.ts';
import type { PhoneVerifierDef } from '../transport.ts';

const VERIFY = 'https://verify.twilio.com/v2/Services';
const Services = Schema.Struct({
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
					Services,
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
