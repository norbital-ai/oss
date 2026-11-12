// An invocation's events: each written to the host's runtime log as it happens.
import { Clock, Effect, Layer, type Scope } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import { LIMITS, type LogQuery } from '../contracts.ts';
import { Logs, type LogsShape } from '../ports.ts';
import { Telemetry, type EventIds, type InvocationEvents } from '../services.ts';
/** A page of the runtime log from the host's store, newest first; the caller has checked the reader may see it. */
export const readLog = (logs: LogsShape, query: LogQuery) =>
	logs
		.query(query)
		.pipe(
			Effect.mapError((error) =>
				BoltError.make(
					error._tag === 'Unavailable' ? 'unavailable' : 'upstream',
					'facility',
					error.message
				)
			)
		);
/** A run's latest log lines, oldest first; a store that cannot answer says so in place of the lines, never as an empty log. */
export const runLog = (logs: LogsShape, run: string, after?: string) =>
	readLog(logs, { run, limit: LIMITS.runLog.lines, ...(after === undefined ? {} : { after }) }).pipe(
		Effect.map((lines) => lines.toReversed()),
		Effect.catch((error) => Effect.succeed(error.message))
	);
export const TelemetryLive = Layer.effect(
	Telemetry,
	Effect.gen(function* () {
		const logs = yield* Logs;
		const open = (ids: EventIds): Effect.Effect<InvocationEvents, never, Scope.Scope> =>
			Effect.succeed({
				emit: (severity, event, attributes) =>
					Effect.gen(function* () {
						yield* logs.write({
							at: new Date(yield* Clock.currentTimeMillis).toISOString(),
							severity,
							event,
							invocation: ids.invocation,
							run: ids.run ?? null,
							conversation: ids.conversation ?? null,
							turn: ids.turn ?? null,
							attributes
						});
					})
			});
		return { open };
	})
);
