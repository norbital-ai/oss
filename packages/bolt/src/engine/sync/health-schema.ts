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
