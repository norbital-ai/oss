import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { Decimal } from '@norbital-ai/std/decimal';
import {
	build,
	compileWrite,
	read,
	schema,
	store,
	table,
	type Insert,
	type StoreError
} from '../src/index.ts';
import { shop } from './fixture.ts';
import { database, exec as raw, required, run, script } from './support.ts';

const db = store(shop);
const fresh = Effect.gen(function* () {
	const pg = yield* database;
	yield* script(pg, `${(yield* build(shop)).join(';\n')};`);
	return run(pg);
});
const failure = <A>(effect: Effect.Effect<A, StoreError>) =>
	Effect.map(Effect.exit(effect), (exit) => (Exit.isFailure(exit) ? String(exit.cause) : 'ok'));

describe('Store over a schema value', () => {
	it.effect('writes explicitly declared metadata fields on ordinary tables', () =>
		Effect.gen(function* () {
			const declaration = schema({
				entry: table({
					key: ['name'],
					fields: {
						name: { kind: 'text' },
						revision: { kind: 'int' },
						updated_at: { kind: 'instant' }
					}
				})
			});
			const pg = yield* database;
			yield* script(pg, (yield* build(declaration)).join(';\n'));
			const entries = store(declaration),
				execute = run(pg);
			const inserted = required(
				(yield* execute(
					yield* entries.create('entry', {
						name: 'one',
						revision: 4,
						updated_at: '2026-10-01T00:00:00Z'
					})
				))[0]
			);
			expect(inserted).toMatchObject({ revision: 4, updated_at: '2026-10-01T00:00:00.000Z' });
			const updated = required(
				(yield* execute(
					yield* entries.update('entry', {
						key: { name: 'one' },
						set: { revision: 9, updated_at: '2026-10-02T00:00:00Z' }
					})
				))[0]
			);
			expect(updated).toMatchObject({ revision: 9, updated_at: '2026-10-02T00:00:00.000Z' });
			const upserted = required(
				(yield* execute(
					yield* entries.upsert('entry', {
						name: 'one',
						revision: 10,
						updated_at: '2026-10-03T00:00:00Z'
					})
				))[0]
			);
			expect(upserted).toMatchObject({ revision: 10, updated_at: '2026-10-03T00:00:00.000Z' });
		})
	);
	it.effect('matches normalized addresses through native text predicates', () =>
		Effect.gen(function* () {
			const execute = yield* fresh;
			yield* execute(
				yield* db.create('tenant', [
					{ handle: 'email', name: 'Person@Example.TEST' },
					{ handle: 'phone', name: '+82 (10) 1234-5678' }
				])
			);
			const page = yield* execute(
				yield* db.read('tenant', {
					where: {
						or: [{ name: { folded: 'person@example.test' } }, { name: { digits: '821012345678' } }]
					},
					orderBy: 'handle',
					all: true
				})
			);
			expect(page.rows.map((row) => row.handle)).toEqual(['email', 'phone']);
		})
	);
	it.effect('selects the first matching row per group before seeking the next page', () =>
		Effect.gen(function* () {
			const exec = yield* fresh;
			yield* exec(
				yield* db.create('environment', [
					{ tenant: 'a', name: 'old', generation: 1 },
					{ tenant: 'a', name: 'first', generation: 3 },
					{ tenant: 'a', name: 'tie', generation: 3 },
					{ tenant: 'b', name: 'old', generation: 1 },
					{ tenant: 'b', name: 'current', generation: 2 },
					{ tenant: 'b', name: 'excluded', generation: 4 }
				])
			);
			const query = {
				firstPer: ['tenant'],
				orderBy: { generation: 'desc' },
				where: { generation: { lt: 4 } },
				limit: 1
			} as const;
			const first = yield* exec(yield* db.read('environment', query));
			expect(first.rows.map(({ tenant, name }) => [tenant, name])).toEqual([['a', 'first']]);
			expect(first.next).not.toBeNull();
			const second = yield* exec(
				yield* db.read('environment', { ...query, after: first.next ?? '' })
			);
			expect(second.rows.map(({ tenant, name }) => [tenant, name])).toEqual([['b', 'current']]);
			expect(second.next).toBeNull();
		})
	);

	it.effect('creates, reads back typed rows, and pages by keyset', () =>
		Effect.gen(function* () {
			const exec = yield* fresh;
			const [acme] = yield* exec(yield* db.create('customer', { code: 'ACME', name: 'Acme' }));
			expect(acme?.code).toBe('ACME');
			expect(acme?.credit).toBeInstanceOf(Decimal);
			expect(acme?.revision).toBe(1);
			const orders = yield* exec(
				yield* db.create(
					'order',
					[1, 2, 3].map((n) => ({
						number: `SO-${n}`,
						customer: required(acme).id,
						placed_on: n === 1 ? '2026-10-01' : n === 2 ? '2026-10-02' : '2026-10-03',
						total: n + 0.5,
						address: { city: n === 2 ? 'Penang' : 'Singapore', floor: n }
					}))
				)
			);
			expect(orders.map((o) => o.number)).toEqual(['SO-1', 'SO-2', 'SO-3']);
			expect(orders[0]?.status).toBe('open');
			const first = yield* exec(yield* db.read('order', { orderBy: { number: 'desc' }, limit: 2 }));
			expect(first.rows.map((o) => o.number)).toEqual(['SO-3', 'SO-2']);
			expect(first.next).not.toBeNull();
			const second = yield* exec(
				yield* db.read('order', { orderBy: { number: 'desc' }, limit: 2, after: first.next ?? '' })
			);
			expect(second.rows.map((o) => o.number)).toEqual(['SO-1']);
			expect(second.next).toBeNull();
		})
	);

	it.effect(
		'reads every relation kind in one statement: one, many, many-to-many, polymorphic, self',
		() =>
			Effect.gen(function* () {
				const exec = yield* fresh;
				const [c] = yield* exec(yield* db.create('customer', { code: 'C', name: 'C' }));
				const [o] = yield* exec(
					yield* db.create('order', {
						number: 'SO-9',
						customer: required(c).id,
						placed_on: '2026-10-09',
						total: 9
					})
				);
				const lines = yield* exec(
					yield* db.create('line', [
						{ order: required(o).id, sku: 'A', qty: 1 },
						{ order: required(o).id, sku: 'B', qty: 2 }
					])
				);
				const [updatedLine] = yield* exec(
					yield* db.update('line', {
						key: { id: required(lines.find((line) => line.sku === 'A')).id },
						set: { qty: 3 }
					})
				);
				expect(updatedLine?.qty).toBe(3);
				const [t] = yield* exec(yield* db.create('tag', { label: 'rush' }));
				yield* exec(yield* db.create('order_tag', { order: required(o).id, tag: required(t).id }));
				yield* exec(
					yield* db.create('note', [
						{ body: 'on customer', about: { model: 'customer', id: required(c).id } },
						{ body: 'on order', about: { model: 'order', id: required(o).id } }
					])
				);
				const [boss] = yield* exec(yield* db.create('employee', { name: 'Boss' }));
				yield* exec(yield* db.create('employee', { name: 'Ann', manager: required(boss).id }));

				const page = yield* exec(
					yield* db.read('order', {
						where: { number: { eq: 'SO-9' } },
						select: { number: true },
						with: {
							customer: { select: { code: true } },
							lines: { orderBy: { sku: 'asc' }, limit: 10, select: { sku: true, qty: true } },
							tags: { all: true, select: { label: true } },
							notes: { all: true, select: { body: true } }
						},
						limit: 1
					})
				);
				const row = page.rows[0];
				expect(row?.customer.code).toBe('C');
				expect(row?.lines.map((l) => [l.sku, l.qty])).toEqual([
					['A', 3],
					['B', 2]
				]);
				expect(row?.tags.map((x) => x.label)).toEqual(['rush']);
				expect(row?.notes.map((n) => n.body)).toEqual(['on order']);

				const notes = yield* exec(
					yield* db.read('note', {
						with: { about: { select: { id: true } } },
						orderBy: 'body',
						all: true
					})
				);
				expect(notes.rows.map((n) => n.about?.model)).toEqual(['customer', 'order']);

				const team = yield* exec(
					yield* db.read('employee', {
						where: { manager: { isNull: true } },
						with: { reports: { all: true } },
						all: true
					})
				);
				expect(team.rows[0]?.reports.map((r) => r.name)).toEqual(['Ann']);
			})
	);

	it.effect('keys: text, composite and natural; gets by key', () =>
		Effect.gen(function* () {
			const exec = yield* fresh;
			yield* exec(yield* db.create('tenant', { handle: 'acme', name: 'Acme' }));
			yield* exec(
				yield* db.create('environment', [
					{ tenant: 'acme', name: 'main' },
					{ tenant: 'acme', name: 'dev' }
				])
			);
			const env = yield* exec(yield* db.get('environment', { tenant: 'acme', name: 'dev' }));
			expect(env).toMatchObject({ tenant: 'acme', name: 'dev', generation: 0, deleted_at: null });
			expect(
				yield* exec(yield* db.get('environment', { tenant: 'acme', name: 'gone' }))
			).toBeNull();
			expect(yield* exec(yield* db.get('tenant', { handle: 'acme' }))).toEqual({
				handle: 'acme',
				name: 'Acme'
			});
		})
	);

	it.effect('updates observe a revision; a moved row is stale and nothing is written', () =>
		Effect.gen(function* () {
			const exec = yield* fresh;
			const [c] = yield* exec(yield* db.create('customer', { code: 'C', name: 'Old' }));
			const [moved] = yield* exec(
				yield* db.update('customer', {
					key: { id: required(c).id },
					set: { name: 'New' },
					observed: 1
				})
			);
			expect(moved?.revision).toBe(2);
			const stale = yield* Effect.flip(
				Effect.flatMap(
					db.update('customer', {
						key: { id: required(c).id },
						set: { name: 'Lost' },
						observed: 1
					}),
					exec
				)
			);
			expect(stale.code).toBe('stale');
			expect((yield* exec(yield* db.get('customer', { id: required(c).id })))?.name).toBe('New');
			const gone = yield* exec(
				yield* db.delete('customer', { key: { id: required(c).id }, observed: 2 })
			);
			expect(gone).toEqual([{ id: required(c).id }]);
		})
	);

	it.effect('upserts on a natural key, updating only where a condition holds', () =>
		Effect.gen(function* () {
			const exec = yield* fresh;
			yield* exec(yield* db.create('customer', { code: 'C', name: 'First', credit: 5 }));
			yield* exec(
				yield* db.upsert(
					'customer',
					{ code: 'C', name: 'Kept' },
					{ on: ['code'], when: { credit: { gt: 10 } } }
				)
			);
			expect(
				(yield* exec(yield* db.read('customer', { all: true }))).rows.map((c) => c.name)
			).toEqual(['First']);
			yield* exec(
				yield* db.upsert(
					'customer',
					[
						{ code: 'C', name: 'Second' },
						{ code: 'D', name: 'New' }
					],
					{ on: ['code'] }
				)
			);
			const all = yield* exec(yield* db.read('customer', { orderBy: 'code', all: true }));
			expect(all.rows.map((c) => [c.code, c.name, c.revision])).toEqual([
				['C', 'Second', 2],
				['D', 'New', 1]
			]);
			const [added] = yield* exec(
				yield* db.upsert(
					'customer',
					{ code: 'C', name: 'Second', credit: 3 },
					{
						on: ['code'],
						merge: { credit: 'add' }
					}
				)
			);
			expect(added?.credit).toEqual(Decimal.of(8));
			const [peak] = yield* exec(
				yield* db.upsert(
					'customer',
					{ code: 'C', name: 'Second', credit: 2 },
					{
						on: ['code'],
						merge: { credit: 'max' }
					}
				)
			);
			expect(peak?.credit).toEqual(Decimal.of(8));
		})
	);

	it.effect(
		'uses the database clock on guarded updates and only the conflict side of an upsert',
		() =>
			Effect.gen(function* () {
				const declaration = schema({
					release: table({
						key: ['template', 'stamp'],
						fields: {
							template: { kind: 'text' },
							stamp: { kind: 'text' },
							commit: { kind: 'text' },
							digest: { kind: 'text' },
							ready_at: { kind: 'instant', default: { var: 'now' } },
							updated_at: { kind: 'instant', default: '2000-01-01T00:00:00Z' },
							payload: { kind: 'json', default: { now: 'literal' } }
						}
					})
				});
				const pg = yield* database;
				yield* script(pg, (yield* build(declaration)).join(';\n'));
				const releases = store(declaration),
					execute = run(pg);
				const original = { template: 'blank', stamp: 'one', commit: 'first', digest: 'kept' };
				yield* execute(
					yield* releases.create('release', { ...original, ready_at: '2000-01-01T00:00:00Z' })
				);
				yield* script(pg, 'BEGIN');
				const inserted = required(
					(yield* execute(
						yield* releases.upsert(
							'release',
							{ ...original, stamp: 'two' },
							{ update: ['commit'], now: ['ready_at'] }
						)
					))[0]
				);
				expect(inserted.payload).toEqual({ now: 'literal' });
				const explicit = required(
					(yield* execute(
						yield* releases.upsert(
							'release',
							{ ...original, stamp: 'three', ready_at: '2000-01-01T00:00:00Z' },
							{ now: ['ready_at'] }
						)
					))[0]
				);
				expect(explicit.ready_at).toBe('2000-01-01T00:00:00.000Z');
				const changed = required(
					(yield* execute(
						yield* releases.upsert(
							'release',
							{ ...original, commit: 'second', digest: 'ignored' },
							{ update: ['commit'], now: ['ready_at'] }
						)
					))[0]
				);
				expect(changed).toMatchObject({
					commit: 'second',
					digest: 'kept',
					ready_at: inserted.ready_at
				});
				expect(
					yield* execute(
						yield* releases.upsert(
							'release',
							{ ...original, commit: 'lost' },
							{ now: ['ready_at'], when: { commit: { eq: 'first' } } }
						)
					)
				).toEqual([]);
				yield* execute(
					yield* releases.update('release', {
						key: { template: 'blank', stamp: 'one' },
						set: {},
						now: ['updated_at']
					})
				);
				expect(
					yield* raw(pg)({
						text: "SELECT ready_at = now() AS ready, updated_at = now() AS updated FROM release WHERE template = 'blank' AND stamp = 'one'",
						params: []
					})
				).toEqual([{ ready: true, updated: true }]);
				yield* script(pg, 'COMMIT');
				for (const name of ['template', 'missing', 'ready_at.nested']) {
					const refused = yield* Effect.flip(
						compileWrite(releases.catalog, {
							kind: 'update',
							table: 'release',
							where: { t: 'const', value: true },
							set: {},
							now: [name],
							select: { fields: null, relations: {} }
						})
					);
					expect(refused.code).toBe('invalid');
				}
				const overlap = yield* Effect.flip(
					releases.update('release', {
						where: {},
						set: { ready_at: '2000-01-01T00:00:00Z' },
						now: ['ready_at']
					})
				);
				expect(overlap.code).toBe('invalid');
				const kept = yield* Effect.flip(
					releases.upsert('release', original, { update: 'keep', now: ['ready_at'] })
				);
				expect(kept.code).toBe('invalid');
			})
	);

	it.effect('inline values: path predicates, list quantifiers, path sort and atomic changes', () =>
		Effect.gen(function* () {
			const exec = yield* fresh;
			const [c] = yield* exec(yield* db.create('customer', { code: 'C', name: 'C' }));
			const make = (
				n: number,
				city: string,
				events: readonly string[]
			): Insert<typeof shop, 'order'> => ({
				number: `SO-${n}`,
				customer: required(c).id,
				placed_on: '2026-10-01',
				total: n,
				address: { city, floor: n },
				events: events.map((what) => ({ at: '2026-10-01T00:00:00.000Z', what }))
			});
			yield* exec(
				yield* db.create('order', [
					make(1, 'Singapore', ['placed']),
					make(2, 'Penang', ['placed', 'shipped'])
				])
			);
			const penang = yield* exec(
				yield* db.read('order', { where: { address: { city: { eq: 'Penang' } } }, all: true })
			);
			expect(penang.rows.map((o) => o.number)).toEqual(['SO-2']);
			const high = yield* exec(
				yield* db.read('order', { where: { address: { floor: { gte: 2 } } }, all: true })
			);
			expect(high.rows.map((o) => o.number)).toEqual(['SO-2']);
			const shipped = yield* exec(
				yield* db.read('order', {
					where: { events: { some: { what: { eq: 'shipped' } } } },
					all: true
				})
			);
			expect(shipped.rows.map((o) => o.number)).toEqual(['SO-2']);
			const none = yield* exec(
				yield* db.read('order', {
					where: { events: { none: { what: { eq: 'shipped' } } } },
					all: true
				})
			);
			expect(none.rows.map((o) => o.number)).toEqual(['SO-1']);
			const byCity = yield* exec(
				yield* db.read('order', { orderBy: { 'address.city': 'asc' }, all: true })
			);
			expect(byCity.rows.map((o) => o.address?.city)).toEqual(['Penang', 'Singapore']);

			const [o] = penang.rows;
			const [patched] = yield* exec(
				yield* db.update('order', {
					key: { id: required(o).id },
					set: { address: { $patch: { zip: '10050' } }, labels: { $append: ['vip', 'gift'] } }
				})
			);
			expect(patched?.address).toEqual({ city: 'Penang', floor: 2, zip: '10050' });
			expect(patched?.labels).toEqual(['vip', 'gift']);
			const [removed] = yield* exec(
				yield* db.update('order', {
					key: { id: required(o).id },
					set: { labels: { $remove: ['vip'] } }
				})
			);
			expect(removed?.labels).toEqual(['gift']);
		})
	);

	it.effect(
		'refuses what does not decode: an unknown field, a wrong value, a key of the wrong shape',
		() =>
			Effect.gen(function* () {
				// the literal as it arrives from outside the type system: decoded, refused with its path
				expect(
					yield* failure(read(db.catalog, 'order', { where: { nope: { eq: 1 } }, all: true }))
				).toContain("where.nope: unknown field 'nope' on 'order'");
				expect(
					yield* failure(
						read(db.catalog, 'order', { where: { customer: { some: {} } }, all: true })
					)
				).toContain('where.customer.some');
				expect(
					yield* failure(read(db.catalog, 'order', { where: { total: { eq: 'x' } }, all: true }))
				).toContain("'total' takes a decimal");
			})
	);
});
