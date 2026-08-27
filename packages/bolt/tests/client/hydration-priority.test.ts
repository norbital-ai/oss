import { describe, expect, it } from 'vitest';
import { createHydrationPriorityScheduler } from '../../src/client/replica/hydration-priority.js';

describe('replica hydration priority', () => {
	it('requires explicit visible-route evidence for priority zero', () => {
		const scheduler = createHydrationPriorityScheduler();
		const mounted = scheduler.mount({ ownerId: 'route:jobs', queryKey: 'jobs' });
		expect(scheduler.snapshot()).toEqual([
			{ queryKey: 'jobs', priority: 1, reasons: ['mounted'], lastAccess: null }
		]);

		mounted.setVisibility('visible');
		expect(scheduler.snapshot()[0]).toMatchObject({ priority: 0, reasons: ['visible'] });
		mounted.setVisibility('hidden');
		expect(scheduler.snapshot()[0]).toMatchObject({ priority: 1, reasons: ['mounted'] });

		mounted.release();
		mounted.release();
		expect(scheduler.snapshot()).toEqual([]);
	});

	it('fences stale owner handles when a key is replaced', () => {
		const scheduler = createHydrationPriorityScheduler();
		const old = scheduler.mount({ ownerId: 'route', queryKey: 'old', visibility: 'visible' });
		const current = scheduler.mount({ ownerId: 'route', queryKey: 'current' });

		old.setVisibility('visible');
		old.release();
		expect(scheduler.snapshot()).toEqual([
			{ queryKey: 'current', priority: 1, reasons: ['mounted'], lastAccess: null }
		]);

		current.release();
		expect(scheduler.snapshot()).toEqual([]);
	});

	it('promotes relation and adjacent work only with concrete query-key evidence', () => {
		const scheduler = createHydrationPriorityScheduler({ now: () => 10 });
		scheduler.retain({
			ownerId: 'relation:proven',
			queryKey: 'shared',
			reason: 'relation-dependency',
			queryKeyEvidence: 'concrete'
		});
		scheduler.retain({
			ownerId: 'adjacent:proven',
			queryKey: 'adjacent',
			reason: 'adjacent',
			queryKeyEvidence: 'concrete'
		});
		scheduler.retain({
			ownerId: 'adjacent:unknown',
			queryKey: 'unknown',
			reason: 'adjacent'
		});
		scheduler.noteRecent({ queryKey: 'shared', lastAccess: 10 });

		expect(scheduler.snapshot(10)).toEqual([
			{
				queryKey: 'shared',
				priority: 1,
				reasons: ['relation-dependency', 'recent'],
				lastAccess: 10
			},
			{
				queryKey: 'adjacent',
				priority: 1,
				reasons: ['adjacent'],
				lastAccess: null
			},
			{
				queryKey: 'unknown',
				priority: 2,
				reasons: ['adjacent'],
				lastAccess: null
			}
		]);
	});

	it('bounds recent retained work by age and deterministic LRU admission', () => {
		let now = 10_000;
		const scheduler = createHydrationPriorityScheduler({
			now: () => now,
			recentMaxAgeMillis: 1_000,
			maxRecentWindows: 2
		});
		scheduler.noteRecent({ queryKey: 'expired', lastAccess: 8_999 });
		scheduler.noteRecent({ queryKey: 'beta', lastAccess: 9_900 });
		scheduler.noteRecent({ queryKey: 'alpha', lastAccess: 9_900 });
		scheduler.noteRecent({ queryKey: 'newest', lastAccess: 9_950 });

		expect(scheduler.snapshot()).toEqual([
			{ queryKey: 'newest', priority: 2, reasons: ['recent'], lastAccess: 9_950 },
			{ queryKey: 'alpha', priority: 2, reasons: ['recent'], lastAccess: 9_900 }
		]);

		now = 11_001;
		expect(scheduler.snapshot()).toEqual([]);
	});
});
