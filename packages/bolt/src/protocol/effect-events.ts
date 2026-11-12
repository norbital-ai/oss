import { Schema } from 'effect';
import { ApprovalLogFields, ApprovalViewSchema } from './approval-view.ts';

export const ApprovalRecipients = Schema.Struct({
	teams: Schema.Array(Schema.String),
	users: Schema.Array(Schema.String)
});
/** Approval effects retain their event snapshot; a deleted record has no current row. */
export const ApprovalEffectEvent = Schema.Struct({
	kind: Schema.Literal('approval'),
	move: ApprovalLogFields.move,
	step: Schema.Int,
	steps: ApprovalViewSchema.fields.steps,
	done: Schema.Boolean,
	request: Schema.String,
	records: Schema.Array(Schema.Struct({
		id: Schema.String,
		row: Schema.NullOr(Schema.Record(Schema.String, Schema.Json))
	})),
	requester: Schema.NullOr(Schema.String),
	approvers: ApprovalRecipients
});
export type ApprovalEffectEvent = typeof ApprovalEffectEvent.Type;
export const EffectEvent = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('write') }),
	ApprovalEffectEvent
]);
export type EffectEvent = typeof EffectEvent.Type;
