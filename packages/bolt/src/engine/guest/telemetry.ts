// An invocation's events: each written to the host's runtime log as it happens.
import { Clock, Effect, Layer, type Scope } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import type { LogEvent, LogQuery } from '../contracts.ts';
import { Logs } from '../ports.ts';
import { Telemetry, type EventIds, type InvocationEvents } from '../services.ts';
/** One event written on its own (outside an invocation's `Telemetry`). */
export const logged = (event: LogEvent): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* (yield* Logs).write(event);
	});
/** A page of the runtime log from the host's store, newest first; the caller has checked the reader may see it. */
export const readLog = (query: LogQuery) =>
	Effect.gen(function* () {
		return yield* (yield* Logs)
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
	});
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
