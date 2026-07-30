import { describe, expect, it } from 'vitest';
import { assertSystemEventsAreReachable } from '../../src/lib/authoring/workspace/define-workspace.js';

/**
 * The two halves of a system-event integration are matched by exact string at dispatch, so a typo on
 * either side produced no matching bindings, no error, and no record — the integration simply never
 * fired. Startup is where that becomes visible.
 */
describe('system event reachability', () => {
	const receive = (event: string) => ({
		direction: 'receive' as const,
		collection: 'quotes',
		systemEvent: event
	});

	it('accepts a receiver whose event some sender emits', () => {
		expect(() =>
			assertSystemEventsAreReachable(
				{ 'billing:quotes.receive.confirmed': receive('quote.confirmed') },
				new Set(['quote.confirmed'])
			)
		).not.toThrow();
	});

	it('refuses a receiver waiting on an event nothing emits, and names the alternatives', () => {
		expect(() =>
			assertSystemEventsAreReachable(
				{ 'billing:quotes.receive.confirmed': receive('quote.confirmedd') },
				new Set(['quote.confirmed', 'quote.rejected'])
			)
		).toThrow(/quote\.confirmedd.*no send binding emits.*quote\.confirmed, quote\.rejected/s);
	});

	it('says so plainly when the workspace declares no events at all', () => {
		expect(() =>
			assertSystemEventsAreReachable(
				{ 'billing:quotes.receive.confirmed': receive('quote.confirmed') },
				new Set()
			)
		).toThrow(/No events are declared/);
	});

	/** A receive binding driven by a webhook or a pull has no `systemEvent` and must not be flagged. */
	it('ignores receivers that are not system-event driven', () => {
		expect(() =>
			assertSystemEventsAreReachable(
				{ 'billing:quotes.receive.hook': { direction: 'receive', collection: 'quotes' } },
				new Set()
			)
		).not.toThrow();
	});
});
