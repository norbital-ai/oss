/**
 * The host-neutral instant-and-timer discipline shared by Colony and bolt-server.
 *
 * A host holds one instant per scope and one timer over the earliest. It never polls: boot restore,
 * announcements, and callback answers are the only inputs. The core also owns the single callback
 * lane, so adapters do not need a second overlap protocol.
 */

/** The largest delay Node's signed 32-bit timer can represent without wrapping. */
export const MAX_TIMEKEEPER_TIMEOUT_MILLIS = 2_147_483_647;

interface TimekeeperTimerHandle {
	readonly unref?: () => void;
}

declare function setTimeout(callback: () => void, delayMillis: number): TimekeeperTimerHandle;
declare function clearTimeout(handle: TimekeeperTimerHandle): void;

export interface TimekeeperHost {
	readonly nowMillis: () => number;
	readonly onDue: () => void;
}

export interface TimekeeperEntry<Subject> {
	readonly key: string;
	readonly subject: Subject;
	readonly at: number;
}

export interface TimekeeperCompletion {
	readonly callbackAtEpochMs: number | null | undefined;
	/** Success merges its answer with announcements made while it ran; failure backoff replaces them. */
	readonly mergeAnnouncements: boolean;
}

export interface TimekeeperResolution<Subject> {
	readonly subject: Subject;
	readonly at: number | undefined;
	/** Retirement or stop overtook the callback, so its answer must not be persisted. */
	readonly stale: boolean;
}

export interface TimekeeperCore<Subject> {
	/** Records an earlier instant and reports whether anything changed. */
	readonly announce: (key: string, subject: Subject, notLaterThanEpochMs: number) => boolean;
	/** Replaces one scope's instant with an authoritative answer; `null` removes it. */
	readonly settle: (key: string, subject: Subject, nextDueAtEpochMs: number | null) => void;
	/** Removes one scope and fences its callback, if active. `true` means there is none to drain. */
	readonly retire: (key: string) => boolean;
	/** Merges durable boot state without replacing newer memory or an active callback. */
	readonly restore: (
		entries: Iterable<Readonly<{ key: string; subject: Subject; at: number }>>
	) => void;
	/** Atomically takes the earliest due entry if the one callback lane is idle. */
	readonly takeDue: (nowMillis: number) => TimekeeperEntry<Subject> | undefined;
	/** Releases the callback lane and resolves the callback/announcement race. */
	readonly complete: (completion: TimekeeperCompletion) => TimekeeperResolution<Subject>;
	readonly armedFor: () => number | undefined;
	readonly arm: () => void;
	readonly stop: () => void;
}

export const makeTimekeeperCore = <Subject>(host: TimekeeperHost): TimekeeperCore<Subject> => {
	const held = new Map<string, { subject: Subject; at: number }>();
	let active: { entry: TimekeeperEntry<Subject>; retired: boolean } | undefined;
	let timer: TimekeeperTimerHandle | undefined;
	let nextTimerAt: number | undefined;
	let stopped = false;

	const disarm = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		nextTimerAt = undefined;
	};

	const arm = (): void => {
		disarm();
		if (stopped || active !== undefined) return;
		let earliest: number | undefined;
		for (const entry of held.values())
			if (earliest === undefined || entry.at < earliest) earliest = entry.at;
		if (earliest === undefined) return;

		const delay = Math.max(0, earliest - host.nowMillis());
		let handle: TimekeeperTimerHandle | undefined;
		handle = setTimeout(
			() => {
				if (timer === handle) {
					timer = undefined;
					nextTimerAt = undefined;
				}
				if (delay > MAX_TIMEKEEPER_TIMEOUT_MILLIS) arm();
				else host.onDue();
			},
			Math.min(delay, MAX_TIMEKEEPER_TIMEOUT_MILLIS)
		);
		handle.unref?.();
		timer = handle;
		nextTimerAt = earliest;
	};

	return {
		announce: (key, subject, at) => {
			if (stopped) return false;
			const current = held.get(key);
			if (current !== undefined && current.at <= at) return false;
			held.set(key, { subject, at });
			return true;
		},
		settle: (key, subject, at) => {
			if (stopped) return;
			if (at === null) held.delete(key);
			else held.set(key, { subject, at });
		},
		retire: (key) => {
			held.delete(key);
			if (active?.entry.key !== key) return true;
			active.retired = true;
			return false;
		},
		restore: (entries) => {
			for (const entry of entries) {
				if (held.has(entry.key) || active?.entry.key === entry.key) continue;
				held.set(entry.key, { subject: entry.subject, at: entry.at });
			}
		},
		takeDue: (nowMillis) => {
			if (stopped || active !== undefined) return undefined;
			let taken: TimekeeperEntry<Subject> | undefined;
			for (const [key, entry] of held) {
				if (entry.at > nowMillis || (taken !== undefined && taken.at <= entry.at)) continue;
				taken = { key, subject: entry.subject, at: entry.at };
			}
			if (taken === undefined) return undefined;
			disarm();
			held.delete(taken.key);
			active = { entry: taken, retired: false };
			return taken;
		},
		complete: (completion) => {
			if (active === undefined) throw new Error('Timekeeper callback lane is idle');
			const { entry, retired } = active;
			const callbackAt =
				typeof completion.callbackAtEpochMs === 'number' &&
				Number.isFinite(completion.callbackAtEpochMs)
					? completion.callbackAtEpochMs
					: undefined;
			const announced = held.get(entry.key)?.at;
			const at = completion.mergeAnnouncements
				? callbackAt === undefined
					? announced
					: announced === undefined
						? callbackAt
						: Math.min(callbackAt, announced)
				: callbackAt;
			const stale = stopped || retired;
			if (!stale) {
				if (at === undefined) held.delete(entry.key);
				else held.set(entry.key, { subject: entry.subject, at });
			}
			active = undefined;
			return { subject: entry.subject, at: stale ? undefined : at, stale };
		},
		armedFor: () => nextTimerAt,
		arm,
		stop: () => {
			stopped = true;
			disarm();
		}
	};
};
