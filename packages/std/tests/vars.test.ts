import { describe, expect, it } from '@effect/vitest';
import { clockDefault, compileVar, evaluateVar } from '../src/vars.ts';

const requestor = {
	id: 'u1',
	email: null,
	phone: null,
	party: null,
	visitor: null,
	instance: null,
	teams: ['ops'],
	teamTree: ['ops', 'ops.north'],
	scopes: { sales_rep: ['c1'] }
};
const at = { today: '2026-10-28', now: '2026-10-28T10:00:00.000Z', requestor };
const run = (text: string, result: 'text' | 'date' | 'instant' | 'list') => {
	const c = compileVar(text, result);
	if ('error' in c) throw new Error(c.error);
	return evaluateVar(c, at);
};

describe('filter variables', () => {
	it('names the requestor members an expression reads at any depth', () => {
		const c = compileVar('requestor.id in requestor.scopes.sales_rep || size(requestor.teams) > 0');
		expect('error' in c ? c.error : [...c.requestor].sort()).toEqual([
			'id',
			'scopes.sales_rep',
			'teams'
		]);
	});
	it('evaluates requestor members, a missing one as null', () => {
		expect(run('requestor.id', 'text')).toBe('u1');
		expect(run('requestor.email', 'text')).toBeNull();
		expect(run('requestor.teamTree', 'list')).toEqual(['ops', 'ops.north']);
		expect(run('requestor.scopes.sales_rep', 'list')).toEqual(['c1']);
		expect(run('requestor.scopes.other', 'list')).toEqual([]);
	});
	it('shifts and truncates the clock', () => {
		expect(run('today', 'date')).toBe('2026-10-28');
		expect(run('today - days(7)', 'date')).toBe('2026-10-21');
		expect(run('today - months(1)', 'date')).toBe('2026-09-28');
		expect(run('startOfWeek(today)', 'date')).toBe('2026-10-26');
		expect(run('startOfMonth(today)', 'date')).toBe('2026-10-01');
		expect(run('startOfQuarter(today)', 'date')).toBe('2026-10-01');
		expect(run('startOfYear(today)', 'date')).toBe('2026-01-01');
		expect(run('now - hours(1)', 'instant')).toBe('2026-10-28T09:00:00.000Z');
	});
	it('types the result against the position and names what it reads', () => {
		expect(compileVar('requestor.email', 'date')).toEqual({
			error: "'requestor.email' is a string, not a date"
		});
		expect(compileVar('nobody', 'text')).toHaveProperty('error');
		const c = compileVar('today - days(1)', 'date');
		expect('error' in c ? c : { time: c.time, requestor: c.requestor }).toEqual({
			time: true,
			requestor: []
		});
	});
});

describe('clock defaults', () => {
	it('takes now or today with at most one span, as its SQL interval', () => {
		expect(clockDefault('now')).toEqual({ base: 'now', interval: '' });
		expect(clockDefault('now - hours(1)')).toEqual({
			base: 'now',
			interval: " - interval '1 hours'"
		});
		expect(clockDefault('today + weeks(2)')).toEqual({
			base: 'today',
			interval: " + interval '14 days'"
		});
		expect(clockDefault('today + hours(1)')).toBeUndefined();
		expect(clockDefault('startOfMonth(today)')).toBeUndefined();
		expect(clockDefault('requestor.id')).toBeUndefined();
	});
});
