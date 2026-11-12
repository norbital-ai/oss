import { Option, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { LogRow } from '../../engine/contracts.ts';

/** One `decision.made` event's attributes as the decision matrix reads them (`decisionEvent`); a missing answer is a dash. */
const DecisionAnswer = Schema.Struct({
	type: Schema.optionalKey(Schema.String),
	choice: Schema.optionalKey(Schema.String),
	score: Schema.optionalKey(Schema.Number),
	noul: Schema.optionalKey(Schema.Number),
	confidence: Schema.optionalKey(Schema.Number)
});
type DecisionAnswer = typeof DecisionAnswer.Type;
const Said = Schema.Struct({
	from: Schema.optionalKey(Schema.String),
	text: Schema.optionalKey(Schema.String)
});
const DecisionAttributes = Schema.Struct({
	use: Schema.optionalKey(Schema.String),
	action: Schema.optionalKey(Schema.String),
	error: Schema.optionalKey(Schema.String),
	questions: Schema.optionalKey(Schema.Array(Schema.String)),
	answers: Schema.optionalKey(Schema.Record(Schema.String, DecisionAnswer)),
	verdicts: Schema.optionalKey(Schema.Array(Schema.String)),
	state: Schema.optionalKey(
		Schema.Struct({
			directive: Schema.optionalKey(Schema.String),
			assistant: Schema.optionalKey(Schema.String),
			pending: Schema.optionalKey(
				Schema.Array(Schema.Struct({ ...Said.fields, id: Schema.optionalKey(Schema.String) }))
			),
			earlier: Schema.optionalKey(Schema.Array(Said))
		})
	)
});
type DecisionAttributes = typeof DecisionAttributes.Type;
const NO_DECISION: DecisionAttributes = {};
/** An event that is no decision the matrix can read shows as an empty one. */
export const decision_of = (a: Json): DecisionAttributes =>
	Option.getOrElse(Schema.decodeUnknownOption(DecisionAttributes)(a), () => NO_DECISION);
export const answer_of = (a: DecisionAnswer | undefined) =>
	a === undefined
		? '—'
		: a.type === 'choice'
			? String(a.choice ?? '—')
			: a.type === 'score'
				? `${a.score ?? 0} (${a.confidence ?? 0})`
				: a.type === 'noul'
					? String(a.noul ?? 0)
					: '—';
export type Decided = { event: LogRow; d: DecisionAttributes };
