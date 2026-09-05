import { Schema } from 'effect';

const missingEntry = Schema.Struct({ code: Schema.Literal('ENOENT') });

/**
 * Whether a caught value is Node's absent-path signal (`ENOENT`).
 *
 * The owner of the unknown-error boundary: an optional-resource read distinguishes
 * "absent is fine" from "unreadable must fail" by decoding the platform code once here,
 * instead of every caller duck-reading `code` off an `unknown`.
 */
export const isMissingEntry = Schema.is(missingEntry);

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(getErrorMessage(value), { cause: value });
}

const stringMessage = Schema.String;
const recordMessage = Schema.Struct({ message: Schema.Unknown });

export function getErrorMessage(value: unknown): string {
	if (value instanceof Error) return value.message;
	if (Schema.is(stringMessage)(value)) return value;
	if (Schema.is(recordMessage)(value)) return Schema.is(stringMessage)(value.message) ? value.message : String(value.message);
	return String(value);
}
