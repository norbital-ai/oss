import { Schema } from 'effect';

/** The settled answer returned by one complete agent-turn invocation. */
export const TurnResult = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	output: Schema.Json,
	status: Schema.Literals(['completed', 'failed'])
});
export interface TurnResult extends Schema.Schema.Type<typeof TurnResult> {}
