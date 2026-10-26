import { Effect, Option, Schema } from 'effect';
import {
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
	type Headers
} from 'effect/unstable/http';
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
	who: string | { readonly method: string; readonly path: string },
	schema: Schema.Decoder<A>,
	request: HttpClientRequest.HttpClientRequest
) => {
	const api = typeof who !== 'string',
		label = typeof who === 'string' ? who : `${who.method} ${who.path}`;
	return Effect.gen(function* () {
		const response = yield* HttpClient.execute(request).pipe(
			Effect.mapError(
				(error) =>
					new ProviderUnavailable({
						message: api ? `${label} failed: ${error.message}` : `${label}: request failed`
					})
			)
		);
		if (response.status >= 400) {
			const text = yield* response.text.pipe(Effect.orElseSucceed(() => ''));
			const error = api ? Option.none() : decodeError(text);
			const reason = Option.isSome(error)
				? (error.value.message ?? error.value.text ?? text)
				: text;
			const retryAfter = api ? Number(response.headers['retry-after']) : Number.NaN;
			return yield* answerFailure(
				api
					? `${label} answered ${response.status}: ${text.slice(0, 500)}`
					: `${label} ${response.status}: ${reason}`,
				response.status,
				undefined,
				Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined
			);
		}
		return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
			Effect.mapError(
				(error) =>
					new ProviderUnavailable(
						api
							? {
									message:
										error._tag === 'HttpClientError'
											? `${label} failed: ${error.message}`
											: `${label} answered something that is not its result`
								}
							: { message: `${label}: response failed validation`, status: response.status }
					)
			)
		);
	});
};

/** Construct an authenticated JSON API request; response handling stays in the shared executor. */
export const jsonApi =
	(base: string, auth: Headers.Input) =>
	<A>(
		schema: Schema.Decoder<A>,
		method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
		path: string,
		body?: Json
	): Effect.Effect<A, ReturnType<typeof answerFailure>, HttpClient.HttpClient> => {
		const request = HttpClientRequest.make(method)(`${base.replace(/\/+$/, '')}${path}`, {
			headers: auth,
			acceptJson: true
		});
		return Effect.suspend(() =>
			providerJson(
				{ method, path },
				schema,
				body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body))
			)
		);
	};
