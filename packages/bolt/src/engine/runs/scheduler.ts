// The in-process `deadlines` port (rule 52a) for bolt-server and the test kit, as a timekeeper:
// one next-due instant per scope in memory, one timer at the
// earliest, one wake lane; a wake's `settle` merges with announcements made while it ran. Nothing polls.
import type { DeadlinesPort } from '../contracts.ts';

/** Node's largest timer delay. */
const MAX_DELAY = 2_147_483_647;

export function inProcessDeadlines(wake: (scope: string) => Promise<void>, now: () => number = Date.now): DeadlinesPort & { stop(): void } {
	const held = new Map<string, number>();
	let active: { scope: string; answer?: number | null } | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const arm = (): void => {
		clearTimeout(timer);
		timer = undefined;
		if (stopped || active !== undefined || held.size === 0) return;
		const earliest = Math.min(...held.values());
		const delay = Math.max(0, earliest - now());
		timer = setTimeout(() => void (delay > MAX_DELAY ? arm() : drain()), Math.min(delay, MAX_DELAY));
		(timer as { unref?: () => void }).unref?.();
	};
	const drain = async (): Promise<void> => {
		const t = now();
		const due = [...held].filter(([, at]) => at <= t).sort(([, a], [, b]) => a - b)[0];
		if (due === undefined) return arm();
		held.delete(due[0]);
		active = { scope: due[0] };
		try {
			await wake(due[0]);
		} finally {
			const { scope, answer } = active;
			active = undefined;
			const announced = held.get(scope);
			const at = answer === undefined || answer === null ? announced : Math.min(answer, announced ?? Infinity);
			if (at === undefined) held.delete(scope); else held.set(scope, at);
			void drain();
		}
	};
	return {
		announce(scope, notLaterThan) {
			const at = Date.parse(notLaterThan);
			if ((held.get(scope) ?? Infinity) <= at) return;
			held.set(scope, at);
			arm();
		},
		settle(scope, nextDue) {
			const at = nextDue === null ? null : Date.parse(nextDue);
			if (active?.scope === scope) { active.answer = at; return; }
			if (at === null) held.delete(scope); else held.set(scope, at);
			arm();
		},
		teardown(scope) {
			held.delete(scope);
			arm();
		},
		stop() {
			stopped = true;
			clearTimeout(timer);
		},
	};
}
