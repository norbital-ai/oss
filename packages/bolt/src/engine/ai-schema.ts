import { Schema } from 'effect';

/** The host's system-2 answer; transcript storage keeps its native toolCalls projection behind the adapter. */
export const AiPortResponseSchema = Schema.Struct({
	content: Schema.Json,
	tool_calls: Schema.Array(Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		input: Schema.Json,
		invalid: Schema.optionalKey(Schema.String)
	})),
	finish: Schema.Literals(['stop', 'tool', 'cut']),
	continuation: Schema.optionalKey(Schema.String),
	reasoning: Schema.optionalKey(Schema.String),
	usage: Schema.Struct({
		input: Schema.Number,
		output: Schema.Number,
		cost: Schema.optionalKey(Schema.Number),
		call: Schema.optionalKey(Schema.String),
		provider: Schema.optionalKey(Schema.String),
		cached: Schema.optionalKey(Schema.Number),
		reasoning: Schema.optionalKey(Schema.Number),
		prompt: Schema.optionalKey(Schema.Struct({ system: Schema.Number, messages: Schema.Number, tools: Schema.Number }))
	})
});
