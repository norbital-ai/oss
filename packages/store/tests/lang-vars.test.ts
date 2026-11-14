import { describe, expect, it } from '@effect/vitest';
import { clock_default, compile_var, evaluate_var } from '../src/lang/vars.ts';

const requestor = {
	id: 'u1',
	email: null,
	phone: null,
	party: null,
	visitor: null,
	instance: null,
	teams: ['ops'],
	team_tree: ['ops', 'ops.north'],
	scopes: { sales_rep: ['c1'] }
};
const at = { today: '2026-10-28', now: '2026-10-28T10:00:00.000Z', actor: requestor };
const run = (text: string, result: 'text' | 'date' | 'instant' | 'list') => {
	const c = compile_var(text, result);
	if ('error' in c) throw new Error(c.error);
	return evaluate_var(c, at);
};

describe('filter variables', () => {
	it('names the requestor members an expression reads at any depth', () => {
		const c = compile_var('actor.id in actor.scopes.sales_rep || size(actor.teams) > 0');
		expect('error' in c ? c.error : [...c.actor].sort()).toEqual([
			'id',
			'scopes.sales_rep',
			'teams'
		]);
	});
	it('evaluates requestor members, a missing one as null', () => {
		expect(run('actor.id', 'text')).toBe('u1');
		expect(run('actor.email', 'text')).toBeNull();
		expect(run('actor.team_tree', 'list')).toEqual(['ops', 'ops.north']);
		expect(run('actor.scopes.sales_rep', 'list')).toEqual(['c1']);
		expect(run('actor.scopes.other', 'list')).toEqual([]);
	});
	it('shifts and truncates the clock', () => {
		expect(run('today', 'date')).toBe('2026-10-28');
		expect(run('today - days(7)', 'date')).toBe('2026-10-21');
		expect(run('today - months(1)', 'date')).toBe('2026-09-28');
		expect(run('start_of_week(today)', 'date')).toBe('2026-10-26');
		expect(run('start_of_month(today)', 'date')).toBe('2026-10-01');
		expect(run('start_of_quarter(today)', 'date')).toBe('2026-10-01');
		expect(run('start_of_year(today)', 'date')).toBe('2026-01-01');
		expect(run('now - hours(1)', 'instant')).toBe('2026-10-28T09:00:00.000Z');
	});
	it('types the result against the position and names what it reads', () => {
		expect(compile_var('actor.email', 'date')).toEqual({
			error: "'actor.email' is a string, not a date"
		});
		expect(compile_var('nobody', 'text')).toHaveProperty('error');
		const c = compile_var('today - days(1)', 'date');
		expect('error' in c ? c : { time: c.time, requestor: c.actor }).toEqual({
			time: true,
			requestor: []
		});
	});
});

describe('clock defaults', () => {
	it('takes now or today with at most one span, as its SQL interval', () => {
		expect(clock_default('now')).toEqual({ base: 'now', interval: '' });
		expect(clock_default('now - hours(1)')).toEqual({
			base: 'now',
			interval: " - interval '1 hours'"
		});
		expect(clock_default('today + weeks(2)')).toEqual({
			base: 'today',
			interval: " + interval '14 days'"
		});
		expect(clock_default('today + hours(1)')).toBeUndefined();
		expect(clock_default('start_of_month(today)')).toBeUndefined();
		expect(clock_default('actor.id')).toBeUndefined();
	});
});
