import { Clock, Effect, Number as ENumber, Result, Schema } from 'effect';
import {
	EffectId,
	INTEGRATION_HTTP_OPERATION,
	IntegrationHttpResponse,
	type IntegrationHttpRequest
} from '@norbital-ai/bolt-protocol';
import type { HttpConnection, PrivateEnvReference } from '#lib/authoring/contracts-schema.js';
import { checkedBaseUrl } from '#lib/authoring/integrations-schema.js';
import type { ConnectorInterface } from '#lib/runtime/facilities/services.js';
import { decodeNumber } from '@norbital-ai/std/json';

/**
 * Whether a response is worth asking for again.
 *
 * 429 and 5xx are the source saying "not now"; 4xx is the source saying "not like that", and
 * repeating a malformed request only spends someone else's rate limit.
 */
export const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/**
 * How long to wait before the next attempt.
 *
 * `Retry-After` wins when the source sent one — it is the only party that knows — and is read in
 * both of its legal forms, delay-seconds and an HTTP date. Otherwise the delay doubles per attempt,
 * capped, so a source that is down does not get hammered on the way back up.
 */
export const retryDelayMs = (
	attempt: number,
	options: { readonly initialDelayMs: number; readonly maxDelayMs: number },
	retryAfter: string | undefined,
	nowEpochMs: number
): number => {
	if (retryAfter !== undefined) {
		const seconds = decodeNumber(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0)
			return Math.min(seconds * 1000, options.maxDelayMs);
		const at = Date.parse(retryAfter);
		if (Number.isFinite(at))
			return ENumber.clamp({ minimum: 0, maximum: options.maxDelayMs })(at - nowEpochMs);
	}
	return Math.min(options.initialDelayMs * 2 ** attempt, options.maxDelayMs);
};

/**
 * The `rel="next"` target of an RFC 8288 `Link` header, when there is one.
 *
 * Parsed here rather than with a regular expression over the whole header because a `Link` carries
 * several targets and the interesting one is rarely first — `first`, `prev`, `next`, `last` is the
 * order json-server sends, and taking the first URL would page backwards forever.
 */
export const nextLink = (header: string | undefined): string | undefined => {
	if (header === undefined) return undefined;
	for (const part of header.split(',')) {
		const [target, ...parameters] = part.split(';');
		const url = target?.trim();
		if (url === undefined || !url.startsWith('<') || !url.endsWith('>')) continue;
		const isNext = parameters.some((parameter) => /^\s*rel\s*=\s*"?next"?\s*$/i.test(parameter));
		if (isNext) return url.slice(1, -1);
	}
	return undefined;
};

/** A connection with its variables read: the API root, and the credential as headers or query. */
export type ResolvedConnection = Readonly<{
	readonly baseUrl: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly query: Readonly<Record<string, string>>;
}>;

/**
 * Resolves a connection's variable references into the request parts they become. The one place
 * that decides what `{ type: 'bearer', token: { env } }` means, for syncs, http channels and an
 * automation's `api.connection` alike.
 */
export const resolveConnection = (
	secret: (effectId: EffectId, name: string) => Effect.Effect<string, { readonly message: string }>,
	effectId: EffectId,
	connection: HttpConnection
): Effect.Effect<ResolvedConnection, { readonly message: string }> =>
	Effect.gen(function* () {
		const baseUrl =
			typeof connection.baseUrl === 'string'
				? connection.baseUrl
				: yield* secret(effectId, connection.baseUrl.env).pipe(
						Effect.flatMap((value) =>
							Effect.try({
								try: () => checkedBaseUrl(value),
								catch: () => ({
									message: `${(connection.baseUrl as PrivateEnvReference).env} is not an absolute HTTPS URL`
								})
							})
						)
					);
		const authentication = connection.authentication;
		if (authentication === undefined) return { baseUrl, headers: {}, query: {} };
		if (authentication.type === 'bearer') {
			const token = yield* secret(effectId, authentication.token.env);
			return { baseUrl, headers: { authorization: `Bearer ${token}` }, query: {} };
		}
		const value = yield* secret(effectId, authentication.value.env);
		return authentication.type === 'header'
			? { baseUrl, headers: { [authentication.header]: value }, query: {} }
			: { baseUrl, headers: {}, query: { [authentication.name]: value } };
	});

/** `path` under the resolved root, with the credential's query parameters; empty is the root. */
export const connectionUrl = (connection: ResolvedConnection, path: string): URL => {
	const url = new URL(
		path === ''
			? connection.baseUrl
			: `${connection.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`
	);
	for (const [key, value] of Object.entries(connection.query)) url.searchParams.set(key, value);
	return url;
};

/** Walks a value down a dotted path (`from.address`), stopping at the first non-object step. */
export const walk = (value: unknown, path: string | undefined): unknown => {
	if (path === undefined || path === '') return value;
	let cursor: unknown = value;
	for (const step of path.split('.')) {
		if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
		cursor = Reflect.get(cursor, step);
	}
	return cursor;
};

/** Sets a dotted path on a plain object, creating the objects on the way. */
export const place = (target: Record<string, unknown>, path: string, value: unknown): void => {
	const steps = path.split('.');
	let cursor = target;
	for (const step of steps.slice(0, -1)) {
		const next = cursor[step];
		if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[step] = {};
		cursor = cursor[step] as Record<string, unknown>;
	}
	cursor[steps.at(-1) ?? path] = value;
};

export type Fetched = Readonly<{
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Schema.Json;
}>;

export type RetrySpec = Readonly<{
	readonly attempts: number;
	readonly initialDelayMs?: number;
	readonly maxDelayMs?: number;
}>;

/** A request that came back with a status the caller must see, or a transport failure. */
export type HttpFailure = Readonly<{
	readonly message: string;
	readonly status?: number;
	readonly retryable: boolean;
	readonly body?: Schema.Json;
}>;

const decodeResponse = Schema.decodeUnknownEffect(IntegrationHttpResponse);

/**
 * Asks the host to perform one request through the connector facility, retrying only what is
 * worth asking again (a retryable transport failure, 429, 5xx). A 4xx comes straight back.
 */
export const performRequest = (
	connector: ConnectorInterface,
	effectId: EffectId,
	request: IntegrationHttpRequest,
	retry: RetrySpec | undefined
): Effect.Effect<Fetched, HttpFailure> =>
	Effect.gen(function* () {
		const attempts = Math.max(retry?.attempts ?? 1, 1);
		const backoff = {
			initialDelayMs: retry?.initialDelayMs ?? 250,
			maxDelayMs: retry?.maxDelayMs ?? 30_000
		};
		let last: HttpFailure = { message: `${request.method} ${request.url} was never attempted`, retryable: true };
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			const outcome = yield* connector
				.execute(EffectId.make(`${effectId}:http:${attempt}`), {
					connector: 'http',
					operation: INTEGRATION_HTTP_OPERATION,
					input: request as unknown as Schema.Json
				})
				.pipe(
					Effect.flatMap((response) => decodeResponse(response.output)),
					Effect.result
				);
			if (Result.isSuccess(outcome) && outcome.success.status < 400) return outcome.success;
			last = Result.isFailure(outcome)
				? {
						message: String(Reflect.get(outcome.failure, 'message') ?? outcome.failure),
						retryable: Reflect.get(outcome.failure, 'retryable') === true
					}
				: {
						message: `${request.method} ${request.url} answered ${outcome.success.status}`,
						status: outcome.success.status,
						retryable: isRetryableStatus(outcome.success.status),
						body: outcome.success.body
					};
			if (!last.retryable || attempt + 1 === attempts) return yield* Effect.fail(last);
			const after = Result.isSuccess(outcome) ? outcome.success.headers['retry-after'] : undefined;
			yield* Effect.sleep(retryDelayMs(attempt, backoff, after, yield* Clock.currentTimeMillis));
		}
		return yield* Effect.fail(last);
	});
