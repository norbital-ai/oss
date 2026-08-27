import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import {
	createWindowLedger,
	type InstallQueryWindow,
	type QueryWindowDescriptor
} from '../../src/client/replica/coverage.js';
import { adaptPGlite } from '../../src/client/replica/pglite-loader.js';
import {
	createPGliteStore,
	markProvisioned,
	provision
} from '../../src/client/replica/pglite-sql.js';
import { provisioningStatements, testWorkspace } from '../support/bolt-test-layer.js';

const rid = (name: string): string => {
	const digest = createHash('sha1').update(name).digest('hex').slice(0, 32);
	return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};

const databases: Array<PGlite> = [];
afterEach(async () => {
	for (const database of databases.splice(0)) await database.close();
});

const replica = async () => {
	const database = await PGlite.create('memory://', {
		extensions: { pg_trgm, btree_gist, vector }
	});
	databases.push(database);
	const engine = adaptPGlite(database);
	const definition = testWorkspace();
	await Effect.runPromise(provision(engine, await provisioningStatements(definition)));
	await Effect.runPromise(markProvisioned(engine, 'coverage:test', { xid: 0, sequence: 0 }));
	const store = await Effect.runPromise(
		createPGliteStore(
			engine,
			Object.fromEntries(definition.collections.map(({ name, fields }) => [name, fields]))
		)
	);
	const windows = await Effect.runPromise(createWindowLedger(engine, store));
	return { engine, store, windows };
};

const descriptor = (
	queryKey: string,
	proofOwner: 'local' | 'server' = 'local'
): QueryWindowDescriptor => ({
	queryKey,
	canonical: {
		collection: 'people',
		limit: 20,
		where: { team: { eq: queryKey } }
	},
	collection: 'people',
	dependencies: ['people'],
	proofOwner,
	locallyReproducible: proofOwner === 'local'
});

const baseRow = (name: string, rowVersion = 1) => ({
	collection: 'people',
	recordId: rid(name),
	rowVersion,
	row: { name, team: 'core' }
});

const install = (
	window: QueryWindowDescriptor,
	rows: ReadonlyArray<ReturnType<typeof baseRow>>,
	input: Readonly<{
		orderedRowIds?: ReadonlyArray<string>;
		nextCursor?: string | null;
		continuation?: string | null;
		lookaheadCount?: number;
		readCursor?: { readonly xid: number; readonly sequence: number };
		dependencyGeneration?: number;
		relationshipRefs?: InstallQueryWindow['relationshipRefs'];
		serverResult?: InstallQueryWindow['serverResult'];
	}> = {}
) => ({
	window,
	dependencies: ['people'],
	baseRows: rows,
	orderedRowIds: input.orderedRowIds ?? rows.map(({ recordId }) => recordId),
	nextCursor: input.nextCursor ?? null,
	readCursor: input.readCursor ?? { xid: 0, sequence: 0 },
	dependencyGenerations: { people: input.dependencyGeneration ?? 0 },
	continuation: input.continuation ?? null,
		lookaheadCount: input.lookaheadCount ?? 0,
		...(input.relationshipRefs === undefined ? {} : { relationshipRefs: input.relationshipRefs }),
		...(input.serverResult === undefined ? {} : { serverResult: input.serverResult })
});

describe('replica base rows and canonical query windows', () => {
	it('stores one authoritative base row shared by two windows', async () => {
		const local = await replica();
		const shared = baseRow('shared');
		await Effect.runPromise(local.windows.installWindow(install(descriptor('window:a'), [shared])));
		await Effect.runPromise(local.windows.installWindow(install(descriptor('window:b'), [shared])));

		const base = await Effect.runPromise(
			local.engine.query<{ readonly count: number | string; readonly row_version: number | string }>(
				`select count(*) over () as count, row_version
				 from bolt_replica_base_row where collection = 'people' and record_id = $1::uuid`,
				[shared.recordId]
			)
		);
		const memberships = await Effect.runPromise(
			local.engine.query<{ readonly query_key: string; readonly record_id: string }>(
				`select query_key, record_id from bolt_replica_window_row
				 where collection = 'people' and record_id = $1::uuid order by query_key`,
				[shared.recordId]
			)
		);
		expect(base.rows.map((row) => ({ count: Number(row.count), version: Number(row.row_version) })))
			.toEqual([{ count: 1, version: 1 }]);
		expect(memberships.rows).toEqual([
			{ query_key: 'window:a', record_id: shared.recordId },
			{ query_key: 'window:b', record_id: shared.recordId }
		]);
		expect(await Effect.runPromise(local.store.recordIds('people'))).toEqual([shared.recordId]);
	});

	it('appends an overlapping continuation to the same logical window', async () => {
		const local = await replica();
		const ada = baseRow('ada');
		const grace = baseRow('grace');
		const alan = baseRow('alan');
		const window = descriptor('window:growing');
		await Effect.runPromise(
			local.windows.installWindow(
				install(window, [ada, grace], {
					nextCursor: 'continuation:1',
					lookaheadCount: 1
				})
			)
		);
		const proof = await Effect.runPromise(
			local.windows.installWindow(
				install(window, [grace, alan], {
					orderedRowIds: [grace.recordId, alan.recordId],
					continuation: 'continuation:1'
				})
			)
		);

		expect(proof.orderedRowIds).toEqual([ada.recordId, grace.recordId, alan.recordId]);
		expect(proof.nextCursor).toBeNull();
		expect(
			Number((await Effect.runPromise(
				local.engine.query<{ readonly count: number | string }>(
					"select count(*) as count from bolt_replica_window where query_key = 'window:growing'"
				)
			)).rows[0]?.count)
		).toBe(1);
		expect(await Effect.runPromise(local.store.recordIds('people'))).toHaveLength(3);
	});

	it('preserves a partial refill tail until one bounded root capture covers it', async () => {
		const local = await replica();
		const first = baseRow('refill:first');
		const oldMiddle = baseRow('refill:old-middle');
		const oldTail = baseRow('refill:old-tail');
		const replacement = baseRow('refill:replacement');
		const newTail = baseRow('refill:new-tail');
		const window = descriptor('window:refill-boundary', 'server');
		await Effect.runPromise(local.windows.installWindow(
			install(window, [first, oldMiddle, oldTail], {
				nextCursor: 'old:next',
				lookaheadCount: 1
			})
		));
		await Effect.runPromise(local.windows.invalidateDependencies(['people']));

		const partial = await Effect.runPromise(local.windows.installWindow(
			install(window, [first], {
				nextCursor: 'partial:next',
				lookaheadCount: 1
			})
		));
		expect(partial).toMatchObject({
			valid: false,
			orderedRowIds: [first.recordId, oldMiddle.recordId, oldTail.recordId]
		});

		const converged = await Effect.runPromise(local.windows.installWindow(
			install(window, [first, replacement, newTail], {
				nextCursor: 'fresh:next',
				lookaheadCount: 1
			})
		));
		expect(converged).toMatchObject({
			valid: true,
			orderedRowIds: [first.recordId, replacement.recordId, newTail.recordId],
			nextCursor: 'fresh:next'
		});
	});

	it('applies only the latest causal fact per record while advancing the batch position once', async () => {
		const local = await replica();
		const shared = baseRow('versioned', 5);
		await Effect.runPromise(local.windows.installWindow(install(descriptor('window:versions'), [shared])));

		const outcome = await Effect.runPromise(
			local.windows.applyDeltaBatch({
				deltas: [
					{
						cursor: { xid: 1, sequence: 3 }, collection: 'people', op: 'upsert',
						recordId: shared.recordId, rowVersion: 6,
						row: { name: 'version 6', team: 'core' }, mutationId: null
					},
					{
						cursor: { xid: 1, sequence: 1 }, collection: 'people', op: 'upsert',
						recordId: shared.recordId, rowVersion: 4,
						row: { name: 'delayed version 4', team: 'core' }, mutationId: null
					},
					{
						cursor: { xid: 1, sequence: 2 }, collection: 'people', op: 'upsert',
						recordId: shared.recordId, rowVersion: 5,
						row: { name: 'duplicate version 5', team: 'core' }, mutationId: null
					}
				],
				headCursor: { xid: 1, sequence: 3 },
				generations: { people: 1 },
				affectedCollections: ['people'],
				refillCollections: []
			})
		);
		const physical = await Effect.runPromise(
			local.engine.query<{ readonly name: string; readonly row_version: number | string }>(
				'select name, row_version from people where id = $1::uuid',
				[shared.recordId]
			)
		);

		expect(outcome.applied).toBe(1);
		expect(physical.rows.map((row) => ({ name: row.name, version: Number(row.row_version) })))
			.toEqual([{ name: 'version 6', version: 6 }]);
		expect(await Effect.runPromise(local.windows.position())).toEqual({
			cursor: { xid: 1, sequence: 3 },
			generations: { people: 1 }
		});
	});

	it('marks a changed LocalExact window dirty but withdraws a ServerProof window', async () => {
		const local = await replica();
		const shared = baseRow('generation-change');
		await Effect.runPromise(local.windows.installWindow(install(descriptor('window:local'), [shared])));
		await Effect.runPromise(
			local.windows.installWindow(install(descriptor('window:server', 'server'), [shared]))
		);
		await Effect.runPromise(local.windows.acquireWindowLease('window:local', 'tab:active-local'));

		const outcome = await Effect.runPromise(
			local.windows.applyDeltaBatch({
				deltas: [{
					cursor: { xid: 2, sequence: 1 }, collection: 'people', op: 'upsert',
					recordId: shared.recordId, rowVersion: 2,
					row: { name: 'generation 1', team: 'core' }, mutationId: null
				}],
				headCursor: { xid: 2, sequence: 1 },
				generations: { people: 1 },
				affectedCollections: ['people'],
				refillCollections: []
			})
		);
		const localProof = await Effect.runPromise(
			local.windows.readWindow('window:local', (proof) => Effect.succeed(proof))
		);
		const serverProof = await Effect.runPromise(
			local.windows.readWindow('window:server', (proof) => Effect.succeed(proof))
		);

		expect(localProof).toMatchObject({ valid: false, dirty: true, proofOwner: 'local' });
		expect(serverProof).toMatchObject({ valid: false, dirty: false, proofOwner: 'server' });
		expect(outcome.affectedWindowIds).toHaveLength(2);
		expect(outcome.affectedWindowIds).toEqual(
			expect.arrayContaining(['window:local', 'window:server'])
		);
		expect(outcome.proofWithdrawals).toEqual(['window:server']);
		expect(await Effect.runPromise(local.windows.position())).toEqual({
			cursor: { xid: 2, sequence: 1 },
			generations: { people: 1 }
		});
	});

	it('does not advance O6 when installing a partial query window', async () => {
		const local = await replica();
		await Effect.runPromise(
			local.windows.recordPosition({
				cursor: { xid: 10, sequence: 0 },
				generations: { people: 10 }
			})
		);
		const row = baseRow('rolled-back');
		const proof = await Effect.runPromise(
			local.windows.installWindow(
				install(descriptor('window:partial'), [row], {
					readCursor: { xid: 9, sequence: 0 },
					dependencyGeneration: 9
				})
			)
		);

		const reconstructible = await Effect.runPromise(
			local.engine.query<{
				readonly base_rows: number | string;
				readonly memberships: number | string;
			}>(
				`select
				 (select count(*) from bolt_replica_base_row) as base_rows,
				 (select count(*) from bolt_replica_window_row) as memberships`
			)
		);
		expect(proof.valid).toBe(false);
		expect(await Effect.runPromise(local.store.recordIds('people'))).toEqual([row.recordId]);
		expect(await Effect.runPromise(local.windows.listWindows())).toHaveLength(1);
		expect(reconstructible.rows.map((counts) => ({
			baseRows: Number(counts.base_rows),
			memberships: Number(counts.memberships)
		}))).toEqual([{ baseRows: 1, memberships: 1 }]);
		expect(await Effect.runPromise(local.windows.position())).toEqual({
			cursor: { xid: 10, sequence: 0 },
			generations: { people: 10 }
		});
	});

	it('activates rehydrated proofs atomically with the final recorded position', async () => {
		const local = await replica();
		const row = baseRow('rehydrated');
		const before = await Effect.runPromise(local.windows.installWindow(
			install(descriptor('window:rehydrated'), [row], {
				readCursor: { xid: 8, sequence: 1 }, dependencyGeneration: 4
			})
		));
		expect(before.valid).toBe(false);

		await Effect.runPromise(local.windows.recordPosition({
			cursor: { xid: 8, sequence: 1 }, generations: { people: 4 }
		}));
		expect(await Effect.runPromise(
			local.windows.readWindow('window:rehydrated', (proof) => Effect.succeed(proof.valid))
		)).toBe(true);
	});

	it('rebuilds O3/O5/O6 without touching an external overlay marker', async () => {
		const local = await replica();
		await Effect.runPromise(
			local.engine.exec(
				`create table external_overlay_marker (id text primary key, payload jsonb not null);
				 insert into external_overlay_marker (id, payload)
				 values ('pending:1', '{"operation":"update"}'::jsonb)`
			)
		);
		const row = baseRow('rebuild');
		await Effect.runPromise(
			local.windows.installWindow(
				install(descriptor('window:rebuild'), [row], {
					readCursor: { xid: 3, sequence: 4 },
					dependencyGeneration: 2
				})
			)
		);

		await Effect.runPromise(local.windows.rebuildNamespace());
		const overlay = await Effect.runPromise(
			local.engine.query<{ readonly id: string; readonly payload: unknown }>(
				'select id, payload from external_overlay_marker'
			)
		);
		const ledgerCounts = await Effect.runPromise(
			local.engine.query<{
				readonly base_rows: number | string;
				readonly windows: number | string;
				readonly memberships: number | string;
			}>(
				`select
				 (select count(*) from bolt_replica_base_row) as base_rows,
				 (select count(*) from bolt_replica_window) as windows,
				 (select count(*) from bolt_replica_window_row) as memberships`
			)
		);

		expect(overlay.rows).toEqual([{ id: 'pending:1', payload: { operation: 'update' } }]);
		expect(ledgerCounts.rows.map((counts) => ({
			baseRows: Number(counts.base_rows),
			windows: Number(counts.windows),
			memberships: Number(counts.memberships)
		}))).toEqual([{ baseRows: 0, windows: 0, memberships: 0 }]);
		expect(await Effect.runPromise(local.store.recordIds('people'))).toEqual([]);
		expect(await Effect.runPromise(local.windows.position())).toEqual({
			cursor: { xid: 0, sequence: 0 },
			generations: {}
		});
	});

	it('does not retain an unseen ServerProof upsert', async () => {
		const local = await replica();
		const retained = baseRow('retained');
		const unseen = baseRow('unseen', 2);
		await Effect.runPromise(
			local.windows.installWindow(install(descriptor('window:server-bounded', 'server'), [retained]))
		);

		const outcome = await Effect.runPromise(local.windows.applyDeltaBatch({
			deltas: [{
				cursor: { xid: 4, sequence: 1 }, collection: 'people', op: 'upsert',
				recordId: unseen.recordId, rowVersion: unseen.rowVersion, row: unseen.row, mutationId: null
			}],
			headCursor: { xid: 4, sequence: 1 },
			generations: { people: 1 },
			affectedCollections: ['people'],
			refillCollections: []
		}));

		expect(outcome.applied).toBe(0);
		expect(outcome.proofWithdrawals).toEqual(['window:server-bounded']);
		expect(await Effect.runPromise(local.store.recordIds('people'))).toEqual([retained.recordId]);
		expect(await Effect.runPromise(
			local.windows.readWindow('window:server-bounded', (proof) => Effect.succeed(proof))
		)).toMatchObject({ valid: false, dirty: false });
	});

	it('stages unseen LocalExact rows only until recompute and pruning', async () => {
		const local = await replica();
		const retained = baseRow('local-retained');
		const candidate = baseRow('local-candidate', 2);
		await Effect.runPromise(
			local.windows.installWindow(install(descriptor('window:local-bounded'), [retained]))
		);
		await Effect.runPromise(
			local.windows.acquireWindowLease('window:local-bounded', 'tab:local-bounded')
		);
		await Effect.runPromise(local.windows.applyDeltaBatch({
			deltas: [{
				cursor: { xid: 5, sequence: 1 }, collection: 'people', op: 'upsert',
				recordId: candidate.recordId, rowVersion: candidate.rowVersion,
				row: candidate.row, mutationId: null
			}],
			headCursor: { xid: 5, sequence: 1 },
			generations: { people: 1 },
			affectedCollections: ['people'],
			refillCollections: []
		}));
		expect(await Effect.runPromise(local.store.recordIds('people'))).toEqual(
			expect.arrayContaining([retained.recordId, candidate.recordId])
		);

		expect(await Effect.runPromise(local.windows.recomputeWindow({
			queryKey: 'window:local-bounded',
			orderedRowIds: [retained.recordId],
			readCursor: { xid: 5, sequence: 1 },
			dependencyGenerations: { people: 1 },
			lookaheadCount: 0,
			nextCursor: null,
			boundaryCovered: true
		}))).toBe(true);
		await Effect.runPromise(local.windows.pruneBaseRows());
		expect(await Effect.runPromise(local.store.recordIds('people'))).toEqual([retained.recordId]);
	});

	it('allows a LocalExact recompute to retain an O4-created root without writing it to O3', async () => {
		const local = await replica();
		const retained = baseRow('overlay-retained');
		const optimisticId = rid('overlay-created');
		const window = {
			...descriptor('window:overlay-create'),
			canonical: {
				kind: 'findMany',
				collection: 'people',
				relationships: { manager: true }
			}
		};
		await Effect.runPromise(local.windows.installWindow(install(window, [retained])));
		await Effect.runPromise(local.windows.dirtyDependencies(['people']));

		expect(await Effect.runPromise(local.windows.recomputeWindow({
			queryKey: window.queryKey,
			orderedRowIds: [retained.recordId, optimisticId],
			optimisticRowIds: [optimisticId],
			readCursor: { xid: 0, sequence: 0 },
			dependencyGenerations: { people: 0 },
			lookaheadCount: 0,
			nextCursor: null,
			boundaryCovered: true
		}))).toBe(true);
		expect(await Effect.runPromise(local.store.hasRecord('people', optimisticId))).toBe(false);
		expect(await Effect.runPromise(
			local.windows.readWindow(window.queryKey, (proof) =>
				Effect.succeed({ valid: proof.valid, orderedRowIds: proof.orderedRowIds })
			)
		)).toEqual({
			valid: true,
			orderedRowIds: [retained.recordId, optimisticId]
		});
	});

	it('balances durable window leases by exact owner', async () => {
		const local = await replica();
		await Effect.runPromise(
			local.windows.installWindow(
				install(descriptor('window:leased'), [baseRow('leased')])
			)
		);

		expect(await Effect.runPromise(
			local.windows.acquireWindowLease('window:leased', 'tab:a')
		)).toBe(true);
		expect(await Effect.runPromise(
			local.windows.acquireWindowLease('window:leased', 'tab:a')
		)).toBe(false);
		expect(await Effect.runPromise(
			local.windows.acquireWindowLease('window:leased', 'tab:b')
		)).toBe(true);
		await Effect.runPromise(local.windows.installWindow(
			install(descriptor('window:leased'), [baseRow('leased')])
		));
		expect(await Effect.runPromise(
			local.windows.readWindow('window:leased', (proof) => Effect.succeed(proof.leaseCount))
		)).toBe(2);

		expect(await Effect.runPromise(
			local.windows.releaseWindowLease('window:leased', 'tab:missing')
		)).toBe(false);
		expect(await Effect.runPromise(
			local.windows.releaseWindowLease('window:leased', 'tab:a')
		)).toBe(true);
		expect(await Effect.runPromise(
			local.windows.releaseWindowLease('window:leased', 'tab:a')
		)).toBe(false);
		expect(await Effect.runPromise(
			local.windows.readWindow('window:leased', (proof) => Effect.succeed(proof.leaseCount))
		)).toBe(1);
		expect(await Effect.runPromise(
			local.windows.releaseWindowLease('window:leased', 'tab:b')
		)).toBe(true);
		expect(await Effect.runPromise(
			local.windows.readWindow('window:leased', (proof) => Effect.succeed(proof.leaseCount))
		)).toBe(0);
	});

	it('stages LocalExact flight deltas before the new window acquires its lease', async () => {
		const local = await replica();
		const retained = baseRow('flight-retained');
		const candidate = baseRow('flight-candidate', 2);
		await Effect.runPromise(local.windows.installWindow(
			install(descriptor('window:inactive'), [baseRow('inactive-retained')])
		));
		const proof = await Effect.runPromise(local.windows.installWindow({
			...install(descriptor('window:flight'), [retained]),
			bufferedDeltas: {
				deltas: [{
					cursor: { xid: 5, sequence: 2 }, collection: 'people', op: 'upsert',
					recordId: candidate.recordId, rowVersion: candidate.rowVersion,
					row: candidate.row, mutationId: null
				}],
				headCursor: { xid: 5, sequence: 2 },
				generations: { people: 2 },
				affectedCollections: ['people'],
				refillCollections: []
			}
		}));

		expect(proof).toMatchObject({ valid: false, dirty: true, leaseCount: 0 });
		expect(await Effect.runPromise(
			local.windows.readWindow('window:inactive', (value) => Effect.succeed(value))
		)).toMatchObject({ valid: false, dirty: false, leaseCount: 0 });
		expect(await Effect.runPromise(local.store.recordIds('people'))).toEqual(
			expect.arrayContaining([retained.recordId, candidate.recordId])
		);
	});

	it('does not explain away a same-collection refill invalidation', async () => {
		const local = await replica();
		const row = baseRow('link-invalidated');
		await Effect.runPromise(local.windows.installWindow(install(descriptor('window:link'), [row])));
		const outcome = await Effect.runPromise(local.windows.applyDeltaBatch({
			deltas: [{
				cursor: { xid: 6, sequence: 1 }, collection: 'people', op: 'upsert',
				recordId: row.recordId, rowVersion: 2,
				row: { name: 'changed', team: 'core' }, mutationId: null
			}],
			headCursor: { xid: 6, sequence: 1 },
			generations: { people: 1 },
			affectedCollections: ['people'],
			refillCollections: ['people']
		}));

		expect(outcome.proofWithdrawals).toEqual(['window:link']);
		expect(await Effect.runPromise(
			local.windows.readWindow('window:link', (proof) => Effect.succeed(proof))
		)).toMatchObject({ valid: false, dirty: false });
	});

	it('persists normalized edges and server results after proof withdrawal', async () => {
		const local = await replica();
		const source = baseRow('group-source');
		const target = baseRow('group-target');
		const edge = {
			sourceCollection: 'people', sourceRecordId: source.recordId, relation: 'manager',
			targetCollection: 'people', targetRecordId: target.recordId
		};
		await Effect.runPromise(local.windows.installWindow(install(
			descriptor('window:grouped', 'server'), [source, target], {
				orderedRowIds: [source.recordId],
				relationshipRefs: [edge],
				serverResult: { kind: 'findGrouped', groups: { core: [source.recordId] } }
			}
		)));
		await Effect.runPromise(local.windows.invalidateDependencies(['people']));
		const proof = await Effect.runPromise(
			local.windows.readWindow('window:grouped', (value) => Effect.succeed(value))
		);

		expect(proof).toMatchObject({
			valid: false,
			dirty: false,
			serverResult: { kind: 'findGrouped', groups: { core: [source.recordId] } },
			relationshipRefs: [edge]
		});
		await Effect.runPromise(local.windows.installWindow(install(
			descriptor('window:count', 'server'), [], {
				serverResult: { kind: 'count', value: 42 }
			}
		)));
		expect(await Effect.runPromise(
			local.windows.readWindow('window:count', (value) => Effect.succeed(value.serverResult))
		)).toEqual({ kind: 'count', value: 42 });
	});

	it('persists relationship membership across the bounded 500-edge write boundary', async () => {
		const local = await replica();
		const source = baseRow('relationship-batch:source');
		const targets = Array.from(
			{ length: 501 },
			(_, index) => baseRow(`relationship-batch:target:${index}`)
		);
		const relationshipRefs = targets.map((target) => ({
			sourceCollection: 'people',
			sourceRecordId: source.recordId,
			relation: 'reports',
			targetCollection: 'people',
			targetRecordId: target.recordId
		}));
		const proof = await Effect.runPromise(local.windows.installWindow(install(
			descriptor('window:relationship-batch', 'server'),
			[source, ...targets],
			{
				orderedRowIds: [source.recordId],
				relationshipRefs
			}
		)));
		const stored = await Effect.runPromise(local.engine.query<{ readonly count: number | string }>(
			`select count(*) as count from bolt_replica_window_relationship
			 where query_key = 'window:relationship-batch'`
		));

		expect(proof.relationshipRefs).toHaveLength(501);
		expect(Number(stored.rows[0]?.count)).toBe(501);
	});

	it('caps membership and lookahead before storing incoming rows', async () => {
		const local = await replica();
		const ids = Array.from({ length: 5_001 }, (_, index) => rid(`cap:${index}`));
		await expect(Effect.runPromise(local.windows.installWindow({
			...install(descriptor('window:too-large'), [], { orderedRowIds: ids }),
			orderedRowIds: ids
		}))).rejects.toThrow('Window membership exceeds the durable cap');
		expect(await Effect.runPromise(local.windows.listWindows())).toEqual([]);
	});

	it('expires inactive windows while preserving overlay-protected rows', async () => {
		const local = await replica();
		const row = baseRow('ttl-protected');
		await Effect.runPromise(local.windows.installWindow(install(descriptor('window:ttl'), [row])));
		await Effect.runPromise(local.engine.query(
			"update bolt_replica_window set expires_at = current_timestamp - interval '1 second'"
		));

		expect(await Effect.runPromise(
			local.windows.expireInactiveWindows([{ collection: 'people', recordId: row.recordId }])
		)).toEqual(['window:ttl']);
		expect(await Effect.runPromise(local.store.recordIds('people'))).toEqual([row.recordId]);
		await Effect.runPromise(local.windows.pruneBaseRows());
		expect(await Effect.runPromise(local.store.recordIds('people'))).toEqual([]);
	});

	it('keeps unexpired tombstones and collects them only after the safety horizon', async () => {
		const local = await replica();
		const row = baseRow('tombstone');
		await Effect.runPromise(local.windows.installWindow(install(descriptor('window:tombstone'), [row])));
		await Effect.runPromise(local.windows.applyDeltaBatch({
			deltas: [{
				cursor: { xid: 7, sequence: 1 }, collection: 'people', op: 'remove',
				recordId: row.recordId, rowVersion: 2, mutationId: null
			}],
			headCursor: { xid: 7, sequence: 1 },
			generations: { people: 1 },
			affectedCollections: ['people'],
			refillCollections: []
		}));
		await Effect.runPromise(local.windows.releaseWindow('window:tombstone'));
		const retained = await Effect.runPromise(local.engine.query<{ readonly count: number | string }>(
			'select count(*) as count from bolt_replica_base_row where record_id = $1::uuid',
			[row.recordId]
		));
		expect(Number(retained.rows[0]?.count)).toBe(1);
		await Effect.runPromise(local.engine.query(
			"update bolt_replica_base_row set tombstone_until = current_timestamp - interval '1 second'"
		));
		expect(await Effect.runPromise(local.windows.pruneBaseRows())).toBe(1);
	});
});
