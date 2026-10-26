import * as Schema from 'effect/Schema';

/**
 * `ctx.refuse` (rule 32): an authored refusal that ends the body; `field` names a field, and in a write callback `row`
 * the index of the offending row in the batch the callback received.
 */
export class Refusal extends Schema.TaggedError<Refusal>()('Refusal', {
	message: Schema.String,
	field: Schema.optional(Schema.String),
	row: Schema.optional(Schema.Number)
}) {}
