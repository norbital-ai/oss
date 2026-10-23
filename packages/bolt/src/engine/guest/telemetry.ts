// An invocation's events share one buffer; the act may take it into its own statement.
import { Clock, Context, Effect, Layer, Ref, type Scope } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Sql } from '../contracts.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { Telemetry, type EventIds, type InvocationEvents } from '../services.ts';
type Severity = 'info' | 'warn' | 'error';
export type SysEvent = {
	readonly at: string;
	readonly severity: Severity;
	readonly event: string;
	readonly invocation: string;
	readonly run: string | null;
	readonly conversation: string | null;
	readonly turn: string | null;
	readonly attributes: { readonly [key: string]: Json };
};
export const SLICE = { ms: 10_000, events: 200 } as const;
export function eventsPiece(param: number): string {
	return `INSERT INTO sys_event (at, severity, event, invocation, run, conversation, turn, attributes) SELECT e.at, e.severity, e.event, e.invocation, e.run, e.conversation, e.turn, e.attributes FROM jsonb_to_recordset($${param}::jsonb) AS e(at timestamptz, severity text, event text, invocation text, run text, conversation text, turn text, attributes jsonb)`;
}
const insertEvents = (events: readonly SysEvent[]): Sql => ({
	text: eventsPiece(1),
	params: [JSON.stringify(events)]
});
/** The host's log store (`HostPorts.events`): each `sys_event` row as it is written; unset, one log line per row. */
export const EventSink = Context.Reference<(row: SysEvent) => Effect.Effect<void>>(
	'bolt/EventSink',
	{ defaultValue: () => (row) => Effect.logInfo(JSON.stringify(row)) }
);
/** One `sys_event` row written on its own: handed to the host's log store, and its insert statement. */
export const logged = (row: SysEvent): Effect.Effect<Sql> =>
	Effect.gen(function* () {
		yield* (yield* EventSink)(row);
		return insertEvents([row]);
	});
export const TelemetryLive = Layer.effect(
	Telemetry,
	Effect.gen(function* () {
		const db = yield* TenantDb,
			sink = yield* EventSink;
		const open = (ids: EventIds): Effect.Effect<InvocationEvents, never, Scope.Scope> =>
			Effect.gen(function* () {
				const buffer = yield* Ref.make<readonly SysEvent[]>([]),
					flushedAt = yield* Ref.make(yield* Clock.currentTimeMillis);
				const take = Effect.gen(function* () {
					const rows = yield* Ref.getAndSet(buffer, []);
					yield* Ref.set(flushedAt, yield* Clock.currentTimeMillis);
					return rows;
				});
				const flush = Effect.gen(function* () {
					const rows = yield* take;
					if (rows.length > 0) yield* db.write(insertEvents(rows));
				}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
				const slice = Effect.gen(function* () {
					const rows = yield* Ref.get(buffer),
						now = yield* Clock.currentTimeMillis;
					if (
						rows.length >= SLICE.events ||
						(rows.length > 0 && now - (yield* Ref.get(flushedAt)) >= SLICE.ms)
					)
						yield* flush;
				});
				yield* Effect.addFinalizer(() => flush);
				const events: InvocationEvents = {
					take,
					slice,
					emit: (severity, event, attributes) =>
						Effect.gen(function* () {
							const now = yield* Clock.currentTimeMillis;
							const row: SysEvent = {
								at: new Date(now).toISOString(),
								severity,
								event,
								invocation: ids.invocation,
								run: ids.run ?? null,
								conversation: ids.conversation ?? null,
								turn: ids.turn ?? null,
								attributes
							};
							yield* sink(row);
							yield* Ref.update(buffer, (rows) => [...rows, row]);
						})
				};
				return events;
			});
		return { open };
	})
);
