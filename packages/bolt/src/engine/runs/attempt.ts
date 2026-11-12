// A run's stored attempts (`sys_run.results`), shared by the engine that appends them and the shell that shows them.
import { Schema } from 'effect';

/** A run's failure: its code/message, native SQLSTATE when known, and any refusal field, rows, rule or records. */
export const RunError = Schema.Struct({
	code: Schema.String,
	message: Schema.optionalKey(Schema.String),
	sqlstate: Schema.optionalKey(Schema.String),
	outcome_unknown: Schema.optionalKey(Schema.Literal(true)),
	field: Schema.optionalKey(Schema.String),
	path: Schema.optionalKey(Schema.String),
	row: Schema.optionalKey(Schema.Number),
	rows: Schema.optionalKey(Schema.Array(Schema.Number)),
	rule: Schema.optionalKey(Schema.String),
	data: Schema.optionalKey(Schema.Struct({ request_id: Schema.String })),
	records: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				model: Schema.String,
				id: Schema.String
			})
		)
	),
	invocation: Schema.optionalKey(Schema.String)
});
/** One attempt of a run (`sys_run.results`): its number, when it finished, the state it left, its output or error, the
 * warnings it raised and whether a cron run started over a minute late. */
export const RunAttempt = Schema.Struct({
	attempt: Schema.Number,
	at: Schema.String,
	state: Schema.String,
	output: Schema.optionalKey(Schema.Json),
	error: Schema.optionalKey(RunError),
	warnings: Schema.optionalKey(Schema.Array(Schema.String)),
	missed: Schema.optionalKey(Schema.Literal(true))
});
export type RunAttempt = typeof RunAttempt.Type;
