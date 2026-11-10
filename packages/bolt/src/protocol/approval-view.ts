import { Schema } from 'effect';

export const ApprovalStateSchema = Schema.Literals([
	'Pending',
	'ChangesRequested',
	'Approved',
	'Rejected',
	'Superseded'
]);

export const ApprovalLogFields = {
	move: Schema.Literals([
		'request',
		'approve',
		'reject',
		'request_changes',
		'resubmit',
		'supersede'
	]),
	at: Schema.String,
	from: Schema.NullOr(ApprovalStateSchema),
	to: ApprovalStateSchema,
	step: Schema.Number,
	reason: Schema.NullOr(Schema.String),
	/** A resubmission's changed fields: the root record's by name, any other held row's as `<model>.<field>`. */
	changed: Schema.optionalKey(Schema.Array(Schema.String)),
	rolledBack: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				model: Schema.String,
				id: Schema.String,
				action: Schema.Literals(['restored', 'removed', 'recreated'])
			})
		)
	),
	skipped: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				model: Schema.String,
				id: Schema.String,
				field: Schema.String,
				reason: Schema.String
			})
		)
	)
};

const Who = Schema.Struct({ ref: Schema.String, name: Schema.NullOr(Schema.String) });
const Operation = Schema.Literals(['create', 'update', 'delete']);
const Names = Schema.Record(Schema.String, Schema.String);
/** The request and its history as the viewer is allowed to read them. */
export const ApprovalViewSchema = Schema.Struct({
	id: Schema.String,
	model: Schema.String,
	record: Schema.String,
	action: Operation,
	at: Schema.String,
	status: ApprovalStateSchema,
	step: Schema.Int,
	steps: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			teams: Schema.Array(Schema.String),
			users: Schema.Array(Schema.String)
		})
	),
	superseded_by: Schema.Array(Schema.String),
	teamNames: Names,
	userNames: Names,
	requestor: Who,
	log: Schema.Array(Schema.Struct({ ...ApprovalLogFields, by: Who })),
	records: Schema.Array(Schema.Struct({ model: Schema.String, id: Schema.String, op: Operation })),
	moves: Schema.Array(
		Schema.Struct({
			decision: Schema.Literals(['approve', 'reject', 'request_changes']),
			reason: Schema.Literals(['required', 'optional'])
		})
	),
	mine: Schema.Boolean,
	participant: Schema.Boolean
});
/** The request and its history as the viewer is allowed to read them. */
export type ApprovalView = typeof ApprovalViewSchema.Type;
