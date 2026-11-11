import { Schema } from 'effect';

export const SyncHealth = Schema.Struct({
	pending: Schema.Number,
	dead: Schema.Number,
	failed: Schema.Number,
	last_read_at: Schema.NullOr(Schema.String),
	last_change_at: Schema.NullOr(Schema.String),
	last_hint_at: Schema.NullOr(Schema.String),
	lag_seconds: Schema.NullOr(Schema.Number),
	webhooks_quiet: Schema.Boolean
});
export type SyncHealth = typeof SyncHealth.Type;

/** A stopped write an integration operator can inspect and retire. */
export const SyncDeadLetter = Schema.Struct({
	id: Schema.String,
	model: Schema.String,
	record: Schema.String,
	revision: Schema.Number,
	op: Schema.String,
	at: Schema.String,
	message: Schema.NullOr(Schema.String)
});
export type SyncDeadLetter = typeof SyncDeadLetter.Type;
