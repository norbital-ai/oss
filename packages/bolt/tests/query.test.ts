import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Base64Url } from 'effect/encoding';
import { catalog } from '../src/protocol/catalog.ts';
import { evaluate, likeRegex } from '../src/engine/query/eval.ts';
import {
	aggregate,
	catalog_for,
	compile,
	encode_cursor,
	read,
	similar,
	where,
	type Pred
} from '@norbital-ai/store';
import { readOptions } from '../src/engine/query/reader.ts';
import { bindings, clerk, manifest, rep } from './query.fixture.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const cat = catalog(manifest);
const code = <E extends { readonly code: string }>(effect: Effect.Effect<unknown, E>) =>
	effect.pipe(
		Effect.as('ok'),
		Effect.catch((error) => Effect.succeed(error.code))
	);

describe('next query: decode', () => {
	it.effect('decodes cursor keys as string-or-null JSON and keeps them parameterized', () =>
		Effect.gen(function* () {
			const query = yield* read(cat, 'orders', { limit: 2, order_by: { note: 'asc' } });
			if (query.kind !== 'read') throw new Error('Expected the native list read');
			const first = yield* compile(cat, query, readOptions({ as: 'workspace' }, bindings));
			const after = (cursor: string) =>
				compile(
					cat,
					{ ...query, page: { _tag: 'Limit', limit: 2, after: cursor } },
					readOptions({ as: 'workspace' }, bindings)
				);
			const id = '00000000-0000-4000-8000-000000000001';
			const note = "quoted ' note \\ 🔒";
			const next = yield* after(encode_cursor(first.hash, [note, id]));
			expect(next.sql.params).toContain(note);
			expect(next.sql.params).toContain(id);
			expect(next.sql.text).not.toContain(note);
			expect((yield* after(encode_cursor(first.hash, [null, id]))).sql.text).toContain('IS NULL');
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
				expect(yield* code(after(cursor))).toBe('bad_cursor');
		})
	);

	it.effect('rule 9: a read states a limit (0–10,000) or all; never a default', () =>
		Effect.gen(function* () {
			expect(yield* code(read(cat, 'orders', {}))).toBe('invalid');
			expect(yield* code(read(cat, 'orders', { limit: 10_001 }))).toBe('invalid');
			expect(yield* code(read(cat, 'orders', { limit: 5, all: true }))).toBe('invalid');
			expect(yield* code(read(cat, 'orders', { limit: 0 }))).toBe('ok');
			expect(
				yield* code(read(cat, 'accounts', { all: true, select: { orders: { select: {} } } }))
			).toBe('invalid');
			expect(yield* code(aggregate(cat, 'orders', { by: ['status'], count: true }))).toBe(
				'invalid'
			);
		})
	);

	it.effect('an unknown field or operator is invalid at decode, never an ignored filter', () =>
		Effect.gen(function* () {
			expect(yield* code(where(cat, 'orders', { nope: { eq: 1 } }))).toBe('invalid');
			// the refusal names the model's fields, and a name dressed in an invisible character says so
			expect(
				(yield* Effect.flip(where(cat, 'orders', { 'sta\u200btus': { eq: 'open' } }))).message
			).toMatch(
				/unknown field 'sta\u200btus' on 'orders' \(the name holds invisible characters\); its fields: .*\bstatus\b/
			);
			expect(yield* code(where(cat, 'orders', { total: { like: 'x' } }))).toBe('invalid');
			expect(yield* code(where(cat, 'orders', { doc: { eq: 1 } }))).toBe('invalid');
			expect(yield* code(where(cat, 'notes', { about: { lines: { is: {} } } }))).toBe('invalid');
			expect(yield* code(similar(cat, 'orders', 'nope', {}, { limit: 3 }))).toBe('invalid');
		})
	);

	it.effect('normalizes relations: is, some/none/every, count, arc arms (K3)', () =>
		Effect.gen(function* () {
			expect(
				yield* where(cat, 'accounts', {
					orders: { some: { status: { eq: 'open' } }, count: { gte: 2 } }
				})
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
				yield* where(cat, 'notes', {
					about: { orders: { is: { qty: { gt: 1 } } }, accounts: { is_null: true } }
				})
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
			expect(yield* where(cat, 'orders', { placed: { gte: '2026-09-18' } })).toEqual({
				t: 'cmp',
				field: 'placed',
				op: 'gte',
				arg: { _tag: 'Lit', value: '2026-09-18' }
			});
		})
	);

	it.effect(
		'rule 13: a caller without a read grant is forbidden; a field outside exposure does not exist (rule 10)',
		() =>
			Effect.gen(function* () {
				const none = { ...rep, models: {} };
				expect(
					yield* code(
						compile(
							cat,
							yield* read(cat, 'orders', { limit: 1 }),
							readOptions({ as: 'caller', authority: none }, bindings)
						)
					)
				).toBe('forbidden');
				expect(
					yield* code(
						compile(
							cat,
							yield* read(cat, 'notes', { limit: 1, where: { created_at: { is_null: false } } }),
							readOptions({ as: 'caller', authority: rep }, bindings)
						)
					)
				).toBe('ok');
				expect(
					yield* code(
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
				).toBe('ok');
				const orders = present(cat.exposures.get('orders'));
				expect(orders.model.fields.get('total')?.pg).toBe('numeric');
			})
	);

	it.effect(
		'rule 46b: a workspace read of a held model carries `$approval` as a caller read does; no other model does',
		() =>
			Effect.gen(function* () {
				const ir = yield* read(cat, 'orders', { limit: 1 });
				const approvals = new Set(['orders']);
				const held = (reader: Parameters<typeof readOptions>[0], models: ReadonlySet<string>) =>
					compile(cat, ir, readOptions(reader, bindings, { approvals: models })).pipe(
						Effect.map((compiled) => compiled.sql.text)
					);
				for (const reader of [{ as: 'workspace' }, { as: 'caller', authority: rep }] as const) {
					expect(yield* held(reader, approvals)).toContain('AS "$approval"');
					expect(yield* held(reader, approvals)).toContain(
						"ap.state IN ('Pending', 'ChangesRequested')"
					);
					expect(yield* held(reader, new Set())).not.toContain('$approval');
				}
				// without the held models (a write's own reads) nothing is attached
				expect(
					(yield* compile(cat, ir, readOptions({ as: 'workspace' }, bindings))).sql.text
				).not.toContain('$approval');
			})
	);

	it.effect(
		'a grouped aggregate always counts its buckets; an ungrouped one counts only when asked',
		() =>
			Effect.gen(function* () {
				const sql = (q: { [k: string]: unknown }) =>
					aggregate(cat, 'orders', q).pipe(
						Effect.flatMap((ir) => compile(cat, ir, readOptions({ as: 'workspace' }, bindings))),
						Effect.map((compiled) => compiled.sql.text)
					);
				expect(yield* aggregate(cat, 'orders', { by: 'status', limit: 2 })).toMatchObject({
					count: true
				});
				expect(yield* sql({ by: 'status', limit: 2 })).toContain('count(*) AS "count"');
				expect(yield* sql({ by: 'status', sum: ['total'], limit: 2 })).toContain(
					'count(*) AS "count"'
				);
				expect(yield* aggregate(cat, 'orders', { sum: ['total'] })).not.toHaveProperty('count');
				expect(yield* sql({ sum: ['total'] })).not.toContain('count(*)');
			})
	);

	it.effect(
		'an output is its fields: aggregating a field it omits is invalid; an ungranted output is forbidden',
		() =>
			Effect.gen(function* () {
				const brief = yield* catalog_for(cat, 'orders', 'brief');
				const clerkReads = readOptions({ as: 'caller', authority: clerk }, bindings);
				const omitted = {
					...(yield* aggregate(brief, 'orders', { sum: ['total'] })),
					output: 'brief'
				};
				expect(yield* code(compile(brief, omitted, clerkReads))).toBe('invalid');
				const total = yield* aggregate(cat, 'orders', { sum: ['total'] });
				expect(yield* code(compile(cat, total, clerkReads))).toBe('forbidden');
				const qty = { ...(yield* aggregate(brief, 'orders', { max: ['qty'] })), output: 'brief' };
				expect(yield* code(compile(brief, qty, clerkReads))).toBe('ok');
				expect(
					yield* code(compile(cat, total, readOptions({ as: 'caller', authority: rep }, bindings)))
				).toBe('ok');
			})
	);

	it.effect(
		'the JS evaluator: nulls never match, ne and not-in are distinct-from, email folds, operands resolve',
		() =>
			Effect.gen(function* () {
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
				expect(is(yield* where(cat, 'orders', { note: { eq: 'x' } }))).toBe(false);
				expect(is(yield* where(cat, 'orders', { note: { ne: 'x' } }))).toBe(true);
				expect(is(yield* where(cat, 'orders', { not: { note: { eq: 'x' } } }))).toBe(true);
				expect(is(yield* where(cat, 'orders', { email: { eq: { var: 'requestor.email' } } }))).toBe(
					true
				);
				expect(
					is(
						yield* where(cat, 'orders', {
							placed: { gte: '2026-09-18' },
							total: { gt: '11' }
						})
					)
				).toBe(false);
				expect(
					is(
						yield* where(cat, 'orders', {
							total: { lt: '10.6' },
							tags: { has: 'a' },
							not: { status: { in: ['closed'] } }
						})
					)
				).toBe(true);
				expect(likeRegex('a\\%b%').test('A%bcd')).toBe(true);
				// the anonymous identity: a visitor matches their own guest rows; a member matches none
				const guest: typeof rep = {
					...rep,
					key: 'guest',
					actor: { kind: 'visitor', app: 'lobby', visitor: 'v-1' }
				};
				const guestIs = (p: Pred) =>
					evaluate({ cat, bindings, authority: guest }, 'orders', p, { ...row, note: 'v-1' });
				expect(
					guestIs(yield* where(cat, 'orders', { note: { eq: { var: 'requestor.visitor' } } }))
				).toBe(true);
				expect(
					is(yield* where(cat, 'orders', { note: { eq: { var: 'requestor.visitor' } } }))
				).toBe(false);
			})
	);
});
