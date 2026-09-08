import { Number as ENumber } from 'effect';
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
