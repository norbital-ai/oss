import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	makeTimekeeperCore,
	MAX_TIMEKEEPER_TIMEOUT_MILLIS
} from '../src/timekeeper-contract.js';

type CapturedTimer = Readonly<{
	readonly callback: () => void;
	readonly delay: number;
	readonly handle: { readonly unref: ReturnType<typeof vi.fn> };
}>;

const captureTimers = () => {
	const active = new Map<object, CapturedTimer>();
	vi.stubGlobal('setTimeout', (callback: () => void, delay = 0) => {
		const handle = { unref: vi.fn() };
		active.set(handle, { callback, delay, handle });
		return handle;
	});
	vi.stubGlobal('clearTimeout', (handle: object) => active.delete(handle));
	return {
		active: () => [...active.values()],
		fire: (timer: CapturedTimer) => {
			active.delete(timer.handle);
			timer.callback();
		}
	};
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('Timekeeper core', () => {
	it('owns no idle timer and serves long waits as one unrefed timer in bounded hops', () => {
		let now = 1_000;
		const timers = captureTimers();
		const onDue = vi.fn();
		const core = makeTimekeeperCore<string>({ nowMillis: () => now, onDue });
		core.arm();
		expect(timers.active()).toEqual([]);

		const dueAt = now + 30 * 24 * 60 * 60 * 1_000;
		expect(core.announce('monthly', 'monthly', dueAt)).toBe(true);
		core.arm();
		const first = timers.active()[0];
		expect(timers.active()).toHaveLength(1);
		expect(first?.delay).toBe(MAX_TIMEKEEPER_TIMEOUT_MILLIS);
		expect(first?.handle.unref).toHaveBeenCalledOnce();

		now += MAX_TIMEKEEPER_TIMEOUT_MILLIS;
		if (first !== undefined) timers.fire(first);
		expect(onDue).not.toHaveBeenCalled();
		expect(timers.active()[0]?.delay).toBe(dueAt - now);
		expect(timers.active()[0]?.handle.unref).toHaveBeenCalledOnce();
	});

	it('keeps the earliest announcement and lets authoritative settlement replace it', () => {
		const timers = captureTimers();
		const core = makeTimekeeperCore<string>({ nowMillis: () => 0, onDue: () => {} });
		expect(core.announce('scope', 'scope', 60_000)).toBe(true);
		expect(core.announce('scope', 'scope', 90_000)).toBe(false);
		expect(core.announce('scope', 'scope', 30_000)).toBe(true);
		core.arm();
		expect(timers.active()[0]?.delay).toBe(30_000);
		core.settle('scope', 'scope', 120_000);
		core.arm();
		expect(timers.active()[0]?.delay).toBe(120_000);
		core.settle('scope', 'scope', null);
		core.arm();
		expect(timers.active()).toEqual([]);
	});

	it('atomically owns one callback lane and merges announcements made during success', () => {
		captureTimers();
		const core = makeTimekeeperCore<string>({ nowMillis: () => 100, onDue: () => {} });
		core.announce('first', 'first', 100);
		core.announce('second', 'second', 100);
		const first = core.takeDue(100);
		expect(first?.key).toBe('first');
		expect(core.takeDue(100)).toBeUndefined();
		core.announce('first', 'first', 130);
		expect(
			core.complete({ callbackAtEpochMs: 140, mergeAnnouncements: true })
		).toEqual({ subject: 'first', at: 130, stale: false });
		expect(core.takeDue(100)?.key).toBe('second');
	});

	it('lets failure backoff replace a racing announcement and retirement fence an active answer', () => {
		captureTimers();
		const core = makeTimekeeperCore<string>({ nowMillis: () => 100, onDue: () => {} });
		core.announce('failed', 'failed', 100);
		core.takeDue(100);
		core.announce('failed', 'failed', 90);
		expect(
			core.complete({ callbackAtEpochMs: 500, mergeAnnouncements: false })
		).toEqual({ subject: 'failed', at: 500, stale: false });

		core.settle('failed', 'failed', 100);
		core.takeDue(100);
		expect(core.retire('failed')).toBe(false);
		expect(
			core.complete({ callbackAtEpochMs: 600, mergeAnnouncements: true })
		).toEqual({ subject: 'failed', at: undefined, stale: true });
		expect(core.takeDue(1_000)).toBeUndefined();
	});
});
