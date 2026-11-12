// What a provider fails with (D3): one tag per way it fails, each a decoded value. `to_drivers` (abi.ts) hands them across
// the driver ABI in the shape the engine reads: a refusal as the engine's `SendRefused`, any other as itself (an
// `Error` named by its tag).
import { Schema } from 'effect';
import type { Fenced } from '@norbital-ai/bolt/engine';
import type { FacilityFailure } from '@norbital-ai/bolt/errors';

/**
 * The provider's API refused: `permanent` (a 4xx other than 429) fails a send at once, otherwise bolt retries it.
 * `code` is the provider's own error code, else the HTTP status.
 */
export class ProviderRefused extends Schema.TaggedError<ProviderRefused>()('ProviderRefused', {
	message: Schema.String,
	code: Schema.optional(Schema.String),
	permanent: Schema.Boolean
}) {}
/** The provider could not be reached, or answered something that is not its result; worth retrying (after `retry_after_ms`, when it said). */
export class ProviderUnavailable extends Schema.TaggedError<ProviderUnavailable>()(
	'ProviderUnavailable',
	{
		message: Schema.String,
		status: Schema.optional(Schema.Number),
		retry_after_ms: Schema.optional(Schema.Number)
	}
) {}
/** The token endpoint refused: `revoked` when only a new sign-in helps (`invalid_grant`). */
export class OAuthRefused extends Schema.TaggedError<OAuthRefused>()('OAuthRefused', {
	message: Schema.String,
	revoked: Schema.Boolean
}) {}
/** The operator's setup input does not do (a missing or malformed field); the shell shows `message` verbatim. */
export class PairingInvalid extends Schema.TaggedError<PairingInvalid>()('PairingInvalid', {
	message: Schema.String
}) {}
/** The link closed (replaced, unpaired) under a call. */
export class LinkClosed extends Schema.TaggedError<LinkClosed>()('LinkClosed', {
	message: Schema.String
}) {}

export type ProviderFailure =
	| ProviderRefused
	| ProviderUnavailable
	| OAuthRefused
	| PairingInvalid
	| LinkClosed
	| FacilityFailure
	| Fenced;

/** A `Retry-After` header's delay in seconds as milliseconds; absent, zero or a date gives none. */
export const retry_after_ms = (header: string | null | undefined): number | undefined => {
	const seconds = Number(header ?? Number.NaN);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
};
/** The connection a call needs is not open (never paired, or closed). */
export const notConnected = (what: string): ProviderUnavailable =>
	new ProviderUnavailable({ message: `${what} is not connected` });

/** A provider API's failed answer: a 4xx other than 429 refuses for good; anything else is unavailable, retried. */
export const answerFailure = (
	message: string,
	status: number,
	code?: string,
	retry_after_ms?: number
): ProviderRefused | ProviderUnavailable =>
	status >= 400 && status < 500 && status !== 429
		? new ProviderRefused({ message, code: code ?? String(status), permanent: true })
		: new ProviderUnavailable({ message, status, retry_after_ms });
