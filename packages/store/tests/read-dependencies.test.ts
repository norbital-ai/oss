import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { catalog_of, compile, read, RECORD_LABEL_COLUMN, SEARCH_COLUMN } from '../src/index.ts';

const cat = catalog_of({
	tables: {
		accounts: {
			fields: {
				code: { kind: 'text' },
				amount: { kind: 'sum', of: 'entries.amount' },
				movements: { kind: 'count', of: 'entries' }
			},
			computed: { upper_code: { kind: 'text' } },
			search: { text: ['code'] }
		},
		entries: {
			fields: {
				memo: { kind: 'text' },
				amount: { kind: 'decimal' },
				account: { kind: 'ref', to: 'accounts', inverse: 'entries' }
			}
		},
		links: {
			fields: { model: { kind: 'text' }, record: { kind: 'text' } },
			label_link: { model: 'model', record: 'record', targets: ['accounts'] }
		}
	}
});

describe('compiler read dependencies', () => {
	it.effect('proves ordinary identity reads without including unused generated fields', () =>
		Effect.gen(function* () {
			const query = yield* read(cat, 'accounts', {
				all: true,
				select: { code: true },
				where: { code: { eq: 'A' } }
			});
			const result = yield* compile(cat, query);
			expect(result.dependencies.complete).toBe(true);
			expect([...result.dependencies.models.keys()]).toEqual(['accounts']);
			expect([...(result.dependencies.models.get('accounts') ?? [])].sort()).toEqual([
				'code',
				'id'
			]);
		})
	);
	it.effect(
		'includes field operands, related filters, nested projections, ordering and grouping',
		() =>
			Effect.gen(function* () {
				const query = yield* read(cat, 'accounts', {
					all: true,
					select: { code: true, entries: { all: true, select: { memo: true } } },
					where: {
						and: [
							{ movements: { eq: { field: 'amount' } } },
							{ entries: { some: { amount: { gt: 0 } } } }
						]
					},
					order_by: { upper_code: 'asc' },
					first_per: ['code']
				});
				const result = yield* compile(cat, query);
				expect([...(result.dependencies.models.get('accounts') ?? [])].sort()).toEqual([
					'amount',
					'code',
					'id',
					'movements',
					'upper_code'
				]);
				expect([...(result.dependencies.models.get('entries') ?? [])].sort()).toEqual([
					'account',
					'amount',
					'id',
					'memo'
				]);
			})
	);
	it.effect('tracks implicit generated search and live-label dependencies', () =>
		Effect.gen(function* () {
			const search = yield* compile(
				cat,
				yield* read(cat, 'accounts', { all: true, select: { code: true }, search: 'A' })
			);
			expect(search.dependencies.models.get('accounts')?.has(SEARCH_COLUMN)).toBe(true);
			const labelled = catalog_of({
				tables: {
					accounts: { fields: { code: { kind: 'text' } }, record_label: 'code' },
					links: {
						fields: { model: { kind: 'text' }, record: { kind: 'text' } },
						label_link: { model: 'model', record: 'record', targets: ['accounts'] }
					}
				}
			});
			const result = yield* compile(
				labelled,
				yield* read(labelled, 'links', { all: true, select: { record: true } })
			);
			expect(result.dependencies.models.get('accounts')?.has(RECORD_LABEL_COLUMN)).toBe(true);
		})
	);
	it.effect('fails closed for opaque root SQL', () =>
		Effect.gen(function* () {
			const query = yield* read(cat, 'accounts', { all: true, select: { code: true } });
			const result = yield* compile(cat, query, { root: () => ['1 AS extra'] });
			expect(result.dependencies.complete).toBe(false);
		})
	);
	it.effect('proves through-table membership and uses its actual prospective source', () =>
		Effect.gen(function* () {
			const through = catalog_of({
				tables: {
					accounts: {
						fields: { code: { kind: 'text' } },
						through: { groups: { table: 'memberships', from: 'account', to: 'group' } }
					},
					groups: { fields: { name: { kind: 'text' } } },
					memberships: {
						fields: {
							account: { kind: 'ref', to: 'accounts' },
							group: { kind: 'ref', to: 'groups' }
						}
					}
				}
			});
			const query = yield* read(through, 'accounts', {
				all: true,
				select: { code: true, groups: { all: true, select: { name: true } } }
			});
			const result = yield* compile(through, query, {
				sources: new Map([['memberships', 'prepared_memberships']])
			});
			expect([...(result.dependencies.models.get('memberships') ?? [])].sort()).toEqual([
				'account',
				'group'
			]);
			expect(result.sql.text).toContain('FROM "prepared_memberships" j');
		})
	);
});
