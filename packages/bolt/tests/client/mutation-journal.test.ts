import { describe, expect, it } from 'vitest';
import {
	createCollectionMutationJournal,
	discoverCollectionMutationJournals,
	locallyDurableMutationResult,
	mutationWireRequest,
	prepareLocalCollectionMutation,
	type MutationJournalStorage
} from '../../src/client/replica/mutation-journal.js';
import {
	deriveBaseThroughOverlay,
	overlayRowKey
} from '../../src/client/replica/overlay.js';

const storage = (): MutationJournalStorage => {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value)
	};
};

const serverPartitionKey = 'sha256:server-partition-a';
const schema2ServerPartitionKey = 'sha256:server-partition-a-schema-2';
const otherServerPartitionKey = 'sha256:server-partition-b';
const localActorBinding = 'replica:principal-alice:operator';
const otherLocalActorBinding = 'replica:principal-bob:operator';
const identity = {
	serverPartitionKey,
	localActorBinding,
	schemaFingerprint: 'sha256:schema-1'
} as const;

const draft = {
	action: 'update',
	collection: 'orders',
	values: { id: 'order-1', status: 'approved' },
	baseVersions: [
		{ row: { collection: 'orders', recordId: 'order-1' }, rowVersion: 3 }
	],
	overlay: [
		{
			kind: 'merge',
			row: { collection: 'orders', recordId: 'order-1' },
			values: { id: 'order-1', status: 'approved' }
		}
	],
	serverPartitionKey,
	localActorBinding
} as const;

describe('the durable browser mutation journal', () => {
	it('reuses one logical mutation across a reconstructed journal until it is terminal', async () => {
		const persisted = storage();
		let next = 0;
		const first = await createCollectionMutationJournal(identity, {
			storage: persisted,
			now: () => 1_700_000_000_000,
			randomId: () => `mutation-${(next += 1)}`
		});
		const reserved = await first.reserve(draft);

		const afterReload = await createCollectionMutationJournal(identity, {
			storage: persisted,
			now: () => 1_700_000_001_000,
			randomId: () => `mutation-${(next += 1)}`
		});
		expect(await afterReload.reserve(draft)).toEqual(reserved);
		expect(next).toBe(1);

		await afterReload.reconcile(reserved.idempotencyKey, { kind: 'accepted' });
		await afterReload.observeAuthoritativeBatch({
			deltas: [],
			confirmations: [
				{ mutationId: reserved.idempotencyKey, cursor: { xid: 10, sequence: 1 } }
			],
			mutationRejections: []
		});
		expect((await afterReload.reserve(draft)).idempotencyKey).toBe('mutation-2');
	});

	it('rehydrates a durable authority settlement while its overlay awaits confirmation', async () => {
		const persisted = storage();
		const first = await createCollectionMutationJournal(identity, {
			storage: persisted,
			now: () => 1_700_000_000_000,
			randomId: () => 'mutation-durable-settlement'
		});
		const reserved = await first.reserve(draft);
		await first.markPushing(reserved.idempotencyKey);
		await first.reconcile(reserved.idempotencyKey, { kind: 'accepted' });

		const afterReload = await createCollectionMutationJournal(identity, { storage: persisted });
		await expect(afterReload.settlement(reserved.idempotencyKey).wait()).resolves.toMatchObject({
			kind: 'accepted',
			idempotencyKey: reserved.idempotencyKey
		});
		expect((await afterReload.entries()).at(0)).toMatchObject({
			pushState: 'awaiting-authoritative-delta',
			authoritySettlement: { kind: 'accepted' }
		});
	});

	it('isolates policy-equivalent actors that share one physical server partition', async () => {
		const persisted = storage();
		let next = 0;
		const options = {
			storage: persisted,
			now: () => 1_700_000_000_000,
			randomId: () => `mutation-${(next += 1)}`
		};
		const journal = await createCollectionMutationJournal(identity, options);
		const original = await journal.reserve(draft);
		const changed = await journal.reserve({
			...draft,
			values: { ...draft.values, status: 'rejected' }
		});
		const otherPrincipal = await createCollectionMutationJournal(
			{
				serverPartitionKey,
				localActorBinding: otherLocalActorBinding,
				schemaFingerprint: 'sha256:schema-1'
			},
			options
		);
		expect(await otherPrincipal.entries()).toEqual([]);
		const bob = await otherPrincipal.reserve({
			...draft,
			localActorBinding: otherLocalActorBinding
		});
		expect(await discoverCollectionMutationJournals(localActorBinding, { storage: persisted })).toEqual([
			identity
		]);
		expect(
			await discoverCollectionMutationJournals(otherLocalActorBinding, { storage: persisted })
		).toEqual([
			{
				serverPartitionKey,
				localActorBinding: otherLocalActorBinding,
				schemaFingerprint: 'sha256:schema-1'
			}
		]);

		expect(new Set([original.idempotencyKey, changed.idempotencyKey, bob.idempotencyKey]).size).toBe(
			3
		);
	});

	it('refuses authoring before a server partition proof and rejects a changed proof at reserve', async () => {
		expect(() =>
			prepareLocalCollectionMutation({
				catalog: { orders: { relationships: [] } },
				collection: 'orders',
				values: { status: 'draft' },
				serverPartitionKey: undefined,
				localActorBinding,
				rowVersion: () => undefined,
				randomId: () => 'order-local'
			})
		).toThrow(/server partition proof is not known/i);
		expect(() =>
			prepareLocalCollectionMutation({
				catalog: { orders: { relationships: [] } },
				collection: 'orders',
				values: { status: 'draft' },
				serverPartitionKey,
				localActorBinding: undefined,
				rowVersion: () => undefined,
				randomId: () => 'order-local'
			})
		).toThrow(/local replica owner is not known/i);

		const journal = await createCollectionMutationJournal(identity, { storage: storage() });
		await expect(
			journal.reserve({ ...draft, serverPartitionKey: otherServerPartitionKey })
		).rejects.toThrow(/partition proof changed/i);
		await expect(
			journal.reserve({ ...draft, localActorBinding: otherLocalActorBinding })
		).rejects.toThrow(/replica owner changed/i);
	});

	it('never turns an unresolved old entry into a new write identity', async () => {
		const persisted = storage();
		let at = 1_700_000_000_000;
		let next = 0;
		const journal = await createCollectionMutationJournal(identity, {
			storage: persisted,
			now: () => at,
			randomId: () => `mutation-${(next += 1)}`
		});
		const first = await journal.reserve(draft);
		at += 8 * 24 * 60 * 60 * 1000;
		const replacement = await journal.reserve(draft);

		expect(replacement).toEqual(first);
	});

	it('quarantines work that crossed its declared offline compatibility horizon', async () => {
		let at = 1_700_000_000_000;
		const journal = await createCollectionMutationJournal(
			identity,
			{ storage: storage(), now: () => at, randomId: () => 'mutation-expired' }
		);
		const reserved = await journal.reserve({ ...draft, compatibilityHorizonMs: 100 });
		const settlement = journal.settlement(reserved.idempotencyKey);
		expect(reserved.compatibility).toEqual({
			authoredAtEpochMs: at,
			expiresAtEpochMs: at + 100,
			durationMs: 100
		});

		at += 101;
		expect(await journal.nextPushable()).toBeUndefined();
		await expect(settlement.settled).resolves.toMatchObject({
			kind: 'quarantined',
			quarantine: { code: 'compatibility-horizon-expired' }
		});
		expect((await journal.entries())[0]?.pushState).toBe('quarantined');
	});

	it('persists the complete graph, whole-row fences, partition binding, schema and device order', async () => {
		const persisted = storage();
		let next = 0;
		const journal = await createCollectionMutationJournal(
			identity,
			{
				storage: persisted,
				now: () => 1_700_000_000_000,
				randomId: () => `mutation-${(next += 1)}`
			}
		);
		const first = await journal.reserve({
			...draft,
			baseVersions: [
				{ row: { collection: 'orders', recordId: 'order-1' }, rowVersion: 3 },
				{ row: { collection: 'order_lines', recordId: 'line-1' }, rowVersion: 8 }
			],
			overlay: [
				{
					kind: 'merge',
					row: { collection: 'orders', recordId: 'order-1' },
					values: { status: 'approved' }
				},
				{ kind: 'remove', row: { collection: 'order_lines', recordId: 'line-1' } },
				{
					kind: 'replace',
					row: { collection: 'orders', recordId: 'order-new' },
					values: { id: 'order-new', status: 'draft', total: 10 }
				},
				{ kind: 'remove', row: { collection: 'orders', recordId: 'order-2' } }
			]
		});
		const second = await journal.reserve({
			action: 'delete',
			collection: 'orders',
			id: 'order-2',
			baseVersions: [
				{ row: { collection: 'orders', recordId: 'order-2' }, rowVersion: 5 }
			],
			overlay: [
				{ kind: 'remove', row: { collection: 'orders', recordId: 'order-2' } }
			],
			serverPartitionKey,
			localActorBinding
		});

		expect(first).toMatchObject({
			partitionKey: serverPartitionKey,
			schemaFingerprint: 'sha256:schema-1',
			originalIdempotencyKey: 'mutation-1',
			deviceSequence: 1,
			baseVersions: [
				{ row: { collection: 'orders', recordId: 'order-1' }, rowVersion: 3 },
				{ row: { collection: 'order_lines', recordId: 'line-1' }, rowVersion: 8 }
			],
			pushState: 'queued'
		});
		expect(first.overlay).toHaveLength(4);
		expect(second.deviceSequence).toBe(2);
		expect(mutationWireRequest(first)).toEqual({
			protocolVersion: 2,
			idempotencyKey: 'mutation-1',
			issuedAtEpochMs: 1_700_000_000_000,
			deviceSequence: 1,
			partitionKey: serverPartitionKey,
			schemaFingerprint: 'sha256:schema-1',
			graph: {
				action: 'update',
				collection: 'orders',
				values: { id: 'order-1', status: 'approved' }
			},
			baseVersions: [
				{ row: { collection: 'orders', recordId: 'order-1' }, rowVersion: 3 },
				{ row: { collection: 'order_lines', recordId: 'line-1' }, rowVersion: 8 }
			]
		});

		const retainedOldJournal = await createCollectionMutationJournal(
			identity,
			{ storage: persisted }
		);
		expect(await retainedOldJournal.entries()).toEqual([first, second]);
		const currentSchemaJournal = await createCollectionMutationJournal(
			{
				serverPartitionKey: schema2ServerPartitionKey,
				localActorBinding,
				schemaFingerprint: 'sha256:schema-2'
			},
			{ storage: persisted }
		);
		expect(await currentSchemaJournal.entries()).toEqual([]);
		expect(
			await discoverCollectionMutationJournals(localActorBinding, { storage: persisted })
		).toEqual([
			identity,
			{
				serverPartitionKey: schema2ServerPartitionKey,
				localActorBinding,
				schemaFingerprint: 'sha256:schema-2'
			}
		]);

		const otherPartition = await createCollectionMutationJournal(
			{
				serverPartitionKey: otherServerPartitionKey,
				localActorBinding,
				schemaFingerprint: 'sha256:schema-2'
			},
			{ storage: persisted }
		);
		expect(await otherPartition.entries()).toEqual([]);
	});

	it('expands nested graphs with stable create ids and every identified whole-row fence', () => {
		let generated = 0;
		const prepared = prepareLocalCollectionMutation({
			catalog: {
				orders: {
					relationships: [{ name: 'lines', target: 'order_lines', cardinality: 'many' }]
				},
				order_lines: {
					relationships: [
						{ name: 'components', target: 'components', cardinality: 'many' }
					]
				},
				components: { relationships: [] }
			},
			collection: 'orders',
			serverPartitionKey,
			localActorBinding,
			values: {
				reference: 'ORD-LOCAL',
				lines: [
					{ id: 'line-existing', sku: 'A-1' },
					{ sku: 'A-2', components: [{ quantity: 2 }] }
				]
			},
			rowVersion: (collection, recordId) =>
				collection === 'order_lines' && recordId === 'line-existing' ? 7 : undefined,
			randomId: () =>
				`00000000-0000-4000-8000-${String((generated += 1)).padStart(12, '0')}`
		});

		expect(prepared.projectedRow).toEqual({
			id: '00000000-0000-4000-8000-000000000001',
			reference: 'ORD-LOCAL',
			lines: [
				{ id: 'line-existing', sku: 'A-1' },
				{
					id: '00000000-0000-4000-8000-000000000002',
					sku: 'A-2',
					components: [
						{ id: '00000000-0000-4000-8000-000000000003', quantity: 2 }
					]
				}
			]
		});
		expect(prepared.draft).toMatchObject({
			action: 'create',
			collection: 'orders',
			baseVersions: [
				{ row: { collection: 'order_lines', recordId: 'line-existing' }, rowVersion: 7 }
			]
		});
		expect(prepared.draft.overlay).toEqual([
			{
				kind: 'merge',
				row: { collection: 'order_lines', recordId: 'line-existing' },
				values: { id: 'line-existing', sku: 'A-1' }
			},
			{
				kind: 'replace',
				row: {
					collection: 'components',
					recordId: '00000000-0000-4000-8000-000000000003'
				},
				values: { id: '00000000-0000-4000-8000-000000000003', quantity: 2 }
			},
			{
				kind: 'replace',
				row: {
					collection: 'order_lines',
					recordId: '00000000-0000-4000-8000-000000000002'
				},
				values: { id: '00000000-0000-4000-8000-000000000002', sku: 'A-2' }
			},
			{
				kind: 'replace',
				row: {
					collection: 'orders',
					recordId: '00000000-0000-4000-8000-000000000001'
				},
				values: {
					id: '00000000-0000-4000-8000-000000000001',
					reference: 'ORD-LOCAL'
				}
			}
		]);
		expect(prepared.affectedCollections).toEqual(['orders', 'order_lines', 'components']);
	});

	it('returns a local-durability acknowledgement with an independent settlement handle', async () => {
		const persisted = storage();
		const journal = await createCollectionMutationJournal(
			identity,
			{ storage: persisted, now: () => 1_700_000_000_000, randomId: () => 'mutation-local' }
		);
		const reserved = await journal.reserve(draft);
		const local = locallyDurableMutationResult(journal, reserved, {
			id: 'order-1',
			status: 'approved'
		});

		expect(local).toMatchObject({
			durability: 'local',
			pending: true,
			idempotencyKey: 'mutation-local',
			deviceSequence: 1,
			row: { id: 'order-1', status: 'approved' }
		});
		expect(await local.settlement.status()).toBe('queued');
		await journal.markPushing(reserved.idempotencyKey);
		await journal.reconcile(reserved.idempotencyKey, { kind: 'accepted' });
		await expect(local.settlement.settled).resolves.toMatchObject({
			kind: 'accepted',
			idempotencyKey: 'mutation-local'
		});
		expect((await journal.entries())[0]?.pushState).toBe('awaiting-authoritative-delta');
		const retirement = await journal.observeAuthoritativeBatch({
			deltas: [
				{
					mutationId: reserved.idempotencyKey,
					row: { collection: 'orders', recordId: 'order-1' },
					kind: 'upsert',
					rowVersion: 4
				}
			],
			confirmations: [
				{ mutationId: reserved.idempotencyKey, cursor: { xid: 20, sequence: 2 } }
			],
			mutationRejections: []
		});
		expect(retirement.retirements).toMatchObject([
			{
				idempotencyKey: reserved.idempotencyKey,
				affectedCollections: ['orders'],
				confirmationCursor: { xid: 20, sequence: 2 }
			}
		]);
		expect(await journal.entries()).toEqual([]);
	});

	it('pushes in device order and recovers an interrupted owner under the same identity', async () => {
		let at = 1_700_000_000_000;
		let next = 0;
		const journal = await createCollectionMutationJournal(
			identity,
			{
				storage: storage(),
				now: () => at,
				randomId: () => `mutation-push-${(next += 1)}`
			}
		);
		const first = await journal.reserve(draft);
		await journal.reserve({
			action: 'delete',
			collection: 'orders',
			id: 'order-2',
			baseVersions: [
				{ row: { collection: 'orders', recordId: 'order-2' }, rowVersion: 2 }
			],
			overlay: [
				{ kind: 'remove', row: { collection: 'orders', recordId: 'order-2' } }
			],
			serverPartitionKey,
			localActorBinding
		});
		expect((await journal.nextPushable())?.idempotencyKey).toBe(first.idempotencyKey);
		await journal.markPushing(first.idempotencyKey);
		expect(await journal.nextPushable()).toBeUndefined();

		at += 30_001;
		const recovered = await journal.nextPushable();
		expect(recovered).toMatchObject({
			idempotencyKey: first.idempotencyKey,
			deviceSequence: 1,
			pushState: 'queued',
			pushAttempts: 1
		});
		await journal.markPushing(first.idempotencyKey);
		expect(await journal.retry(first.idempotencyKey, new Error('offline'))).toMatchObject({
			idempotencyKey: first.idempotencyKey,
			pushState: 'queued',
			lastPushError: 'offline'
		});
	});

	it('reconciles rebase, rejection and quarantine without changing original identity', async () => {
		let at = 1_700_000_000_000;
		let next = 0;
		const journal = await createCollectionMutationJournal(
			identity,
			{
				storage: storage(),
				now: () => at,
				randomId: () => `mutation-${(next += 1)}`
			}
		);
		const rebasedOriginal = await journal.reserve(draft);
		const rebasedSettlement = journal.settlement(rebasedOriginal.idempotencyKey);
		await journal.markPushing(rebasedOriginal.idempotencyKey);
		const rebased = await journal.reconcile(rebasedOriginal.idempotencyKey, {
			kind: 'rebased',
			fromSchemaFingerprint: 'sha256:schema-1',
			toSchemaFingerprint: 'sha256:schema-2'
		});
		expect(rebased.mutation).toMatchObject({
			idempotencyKey: rebasedOriginal.idempotencyKey,
			originalIdempotencyKey: rebasedOriginal.idempotencyKey,
			deviceSequence: rebasedOriginal.deviceSequence,
			schemaFingerprint: 'sha256:schema-1',
			pushState: 'awaiting-authoritative-delta'
		});
		await expect(rebasedSettlement.settled).resolves.toMatchObject({
			kind: 'rebased',
			fromSchemaFingerprint: 'sha256:schema-1',
			toSchemaFingerprint: 'sha256:schema-2'
		});
		await journal.observeAuthoritativeBatch({
			deltas: [],
			confirmations: [
				{ mutationId: rebasedOriginal.idempotencyKey, cursor: { xid: 30, sequence: 1 } }
			],
			mutationRejections: []
		});

		const rejected = await journal.reserve({
			action: 'delete',
			collection: 'orders',
			id: 'order-2',
			baseVersions: [
				{ row: { collection: 'orders', recordId: 'order-2' }, rowVersion: 2 }
			],
			overlay: [
				{ kind: 'remove', row: { collection: 'orders', recordId: 'order-2' } }
			],
			serverPartitionKey,
			localActorBinding
		});
		const rejectedSettlement = journal.settlement(rejected.idempotencyKey);
		const rejectedResult = await journal.reconcile(rejected.idempotencyKey, {
			kind: 'rejected',
			code: 'invariant',
			message: 'The order is already paid.'
		});
		expect(rejectedResult.retirement).toMatchObject({
			reason: 'rejected',
			idempotencyKey: rejected.idempotencyKey
		});
		await expect(rejectedSettlement.settled).resolves.toMatchObject({
			kind: 'rejected',
			code: 'invariant'
		});
		expect(
			(await journal.entries()).some((entry) => entry.idempotencyKey === rejected.idempotencyKey)
		).toBe(false);

		const quarantined = await journal.reserve({
			action: 'delete',
			collection: 'orders',
			id: 'order-3',
			baseVersions: [
				{ row: { collection: 'orders', recordId: 'order-3' }, rowVersion: 6 }
			],
			overlay: [
				{ kind: 'remove', row: { collection: 'orders', recordId: 'order-3' } }
			],
			serverPartitionKey,
			localActorBinding
		});
		const quarantineSettlement = journal.settlement(quarantined.idempotencyKey);
		at += 1_000;
		await journal.reconcile(quarantined.idempotencyKey, {
			kind: 'quarantined',
			code: 'schema-incompatible',
			message: 'The old field no longer has a safe adapter.'
		});
		await expect(quarantineSettlement.wait()).resolves.toMatchObject({
			kind: 'quarantined',
			quarantine: { code: 'schema-incompatible' }
		});
		expect((await journal.entries()).at(-1)).toMatchObject({
			idempotencyKey: quarantined.idempotencyKey,
			pushState: 'quarantined'
		});
	});

	it('accumulates exact mutation provenance across batches and confirms write-only mutations', async () => {
		const persisted = storage();
		const journal = await createCollectionMutationJournal(identity, {
			storage: persisted,
			randomId: () => 'mutation-provenance'
		});
		const reserved = await journal.reserve({
			...draft,
			overlay: [
				{
					kind: 'merge',
					row: { collection: 'orders', recordId: 'order-1' },
					values: { status: 'approved' }
				},
				{
					kind: 'replace',
					row: { collection: 'order_lines', recordId: 'line-local' },
					values: { id: 'line-local', sku: 'A-1' }
				}
			]
		});
		await journal.reconcile(reserved.idempotencyKey, { kind: 'accepted' });
		expect(await journal.pendingAuthoritativeMutationIds()).toEqual([
			reserved.idempotencyKey
		]);
		expect(
			await journal.observeAuthoritativeBatch({
				deltas: [
					{
						mutationId: reserved.idempotencyKey,
						row: { collection: 'orders', recordId: 'order-1' },
						kind: 'upsert',
						rowVersion: 4
					}
				],
				confirmations: [],
				mutationRejections: []
			})
		).toEqual({ retirements: [] });

		const afterReload = await createCollectionMutationJournal(identity, { storage: persisted });
		expect((await afterReload.entries())[0]?.authoritative.changes).toHaveLength(1);
		await afterReload.observeAuthoritativeBatch({
			deltas: [
				{
					mutationId: reserved.idempotencyKey,
					row: { collection: 'order_lines', recordId: 'line-local' },
					kind: 'upsert',
					rowVersion: 1
				}
			],
			confirmations: [],
			mutationRejections: []
		});
		const completed = await afterReload.observeAuthoritativeBatch({
			deltas: [],
			confirmations: [
				{ mutationId: reserved.idempotencyKey, cursor: { xid: 40, sequence: 2 } }
			],
			mutationRejections: []
		});
		expect(completed.retirements).toMatchObject([
			{
				idempotencyKey: reserved.idempotencyKey,
				affectedCollections: ['orders', 'order_lines'],
				authoritativeChanges: [{ rowVersion: 4 }, { rowVersion: 1 }]
			}
		]);

		const writeOnly = await afterReload.reserve({
			...draft,
			values: { ...draft.values, status: 'write-only' }
		});
		const writeOnlyConfirmation = await afterReload.observeAuthoritativeBatch({
			deltas: [{
				mutationId: null,
				row: { collection: 'unrelated', recordId: 'other' },
				kind: 'upsert',
				rowVersion: 1
			}],
			confirmations: [
				{ mutationId: writeOnly.idempotencyKey, cursor: { xid: 41, sequence: 1 } }
			],
			mutationRejections: []
		});
		expect(writeOnlyConfirmation).toEqual({ retirements: [] });
		const writeOnlyCompleted = await afterReload.reconcile(writeOnly.idempotencyKey, {
			kind: 'accepted'
		});
		expect(writeOnlyCompleted.retirement).toMatchObject({
			idempotencyKey: writeOnly.idempotencyKey,
			authoritativeChanges: []
		});

		const pendingApproval = await afterReload.reserve({
			...draft,
			values: { ...draft.values, status: 'pending-approval' }
		});
		await afterReload.reconcile(pendingApproval.idempotencyKey, { kind: 'accepted' });
		const approvalRejected = await afterReload.observeAuthoritativeBatch({
			deltas: [],
			confirmations: [],
			mutationRejections: [
				{
					mutationId: pendingApproval.idempotencyKey,
					code: 'refused',
					message: 'The approval request was discarded.'
				}
			]
		});
		expect(approvalRejected.retirements[0]).toMatchObject({
			reason: 'rejected',
			idempotencyKey: pendingApproval.idempotencyKey,
			rejection: { code: 'refused' }
		});
		expect((await afterReload.snapshot()).issues.at(-1)).toMatchObject({
			kind: 'rejected',
			idempotencyKey: pendingApproval.idempotencyKey
		});
	});

	it('publishes payload-free snapshots and retains sync issues for a reconstructed shell', async () => {
		const persisted = storage();
		const journal = await createCollectionMutationJournal(
			identity,
			{
				storage: persisted,
				now: () => 1_700_000_000_000,
				randomId: () => 'mutation-issue'
			}
		);
		const snapshots: Array<Awaited<ReturnType<typeof journal.snapshot>>> = [];
		const unsubscribe = journal.subscribe((snapshot) => snapshots.push(snapshot));
		const reserved = await journal.reserve(draft);
		await Promise.resolve();
		expect(snapshots.at(-1)?.mutations).toEqual([
			{
				idempotencyKey: 'mutation-issue',
				deviceSequence: 1,
				collection: 'orders',
				action: 'update',
				schemaFingerprint: 'sha256:schema-1',
				issuedAtEpochMs: 1_700_000_000_000,
				pushState: 'queued',
				pushAttempts: 0
			}
		]);

		await journal.reconcile(reserved.idempotencyKey, {
			kind: 'rejected',
			code: 'forbidden',
			message: 'Authority changed while offline.'
		});
		await Promise.resolve();
		expect(snapshots.at(-1)).toMatchObject({
			mutations: [],
			issues: [
				{
					kind: 'rejected',
					idempotencyKey: 'mutation-issue',
					message: 'Authority changed while offline.'
				}
			]
		});
		unsubscribe();

		const afterReload = await createCollectionMutationJournal(
			identity,
			{ storage: persisted }
		);
		expect((await afterReload.snapshot()).issues).toHaveLength(1);
		await afterReload.dismissIssue('mutation-issue');
		expect((await afterReload.snapshot()).issues).toEqual([]);
	});

	it('derives reads through ordered overlays and protects every referenced row from eviction', async () => {
		const journal = await createCollectionMutationJournal(
			{
				serverPartitionKey: 'partition-a',
				localActorBinding,
				schemaFingerprint: 'sha256:schema-1'
			},
			{ storage: storage(), randomId: () => 'mutation-overlay' }
		);
		const reserved = await journal.reserve({
			...draft,
			serverPartitionKey: 'partition-a',
			overlay: [
				{
					kind: 'merge',
					row: { collection: 'orders', recordId: 'order-1' },
					values: { status: 'approved' }
				},
				{ kind: 'remove', row: { collection: 'order_lines', recordId: 'line-1' } },
				{
					kind: 'replace',
					row: { collection: 'orders', recordId: 'order-new' },
					values: { id: 'order-new', status: 'draft', total: 10 }
				},
				{ kind: 'remove', row: { collection: 'orders', recordId: 'order-2' } }
			]
		});
		const projection = deriveBaseThroughOverlay(
			{
				serverPartitionKey: 'partition-after-m3',
				localActorBinding,
				collection: 'orders'
			},
			[
				{
					partitionKey: 'partition-after-m3',
					collection: 'orders',
					recordId: 'order-1',
					rowVersion: 3,
					row: { id: 'order-1', status: 'draft', total: 25 }
				},
				{
					partitionKey: 'partition-after-m3',
					collection: 'orders',
					recordId: 'order-2',
					rowVersion: 4,
					row: { id: 'order-2', status: 'draft', total: 15 }
				},
				{
					partitionKey: 'partition-after-m3',
					collection: 'order_lines',
					recordId: 'line-1',
					rowVersion: 8,
					row: { id: 'line-1', sku: 'A-1' }
				}
			],
			await journal.overlay()
		);
		const orderKey = overlayRowKey({ collection: 'orders', recordId: 'order-1' });
		const lineKey = overlayRowKey({ collection: 'order_lines', recordId: 'line-1' });
		const createdKey = overlayRowKey({ collection: 'orders', recordId: 'order-new' });
		const deletedKey = overlayRowKey({ collection: 'orders', recordId: 'order-2' });

		expect(projection.rows.get(orderKey)).toEqual({
			id: 'order-1',
			status: 'approved',
			total: 25
		});
		expect(projection.rows.has(lineKey)).toBe(false);
		expect(projection.rows.get(createdKey)).toMatchObject({ id: 'order-new', total: 10 });
		expect(projection.rows.has(deletedKey)).toBe(false);
		expect(projection.protectedRows).toEqual(
			new Set([orderKey, lineKey, createdKey, deletedKey])
		);
		expect(await journal.protectedRows()).toEqual([
			{ collection: 'orders', recordId: 'order-1' },
			{ collection: 'order_lines', recordId: 'line-1' },
			{ collection: 'orders', recordId: 'order-new' },
			{ collection: 'orders', recordId: 'order-2' }
		]);

		await journal.reconcile(reserved.idempotencyKey, {
			kind: 'quarantined',
			code: 'manual-review',
			message: 'Keep the old namespace until this graph is exported.'
		});
		const quarantinedProjection = deriveBaseThroughOverlay(
			{
				serverPartitionKey: 'partition-after-m3',
				localActorBinding,
				collection: 'orders'
			},
			[
				{
					partitionKey: 'partition-after-m3',
					collection: 'orders',
					recordId: 'order-1',
					rowVersion: 3,
					row: { id: 'order-1', status: 'draft', total: 25 }
				}
			],
			await journal.overlay()
		);
		expect(quarantinedProjection.rows.get(orderKey)).toMatchObject({ status: 'draft' });
		expect(quarantinedProjection.protectedRows.has(orderKey)).toBe(true);
	});
});
