import { describe, expect, it } from 'vitest';
import { Base64Url } from 'effect/encoding';
import { catalog } from '../src/protocol/catalog.ts';
import { evaluate, likeRegex } from '../src/engine/query/eval.ts';
import {
	aggregate,
	compile,
	encodeCursor,
	read,
	similar,
	where,
	type Pred
} from '@norbital-ai/store';
import { storeSync } from '../src/protocol/errors.ts';
import { readOptions } from '../src/engine/query/reader.ts';
import { bindings, manifest, rep } from './query.fixture.ts';

const cat = catalog(manifest);
const code = (f: () => unknown) => {
	try {
		f();
	} catch (e) {
		return (e as { code?: string }).code;
	}
	return 'ok';
};

describe('next query: decode', () => {
	it('decodes cursor keys as string-or-null JSON and keeps them parameterized', () => {
		const query = storeSync(read(cat, 'orders', { limit: 2, orderBy: { note: 'asc' } }));
		if (query.kind !== 'read') throw new Error('Expected the native list read');
		const first = storeSync(compile(cat, query, readOptions({ as: 'workspace' }, bindings)));
		const after = (cursor: string) =>
			storeSync(
				compile(
					cat,
					{ ...query, page: { _tag: 'Limit', limit: 2, after: cursor } },
					readOptions({ as: 'workspace' }, bindings)
				)
			);
		const id = '00000000-0000-4000-8000-000000000001';
		const note = "quoted ' note \\ 🔒";
		const next = after(encodeCursor(first.hash, [note, id]));
		expect(next.sql.params).toContain(note);
		expect(next.sql.params).toContain(id);
		expect(next.sql.text).not.toContain(note);
		expect(after(encodeCursor(first.hash, [null, id])).sql.text).toContain('IS NULL');
		const malformed = [
			null,
			[],
			{ h: first.hash },
			{ h: first.hash, k: [id] },
			{ h: first.hash, k: [{}, id] },
			{ h: first.hash, k: [1, id] },
			{ h: 'another-query', k: [null, id] }
		];
		for (const cursor of [
			'!',
			Base64Url.encode('{'),
			...malformed.map((value) => Base64Url.encode(JSON.stringify(value)))
		])
			expect(() => after(cursor)).toThrowError(expect.objectContaining({ code: 'badCursor' }));
	});

	it('rule 9: a read states a limit (0–10,000) or all; never a default', () => {
		expect(code(() => storeSync(read(cat, 'orders', {})))).toBe('invalid');
		expect(code(() => storeSync(read(cat, 'orders', { limit: 10_001 })))).toBe('invalid');
		expect(code(() => storeSync(read(cat, 'orders', { limit: 5, all: true })))).toBe('invalid');
		expect(code(() => storeSync(read(cat, 'orders', { limit: 0 })))).toBe('ok');
		expect(
			code(() =>
				storeSync(read(cat, 'accounts', { all: true, select: { orders: { select: {} } } }))
			)
		).toBe('invalid');
		expect(code(() => storeSync(aggregate(cat, 'orders', { by: ['status'], count: true })))).toBe(
			'invalid'
		);
	});

	it('an unknown field or operator is invalid at decode, never an ignored filter', () => {
		expect(code(() => storeSync(where(cat, 'orders', { nope: { eq: 1 } })))).toBe('invalid');
		expect(code(() => storeSync(where(cat, 'orders', { total: { like: 'x' } })))).toBe('invalid');
		expect(code(() => storeSync(where(cat, 'orders', { doc: { eq: 1 } })))).toBe('invalid');
		expect(code(() => storeSync(where(cat, 'notes', { about: { lines: { is: {} } } })))).toBe(
			'invalid'
		);
		expect(code(() => storeSync(similar(cat, 'orders', 'nope', {}, { limit: 3 })))).toBe('invalid');
	});

	it('normalizes relations: is, some/none/every, count, arc arms (K3)', () => {
		expect(
			storeSync(
				where(cat, 'accounts', { orders: { some: { status: { eq: 'open' } }, count: { gte: 2 } } })
			)
		).toEqual({
			t: 'and',
			of: [
				{
					t: 'many',
					rel: 'orders',
					target: 'orders',
					q: 'some',
					pred: { t: 'cmp', field: 'status', op: 'eq', arg: { _tag: 'Lit', value: 'open' } }
				},
				{ t: 'count', rel: 'orders', target: 'orders', op: 'gte', n: 2 }
			]
		});
		expect(
			storeSync(
				where(cat, 'notes', {
					about: { orders: { is: { qty: { gt: 1 } } }, accounts: { isNull: true } }
				})
			)
		).toEqual({
			t: 'and',
			of: [
				{
					t: 'one',
					rel: 'about',
					target: 'orders',
					pred: { t: 'cmp', field: 'qty', op: 'gt', arg: { _tag: 'Lit', value: 1 } }
				},
				{ t: 'null', field: 'about.accounts', is: true }
			]
		});
		expect(storeSync(where(cat, 'orders', { placed: { gte: '2026-09-18' } }))).toEqual({
			t: 'cmp',
			field: 'placed',
			op: 'gte',
			arg: { _tag: 'Lit', value: '2026-09-18' }
		});
	});

	it('rule 13: a caller without a read grant is forbidden; a field outside exposure does not exist (rule 10)', () => {
		const none = { ...rep, models: {} };
		expect(
			code(() =>
				storeSync(
					compile(
						cat,
						storeSync(read(cat, 'orders', { limit: 1 })),
						readOptions({ as: 'caller', authority: none }, bindings)
					)
				)
			)
		).toBe('forbidden');
		expect(
			code(() =>
				storeSync(
					compile(
						cat,
						storeSync(read(cat, 'notes', { limit: 1, where: { created_at: { isNull: false } } })),
						readOptions({ as: 'caller', authority: rep }, bindings)
					)
				)
			)
		).toBe('ok');
		expect(
			code(() =>
				storeSync(
					compile(
						cat,
						{
							kind: 'read',
							model: 'notes',
							select: { fields: ['id'], relations: {} },
							page: { _tag: 'Limit', limit: 1 },
							where: { t: 'null', field: 'revision', is: false }
						},
						readOptions({ as: 'workspace' }, bindings)
					)
				)
			)
		).toBe('ok');
		const orders = cat.exposures.get('orders')!;
		expect(orders.model.fields.get('total')?.pg).toBe('numeric');
	});

	it('rule 14: aggregating a field masked to the caller is forbidden', () => {
		const ir = storeSync(aggregate(cat, 'orders', { sum: ['total'] }));
		expect(
			code(() =>
				storeSync(compile(cat, ir, readOptions({ as: 'caller', authority: rep }, bindings)))
			)
		).toBe('forbidden');
		expect(
			code(() => storeSync(compile(cat, ir, readOptions({ as: 'workspace' }, bindings))))
		).toBe('ok');
	});

	it('the JS evaluator: nulls never match, ne and nin are distinct-from, email folds, operands resolve', () => {
		const env = { cat, bindings, authority: rep };
		const row = {
			id: 'x',
			status: 'open',
			note: null,
			email: 'a@X.IO',
			placed: '2026-09-20',
			qty: 3,
			tags: ['a'],
			total: '10.50'
		};
		const is = (p: Pred) => evaluate(env, 'orders', p, row);
		expect(is(storeSync(where(cat, 'orders', { note: { eq: 'x' } })))).toBe(false);
		expect(is(storeSync(where(cat, 'orders', { note: { ne: 'x' } })))).toBe(true);
		expect(is(storeSync(where(cat, 'orders', { not: { note: { eq: 'x' } } })))).toBe(true);
		expect(is(storeSync(where(cat, 'orders', { email: { eq: { var: 'requestor.email' } } })))).toBe(
			true
		);
		expect(
			is(
				storeSync(
					where(cat, 'orders', {
						placed: { gte: '2026-09-18' },
						total: { gt: '11' }
					})
				)
			)
		).toBe(false);
		expect(
			is(
				storeSync(
					where(cat, 'orders', {
						total: { lt: '10.6' },
						tags: { hasAll: ['a'] },
						status: { nin: ['closed'] }
					})
				)
			)
		).toBe(true);
		expect(likeRegex('a\\%b%').test('A%bcd')).toBe(true);
		// the anonymous identity: a visitor matches their own guest rows; a member matches none
		const guest = {
			...rep,
			key: 'guest',
			actor: { kind: 'visitor', app: 'lobby', visitor: 'v-1' }
		} as typeof rep;
		const guestIs = (p: Pred) =>
			evaluate({ cat, bindings, authority: guest }, 'orders', p, { ...row, note: 'v-1' });
		expect(
			guestIs(storeSync(where(cat, 'orders', { note: { eq: { var: 'requestor.visitor' } } })))
		).toBe(true);
		expect(
			is(storeSync(where(cat, 'orders', { note: { eq: { var: 'requestor.visitor' } } })))
		).toBe(false);
	});
});
