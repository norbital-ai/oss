import * as Schema from 'effect/Schema';

/** `ctx.refuse` (rule 32): an authored refusal that ends the body; `field` names an input field. */
export class Refusal extends Schema.TaggedError<Refusal>()('Refusal', {
	message: Schema.String,
	field: Schema.optional(Schema.String)
}) {}
