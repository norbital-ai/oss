import { describe, expect, it } from 'vitest';
import { Cron } from '../../src/runtime/tasks/cron.js';

/**
 * The parser is hand-written, so this is the whole of its warrant.
 *
 * Every case states an instant rather than a duration: `nextRunAfter` is the only thing `roll` asks
 * it, and a table of expected UTC instants is checkable by hand in a way that "advances by an hour"
 * is not.
 */
const at = (iso: string): number => Date.parse(iso);

/** Reads the next instant, failing the test rather than returning a fallback when it is rejected. */
const next = (expression: string, after: string): string => {
	const outcome = Cron.nextRunAfter(expression, at(after));
	if (outcome._tag === 'Rejected') throw new Error(`rejected: ${outcome.reason}`);
	return new Date(outcome.epochMs).toISOString();
};

const rejection = (expression: string): string => {
	const outcome = Cron.nextRunAfter(expression, at('2026-08-18T00:00:00.000Z'));
	if (outcome._tag === 'Next') throw new Error(`expected a rejection, got ${outcome.epochMs}`);
	return outcome.reason;
};

describe('cron', () => {
	it('answers the next instant for the schedules a manifest actually declares', () => {
		// The CRM template's three bindings all carry this one.
		expect(next('15 * * * *', '2026-08-18T04:00:00.000Z')).toBe('2026-08-18T04:15:00.000Z');
		expect(next('15 * * * *', '2026-08-18T04:15:00.000Z')).toBe('2026-08-18T05:15:00.000Z');
		expect(next('15 * * * *', '2026-08-18T04:59:59.999Z')).toBe('2026-08-18T05:15:00.000Z');
		expect(next('0 * * * *', '2026-08-18T23:30:00.000Z')).toBe('2026-08-19T00:00:00.000Z');
		expect(next('0 6 * * *', '2026-08-18T06:00:00.000Z')).toBe('2026-08-19T06:00:00.000Z');
		expect(next('0 3 * * 1', '2026-08-18T00:00:00.000Z')).toBe('2026-08-24T03:00:00.000Z');
	});

	it('is strictly after the instant it is given, so one slot cannot fire twice', () => {
		// The same due time asked twice must move on. Were this `>=`, `settle` would rewrite an
		// entry's next run to the run that just happened and the sweep would fire it again forever.
		const due = at('2026-08-18T04:15:00.000Z');
		const first = Cron.nextRunAfter('15 * * * *', due);
		expect(first).toEqual({ _tag: 'Next', epochMs: at('2026-08-18T05:15:00.000Z') });
	});

	it('skips missed occurrences rather than queueing them', () => {
		// A host down from 04:20 to 07:40 owes one run, not three: the next instant is computed from
		// now, never from the slot that was missed.
		expect(next('15 * * * *', '2026-08-18T07:40:00.000Z')).toBe('2026-08-18T08:15:00.000Z');
	});

	it('expands steps, ranges, and lists', () => {
		expect(next('*/15 * * * *', '2026-08-18T04:02:00.000Z')).toBe('2026-08-18T04:15:00.000Z');
		expect(next('0 9-17 * * *', '2026-08-18T18:30:00.000Z')).toBe('2026-08-19T09:00:00.000Z');
		expect(next('0 0 1,15 * *', '2026-08-18T00:00:00.000Z')).toBe('2026-09-01T00:00:00.000Z');
		expect(next('30 8/6 * * *', '2026-08-18T09:00:00.000Z')).toBe('2026-08-18T14:30:00.000Z');
		expect(next('0 0 1 1 *', '2026-08-18T00:00:00.000Z')).toBe('2027-01-01T00:00:00.000Z');
	});

	it('takes 0 and 7 as the same Sunday', () => {
		expect(next('0 0 * * 0', '2026-08-18T00:00:00.000Z')).toBe(
			next('0 0 * * 7', '2026-08-18T00:00:00.000Z')
		);
	});

	it('unions the two day fields when both are restricted, and intersects neither', () => {
		// The classic Vixie rule. `0 0 1 * 1` is the first of the month *or* any Monday.
		expect(next('0 0 1 * 1', '2026-08-18T00:00:00.000Z')).toBe('2026-08-24T00:00:00.000Z');
		expect(next('0 0 1 * 1', '2026-08-25T00:00:00.000Z')).toBe('2026-08-31T00:00:00.000Z');
		// With only day-of-month restricted, weekday is ignored entirely.
		expect(next('0 0 1 * *', '2026-08-25T00:00:00.000Z')).toBe('2026-09-01T00:00:00.000Z');
	});

	it('crosses a leap day without losing a beat', () => {
		expect(next('0 0 * * *', '2028-02-28T12:00:00.000Z')).toBe('2028-02-29T00:00:00.000Z');
		expect(next('0 0 29 2 *', '2026-08-18T00:00:00.000Z')).toBe('2028-02-29T00:00:00.000Z');
	});

	it('refuses what it cannot read instead of guessing a schedule', () => {
		// Every one of these would otherwise be a schedule that silently never fires, or — worse —
		// a different schedule from the one the artifact declared.
		expect(rejection('')).toMatch(/expected 5/);
		expect(rejection('* * * *')).toMatch(/expected 5/);
		expect(rejection('* * * * * *')).toMatch(/expected 5/);
		expect(rejection('@hourly')).toMatch(/expected 5/);
		expect(rejection('0 0 * * MON')).toMatch(/day-of-week/);
		expect(rejection('0 0 L * *')).toMatch(/day-of-month/);
		expect(rejection('0 0 * * ?')).toMatch(/day-of-week/);
		expect(rejection('60 * * * *')).toMatch(/minute/);
		expect(rejection('* 24 * * *')).toMatch(/hour/);
		expect(rejection('0 0 0 * *')).toMatch(/day-of-month/);
		expect(rejection('0 0 * 13 *')).toMatch(/month/);
		expect(rejection('*/0 * * * *')).toMatch(/step/);
		expect(rejection('5-1 * * * *')).toMatch(/backwards/);
		expect(rejection('1-2-3 * * * *')).toMatch(/minute/);
		expect(rejection('0,, * * * *')).toMatch(/minute/);
	});

	it('reports an expression that names no reachable instant rather than pretending to schedule it', () => {
		// 30 February parses field by field and matches no day that will ever exist.
		expect(rejection('0 0 30 2 *')).toMatch(/names no instant/);
	});
});
