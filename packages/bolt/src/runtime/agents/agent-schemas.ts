import { Schema } from 'effect';

/** The settled or parked answer returned by an agent turn. */
export const TurnResult = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	output: Schema.Json,
	status: Schema.Literals(['completed', 'waiting', 'failed'])
});
export interface TurnResult extends Schema.Schema.Type<typeof TurnResult> {}
