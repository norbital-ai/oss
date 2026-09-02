import { makeTimekeeperCore } from '@norbital-ai/bolt-protocol';
import { Effect } from 'effect';

/**
 * One number and one timer — the whole of what a host owes the tenant's scheduler.
 *
 * A bolt does not have a clock that outlives an invocation: it is a bundle in a `vm` context with no
 * timer of its own that anybody will come back for. So the division is that the guest knows *what*
 * should happen and *when next*, and the host knows only the instant — it holds one, arms a timer to
 * it, and when it arrives it runs the tick `schedules.ts` owns. It never learns cron grammar and
 * never originates work, and the day it needs to, the seam has leaked.
 *
 * The instant, the overlap rule and the hop discipline are `makeTimekeeperCore` in
	 * `@norbital-ai/bolt-protocol`, shared verbatim with Colony's Timekeeper and proved in that
	 * package. What is left here is what a self-host alone owns: it serves exactly one
 * scope, it persists nothing (the tenant database is the only queue), and its backoff is its own.
 *
 * **A host with no timer still works.** Rows commit, schedules record, retries are scheduled. What
 * such a host loses is punctuality — nothing fires until somebody drives a tick. Durability and
 * punctuality are separate properties and only the second one needs this file.
 */

/** The single scope a self-host serves, named because the shared core is keyed for hosts that serve many. */
const SELF_SCOPE = 'self';

const DEFAULT_RETRY_AFTER_MILLIS = 60_000;

/** However long a host has been failing, it looks again at least this often. */
const MAX_FAILURE_BACKOFF_MILLIS = 3_600_000;

export type TimekeeperOptions<R = never, E = never> = Readonly<{
	/**
	 * Runs one tick and answers the next instant anything is due, or `null` for "nothing".
	 *
	 * The answer comes from the tick itself rather than from a query this module makes: the guest has
	 * just been in the database and knows, so asking again would be paying twice for one fact.
	 */
	readonly tick: () => Effect.Effect<number | null, E, R>;
	/**
	 * Process edge that executes one tick Effect. The timer callback is not itself an Effect
	 * runtime, so this is where a host attaches its ManagedRuntime (or `Effect.runPromise`).
	 */
	readonly run: <A, E>(effect: Effect.Effect<A, E, R>) => Promise<A>;
	/** Reports a tick that failed. A tick is background work with nobody waiting, so silence is loss. */
	readonly onFailure: (cause: unknown) => void;
	/**
	 * How long after a failed tick to try again.
	 *
	 * A failure here is the host's, not the task's — the database was unreachable, the bundle would
	 * not load — so the tasks themselves have taken no attempt and lost nothing. What must not happen
	 * is a tight retry against something that is down, so a failed tick re-arms on this rather than on
	 * whatever it failed to read.
	 */
	readonly retryAfterMillis?: number;
	/**
	 * The host's clock, injected so the failure backoff is deterministic under a test clock.
	 */
	readonly nowMillis?: () => number;
}>;

export type Timekeeper = Readonly<{
	/**
	 * "Come back no later than this instant."
	 *
	 * Earliest wins, and a later instant is ignored — which is what keeps a workspace whose next job
	 * is tomorrow morning from re-arming on every write it serves in between. The guest sends this
	 * unconditionally, because it cannot see what this holds and finding out would cost a round trip
	 * to learn something that can be decided here for free.
	 */
	readonly announce: (notLaterThanEpochMs: number) => void;
	/**
	 * "Here is when anything is next due, as of now."
	 *
	 * Replaces rather than lowers, because this is the authoritative answer from the party that just
	 * read both tables — including the answer "nothing", which disarms the timer entirely. That is the
	 * state an idle workspace spends almost all of its life in, and it has to cost nothing: no
	 * heartbeat, no minimum interval, no liveness probe.
	 */
	readonly settle: (nextDueAtEpochMs: number | null) => void;
	/** The instant currently armed, or `undefined`. For tests and for reporting; nothing depends on it. */
	readonly armedFor: () => number | undefined;
	readonly stop: () => void;
}>;

export const makeTimekeeper = <R = never, E = never>(
	options: TimekeeperOptions<R, E>
): Timekeeper => {
	const retryAfterMillis = options.retryAfterMillis ?? DEFAULT_RETRY_AFTER_MILLIS;
	const nowMillis = options.nowMillis ?? Date.now;
	/**
	 * How many ticks in a row have failed, which is this host's own backoff and not the queue's.
	 *
	 * The queue's backoff lives inside the guest, on the task rows — so it is precisely unreachable
	 * when the guest is what is broken. A bundle that will not boot or a database that will not answer
	 * gives this side no `nextDueAt` at all, and re-arming to the instant it failed at produces
	 * tick → fail → re-arm → tick with no gap. Consecutive failures widen the gap; one success
	 * clears it.
	 */
	let consecutiveFailures = 0;

	const core = makeTimekeeperCore<string>({
		nowMillis,
		onDue: () => fire()
	});

	/** Resolves one finished tick, merging whatever was announced while it ran, and re-arms. */
	const resolve = (callbackAtEpochMs: number | null, mergeAnnouncements: boolean) => {
		core.complete({
			callbackAtEpochMs,
			mergeAnnouncements
		});
		core.arm();
	};

	const fire = () => {
		const entry = core.takeDue(nowMillis());
		if (entry === undefined) return core.arm();
		void options.run(
			Effect.map(options.tick(), (nextDueAtEpochMs) => {
				consecutiveFailures = 0;
				resolve(nextDueAtEpochMs, true);
			}).pipe(
				Effect.catch((cause) =>
					Effect.sync(() => {
						consecutiveFailures += 1;
						options.onFailure(cause);
						// Capped exponential host backoff; an earlier concurrent wake still wins.
						const backoff = Math.min(
							retryAfterMillis * 2 ** Math.min(consecutiveFailures - 1, 5),
							MAX_FAILURE_BACKOFF_MILLIS
						);
						resolve(nowMillis() + backoff, false);
					})
				)
			)
		);
	};

	return {
		announce: (notLaterThanEpochMs) => {
			if (!core.announce(SELF_SCOPE, SELF_SCOPE, notLaterThanEpochMs)) return;
			core.arm();
		},
		settle: (nextDueAtEpochMs) => {
			core.settle(SELF_SCOPE, SELF_SCOPE, nextDueAtEpochMs);
			core.arm();
		},
		armedFor: () => core.armedFor(),
		stop: () => core.stop()
	};
};
