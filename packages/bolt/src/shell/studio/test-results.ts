import { Schema } from 'effect';

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** A fixed test job's parsed results, tied to the exact source it executed. */
export const StudioTestRun = Schema.Struct({
	id: Schema.String,
	commit: Schema.String,
	state: Schema.Literals(['running', 'passed', 'failed', 'empty']),
	startedAt: Schema.String,
	finishedAt: Schema.optionalKey(Schema.String),
	summary: Schema.optionalKey(
		Schema.Struct({
			files: count,
			total: count,
			passed: count,
			failed: count,
			skipped: count,
			durationMs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
		})
	),
	files: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			state: Schema.Literals(['passed', 'failed', 'skipped']),
			error: Schema.optionalKey(Schema.String),
			tests: Schema.Array(
				Schema.Struct({
					name: Schema.String,
					state: Schema.Literals(['passed', 'failed', 'skipped']),
					durationMs: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
					error: Schema.optionalKey(Schema.String)
				})
			)
		})
	),
	error: Schema.optionalKey(Schema.String),
	truncated: Schema.optionalKey(Schema.Literal(true))
});
export type StudioTestRun = typeof StudioTestRun.Type;
