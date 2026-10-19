import { Effect, Option, Schema } from 'effect';
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';
import type { Json } from '@norbital-ai/bolt/engine';
import { answerFailure, ProviderRefused, ProviderUnavailable } from './errors.ts';

export type TransportDef = {
	readonly send: (
		message: Json
	) => Effect.Effect<
		{ readonly providerId: string },
		ProviderRefused | ProviderUnavailable,
		HttpClient.HttpClient
	>;
};
export type PhoneVerifierDef = {
	readonly via: readonly ('sms' | 'whatsapp')[];
	readonly start: (
		to: string,
		via: 'sms' | 'whatsapp'
	) => Effect.Effect<void, ProviderRefused | ProviderUnavailable, HttpClient.HttpClient>;
	readonly check: (
		to: string,
		code: string
	) => Effect.Effect<boolean, ProviderRefused | ProviderUnavailable, HttpClient.HttpClient>;
};
const Address = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
export const Email = Schema.Struct({
	to: Address,
	subject: Schema.String,
	cc: Schema.optionalKey(Address),
	from: Schema.optionalKey(Schema.String),
	text: Schema.optionalKey(Schema.String),
	html: Schema.optionalKey(Schema.String),
	thread: Schema.optionalKey(Schema.String),
	inReplyTo: Schema.optionalKey(Schema.String),
	references: Schema.optionalKey(Address)
});
export const Text = Schema.Struct({
	to: Schema.String.check(Schema.isPattern(/^\+[1-9]\d{7,14}$/)),
	text: Schema.String
});
export const strings = (value: string | readonly string[] | undefined) =>
	(typeof value === 'string' ? [value] : (value ?? [])).filter((entry) => entry !== '');
export const invalid = (message: string) =>
	new ProviderRefused({ message, code: 'invalid', permanent: true });
export const decodeMessage = <A>(schema: Schema.Decoder<A>, message: Json, reason: string) =>
	Schema.decodeUnknownEffect(schema)(message).pipe(Effect.mapError(() => invalid(reason)));

const ErrorBody = Schema.Struct({
	message: Schema.optionalKey(Schema.String),
	text: Schema.optionalKey(Schema.String)
});
const decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));

/** Decode each external JSON answer exactly once; retain provider evidence in typed refusals. */
export const providerJson = <A>(
	who: string,
	schema: Schema.Decoder<A>,
	request: HttpClientRequest.HttpClientRequest
) =>
	HttpClient.execute(request).pipe(
		Effect.mapError(() => new ProviderUnavailable({ message: `${who}: request failed` })),
		Effect.flatMap((response) =>
			Effect.gen(function* () {
				if (response.status >= 400) {
					const text = yield* response.text.pipe(Effect.orElseSucceed(() => ''));
					const error = decodeError(text);
					const reason = Option.isSome(error)
						? (error.value.message ?? error.value.text ?? text)
						: text;
					return yield* Effect.fail(
						answerFailure(`${who} ${response.status}: ${reason}`, response.status)
					);
				}
				return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
					Effect.mapError(
						() =>
							new ProviderUnavailable({
								message: `${who}: response failed validation`,
								status: response.status
							})
					)
				);
			})
		)
	);
