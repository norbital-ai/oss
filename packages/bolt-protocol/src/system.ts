import { Schema } from 'effect';

/** The immutable descriptor carried by system commands that attach or read a chat document. */
export const ChatDocumentRef = Schema.Struct({
	storage_key: Schema.NonEmptyString,
	file_name: Schema.NonEmptyString,
	file_size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	mime_type: Schema.NonEmptyString
});
export interface ChatDocumentRef extends Schema.Schema.Type<typeof ChatDocumentRef> {}

/** The receipt returned when an agent turn is accepted into its conversation lane. */
export const AgentEnqueueResult = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString,
	turnId: Schema.NonEmptyString,
	messageId: Schema.NonEmptyString,
	runId: Schema.optionalKey(Schema.NonEmptyString),
	status: Schema.Literals(['pending', 'running', 'completed', 'needs_attention', 'failed'])
});
export interface AgentEnqueueResult extends Schema.Schema.Type<typeof AgentEnqueueResult> {}

/** The approval state exchanged by the browser approval commands and their runtime handler. */
export const ApprovalState = Schema.TaggedUnion({
	Pending: {
		requestId: Schema.NonEmptyString,
		step: Schema.Number.check(Schema.isInt()),
		operation: Schema.Json
	},
	Approved: {
		requestId: Schema.NonEmptyString,
		decidedBy: Schema.NonEmptyString,
		superseded: Schema.optionalKey(Schema.Literal(true)),
		reason: Schema.optionalKey(Schema.NonEmptyString),
		operation: Schema.optionalKey(Schema.Json)
	},
	// Terminal refusals retain the operation so a held record can still be resolved or removed.
	Rejected: {
		requestId: Schema.NonEmptyString,
		decidedBy: Schema.NonEmptyString,
		reason: Schema.String,
		operation: Schema.optionalKey(Schema.Json)
	},
	ChangesRequested: {
		requestId: Schema.NonEmptyString,
		decidedBy: Schema.NonEmptyString,
		reason: Schema.NonEmptyString,
		operation: Schema.optionalKey(Schema.Json)
	},
	Conflicted: {
		requestId: Schema.NonEmptyString,
		reason: Schema.NonEmptyString,
		operation: Schema.optionalKey(Schema.Json)
	},
	Withdrawn: {
		requestId: Schema.NonEmptyString,
		withdrawnBy: Schema.NonEmptyString,
		operation: Schema.optionalKey(Schema.Json)
	}
});
export type ApprovalState = typeof ApprovalState.Type;
