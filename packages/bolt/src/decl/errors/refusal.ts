import * as Schema from 'effect/Schema';

/**
 * What `ctx.refuse` fails with (rule 32): `message` is a catalogue key, `field` names a field, and `row` the index of
 * the offending row in the batch or list the body received. Bodies refuse through `ctx.refuse`, never by constructing it.
 */
export class Refusal extends Schema.TaggedError<Refusal>()('Refusal', {
	message: Schema.String,
	field: Schema.optional(Schema.String),
	row: Schema.optional(Schema.Number)
}) {}
