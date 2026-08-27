import { Effect, Schema } from 'effect';
import type { BoltTransport } from '#lib/client/contracts.js';
import { cacheKeyFor } from '#lib/client/replica/query-cache.js';

export type HttpBoltTransportOptions = Readonly<{
	/**
	 * Where a command is posted, as a prefix the command name is appended to.
	 *
	 * Stated rather than assumed. This was `${baseUrl}/api/bolt/command/…`, which is one host's
	 * routing table written into the framework: an artifact served by anything else answered
	 * commands at a path this transport could not name, and the only way to find out was every
	 * command failing with a 404 that read as a missing command.
	 */
	readonly endpoint: string;
	readonly credential: string;
}>;

/** A string field of an object, or nothing — the shape checks every branch below would repeat. */
const textField = (value: unknown, field: string): string | undefined => {
	if (value === null || typeof value !== 'object') return undefined;
	const held = Reflect.get(value, field);
	return typeof held === 'string' && held.trim() !== '' ? held : undefined;
};

/**
 * What the operator is told when a command is refused.
 *
 * This read `payload.message` and nothing else, so it found a message only when the body happened
 * to put one at the top level — and the two bodies that actually carry a refusal do not.
 *
 * A runtime refusal is a *wire error*: the host answers `{ error: { code, message } }` with the
 * bundle's own status, which is how every Postgres failure, every denied access check and every
 * facility fault comes back. A host refusal (Colony's 409) is a tagged failure serialised as its
 * fields. In both cases the reason was present in the response body and thrown away here, so a
 * unique-constraint violation and an unconfigured AI provider both reported themselves as
 * `Bolt command <name> failed (500)` — a status code, which is the one fact the caller already had.
 *
 * The status-only sentence stays as the last resort, for a body that genuinely says nothing.
 */
const refusalMessage = (command: string, status: number, payload: unknown): string => {
	const direct = textField(payload, 'message');
	if (direct !== undefined) return direct;
	const wire =
		payload !== null && typeof payload === 'object'
			? (payload as { readonly error?: unknown }).error
			: undefined;
	const nested = textField(wire, 'message');
	if (nested !== undefined) {
		const code = textField(wire, 'code');
		return code === undefined || code === '' ? nested : `${code}: ${nested}`;
	}
	const reason = textField(payload, 'reason');
	if (reason !== undefined) return reason;
	return `Bolt command ${command} failed (${status})`;
};

/** Carries the response controls needed by bounded retry and mutation outcome classification. */
export class BoltHttpResponseError extends Error {
	readonly status: number;
	readonly retryAfter: string | undefined;
	readonly payload: Schema.Json;

	constructor(
		message: string,
		status: number,
		retryAfter: string | undefined,
		payload: Schema.Json
	) {
		super(message);
		this.name = 'BoltHttpResponseError';
		this.status = status;
		this.retryAfter = retryAfter;
		this.payload = payload;
	}
}

type PageValidator = Readonly<{ readonly etag: string; readonly value: Schema.Json }>;
const MAX_PAGE_VALIDATORS = 128;

/** Browser transport that posts Bolt commands to the endpoint the host declared. */
export function createHttpBoltTransport(options: HttpBoltTransportOptions): BoltTransport {
	const endpoint = options.endpoint.replace(/\/$/, '');
	// This closure is created for one mounted, credential-bound workspace session. Keeping validators
	// here makes an exact page reusable across remounts of that session without ever crossing into a
	// different transport/principal, and the fixed ceiling prevents navigation from growing it forever.
	const pages = new Map<string, PageValidator>();
	return {
		command: (command, input, signal) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const pageKey =
						command === 'collections.findMany' ? cacheKeyFor(command, input) : undefined;
					const prior = pageKey === undefined ? undefined : pages.get(pageKey);
					const response = yield* Effect.tryPromise(() =>
						fetch(`${endpoint}/${encodeURIComponent(command)}`, {
							method: 'POST',
							credentials: 'same-origin',
							headers: {
								'content-type': 'application/json',
								authorization: `Bearer ${options.credential}`,
								...(prior === undefined ? {} : { 'if-none-match': prior.etag })
							},
							body: JSON.stringify(input),
							signal: signal ?? null
						})
					);
					if (response.status === 304) {
						if (prior === undefined)
							return yield* Effect.fail(
								new Error('Bolt returned 304 without an exact authority-scoped page')
							);
						pages.delete(pageKey as string);
						pages.set(pageKey as string, prior);
						return prior.value;
					}
					const text = yield* Effect.tryPromise(() => response.text());
					const payload =
						text.trim() === ''
							? null
							: yield* Schema.decodeUnknownEffect(
									Schema.NullOr(Schema.fromJsonString(Schema.Json))
								)(text);
					if (!response.ok) {
						return yield* Effect.fail(
							new BoltHttpResponseError(
								refusalMessage(command, response.status, payload),
								response.status,
								response.headers.get('retry-after') ?? undefined,
								payload
							)
						);
					}
					const etag = response.headers.get('etag');
					if (pageKey !== undefined && etag !== null) {
						pages.delete(pageKey);
						pages.set(pageKey, { etag, value: payload });
						while (pages.size > MAX_PAGE_VALIDATORS) {
							const oldest = pages.keys().next().value as string | undefined;
							if (oldest === undefined) break;
							pages.delete(oldest);
						}
					}
					return payload;
				})
			)
	};
}
