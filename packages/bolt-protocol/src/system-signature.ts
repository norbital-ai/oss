import { Schema } from 'effect';

/**
 * What a host signs to run one invocation as the system principal, in the package both ends import.
 *
 * The runtime verifies a digest by rebuilding this payload from what actually arrived and comparing;
 * a host that rendered its own version of "the bytes we sign" would be one edit away from a check
 * that passes on a payload nobody meant to authorize. It lives here rather than in the runtime
 * because it is a wire contract with two implementers and one meaning: Colony reaches it through
 * `@norbital-ai/bolt/host`, bolt-server through this package, and the runtime rebuilds it on the
 * other side of the same boundary.
 *
 * The secret never crosses this seam. It is read from each side's own environment under
 * `GATEWAY_SECRET_VARIABLE`, and the HMAC itself is computed by whichever primitive the side that
 * needs it can reach — `node:crypto` on a host, WebCrypto inside the runtime's bundle.
 */

/**
 * The configuration key the signing secret is read from on both sides.
 *
 * The same `COLONY_GATEWAY_SECRET` a host already verifies operator requests against, not a second
 * secret minted for this. A host that sets none can mint no system principal, and the runtime's
 * verification answers `false` rather than treating an unconfigured host as a trusted one.
 */
export const GATEWAY_SECRET_VARIABLE = 'COLONY_GATEWAY_SECRET';

/** The two headers a host-signed invocation carries, lowercase because header lookup folds case. */
export const SYSTEM_SIGNATURE_HEADER = 'x-colony-system-signature';
export const SYSTEM_TIMESTAMP_HEADER = 'x-colony-system-timestamp';

/**
 * How long a signature is good for: one invocation, inside a five minute window.
 *
 * Wide enough for clock skew between a host and a runtime that may not share a machine, narrow
 * enough that a captured header is worthless long before anybody could find it. The comparison the
 * runtime makes is two-sided, so a timestamp from the future is refused too.
 */
export const SIGNATURE_LIFETIME_MILLIS = 300_000;

/** The four facts the host signs, in order. */
export type SystemSignaturePayload = Readonly<{
	readonly timestamp: number;
	readonly command: string;
	readonly tenantId: string;
	readonly input: unknown;
}>;

/**
 * The bytes the host signs, rendered identically on both sides.
 *
 * All four fields are in it, and each closes something. The `timestamp` bounds replay. The `command`
 * binds the signature to *this* command, so a digest captured from a `schema.migrate` cannot be
 * replayed onto an `identity.admitFounder`. The `tenantId` binds it to one workspace, so a signature
 * for a demo tenant cannot migrate a customer's. The canonical rendering of `input` binds it to the
 * arguments, so a captured signature cannot be replayed with different ones.
 */
export const systemSignaturePayload = (parameters: SystemSignaturePayload): string =>
	[
		String(parameters.timestamp),
		parameters.command,
		parameters.tenantId,
		canonicalJson(parameters.input)
	].join('\n');

/**
 * A rendering of a JSON value that does not depend on key order.
 *
 * `JSON.stringify` preserves insertion order, and the input a host signs is a literal it wrote while
 * the input the runtime verifies may have been round-tripped through a JSON body. Sorting the keys
 * is what makes those two the same string. Anything that is not JSON renders as `null`, which can
 * only ever fail a comparison rather than pass one.
 */
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isString = Schema.is(Schema.String);
const isBoolean = Schema.is(Schema.Boolean);
const isNumber = Schema.is(Schema.Number);

const canonicalJson = (value: unknown): string => {
	if (value == null) return 'null';
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (isRecord(value)) {
		const entries = Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
		return `{${entries.join(',')}}`;
	}
	if (isString(value) || isBoolean(value)) return JSON.stringify(value);
	if (isNumber(value)) return Number.isFinite(value) ? JSON.stringify(value) : 'null';
	return 'null';
};
