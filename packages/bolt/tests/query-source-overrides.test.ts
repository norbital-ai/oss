import { describe, it, expect } from '@effect/vitest';
import { Effect } from 'effect';
import { catalog } from '../src/protocol/catalog.ts';
import {
	aggregate,
	compile,
	compile_gets,
	get,
	grant_sql,
	read,
	select,
	where,
	where_sql
} from '@norbital-ai/store';
import { readOptions, resolverOf } from '../src/engine/query/reader.ts';
import { bindings, manifest, rep } from './query.fixture.ts';

const cat = catalog(manifest);
const workspace = { as: 'workspace' } as const;
const sources = new Map([
	['accounts', '__bolt_prepared_0'],
	['orders', '__bolt_prepared_1'],
	['lines', '__bolt_prepared_2']
]);

describe('engine-owned prospective query sources', () => {
	it.effect(
		'routes root, relation predicates, nested selections and aggregation paths through the same sources',
		() =>
			Effect.gen(function* () {
				const queries = [
					yield* read(cat, 'accounts', {
						all: true,
						where: { orders: { some: { status: { eq: 'open' } } } },
						select: {
							name: true,
							orders: {
								all: true,
								select: { status: true, lines: { all: true, select: { sku: true } } }
							}
						}
					}),
					yield* read(cat, 'orders', {
						all: true,
						select: { account: { select: { name: true } } }
					}),
					yield* aggregate(cat, 'orders', {
						by: ['account.region'],
						count: true,
						sum: ['total'],
						all: true
					})
				];
				for (const query of queries) {
					const ordinary = yield* compile(cat, query, readOptions(workspace, bindings));
					const prospective = yield* compile(
						cat,
						query,
						readOptions(workspace, bindings, { sources })
					);
					expect(prospective.sql.params).toEqual(ordinary.sql.params);
					expect(prospective.sql.text).toContain('"__bolt_prepared_0"');
					expect(prospective.sql.text).toContain('"__bolt_prepared_1"');
					expect(prospective.sql.text).not.toMatch(/FROM "(?:accounts|orders|lines)"/);
				}
			})
	);
	it.effect('keeps caller scope when replacing physical sources', () =>
		Effect.gen(function* () {
			const query = yield* read(cat, 'orders', {
				limit: 3,
				select: { total: true, account: { select: { name: true } } }
			});
			const caller = { as: 'caller', authority: rep } as const;
			const ordinary = yield* compile(cat, query, readOptions(caller, bindings));
			const prospective = yield* compile(cat, query, readOptions(caller, bindings, { sources }));
			expect(prospective.sql.params).toEqual(ordinary.sql.params);
			expect(prospective.sql.params).toContain('north');
			expect(prospective.sql.text).not.toMatch(/FROM "(?:accounts|orders)"/);
		})
	);
	it.effect(
		'routes single, batched and predicate reads, quoting source identifiers as identifiers',
		() =>
			Effect.gen(function* () {
				const id = '00000000-0000-4000-8000-000000000001';
				const order = yield* get(cat, 'orders', id);
				expect(
					(yield* compile(cat, order, readOptions(workspace, bindings, { sources }))).sql.text
				).toContain('FROM "__bolt_prepared_1"');
				expect(
					(yield* compile_gets(
						cat,
						'orders',
						[id],
						yield* select(cat, 'orders', { status: true }),
						readOptions(workspace, bindings, { sources })
					)).text
				).toContain('FROM "__bolt_prepared_1"');
				const predicate = yield* where(cat, 'orders', {
					account: { is: { region: { eq: 'north' } } }
				});
				for (const sql of [
					yield* where_sql(cat, 'orders', predicate, readOptions(workspace, bindings, { sources })),
					yield* grant_sql(cat, 'orders', predicate, {
						resolve: resolverOf(bindings, rep),
						tz: bindings.tz,
						sources
					})
				]) {
					expect(sql.text).toContain('FROM "__bolt_prepared_0"');
					expect(sql.text).toContain('FROM "__bolt_prepared_1"');
				}
				const odd = new Map([['orders', 'prepared"name']]);
				expect(
					(yield* compile(cat, order, readOptions(workspace, bindings, { sources: odd }))).sql.text
				).toContain('FROM "prepared""name"');
			})
	);
});
