import { Number as ENumber, Schema } from 'effect';
import { decodeNumber } from '@norbital-ai/std/json';

/**
 * The one connector operation an integration performs, and its two message shapes.
 *
 * `ConnectorRequest` in the protocol is `{ connector, operation, input: Json }` — deliberately
 * open, because a connector is whatever a host binds. An integration needs exactly one thing from
 * it: send this HTTP request, give me back the status, the headers and the body. Stating that as a
 * schema here rather than inventing a second protocol field means every host already speaks it: the
 * request rides in `input` and the response rides in `output`, both plain JSON.
 *
 * The runtime plans the request — it resolves the credential, appends the cursor, walks the pages —
 * and the host performs it. That split is the whole point of the facility boundary: Bolt never
 * opens a socket, and a host can refuse an egress its policy does not allow without Bolt having to
 * know what that policy is.
 */
export const INTEGRATION_HTTP_OPERATION = 'http.request';

/**
 * The methods an integration may ask a host to perform.
 *
 * A pull only ever needs the first two. The rest arrived with outbound delivery, where they are not
 * decoration: a binding that mirrors a record into somebody else's system replaces it with `PUT`,
 * amends it with `PATCH` and withdraws it with `DELETE`, and collapsing all three into `POST` would
 * mean every update created a duplicate over there.
 */
const IntegrationHttpMethod = Schema.Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const IntegrationHttpRequest = Schema.Struct({
	method: IntegrationHttpMethod,
	url: Schema.NonEmptyString,
	headers: Schema.Record(Schema.String, Schema.String),
	body: Schema.optionalKey(Schema.Json)
});
export interface IntegrationHttpRequest extends Schema.Schema.Type<typeof IntegrationHttpRequest> {}

export const IntegrationHttpResponse = Schema.Struct({
	status: Schema.Number,
	/** Lower-cased by the performer, so `nextCursorHeader: 'X-Next-Cursor'` and `x-next-cursor` are the same header. */
	headers: Schema.Record(Schema.String, Schema.String),
	body: Schema.Json
});
export interface IntegrationHttpResponse extends Schema.Schema.Type<
	typeof IntegrationHttpResponse
> {}

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
