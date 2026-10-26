import { describe, expect, it } from '@effect/vitest';
import { expectTypeOf } from 'vitest';
import { Effect } from 'effect';
import { Decimal } from '@norbital-ai/std/decimal';
import { build, read, schema, store, table, type Statement } from '../src/index.ts';
import { shop } from './fixture.ts';
import { database, exec, run, script } from './support.ts';

const first = <A>(rows: readonly A[]): A => {
	const row = rows[0];
	if (row === undefined) throw new Error('fixture row missing');
	return row;
};

describe('typed read projections', () => {
	it.effect('creates multiple identity rows using only declared defaults', () =>
		Effect.gen(function* () {
			const declarations = schema({
				entry: table({ key: 'identity', fields: { name: { kind: 'text', default: 'Untitled' } } })
			});
			const pg = yield* database;
			yield* script(pg, `${(yield* build(declarations)).join(';\n')};`);
			const db = store(declarations),
				execute = run(pg);
			const rows = yield* execute(yield* db.create('entry', [{}, {}]));
			expect(rows.map((row) => row.id)).toEqual([1, 2]);
			expect(rows.map((row) => row.name)).toEqual(['Untitled', 'Untitled']);
			const page = yield* execute(yield* db.read('entry', { orderBy: { id: 'desc' }, limit: 1 }));
			expect(page.rows.map((row) => row.id)).toEqual([2]);
			expect(page.next).not.toBeNull();
			const next = yield* execute(
				yield* db.read('entry', {
					orderBy: { id: 'desc' },
					limit: 1,
					after: page.next ?? ''
				})
			);
			expect(next.rows.map((row) => row.id)).toEqual([1]);
		})
	);

	it.effect('patches null objects and preserves explicitly assigned empty nested objects', () =>
		Effect.gen(function* () {
			const declarations = schema({
				entry: table({
					fields: {
						payload: {
							kind: 'object',
							optional: true,
							fields: {
								nested: {
									kind: 'object',
									optional: true,
									fields: { label: { kind: 'text', optional: true } }
								}
							}
						}
					}
				})
			});
			const pg = yield* database;
			yield* script(pg, `${(yield* build(declarations)).join(';\n')};`);
			const db = store(declarations),
				execute = run(pg);
			const entry = first(yield* execute(yield* db.create('entry', { payload: null })));
			const changed = first(
				yield* execute(
					yield* db.update('entry', {
						key: { id: entry.id },
						set: { payload: { $patch: { nested: {} } } }
					})
				)
			);
			expect(changed.payload).toEqual({ nested: {} });
		})
	);

	it.effect(
		'keeps default columns with relations and projects each polymorphic target in one statement',
		() =>
			Effect.gen(function* () {
				const pg = yield* database;
				yield* script(pg, `${(yield* build(shop)).join(';\n')};`);
				const db = store(shop),
					execute = run(pg);
				const customer = first(
					yield* execute(yield* db.create('customer', { code: 'ACME', name: 'Acme' }))
				);
				const order = first(
					yield* execute(
						yield* db.create('order', {
							number: 'SO-1',
							customer: customer.id,
							placed_on: '2026-10-01',
							total: '12.50'
						})
					)
				);
				yield* execute(
					yield* db.create('note', [
						{ body: 'customer', about: { collection: 'customer', id: customer.id } },
						{ body: 'order', about: { collection: 'order', id: order.id } },
						{ body: 'unlinked' }
					])
				);
				const base = first(
					(yield* execute(
						yield* db.read('order', {
							with: { customer: true },
							all: true
						})
					)).rows
				);
				expect(base.number).toBe('SO-1');
				expectTypeOf(base.customer.name).toEqualTypeOf<string>();
				expect(base.customer.name).toBe('Acme');
				const statement = yield* db.read('note', {
					select: { body: true },
					with: {
						about: {
							customer: {
								select: { code: true },
								with: { orders: { all: true, select: { number: true } } }
							},
							order: { select: { number: true }, with: { customer: { select: { name: true } } } }
						}
					},
					orderBy: 'body',
					all: true
				});
				let statements = 0;
				const once = <A>(st: Statement<A>) =>
					Effect.gen(function* () {
						statements += 1;
						return yield* Effect.flatMap(exec(pg)(st.sql), st.decode);
					});
				const page = yield* once(statement);
				expect(statements).toBe(1);
				expect(page.rows.map((note) => note.about?.collection ?? null)).toEqual([
					'customer',
					'order',
					null
				]);
				for (const note of page.rows) {
					const target = note.about;
					if (target?.collection === 'customer') {
						expectTypeOf(target.code).toEqualTypeOf<string>();
						expectTypeOf<keyof typeof target>().toEqualTypeOf<
							'id' | 'collection' | 'code' | 'orders'
						>();
						expect(target.code).toBe('ACME');
						expect(target.orders.map((row) => row.number)).toEqual(['SO-1']);
						expect(target).not.toHaveProperty('name');
					} else if (target?.collection === 'order') {
						expectTypeOf(target.number).toEqualTypeOf<string>();
						expectTypeOf<keyof typeof target>().toEqualTypeOf<
							'id' | 'collection' | 'number' | 'customer'
						>();
						expect(target.number).toBe('SO-1');
						expect(target.customer.name).toBe('Acme');
						expect(target).not.toHaveProperty('total');
					}
				}
				const malformed = yield* Effect.flip(statement.decode([{ j: 1 }]));
				expect(malformed.code).toBe('internal');
			})
	);

	it.effect(
		'keeps related filters, ordering, and limits local to each parent in a nested read',
		() =>
			Effect.gen(function* () {
				const pg = yield* database;
				yield* script(pg, `${(yield* build(shop)).join(';\n')};`);
				const db = store(shop),
					execute = run(pg);
				const customer = first(
					yield* execute(yield* db.create('customer', { code: 'C', name: 'C' }))
				);
				const orders = yield* execute(
					yield* db.create(
						'order',
						[1, 2, 3].map((n) => ({
							number: `SO-${n}`,
							customer: customer.id,
							placed_on: '2026-10-01',
							total: n
						}))
					)
				);
				for (const order of orders.slice(0, 2))
					yield* execute(
						yield* db.create('line', [
							{ order: order.id, sku: `A-${order.number}`, qty: 1 },
							{ order: order.id, sku: `B-${order.number}`, qty: 2 },
							{ order: order.id, sku: `Z-${order.number}`, qty: 0 }
						])
					);
				const statement = yield* db.read('order', {
					select: { number: true },
					with: {
						lines: {
							where: { qty: { gt: 0 } },
							orderBy: { sku: 'desc' },
							limit: 1,
							select: { sku: true },
							with: { order: { select: { number: true } } }
						}
					},
					orderBy: 'number',
					all: true
				});
				const page = yield* execute(statement);
				expect(
					page.rows.map((order) => [
						order.number,
						order.lines.map((line) => [line.sku, line.order.number])
					])
				).toEqual([
					['SO-1', [['B-SO-1', 'SO-1']]],
					['SO-2', [['B-SO-2', 'SO-2']]],
					['SO-3', []]
				]);
			})
	);

	it.effect('decodes exact aggregate metrics and pages grouped buckets', () =>
		Effect.gen(function* () {
			const pg = yield* database;
			yield* script(pg, `${(yield* build(shop)).join(';\n')};`);
			const db = store(shop),
				execute = run(pg);
			const customer = first(
				yield* execute(yield* db.create('customer', { code: 'C', name: 'C' }))
			);
			yield* execute(
				yield* db.create('order', [
					{ number: 'A', customer: customer.id, placed_on: '2026-10-01', total: '1.20' },
					{
						number: 'B',
						customer: customer.id,
						placed_on: '2026-10-02',
						total: '2.30',
						status: 'shipped'
					}
				])
			);
			const totals = yield* execute(
				yield* db.aggregate('order', {
					count: true,
					sum: ['total'],
					avg: ['total'],
					min: ['placed_on', 'customer.code']
				})
			);
			expectTypeOf(totals.count).toEqualTypeOf<number>();
			expectTypeOf(totals.sum.total).toEqualTypeOf<Decimal | null>();
			expect(totals.count).toBe(2);
			expect(totals.sum.total?.eq('3.50')).toBe(true);
			expect(totals.avg.total?.eq('1.75')).toBe(true);
			expect(totals.min).toEqual({ placed_on: '2026-10-01', 'customer.code': 'C' });
			const grouped = yield* execute(
				yield* db.aggregate('order', { by: 'status', count: true, limit: 1 })
			);
			expect(first(grouped.rows).key.status).toBe('open');
			expect(grouped.next).not.toBeNull();
			const next = yield* execute(
				yield* db.aggregate('order', {
					by: 'status',
					count: true,
					limit: 1,
					after: grouped.next ?? ''
				})
			);
			expect(first(next.rows).key.status).toBe('shipped');
			const empty = yield* execute(
				yield* db.aggregate('order', {
					where: { number: { eq: 'missing' } },
					count: true,
					sum: ['total']
				})
			);
			expect(empty).toEqual({ count: 0, sum: { total: null } });
			const filtered = yield* execute(
				yield* db.read('order', { where: { total: { eq: Decimal.of('1.20') } }, all: true })
			);
			expect(filtered.rows.map((row) => row.number)).toEqual(['A']);
		})
	);

	it.effect(
		'queries and sorts nested json shapes, validates atomic changes, and uses identity keys',
		() =>
			Effect.gen(function* () {
				const declaration = schema({
					owner: table({ key: 'identity', fields: { name: { kind: 'text' } } }),
					tenant: table({
						key: ['handle'],
						fields: { handle: { kind: 'text' }, name: { kind: 'text' } }
					}),
					document: table({
						key: 'identity',
						fields: {
							payload: {
								kind: 'json',
								shape: {
									kind: 'object',
									fields: {
										location: {
											kind: 'object',
											fields: { city: { kind: 'text' }, floor: { kind: 'int' } }
										},
										tags: { kind: 'list', of: { kind: 'text' } },
										price: { kind: 'decimal', scale: 2, optional: true }
									}
								}
							},
							amounts: { kind: 'list', of: { kind: 'decimal', scale: 2 }, default: [] },
							owner: { kind: 'ref', to: 'owner' },
							about: { kind: 'ref', to: ['owner', 'tenant'], optional: true }
						}
					})
				});
				const pg = yield* database;
				yield* script(pg, `${(yield* build(declaration)).join(';\n')};`);
				const db = store(declaration),
					execute = run(pg);
				const owner = first(yield* execute(yield* db.create('owner', { name: 'Ann' })));
				const tenant = first(
					yield* execute(yield* db.create('tenant', { handle: 'acme', name: 'Acme' }))
				);
				yield* execute(yield* db.create('tenant', { handle: 'beta', name: 'Beta' }));
				const tenants = yield* execute(
					yield* db.read('tenant', { orderBy: { handle: 'desc' }, all: true })
				);
				expect(tenants.rows.map((row) => row.handle)).toEqual(['beta', 'acme']);
				const document = first(
					yield* execute(
						yield* db.create('document', {
							payload: {
								location: { city: 'Seoul', floor: 4 },
								tags: ['a'],
								price: Decimal.of('0.25')
							},
							owner: owner.id,
							about: { collection: 'owner', id: owner.id },
							amounts: [Decimal.of('0.80'), 2]
						})
					)
				);
				expectTypeOf(document.id).toEqualTypeOf<number>();
				expect((yield* execute(yield* db.get('document', { id: document.id })))?.id).toBe(
					document.id
				);
				const page = yield* execute(
					yield* db.read('document', {
						where: {
							payload: { location: { floor: { gte: 4 } }, tags: { some: { eq: 'a' } } },
							owner: { eq: owner.id }
						},
						orderBy: { 'payload.location.city': 'asc' },
						all: true
					})
				);
				expect(first(page.rows).payload.location.city).toBe('Seoul');
				const changed = first(
					yield* execute(
						yield* db.update('document', {
							key: { id: document.id },
							set: {
								payload: { $patch: { location: { floor: 5 }, price: Decimal.of('2.50') } },
								amounts: { $append: [Decimal.of('1.20')] }
							}
						})
					)
				);
				expect(changed.payload.location).toEqual({ city: 'Seoul', floor: 5 });
				expect(changed.payload.price?.eq('2.50')).toBe(true);
				expect(changed.amounts.map((amount) => amount.toString())).toEqual(['0.80', '2', '1.20']);
				const rejected = yield* Effect.flip(
					db.update('document', {
						key: { id: document.id },
						set: { amounts: [Number.NaN] }
					})
				);
				expect(rejected.code).toBe('invalid');
				const persisted = yield* execute(yield* db.get('document', { id: document.id }));
				expect(persisted?.amounts.map((amount) => amount.toString())).toEqual([
					'0.80',
					'2',
					'1.20'
				]);
				yield* execute(
					yield* db.create('document', {
						payload: document.payload,
						owner: owner.id,
						about: { collection: 'tenant', id: tenant.handle }
					})
				);
				const references = yield* execute(
					yield* db.read('document', {
						with: {
							owner: { select: { name: true } },
							about: {
								owner: { select: { name: true } },
								tenant: { select: { name: true } }
							}
						},
						orderBy: 'id',
						all: true
					})
				);
				expect(references.rows.map((row) => [row.owner.name, row.about?.collection])).toEqual([
					['Ann', 'owner'],
					['Ann', 'tenant']
				]);
				const extraKey = { id: document.id, extra: 'no' };
				expect((yield* Effect.flip(db.get('document', extraKey))).code).toBe('invalid');
				expect(
					(yield* Effect.flip(
						read(db.catalog, 'document', {
							with: { payload: true },
							all: true
						})
					)).code
				).toBe('invalid');
			})
	);
});
