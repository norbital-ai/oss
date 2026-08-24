import { Schema } from 'effect';
import { EnvironmentName, InvocationId, ProtocolVersion, ReleaseId, TenantId } from './wire.js';

export const InvocationScope = Schema.Struct({
	tenantId: TenantId,
	environment: EnvironmentName,
	releaseId: ReleaseId
}).annotate({ identifier: 'BoltInvocationScope' });
export interface InvocationScope extends Schema.Schema.Type<typeof InvocationScope> {}

const InvocationFields = {
	protocolVersion: ProtocolVersion,
	id: InvocationId,
	scope: InvocationScope,
	deadlineEpochMs: Schema.Number.check(Schema.isFinite())
};

/** Host-proven context attached to plugin calls; it can only narrow authenticated authority. */
export const PluginTrustedContext = Schema.Struct({
	source: Schema.optional(Schema.NonEmptyString),
	plugin: Schema.optional(Schema.NonEmptyString),
	subject: Schema.optional(Schema.NonEmptyString),
	impersonatedSubject: Schema.optional(Schema.NonEmptyString),
	impersonatedUser: Schema.optional(Schema.NonEmptyString),
	impersonatedTeam: Schema.optional(Schema.NonEmptyString),
	app: Schema.optional(Schema.NonEmptyString)
});
export type PluginTrustedContext = typeof PluginTrustedContext.Type;

export const Invocation = Schema.TaggedUnion({
	Request: {
		...InvocationFields,
		method: Schema.NonEmptyString,
		url: Schema.NonEmptyString,
		headers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
		body: Schema.optionalKey(Schema.Uint8Array)
	},
	Command: {
		...InvocationFields,
		command: Schema.NonEmptyString,
		input: Schema.Json,
		headers: Schema.Record(Schema.String, Schema.Array(Schema.String))
	},
	Plugin: {
		...InvocationFields,
		plugin: Schema.NonEmptyString,
		command: Schema.NonEmptyString,
		input: Schema.Json,
		// `trustedContext` is whatever the host asserted, and over `POST /_bolt/plugin/...` the host is
		// whoever sent the body — so the tag needed somewhere to carry proof that it is one. Headers are
		// where `Command` and `Request` already carry theirs; a second field would be a second thing to
		// authenticate. Required rather than optional so every producer has to decide what it presents.
		headers: Schema.Record(Schema.String, Schema.Array(Schema.String)),
		trustedContext: PluginTrustedContext
	},
	Task: {
		...InvocationFields,
		command: Schema.NonEmptyString,
		input: Schema.Json,
		attempt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
	},
	Realtime: {
		...InvocationFields,
		connectionId: Schema.NonEmptyString,
		event: Schema.TaggedUnion({
			Open: {},
			Input: {
				frame: Schema.Struct({
					sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
					kind: Schema.Literals(['binary', 'text']),
					bytes: Schema.Uint8Array
				})
			},
			Pull: {
				afterCursor: Schema.optionalKey(Schema.String),
				maxFrames: Schema.Number.check(
					Schema.isInt(),
					Schema.isGreaterThan(0),
					Schema.isLessThanOrEqualTo(256)
				)
			},
			Close: { code: Schema.Number.check(Schema.isInt()), reason: Schema.String },
			Cancel: { reason: Schema.NonEmptyString }
		})
	}
}).annotate({ identifier: 'BoltInvocation' });
export type Invocation = typeof Invocation.Type;

export const Activation = Schema.Struct({
	protocolVersion: ProtocolVersion,
	id: InvocationId,
	scope: InvocationScope,
	deadlineEpochMs: Schema.Number.check(Schema.isFinite()),
	reason: Schema.Literals(['deploy', 'restart', 'repair'])
}).annotate({ identifier: 'BoltActivation' });
export interface Activation extends Schema.Schema.Type<typeof Activation> {}
