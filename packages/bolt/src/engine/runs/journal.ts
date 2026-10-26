// A run's journal (compute model §3 "Durable steps"): the answers of its AI, infer and HTTP calls and infer's own steps,
// kept by the host outside the tenant database so a journal never wakes it. Keyed by the run; a cron's run id is its
// slot's digest, so a slot's journal is the run's. Side effects stay in the tenant database (`bolt_idem`), committed
// with their write.
import { Context, Effect, Schema } from 'effect';
import type { BoltError } from '../../protocol/errors.ts';

/** One journalled answer: `key` is the call's (`<run>:<digest>:<ordinal>`, or an infer step's under it). */
export const JournalEntry = Schema.Struct({
	key: Schema.String,
	/** The attempt that wrote it: a failed answer replays only within its own attempt. */
	attempt: Schema.Int,
	answer: Schema.Json
});
export type JournalEntry = typeof JournalEntry.Type;
/**
 * HOST_API: the host's journals of one environment's runs. `write` keeps an attempt's first entry per `(run, key)`
 * (a later attempt's replaces it: that attempt asked again); past the host's caps it rejects with an encoded
 * `HostFailure` of code `journalFull`. `clear` deletes the run's journal once it completed (idempotent).
 */
export interface JournalPort {
	read(run: string, signal: AbortSignal): Promise<readonly JournalEntry[]>;
	write(run: string, entry: JournalEntry, signal: AbortSignal): Promise<void>;
	clear(run: string, signal: AbortSignal): Promise<void>;
}
export class RunJournal extends Context.Service<
	RunJournal,
	{
		readonly read: (run: string) => Effect.Effect<readonly JournalEntry[], BoltError>;
		readonly write: (run: string, entry: JournalEntry) => Effect.Effect<void, BoltError>;
		readonly clear: (run: string) => Effect.Effect<void, BoltError>;
	}
>()('bolt/RunJournal') {
	/**
	 * A host without a control store (`bolt dev`, the kit) journals in the generation's memory: a park or a retry in
	 * the same process replays; a lost process runs its calls again.
	 */
	static readonly memory = Effect.sync(() => {
		const runs = new Map<string, Map<string, JournalEntry>>();
		return RunJournal.of({
			read: (run) => Effect.sync(() => [...(runs.get(run)?.values() ?? [])]),
			write: (run, entry) =>
				Effect.sync(() => {
					let held = runs.get(run);
					if (held === undefined) runs.set(run, (held = new Map()));
					if (held.get(entry.key)?.attempt !== entry.attempt) held.set(entry.key, entry);
				}),
			clear: (run) =>
				Effect.sync(() => {
					runs.delete(run);
				})
		});
	});
}
