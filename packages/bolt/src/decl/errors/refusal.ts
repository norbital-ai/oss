import * as Schema from 'effect/Schema';

/** A catalogue message's `{placeholder}` values. */
export const MessageValues = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]));
export type MessageValues = typeof MessageValues.Type;

/**
 * A catalogue message by key with its `{name}` placeholders filled from `values`: the one translation path of pages
 * (`ctx.t`), public pages and the engine's refusals. An unknown key is itself; an unfilled placeholder stays.
 */
export const message_text = (
	catalogue: Readonly<Record<string, string>> | undefined,
	key: string,
	values: MessageValues = {}
): string =>
	(catalogue?.[key] ?? key).replace(/\{(\w+)\}/g, (whole, name: string) =>
		values[name] === undefined ? whole : String(values[name])
	);

/**
 * What `ctx.refuse` fails with (rule 32): `message` is a catalogue key, `values` its placeholders, `field` names a
 * field, and `row` the index of the offending row in the batch or list the body received. Bodies refuse through
 * `ctx.refuse`, never by constructing it. The engine renders the key with the workspace catalogue.
 */
export class Refusal extends Schema.TaggedError<Refusal>()('Refusal', {
	message: Schema.String,
	values: Schema.optional(MessageValues),
	field: Schema.optional(Schema.String),
	row: Schema.optional(Schema.Number)
}) {}
