import { cronMatches, parseCron, type CronSchedule } from './cron.js';
import type { HostQueue, QueueJob } from './types.js';

export type IntervalQueueOptions = {
	/** How often to sweep, in milliseconds. Defaults to 30s; floored at 1s. */
	readonly intervalMs?: number;
	readonly log?: (message: string) => void;
};

/**
 * An in-process queue backed by a timer. Development and single-process deployments only.
 *
 * It satisfies the `queue` facility but provides none of the guarantees a real queue does: nothing
 * survives a restart, a missed schedule is never caught up, and two processes running this against
 * one database will both claim. Those are acceptable for `pod dev` and a single-container
 * deployment, and unacceptable for anything that must not drop work — point `queue` at pg-boss or
 * an equivalent there.
 *
 * Naming it, rather than defaulting to it, is the point: a deployment that is running on a timer
 * says so in its own `pod.host.ts`.
 *
 * Scheduling is minute-granular and non-catch-up: each job records the minute it last ran in, and a
 * matching minute runs at most once. A host that was asleep does not retroactively fire the
 * schedules it missed — a cron job that fires forty times on resume is worse than one that skipped,
 * and the runtime records every run in `automation_run` either way.
 */
export function intervalQueue(options: IntervalQueueOptions = {}): HostQueue {
	const log = options.log ?? ((message: string) => console.log(message));
	const intervalMs = Math.max(options.intervalMs ?? 30_000, 1000);

	return async (jobs) => {
		if (jobs.length === 0) return () => {};

		const cron = new Map<string, CronSchedule>();
		for (const job of jobs) {
			if (job.schedule !== 'continuous') cron.set(job.name, parseCron(job.schedule));
		}

		const lastRunMinute = new Map<string, number>();
		const inFlight = new Set<string>();
		let sweeping = false;

		const runJob = (job: QueueJob): void => {
			// The contract is that one job name never overlaps itself; a slow drain must not be
			// started again while it is still settling rows.
			if (inFlight.has(job.name)) return;
			inFlight.add(job.name);
			void job
				.run()
				.catch((cause: unknown) => {
					log(
						`[pod:queue] job "${job.name}" failed: ${
							cause instanceof Error ? cause.message : String(cause)
						}`
					);
				})
				.finally(() => inFlight.delete(job.name));
		};

		const sweep = (): void => {
			if (sweeping) return;
			sweeping = true;
			try {
				const now = new Date();
				// Identify the minute by epoch-minute so a schedule cannot fire twice within it, and so
				// the comparison stays correct across an hour or day boundary.
				const minuteKey = Math.floor(now.getTime() / 60_000);
				for (const job of jobs) {
					const schedule = cron.get(job.name);
					if (!schedule) {
						runJob(job);
						continue;
					}
					if (!cronMatches(schedule, now)) continue;
					if (lastRunMinute.get(job.name) === minuteKey) continue;
					lastRunMinute.set(job.name, minuteKey);
					runJob(job);
				}
			} finally {
				sweeping = false;
			}
		};

		const timer = setInterval(sweep, intervalMs);
		// The sweep must never be the reason the process stays alive; the HTTP server owns that.
		timer.unref();
		sweep();

		log(`[pod:queue] interval queue started (${jobs.length} job(s), every ${intervalMs}ms)`);
		return () => clearInterval(timer);
	};
}
