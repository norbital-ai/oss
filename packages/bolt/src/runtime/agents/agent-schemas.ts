import { Schema } from 'effect';

/** The settled or parked answer returned by an agent turn. */
export const TurnResult = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	output: Schema.Json,
	status: Schema.Literals(['completed', 'waiting', 'failed'])
});
export interface TurnResult extends Schema.Schema.Type<typeof TurnResult> {}

/** Durable admission answer. A direct lane invocation starts inference and sync carries its parts. */
export const AgentEnqueueResult = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString,
	turnId: Schema.NonEmptyString,
	status: Schema.Literal('queued')
});
export interface AgentEnqueueResult extends Schema.Schema.Type<typeof AgentEnqueueResult> {}

/** A direct lane invocation either owned the lane or found another invocation already owning it. */
export const AgentRunResult = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	status: Schema.Literals(['drained', 'busy', 'paused'])
});
export interface AgentRunResult extends Schema.Schema.Type<typeof AgentRunResult> {}
