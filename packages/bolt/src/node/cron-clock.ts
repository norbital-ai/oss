// An in-process host's cron clock: a minute timer fires each cron whose latest slot is new since the last tick. One run
// per id at a time; a slot that comes due while its id runs waits, and only the latest waiting slot is kept. There is no
// watermark: a restart starts from now. A multi-host kernel runs its own clock, with leases and watermarks.
import { Clock, Cron, Effect, FiberMap, Result, type Scope } from 'effect';
import type { CronEntry, CronFired } from '../engine/contracts.ts';

const MINUTE = 60_000;

export const cronClock = <E>(source: {
	readonly crons: Effect.Effect<readonly CronEntry[]>;
	readonly fire: (id: string, slot: string) => Effect.Effect<CronFired, E>;
}): Effect.Effect<void, never, Scope.Scope> =>
	Effect.gen(function* () {
		const entries: { readonly id: string; readonly cron: Cron.Cron }[] = [];
		for (const entry of yield* source.crons) {
			const parsed = Cron.parse(entry.cron, entry.zone);
			if (Result.isSuccess(parsed)) entries.push({ id: entry.id, cron: parsed.success });
			else yield* Effect.logWarning(`cron ${entry.id} never fires: ${parsed.failure.message}`);
		}
		const running = yield* FiberMap.make<string>();
		/** An id with a run in flight → the latest slot waiting for it. */
		const waiting = new Map<string, string | undefined>();
		const drain = (id: string, slot: string): Effect.Effect<void> =>
			source.fire(id, slot).pipe(
				Effect.catchCause((cause) => Effect.logWarning(`cron ${id} at ${slot} failed`, cause)),
				Effect.andThen(
					Effect.suspend(() => {
						const next = waiting.get(id);
						if (next === undefined) {
							waiting.delete(id);
							return Effect.void;
						}
						waiting.set(id, undefined);
						return drain(id, next);
					})
				)
			);
		let through = yield* Clock.currentTimeMillis;
		yield* Effect.forkScoped(
			Effect.forever(
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis,
						minute = now - (now % MINUTE) + MINUTE;
					yield* Effect.sleep(minute - now);
					for (const { id, cron } of entries) {
						// `prev` is strict and slots fall on whole minutes: one second past finds this minute's own slot
						const slot = Cron.prev(cron, minute + 1000).getTime();
						if (slot <= through) continue;
						const at = new Date(slot).toISOString();
						if (waiting.has(id)) waiting.set(id, at);
						else {
							waiting.set(id, undefined);
							yield* FiberMap.run(running, id, drain(id, at));
						}
					}
					through = minute;
				})
			)
		);
	});
