/**
 * One number and one timer — the whole of what a host owes the tenant's scheduler.
 *
 * A bolt does not have a clock that outlives an invocation: it is a bundle in a `vm` context with no
 * timer of its own that anybody will come back for. So the division is that the guest knows *what*
 * should happen and *when next*, and the host knows only the instant — it holds one, arms a timer to
 * it, and invokes `tasks.tick` when it arrives. It never learns cron grammar, command names, or the
 * shape of either table, and the day it needs to, the seam has leaked.
 *
 * **Why a re-armed one-shot and not a sweep.** A sweep asks "is anything due?" on a fixed period,
 * which means asking a database that is asleep, on a period short enough to be punctual — and a
 * serverless Postgres that is asked anything every thirty seconds never suspends, so an idle
 * workspace bills continuously. This asks nothing. It holds a number in memory, refreshed only as
 * the return value of work that was already touching the database, and between two instants it makes
 * no queries at all. That is the entire cost argument, and it is why the timer is here rather than a
 * loop somewhere.
 *
 * **A host with no timer still works.** Rows commit, schedules record, retries are scheduled. What
 * such a host loses is punctuality — nothing fires until somebody invokes `tasks.tick`. Durability
 * and punctuality are separate properties and only the second one needs this file.
 */

export type SchedulerOptions = Readonly<{
	/**
	 * Runs one tick and answers the next instant anything is due, or `null` for "nothing".
	 *
	 * The answer comes from the tick itself rather than from a query this module makes: the guest has
	 * just been in the database and knows, so asking again would be paying twice for one fact.
	 */
	readonly tick: () => Promise<number | null>;
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
}>;

export type Scheduler = Readonly<{
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

const DEFAULT_RETRY_AFTER_MILLIS = 60_000;

/** However long a host has been failing, it looks again at least this often. */
const MAX_FAILURE_BACKOFF_MILLIS = 3_600_000;

/**
 * `setTimeout` cannot be trusted past this, so a longer wait is served in hops.
 *
 * Node stores a timer's delay in a signed 32-bit integer, and a delay above 2^31−1 milliseconds
 * (about 24.9 days) overflows to *one millisecond* — it fires immediately, repeatedly. A monthly
 * cron is an ordinary thing for a workspace to declare, so this is reachable rather than theoretical,
 * and the failure it would produce is a tight loop rather than a late job.
 */
const MAX_TIMEOUT_MILLIS = 2_147_483_647;

export const makeScheduler = (options: SchedulerOptions): Scheduler => {
	const retryAfterMillis = options.retryAfterMillis ?? DEFAULT_RETRY_AFTER_MILLIS;
	let armedFor: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let running = false;
	/**
	 * The earliest instant announced while a tick was in flight, if any.
	 *
	 * A tick reads "when is anything next due?" at some instant and then returns; a `Wake` arriving
	 * after that read but before the answer lands names work the tick could not have seen. Arming to
	 * the answer alone would drop it until something unrelated woke the tenant — durable, correct, and
	 * silently late, which is the failure this whole design exists to avoid.
	 *
	 * Kept as a value rather than a flag so the two can be combined. Taking the *minimum* of the
	 * tick's answer and this, rather than letting the announcement win outright, is what stops the
	 * host relying on the guest's earlier-only discipline for its own correctness: an announcement
	 * should never be later than the answer, but a restart on either side can diverge them.
	 */
	let announcedDuringRun: number | undefined;
	/**
	 * How many ticks in a row have failed, which is the host's own backoff and not the queue's.
	 *
	 * The queue's backoff lives inside the guest, on the task rows — so it is precisely unreachable
	 * when the guest is what is broken. A bundle that will not boot or a database that will not answer
	 * gives this side no `nextDueAt` at all, and re-arming to the instant it failed at produces
	 * tick → fail → re-arm → tick with no gap. Consecutive failures widen the gap; one success
	 * clears it.
	 */
	let consecutiveFailures = 0;
	let stopped = false;

	const disarm = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};

	const arm = (instant: number | undefined) => {
		disarm();
		armedFor = instant;
		if (stopped || instant === undefined) return;
		const delay = Math.max(0, instant - Date.now());
		timer = setTimeout(
			delay > MAX_TIMEOUT_MILLIS ? () => arm(instant) : fire,
			Math.min(delay, MAX_TIMEOUT_MILLIS)
		);
		// A timer is not a reason to hold the process open. Everything durable is already in the
		// database, so a server told to exit should exit rather than wait for a nightly digest.
		timer.unref?.();
	};

	/** The earliest of what the tick said and what was announced while it ran. */
	const earliest = (answer: number | undefined): number | undefined => {
		if (announcedDuringRun === undefined) return answer;
		return answer === undefined ? announcedDuringRun : Math.min(answer, announcedDuringRun);
	};

	const fire = () => {
		if (stopped || running) return;
		running = true;
		announcedDuringRun = undefined;
		armedFor = undefined;
		void options
			.tick()
			.then((nextDueAtEpochMs) => {
				running = false;
				consecutiveFailures = 0;
				// `null` means nothing is pending, and the answer to that is to arm no timer at all — not
				// to arm one far out. A far-future sentinel is how the 32-bit overflow above gets
				// reintroduced by someone who has forgotten it exists. A scope with nothing pending comes
				// back on the next `Wake`, the next boot, or a rescan.
				arm(earliest(nextDueAtEpochMs === null ? undefined : nextDueAtEpochMs));
			})
			.catch((cause: unknown) => {
				running = false;
				consecutiveFailures += 1;
				options.onFailure(cause);
				// Exponential in the number of consecutive failures, capped, so a host that cannot reach
				// its own database backs off instead of hammering it — and so a genuinely due job is not
				// abandoned either. An announcement that arrived meanwhile still wins if it is earlier.
				const backoff = Math.min(
					retryAfterMillis * 2 ** Math.min(consecutiveFailures - 1, 5),
					MAX_FAILURE_BACKOFF_MILLIS
				);
				arm(earliest(Date.now() + backoff));
			});
	};

	return {
		announce: (notLaterThanEpochMs) => {
			if (stopped) return;
			if (running) {
				// Remembered rather than armed, because the tick in flight is about to answer and the two
				// are combined then. Arming here would be overwritten by that answer.
				announcedDuringRun =
					announcedDuringRun === undefined
						? notLaterThanEpochMs
						: Math.min(announcedDuringRun, notLaterThanEpochMs);
				return;
			}
			if (armedFor !== undefined && armedFor <= notLaterThanEpochMs) return;
			arm(notLaterThanEpochMs);
		},
		settle: (nextDueAtEpochMs) => {
			if (stopped) return;
			arm(nextDueAtEpochMs === null ? undefined : nextDueAtEpochMs);
		},
		armedFor: () => armedFor,
		stop: () => {
			stopped = true;
			disarm();
		}
	};
};
