import { Effect, Schema } from 'effect';
import { KitInvalid, type JobResult, type Kit } from './effect.ts';

const RunResult = Schema.Struct({
	state: Schema.String,
	output: Schema.NullOr(Schema.Json),
	error: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String }))
});

type RunFailure =
	| Effect.Error<ReturnType<Kit['run_due']>>
	| Effect.Error<ReturnType<Kit['db']['rows']>>
	| KitInvalid;

/** The actual native run ledger, without treating queue admission as business completion. */
export const settledRun = Effect.fnUntraced(function* (
	t: Kit,
	id: string
): Effect.fn.Return<typeof RunResult.Type, RunFailure> {
	yield* t.run_due();
	const rows = yield* t.db.rows(RunResult, {
		text: 'SELECT state, output, error FROM sys_run WHERE id = $1',
		params: [id]
	});
	const row = rows[0];
	if (row === undefined)
		return yield* Effect.fail(new KitInvalid({ message: 'Fixture run is missing.' }));
	if (['queued', 'running', 'waiting'].includes(row.state))
		return yield* Effect.fail(
			new KitInvalid({
				message: `Run ${id} is ${row.state}; advance the test clock or provide its awaited event before asserting settlement.`
			})
		);
	return row;
});

/** Start through the native route, execute the queue, and inspect the actual run's settlement. */
export const runAutomation = Effect.fnUntraced(function* <E, R>(
	t: Kit,
	start: Effect.Effect<JobResult, E, R>
): Effect.fn.Return<typeof RunResult.Type, E | RunFailure, R> {
	const queued = yield* start;
	if (queued.kind !== 'committed')
		return yield* Effect.fail(new KitInvalid({ message: 'Fixture run was not queued.' }));
	return yield* settledRun(t, queued.output.id);
});
