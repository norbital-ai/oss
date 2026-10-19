// What every link does with the host and its provider's API: reads its stored credential through a Schema, and calls a
// JSON API over `HttpClient` with the failures a link answers (`ProviderRefused`, `ProviderUnavailable`).
import { Effect, Option, Schema } from 'effect';
import {
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
	type Headers
} from 'effect/unstable/http';
import type { DriverOpen, Json } from '@norbital-ai/bolt/engine';
import { answerFailure, ProviderUnavailable } from './errors.ts';

/**
 * The instance's stored credential `key` as `schema` decodes it; `None` when there is none or it no longer decodes (the
 * operator pairs again). A host that cannot read its credentials is unavailable.
 */
export const storedCredential = <A>(
	ctx: Pick<DriverOpen, 'credentials'>,
	schema: Schema.Decoder<A>,
	key = 'credential'
): Effect.Effect<Option.Option<A>, ProviderUnavailable> =>
	Effect.tryPromise({
		try: () => ctx.credentials.load(),
		catch: (e) =>
			new ProviderUnavailable({
				message: `the stored credentials could not be read: ${e instanceof Error ? e.message : 'the host refused'}`
			})
	}).pipe(Effect.map((stored) => Schema.decodeUnknownOption(schema)(stored.get(key))));

/** `retry-after` (seconds) in milliseconds, when the provider sent one. */
const retryAfter = (response: HttpClientResponse.HttpClientResponse): number | undefined => {
	const s = Number(response.headers['retry-after']);
	return Number.isFinite(s) && s > 0 ? s * 1000 : undefined;
};

/**
 * A provider's JSON API at `base`, every request carrying `auth`'s headers: a call answers its body decoded as `schema`;
 * a 4xx other than 429 refuses (`ProviderRefused`), anything else that is not the result is `ProviderUnavailable`.
 */
export const jsonApi =
	(base: string, auth: Headers.Input) =>
	<A>(
		schema: Schema.Decoder<A>,
		method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
		path: string,
		body?: Json
	): Effect.Effect<A, ReturnType<typeof answerFailure>, HttpClient.HttpClient> => {
		const url = `${base.replace(/\/+$/, '')}${path}`;
		const request = HttpClientRequest.make(method)(url, { headers: auth, acceptJson: true });
		return Effect.gen(function* () {
			const response = yield* HttpClient.execute(
				body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body))
			);
			if (response.status >= 400) {
				const text = yield* Effect.orElseSucceed(response.text, () => '');
				return yield* answerFailure(
					`${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`,
					response.status,
					undefined,
					retryAfter(response)
				);
			}
			return yield* HttpClientResponse.schemaBodyJson(schema)(response);
		}).pipe(
			Effect.catchTags({
				HttpClientError: (e) =>
					Effect.fail(
						new ProviderUnavailable({ message: `${method} ${path} failed: ${e.message}` })
					),
				SchemaError: () =>
					Effect.fail(
						new ProviderUnavailable({
							message: `${method} ${path} answered something that is not its result`
						})
					)
			})
		);
	};
