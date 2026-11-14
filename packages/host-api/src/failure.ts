// What a Host API call rejects with, encoded, so a host decodes it whatever Bolt release raised it.
import { Schema } from 'effect';

/**
 * An engine answer: a `BoltError` the release raised. `code` and `phase` stay strings on the wire, since two
 * releases' sets may differ.
 */
export const HostFailure = Schema.TaggedStruct('HostFailure', {
	code: Schema.String,
	phase: Schema.String,
	message: Schema.String
});
export type HostFailure = typeof HostFailure.Type;
/** Anything else: the database went away, a host port threw. The host may retry it elsewhere; an engine answer stands. */
export const HostDefect = Schema.TaggedStruct('HostDefect', { message: Schema.String });
export type HostDefect = typeof HostDefect.Type;
/** What a Host API call rejects with: an engine answer (`HostFailure`) or a retryable host defect (`HostDefect`). */
export const HostApiFailure = Schema.Union([HostFailure, HostDefect]);
export type HostApiFailure = typeof HostApiFailure.Type;
