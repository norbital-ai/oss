import { describe, expect, it } from 'vitest';
import { Base64Url } from 'effect/encoding';
import { catalog } from '../src/protocol/catalog.ts';
import { evaluate, likeRegex } from '../src/engine/query/eval.ts';
import {
	aggregate,
	catalogFor,
	compile,
	encodeCursor,
	read,
	similar,
	where,
	type Pred
} from '@norbital-ai/store';
import { storeSync } from '../src/protocol/errors.ts';
import { readOptions } from '../src/engine/query/reader.ts';
import { bindings, clerk, manifest, rep } from './query.fixture.ts';

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
		// the refusal names the model's fields, and a name dressed in an invisible character says so
		expect(() => storeSync(where(cat, 'orders', { 'sta\u200btus': { eq: 'open' } }))).toThrow(
			/unknown field 'sta\u200btus' on 'orders' \(the name holds invisible characters\); its fields: .*\bstatus\b/
		);
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

	it('rule 46b: a workspace read of a held model carries `$approval` as a caller read does; no other model does', () => {
		const ir = storeSync(read(cat, 'orders', { limit: 1 }));
		const approvals = new Set(['orders']);
		const held = (reader: Parameters<typeof readOptions>[0], models: ReadonlySet<string>) =>
			storeSync(compile(cat, ir, readOptions(reader, bindings, { approvals: models }))).sql.text;
		for (const reader of [{ as: 'workspace' }, { as: 'caller', authority: rep }] as const) {
			expect(held(reader, approvals)).toContain('AS "$approval"');
			expect(held(reader, approvals)).toContain("ap.state IN ('Pending', 'ChangesRequested')");
			expect(held(reader, new Set())).not.toContain('$approval');
		}
		// without the held models (a write's own reads) nothing is attached
		expect(
			storeSync(compile(cat, ir, readOptions({ as: 'workspace' }, bindings))).sql.text
		).not.toContain('$approval');
	});

	it('a grouped aggregate always counts its buckets; an ungrouped one counts only when asked', () => {
		const sql = (q: { [k: string]: unknown }) =>
			storeSync(
				compile(
					cat,
					storeSync(aggregate(cat, 'orders', q)),
					readOptions({ as: 'workspace' }, bindings)
				)
			).sql.text;
		expect(storeSync(aggregate(cat, 'orders', { by: 'status', limit: 2 }))).toMatchObject({
			count: true
		});
		expect(sql({ by: 'status', limit: 2 })).toContain('count(*) AS "count"');
		expect(sql({ by: 'status', sum: ['total'], limit: 2 })).toContain('count(*) AS "count"');
		expect(storeSync(aggregate(cat, 'orders', { sum: ['total'] }))).not.toHaveProperty('count');
		expect(sql({ sum: ['total'] })).not.toContain('count(*)');
	});

	it('an output is its fields: aggregating a field it omits is invalid; an ungranted output is forbidden', () => {
		const brief = storeSync(catalogFor(cat, 'orders', 'brief'));
		const clerkReads = readOptions({ as: 'caller', authority: clerk }, bindings);
		const omitted = {
			...storeSync(aggregate(brief, 'orders', { sum: ['total'] })),
			output: 'brief'
		};
		expect(code(() => storeSync(compile(brief, omitted, clerkReads)))).toBe('invalid');
		const total = storeSync(aggregate(cat, 'orders', { sum: ['total'] }));
		expect(code(() => storeSync(compile(cat, total, clerkReads)))).toBe('forbidden');
		const qty = { ...storeSync(aggregate(brief, 'orders', { max: ['qty'] })), output: 'brief' };
		expect(code(() => storeSync(compile(brief, qty, clerkReads)))).toBe('ok');
		expect(
			code(() =>
				storeSync(compile(cat, total, readOptions({ as: 'caller', authority: rep }, bindings)))
			)
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
