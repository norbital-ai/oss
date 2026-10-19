import { Effect, Option, Schema } from 'effect';
import { OAuthRefused, ProviderRefused, ProviderUnavailable } from '../errors.ts';
import { codeOf } from './reports.ts';

export type Method = 'password' | 'microsoft' | 'google';
export const Server = Schema.Struct({ host: Schema.NonEmptyString, port: Schema.Number });
export type Server = typeof Server.Type;
const fields = {
	address: Schema.NonEmptyString,
	user: Schema.NonEmptyString,
	fromName: Schema.NullOr(Schema.String),
	folder: Schema.NonEmptyString,
	tracking: Schema.Boolean,
	quietHours: Schema.Number,
	imap: Server,
	smtp: Schema.optionalKey(Server),
	pixelKey: Schema.NonEmptyString
};
const OAuth = Schema.Struct({
	clientId: Schema.NonEmptyString,
	clientSecret: Schema.NonEmptyString,
	tenant: Schema.optionalKey(Schema.String)
});
export const Mailbox = Schema.Union([
	Schema.Struct({ ...fields, method: Schema.Literal('password'), password: Schema.NonEmptyString }),
	Schema.Struct({ ...fields, method: Schema.Literal('microsoft'), oauth: OAuth }),
	// Google signs in with the host's OAuth client (`DriverOpen.oauthClient`), so the mailbox keeps none
	Schema.Struct({ ...fields, method: Schema.Literal('google') })
]);
export type Mailbox = typeof Mailbox.Type;
export const Cursor = Schema.Struct({ validity: Schema.String, uid: Schema.Number });
export type Cursor = typeof Cursor.Type;
export const Wire = Schema.Struct({
	id: Schema.NonEmptyString,
	to: Schema.Array(Schema.String),
	cc: Schema.optionalKey(Schema.Array(Schema.String)),
	subject: Schema.String,
	text: Schema.optionalKey(Schema.String),
	html: Schema.optionalKey(Schema.String),
	inReplyTo: Schema.optionalKey(Schema.String),
	references: Schema.optionalKey(Schema.Array(Schema.String))
});
export type Wire = typeof Wire.Type;
export type Login = {
	readonly user: string;
	readonly pass?: string;
	readonly accessToken?: string;
};

const Failure = Schema.Struct({
	authenticationFailed: Schema.optionalKey(Schema.Boolean),
	code: Schema.optionalKey(Schema.String),
	responseCode: Schema.optionalKey(Schema.Number),
	response: Schema.optionalKey(Schema.String)
});
const decodeFailure = Schema.decodeUnknownOption(Failure);
export const serverFailure = (operation: string) => (cause: unknown) => {
	const decoded = decodeFailure(cause),
		reason = cause instanceof Error ? cause.message : 'mail server request failed';
	if (Option.isSome(decoded)) {
		const value = decoded.value;
		if (value.authenticationFailed || value.code === 'EAUTH')
			return new OAuthRefused({ message: `${operation}: ${reason}`, revoked: true });
		if (value.responseCode !== undefined && value.responseCode >= 400)
			return new ProviderRefused({
				message: `${operation}: ${value.response ?? reason}`,
				code: codeOf(value.response ?? reason) ?? String(value.responseCode),
				permanent: value.responseCode >= 500
			});
		if (value.code === 'EENVELOPE')
			return new ProviderRefused({ message: reason, permanent: true });
	}
	return new ProviderUnavailable({ message: `${operation}: ${reason}` });
};
export const mailCall = <A>(operation: string, call: () => Promise<A>) =>
	Effect.tryPromise({ try: call, catch: serverFailure(operation) });
