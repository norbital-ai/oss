import { Schema } from 'effect';

/** The settled or parked answer returned by an agent turn. */
export const TurnResult = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	output: Schema.Json,
	status: Schema.Literals(['completed', 'waiting', 'failed'])
});
export interface TurnResult extends Schema.Schema.Type<typeof TurnResult> {}

/** Durable admission answer. Inference happens later from the task queue and is observed via sync. */
export const AgentEnqueueResult = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString,
	turnId: Schema.NonEmptyString,
	status: Schema.Literal('queued')
});
export interface AgentEnqueueResult extends Schema.Schema.Type<typeof AgentEnqueueResult> {}
