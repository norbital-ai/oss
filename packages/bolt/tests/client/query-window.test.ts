import { describe, expect, it } from 'vitest';
import { Effect, Result } from 'effect';
import {
	authoritativeBaseRowsFromPage,
	confirmCollectionCountWindow,
	confirmCollectionGroupedWindow,
	confirmCollectionQueryPage,
	describeClientQueryWindow,
	type QueryWindowCatalog
} from '../../src/client/replica/query-window.js';

const catalog: QueryWindowCatalog = {
	jobs: {
		fields: [
			{ name: 'priority', kind: 'number' },
			{ name: 'status', kind: 'string' },
			{ name: 'title', kind: 'string' },
			{
				name: 'assignee',
				kind: 'reference',
				relation: { targets: ['people', 'service_accounts'] }
			}
		],
		relationships: [{ name: 'assignments', target: 'job_assignments' }]
	},
	job_assignments: {
		fields: [{ name: 'active', kind: 'boolean' }],
		relationships: [{ name: 'person', target: 'people' }]
	},
	people: { fields: [{ name: 'name', kind: 'string' }] },
	service_accounts: { fields: [{ name: 'name', kind: 'string' }] }
};

const identity = {
	protocolVersion: 6,
	schemaFingerprint: 'sha256:schema-a',
	partitionKey: 'partition-a'
};

describe('canonical query windows', () => {
	it('shares one key across continuations, page sizes, and projections', async () => {
		const first = await Effect.runPromise(
			describeClientQueryWindow(
				'findMany',
				{
					collection: 'jobs',
					where: { priority: { gte: 2 } },
					orderBy: { priority: 'desc' },
					limit: 20,
					columns: { title: true }
				},
				catalog,
				identity
			)
		);
		const continuation = await Effect.runPromise(
			describeClientQueryWindow(
				'findMany',
				{
					collection: 'jobs',
					where: { priority: { gte: 2 } },
					orderBy: { priority: 'desc' },
					limit: 100,
					after: 'next-page',
					columns: { priority: false }
				},
				catalog,
				identity
			)
		);

		expect(first?.queryKey).toBe(continuation?.queryKey);
		expect(first?.query.orderBy).toEqual([
			{ field: 'priority', direction: 'desc' },
			{ field: 'id', direction: 'asc' }
		]);

		const nestedProjection = await Effect.runPromise(
			describeClientQueryWindow(
				'findMany',
				{
					collection: 'jobs',
					with: { assignments: { columns: { active: true } } }
				},
				catalog,
				identity
			)
		);
		const otherNestedProjection = await Effect.runPromise(
			describeClientQueryWindow(
				'findMany',
				{
					collection: 'jobs',
					with: { assignments: { columns: { active: false } } }
				},
				catalog,
				identity
			)
		);
		expect(nestedProjection?.queryKey).toBe(otherNestedProjection?.queryKey);
	});

	it('includes protocol, schema, partition, and authored order in the key', async () => {
		const describe = (orderBy: Readonly<Record<string, 'asc' | 'desc'>>, next = identity) =>
			Effect.runPromise(
				describeClientQueryWindow('findMany', { collection: 'jobs', orderBy }, catalog, next)
			);
		const priorityThenId = await describe({ priority: 'desc', id: 'asc' });
		const idThenPriority = await describe({ id: 'asc', priority: 'desc' });
		expect(priorityThenId?.queryKey).not.toBe(idThenPriority?.queryKey);
		expect((await describe({ priority: 'desc' }, { ...identity, protocolVersion: 7 }))?.queryKey).not.toBe(
			priorityThenId?.queryKey
		);
		expect(
			(await describe({ priority: 'desc' }, { ...identity, schemaFingerprint: 'sha256:schema-b' }))
				?.queryKey
		).not.toBe(priorityThenId?.queryKey);
		expect(
			(await describe({ priority: 'desc' }, { ...identity, partitionKey: 'partition-b' }))
				?.queryKey
		).not.toBe(priorityThenId?.queryKey);
	});

	it('derives relationship dependencies and requires exact server confirmation generations', async () => {
		const described = await Effect.runPromise(
			describeClientQueryWindow(
				'findMany',
				{
					collection: 'jobs',
					where: { assignments: { active: { eq: true } } },
					with: { assignee: true, assignments: { with: { person: true } } }
				},
				catalog,
				identity
			)
		);
		if (described === undefined) throw new Error('expected a canonical query');
		expect(described.dependencies).toEqual([
			'job_assignments',
			'jobs',
			'people',
			'service_accounts'
		]);

		const confirmed = confirmCollectionQueryPage(described, {
			rows: [],
			baseRows: [],
			relationshipRefs: [],
			pageCursor: null,
			nextCursor: null,
			lookahead: 0,
			readCursor: { xid: 8, sequence: 1 },
			partitionKey: 'partition-a',
			confirmedDependencies: [
				'jobs',
				'job_assignments',
				'people',
				'service_accounts',
				'policy_links'
			],
			dependencyGenerations: {
				jobs: 4,
				job_assignments: 7,
				people: 2,
				service_accounts: 1,
				policy_links: 9
			},
			reproducibility: { _tag: 'LocalExact', semantics: { version: 1, collation: 'none', operators: [] } }
		});
		expect(Result.isSuccess(confirmed)).toBe(true);
		if (Result.isSuccess(confirmed)) {
			expect(confirmed.success.dependencies).toEqual([
				'job_assignments',
				'jobs',
				'people',
				'policy_links',
				'service_accounts'
			]);
		}

		expect(
			Result.isFailure(
				confirmCollectionQueryPage(described, {
					rows: [],
					baseRows: [],
					relationshipRefs: [],
					pageCursor: null,
					nextCursor: null,
					lookahead: 0,
					readCursor: { xid: 8, sequence: 1 },
					partitionKey: 'partition-a',
					confirmedDependencies: ['jobs'],
					dependencyGenerations: { jobs: 4 },
					reproducibility: {
						_tag: 'ServerProof',
						reasons: ['unknown-query-shape']
					}
				})
			)
		).toBe(true);
	});

	it('installs normalized related rows once and refuses dangling relationship membership', async () => {
		const described = await Effect.runPromise(
			describeClientQueryWindow(
				'findMany',
				{ collection: 'jobs', with: { assignee: true } },
				catalog,
				identity
			)
		);
		if (described === undefined) throw new Error('expected a canonical query');
		const root = { id: 'j1', row_version: 4, assignee: { kind: 'person', id: 'p1' } };
		const related = { id: 'p1', row_version: 2, name: 'Ada' };
		const page = {
			rows: [root],
			baseRows: [
				{ collection: 'jobs', recordId: 'j1', rowVersion: 4, row: root },
				{ collection: 'people', recordId: 'p1', rowVersion: 2, row: related }
			],
			relationshipRefs: [
				{
					sourceCollection: 'jobs',
					sourceRecordId: 'j1',
					relation: 'assignee',
					targetCollection: 'people',
					targetRecordId: 'p1'
				}
			],
			pageCursor: null,
			nextCursor: null,
			lookahead: 0,
			readCursor: { xid: 8, sequence: 1 },
			partitionKey: 'partition-a',
			confirmedDependencies: ['jobs', 'people', 'service_accounts'],
			dependencyGenerations: { jobs: 4, people: 2, service_accounts: 1 },
			reproducibility: described.reproducibility
		} as const;

		const installed = authoritativeBaseRowsFromPage('jobs', page);
		expect(Result.isSuccess(installed)).toBe(true);
		if (Result.isSuccess(installed)) {
			expect(installed.success.map(({ collection, recordId }) => [collection, recordId])).toEqual([
				['jobs', 'j1'],
				['people', 'p1']
			]);
		}
		expect(Result.isSuccess(confirmCollectionQueryPage(described, page))).toBe(true);
		expect(
			Result.isFailure(
				confirmCollectionQueryPage(described, {
					...page,
					baseRows: page.baseRows.slice(0, 1)
				})
			)
		).toBe(true);
	});

	it('keeps unpinned text, unsupported operators, counts, and grouped queries server-proof', async () => {
		const text = await Effect.runPromise(
			describeClientQueryWindow(
				'findMany',
				{ collection: 'jobs', orderBy: { title: 'asc' } },
				catalog,
				identity
			)
		);
		expect(text?.reproducibility).toEqual({
			_tag: 'ServerProof',
			reasons: ['unpinned-collation']
		});
		const pinnedText = await Effect.runPromise(
			describeClientQueryWindow(
				'findMany',
				{ collection: 'jobs', where: { title: { ilike: '%urgent%' } } },
				catalog,
				identity,
				{ pinnedCollation: true }
			)
		);
		expect(pinnedText?.reproducibility).toEqual({
			_tag: 'LocalExact',
			semantics: {
				version: 1,
				collation: 'postgres-c-v1',
				operators: ['ilike']
			}
		});

		const unsupported = await Effect.runPromise(
			describeClientQueryWindow(
				'findMany',
				{ collection: 'jobs', where: { priority: { externalSearch: 'urgent' } } },
				catalog,
				identity
			)
		);
		expect(unsupported?.reproducibility._tag).toBe('ServerProof');
		if (unsupported?.reproducibility._tag === 'ServerProof') {
			expect(unsupported.reproducibility.reasons).toContain('unsupported-operator');
		}

		const relationships = await Effect.runPromise(
			describeClientQueryWindow(
				'findMany',
				{ collection: 'jobs', with: { assignee: true } },
				catalog,
				identity,
				{ pinnedCollation: true }
			)
		);
		expect(relationships?.reproducibility).toEqual({
			_tag: 'ServerProof',
			reasons: ['local-relationships-unavailable']
		});

		const search = await Effect.runPromise(
			describeClientQueryWindow(
				'findMany',
				{ collection: 'jobs', search: 'urgent' },
				catalog,
				identity,
				{ pinnedCollation: true }
			)
		);
		expect(search?.reproducibility).toEqual({
			_tag: 'ServerProof',
			reasons: ['local-search-unavailable']
		});

		for (const kind of ['count', 'findGrouped'] as const) {
			const aggregate = await Effect.runPromise(
				describeClientQueryWindow(kind, { collection: 'jobs' }, catalog, identity, {
					pinnedCollation: true
				})
			);
			expect(aggregate?.reproducibility._tag).toBe('ServerProof');
		}
	});

	it('gives exact grouped aggregates their own page-size-independent canonical identity', async () => {
		const first = await Effect.runPromise(
			describeClientQueryWindow(
				'findGrouped',
				{
					collection: 'jobs',
					group: { by: 'status', lanes: ['open', 'closed'] },
					limit: 500,
					columns: { title: true }
				},
				catalog,
				identity,
				{ pinnedCollation: true }
			)
		);
		const sameAggregate = await Effect.runPromise(
			describeClientQueryWindow(
				'findGrouped',
				{
					collection: 'jobs',
					group: { by: 'status', lanes: ['open', 'closed'] },
					limit: 20,
					columns: { priority: true }
				},
				catalog,
				identity,
				{ pinnedCollation: true }
			)
		);
		const otherLanes = await Effect.runPromise(
			describeClientQueryWindow(
				'findGrouped',
				{
					collection: 'jobs',
					group: { by: 'status', lanes: ['closed', 'open'] }
				},
				catalog,
				identity,
				{ pinnedCollation: true }
			)
		);
		expect(first?.queryKey).toBe(sameAggregate?.queryKey);
		expect(first?.queryKey).not.toBe(otherLanes?.queryKey);
		expect(first?.reproducibility).toEqual({ _tag: 'ServerProof', reasons: ['grouped'] });
		if (first === undefined) throw new Error('expected a canonical grouped query');
		expect(
			Result.isSuccess(
				confirmCollectionGroupedWindow(first, {
					groups: { open: [], closed: [] },
					baseRows: [],
					relationshipRefs: [],
					readCursor: { xid: 9, sequence: 1 },
					partitionKey: identity.partitionKey,
					confirmedDependencies: ['jobs'],
					dependencyGenerations: { jobs: 5 },
					reproducibility: { _tag: 'ServerProof', reasons: ['grouped'] }
				})
			)
		).toBe(true);
	});

	it('confirms a scalar count proof without any row hydration payload', async () => {
		const count = await Effect.runPromise(
			describeClientQueryWindow(
				'count',
				{ collection: 'jobs', where: { priority: { gte: 2 } }, limit: 500 },
				catalog,
				identity,
				{ pinnedCollation: true }
			)
		);
		if (count === undefined) throw new Error('expected a canonical count query');
		const confirmed = confirmCollectionCountWindow(count, {
			count: 42,
			readCursor: { xid: 10, sequence: 2 },
			partitionKey: identity.partitionKey,
			confirmedDependencies: ['jobs'],
			dependencyGenerations: { jobs: 6 },
			reproducibility: { _tag: 'ServerProof', reasons: ['aggregate'] }
		});
		expect(Result.isSuccess(confirmed)).toBe(true);
		expect('rows' in ({ count: 42 } as object)).toBe(false);
	});
});
