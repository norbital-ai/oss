import { Option, Predicate } from 'effect';
import * as Schema from 'effect/Schema';
import { actFailureTag } from './act-failure-tag.ts';

/**
 * A write refused (rule 32): `code` is `refused` for an authored refusal, else the engine's code (`forbidden`, `unique`,
 * …), with the field or rows it names and, for tenant code, the `rule` that refused.
 */
export class ActRefused extends Schema.TaggedError<ActRefused>()('ActRefused', {
	code: Schema.String,
	message: Schema.String,
	field: Schema.optional(Schema.String),
	row: Schema.optional(Schema.Number),
	rows: Schema.optional(Schema.Array(Schema.Number)),
	rule: Schema.optional(Schema.String),
	data: Schema.optional(Schema.Struct({ requestId: Schema.String }))
}) {}

/** A write that lost a race: another write changed the named fields of these records since they were read. */
export class ActConflict extends Schema.TaggedError<ActConflict>()('ActConflict', {
	records: Schema.Array(
		Schema.Struct({
			collection: Schema.String,
			id: Schema.String,
			fields: Schema.Array(Schema.String)
		})
	)
}) {
	readonly message = 'another write changed these records since they were read';
}

/** A write whose outcome could not be confirmed (a lost connection); `invocation` is the id to look it up by. */
export class ActUnknown extends Schema.TaggedError<ActUnknown>()('ActUnknown', {
	invocation: Schema.String
}) {
	readonly message = `the outcome of ${this.invocation} could not be confirmed`;
}

/** Every way `ctx.act` (and a kit caller's `act`) fails. */
export type ActFailure = ActRefused | ActConflict | ActUnknown;

const decodeAct = Schema.decodeUnknownOption(
	Schema.suspend(() => Schema.Union([ActRefused, ActConflict, ActUnknown]))
);

/** A write's outcome as its failure, by its `kind`: `refused`, `conflict`, `unknown`; none for any other value. */
export const actFailure = (outcome: unknown): Option.Option<ActFailure> => {
	const tag = actFailureTag(outcome);
	return tag === undefined || !Predicate.isObject(outcome)
		? Option.none()
		: decodeAct({ ...outcome, _tag: tag });
};
