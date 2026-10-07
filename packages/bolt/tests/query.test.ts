import { describe, expect, it } from 'vitest';
import type { Pred } from '../src/engine/contracts.ts';
import { catalog } from '../src/protocol/catalog.ts';
import { evaluate, likeRegex } from '../src/engine/query/eval.ts';
import { aggregate, read, similar, where } from '../src/protocol/ir.ts';
import { compile } from '../src/engine/query/sql.ts';
import { bindings, manifest, rep } from './query.fixture.ts';

const cat = catalog(manifest);
const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { code?: string }).code; } return 'ok'; };

describe('next query: decode', () => {
	it('rule 9: a read states a limit (0–10,000) or all; never a default', () => {
		expect(code(() => read(cat, 'orders', {}))).toBe('invalid');
		expect(code(() => read(cat, 'orders', { limit: 10_001 }))).toBe('invalid');
		expect(code(() => read(cat, 'orders', { limit: 5, all: true }))).toBe('invalid');
		expect(code(() => read(cat, 'orders', { limit: 0 }))).toBe('ok');
		expect(code(() => read(cat, 'accounts', { all: true, select: { orders: { select: {} } } }))).toBe('invalid');
		expect(code(() => aggregate(cat, 'orders', { by: ['status'], count: true }))).toBe('invalid');
	});

	it('an unknown field or operator is invalid at decode, never an ignored filter', () => {
		expect(code(() => where(cat, 'orders', { nope: { eq: 1 } }))).toBe('invalid');
		expect(code(() => where(cat, 'orders', { total: { like: 'x' } }))).toBe('invalid');
		expect(code(() => where(cat, 'orders', { doc: { eq: 1 } }))).toBe('invalid');
		expect(code(() => where(cat, 'notes', { about: { lines: { is: {} } } }))).toBe('invalid');
		expect(code(() => similar(cat, 'orders', 'nope', {}, { limit: 3 }))).toBe('invalid');
	});

	it('normalizes relations: is, some/none/every, count, arc arms (K3)', () => {
		expect(where(cat, 'accounts', { orders: { some: { status: { eq: 'open' } }, count: { gte: 2 } } })).toEqual({ t: 'and', of: [
			{ t: 'many', rel: 'orders', target: 'orders', q: 'some', pred: { t: 'cmp', field: 'status', op: 'eq', arg: { lit: 'open' } } },
			{ t: 'count', rel: 'orders', target: 'orders', op: 'gte', n: 2 }] });
		expect(where(cat, 'notes', { about: { orders: { is: { qty: { gt: 1 } } }, accounts: { isNull: true } } })).toEqual({ t: 'and', of: [
			{ t: 'one', rel: 'about', target: 'orders', pred: { t: 'cmp', field: 'qty', op: 'gt', arg: { lit: 1 } } },
			{ t: 'null', field: 'about.accounts', is: true }] });
		expect(where(cat, 'orders', { placed: { gte: { today: '-7d' } } })).toEqual({ t: 'cmp', field: 'placed', op: 'gte', arg: { today: '-7d' } });
	});

	it('rule 13: a caller without a read grant is forbidden; a field outside exposure does not exist (rule 10)', () => {
		const none = { ...rep, collections: {} };
		expect(code(() => compile(cat, read(cat, 'orders', { limit: 1 }), { as: 'caller', authority: none }, bindings))).toBe('forbidden');
		expect(code(() => compile(cat, read(cat, 'notes', { limit: 1, where: { created_at: { isNull: false } } }), { as: 'caller', authority: rep }, bindings))).toBe('ok');
		expect(code(() => compile(cat, { kind: 'read', collection: 'notes', select: { fields: ['id'], relations: {} }, page: { limit: 1 },
			where: { t: 'null', field: 'revision', is: false } }, { as: 'workspace' }, bindings))).toBe('ok');
		const orders = cat.collections.get('orders')!;
		expect(orders.model.fields.get('total')?.pg).toBe('numeric');
	});

	it('rule 14: aggregating a field masked to the caller is forbidden', () => {
		const ir = aggregate(cat, 'orders', { sum: ['total'] });
		expect(code(() => compile(cat, ir, { as: 'caller', authority: rep }, bindings))).toBe('forbidden');
		expect(code(() => compile(cat, ir, { as: 'workspace' }, bindings))).toBe('ok');
	});

	it('the JS evaluator: nulls never match, ne and nin are distinct-from, email folds, operands resolve', () => {
		const env = { cat, bindings, authority: rep };
		const row = { id: 'x', status: 'open', note: null, email: 'a@X.IO', placed: '2026-09-20', qty: 3, tags: ['a'], total: '10.50' };
		const is = (p: Pred) => evaluate(env, 'orders', p, row);
		expect(is(where(cat, 'orders', { note: { eq: 'x' } }))).toBe(false);
		expect(is(where(cat, 'orders', { note: { ne: 'x' } }))).toBe(true);
		expect(is(where(cat, 'orders', { not: { note: { eq: 'x' } } }))).toBe(true);
		expect(is(where(cat, 'orders', { email: { eq: { actor: 'email' } } }))).toBe(true);
		expect(is(where(cat, 'orders', { placed: { gte: { today: '-7d' } }, total: { gt: { param: 'min' } } }))).toBe(false);
		expect(is(where(cat, 'orders', { total: { lt: '10.6' }, tags: { hasAll: ['a'] }, status: { nin: ['closed'] } }))).toBe(true);
		expect(likeRegex('a\\%b%').test('A%bcd')).toBe(true);
		// the anonymous identity: a visitor matches their own guest rows; a member matches none
		const guest = { ...rep, key: 'guest', actor: { kind: 'visitor', app: 'lobby', visitor: 'v-1' } } as typeof rep;
		const guestIs = (p: Pred) => evaluate({ cat, bindings, authority: guest }, 'orders', p, { ...row, note: 'v-1' });
		expect(guestIs(where(cat, 'orders', { note: { eq: { actor: 'visitor' } } }))).toBe(true);
		expect(is(where(cat, 'orders', { note: { eq: { actor: 'visitor' } } }))).toBe(false);
	});
});
