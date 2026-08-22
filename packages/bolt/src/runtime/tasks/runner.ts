import { Clock, Effect } from 'effect';
import type {
	makeQueue,
	Outcome,
	Rejection,
	Statement,
	TaskRow
} from '#lib/runtime/tasks/queue.js';

/**
 * One tick: roll, take, run, finish, and say when to come back.
 *
 * This is the whole of the scheduler's control flow. It is Effect-native for exactly one reason —
 * running a task means running a *command*, and every command in this runtime is an Effect that
 * needs the invocation's services. A promise-shaped `run` would have to be handed a captured context
 * to provide, which is a bridge in the wrong direction and one more thing to get wrong. Being
 * generic over that requirement instead costs nothing: a test supplies a `run` needing no services,
 * and `dispatch` supplies one needing all of them.
 *
 * The queue below is Effect-native and remains a function of `execute` and nothing else, so tests
 * can still supply an in-memory executor without creating a host.
 */

/** How a task is actually executed. The runner never learns what a command means. */
export type Run<E, R> = (
	task: TaskRow,
	/**
	 * The effect id this attempt runs under: `<task effect id>:<attempt>`.
	 *
	 * Every facility is idempotent on `(scope, effectId)`, so an attempt that reused the previous
	 * attempt's id would be answered with the previous attempt's cached result — a retry that reports
	 * success while doing nothing. It is derived from the task's own key rather than from the
	 * invocation's, so attempt 2 carries the same id whichever host and whichever tick runs it.
	 */
	attemptEffectId: string
) => Effect.Effect<Outcome, E, R>;

export type TickReport = Readonly<{
	/** How many tasks this tick ran, whatever they came to. */
	readonly ran: number;
	/** How many due schedules became task rows. */
	readonly rolled: number;
	/** The next instant anything is due, or `undefined` when the workspace has nothing pending. */
	readonly nextDueAtEpochMs: number | undefined;
	/** Schedules that could not be read, so the caller can report them rather than swallow them. */
	readonly rejections: ReadonlyArray<Rejection>;
	/** Whether the tick declined to take work because it had too little time left to finish any. */
	readonly declined: boolean;
}>;

/**
 * The time a tick must have left before it is willing to take anything.
 *
 * Not a comfort margin — an attempt-burn guard. `take` increments `attempts` and hides the row for
 * the invocation's *remaining* time, and the runtime clamps a remaining deadline to at least one
 * millisecond (`runtime/app.ts`). So a tick that arrived already past its deadline would take a row,
 * hide it for a millisecond, be interrupted before running anything, and hand the row to the next
 * tick one attempt poorer. Repeat that and the whole attempt budget is spent in seconds on a task
 * nobody ever tried — which reads in the table as a flaky task and is nothing of the sort.
 *
 * The floor has two parts because the tick has two costs left when it decides. It still needs two
 * facility round trips — `take` and `finish` — and it has *already paid for one* in `roll`, so that
 * half is measured rather than guessed. The constant covers the only thing that cannot be measured
 * from in here: how long the command itself might run. Five seconds is a floor on that rather than an
 * estimate of it, and a task needing longer is not harmed, because the hide covers the whole
 * remaining deadline either way.
 */
const RUN_ALLOWANCE_MILLIS = 5_000;

type Tick = Readonly<{
	/** The instant the tick believes it is. Read only for cron arithmetic; due times come from SQL. */
	readonly nowEpochMs: number;
	/** How long this invocation has left. Both the hide interval and the floor above read it. */
	readonly remainingMillis: number;
}>;

export const makeRunner = <E, R, QE>(queue: ReturnType<typeof makeQueue<QE>>, run: Run<E, R>) => {
	/**
	 * Runs one tick to completion.
	 *
	 * The order is fixed and each step earns its place: `roll` first, so a schedule that comes due
	 * this instant is run by this tick rather than the next one — its insert and the take commit
	 * together; `finish` last, so the instant the host arms its timer to is read after everything this
	 * tick did.
	 *
	 * **Tasks are taken one at a time, and that is a decision rather than an oversight.** `take`
	 * spends an attempt and hides the row at the moment it hands it out, so a tick that took five rows
	 * and had time to run two would have spent three attempts on work nobody ever tried —
	 * indistinguishable, in the table, from three flaky tasks. One at a time costs one round trip per
	 * task, which is noise beside the task's own queries, and buys the invariant that *an attempt is
	 * only ever spent on an attempt*.
	 */
	const tick = (moment: Tick): Effect.Effect<TickReport, E | QE, R> =>
		Effect.gen(function* () {
			const startedAt = yield* Clock.currentTimeMillis;
			const rolled = yield* queue.roll(moment.nowEpochMs);
			// What one facility round trip costs, measured on the one this tick has already paid for.
			const roundTripMillis = Math.max(0, (yield* Clock.currentTimeMillis) - startedAt);
			const outcomes: Array<Outcome> = [];
			let pending: ReadonlyArray<Statement> = rolled.statements;
			let taken = 0;
			let declined = false;
			for (;;) {
				const remaining = moment.remainingMillis - ((yield* Clock.currentTimeMillis) - startedAt);
				if (remaining < RUN_ALLOWANCE_MILLIS + 2 * roundTripMillis) {
					declined = taken === 0;
					// `roll`'s writes still have to land even when nothing may be taken: a schedule that
					// advanced in memory and not on disk fires its next occurrence twice.
					if (pending.length > 0) {
						yield* queue.take(pending, { hideForMillis: 0, batchSize: 0 });
					}
					break;
				}
				const tasks = yield* queue.take(pending, { hideForMillis: remaining, batchSize: 1 });
				pending = [];
				const task = tasks[0];
				if (task === undefined) break;
				taken += 1;
				outcomes.push(yield* run(task, `${task.effectId}:${task.attempts}`));
			}
			const nextDueAtEpochMs = yield* queue.finish(outcomes);
			return {
				ran: outcomes.length,
				rolled: rolled.rolled,
				nextDueAtEpochMs,
				rejections: rolled.rejections,
				declined
			};
		});
	return { tick };
};
