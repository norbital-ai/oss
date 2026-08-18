import { describe, expect, it, vi } from 'vitest';
import type { Schema } from 'effect';
import { createLocalStore } from '../../src/client/replica/local-sql.js';
import {
	compareCursors,
	createSyncClient,
	isResetBatch,
	ORIGIN_CURSOR
} from '../../src/client/replica/sync-client.js';
import type { SyncChange, SyncCursor } from '../../src/runtime/sync/sync.js';

const change = (
	sequence: number,
	operation: SyncChange['operation'],
	recordId: string,
	record?: Record<string, Schema.Json>
): SyncChange => ({
	cursor: { xid: 1, sequence },
	collection: 'people',
	recordId,
	operation,
	...(record === undefined ? {} : { record })
});

/** Serves prepared batches in order, then nothing — the shape `sync.diff` presents to a client. */
const transportOf = (batches: ReadonlyArray<ReadonlyArray<SyncChange>>) => {
	const pending = [...batches];
	const requested: Array<SyncCursor> = [];
	return {
		requested,
		transport: {
			head: async (): Promise<SyncCursor> => ORIGIN_CURSOR,
			diff: async (cursor: SyncCursor): Promise<ReadonlyArray<SyncChange>> => {
				requested.push(cursor);
				return pending.shift() ?? [];
			}
		}
	};
};

describe('local replica store', () => {
	it('projects creates, merges partial updates, and drops deletes', async () => {
		const store = createLocalStore();
		await store.apply([change(1, 'create', 'p1', { name: 'Ada', team: 'core' })]);
		expect(store.row('people', 'p1')).toEqual({ name: 'Ada', team: 'core', norbital_id: 'p1' });

		// An update carries only what changed; replacing the row would lose `team`.
		await store.apply([change(2, 'update', 'p1', { name: 'Ada Lovelace' })]);
		expect(store.row('people', 'p1')).toEqual({
			name: 'Ada Lovelace',
			team: 'core',
			norbital_id: 'p1'
		});

		await store.apply([change(3, 'delete', 'p1')]);
		expect(store.row('people', 'p1')).toBeUndefined();
		expect(store.rows('people')).toEqual([]);
	});

	it('accepts a collection it has never seen', async () => {
		const store = createLocalStore();
		await store.apply([
			{
				cursor: { xid: 1, sequence: 1 },
				collection: 'newly_granted',
				recordId: 'x',
				operation: 'create',
				record: { a: 1 }
			}
		]);
		expect(store.collections()).toEqual(['newly_granted']);
	});

	it('drops everything on reset', async () => {
		const store = createLocalStore();
		await store.apply([change(1, 'create', 'p1', { name: 'Ada' })]);
		await store.apply([
			{ cursor: { xid: 2, sequence: 1 }, collection: '*', recordId: 'reset', operation: 'reset' }
		]);
		expect(store.collections()).toEqual([]);
	});

	it('hands out an isolated snapshot', async () => {
		const store = createLocalStore();
		await store.apply([change(1, 'create', 'p1', { name: 'Ada' })]);
		const snapshot = store.snapshot();
		await store.apply([change(2, 'create', 'p2', { name: 'Grace' })]);
		expect(snapshot.get('people')?.size).toBe(1);
		expect(store.rows('people')).toHaveLength(2);
	});
});

describe('replica sync client', () => {
	it('walks the cursor forward across batches until the server is empty', async () => {
		const { transport, requested } = transportOf([
			[change(1, 'create', 'p1', { name: 'Ada' }), change(2, 'create', 'p2', { name: 'Grace' })],
			[change(3, 'update', 'p1', { name: 'Ada Lovelace' })]
		]);
		const store = createLocalStore();
		const client = createSyncClient({
			transport,
			sink: { apply: store.apply, reset: store.reset },
			batchSize: 2
		});

		expect(await client.drain()).toBe(3);
		expect(requested).toEqual([
			{ xid: 0, sequence: 0 },
			{ xid: 1, sequence: 2 }
		]);
		expect(client.cursor()).toEqual({ xid: 1, sequence: 3 });
		expect(store.row('people', 'p1')).toMatchObject({ name: 'Ada Lovelace' });
	});

	it('stops after a short batch rather than asking again', async () => {
		const { transport, requested } = transportOf([[change(1, 'create', 'p1', { name: 'Ada' })]]);
		const store = createLocalStore();
		const client = createSyncClient({
			transport,
			sink: { apply: store.apply, reset: store.reset },
			batchSize: 50
		});
		expect(await client.drain()).toBe(1);
		expect(requested).toHaveLength(1);
	});

	it('rebuilds from the reset point when the cursor fell off retained history', async () => {
		const reset: SyncChange = {
			cursor: { xid: 9, sequence: 4 },
			collection: '*',
			recordId: 'reset',
			operation: 'reset'
		};
		const { transport } = transportOf([[reset], [change(5, 'create', 'p2', { name: 'Grace' })]]);
		const store = createLocalStore();
		await store.apply([change(1, 'create', 'p1', { name: 'stale' })]);
		const client = createSyncClient({
			transport,
			sink: { apply: store.apply, reset: store.reset },
			batchSize: 10
		});

		await client.drain();
		expect(store.row('people', 'p1')).toBeUndefined();
		expect(store.row('people', 'p2')).toMatchObject({ name: 'Grace' });
	});

	it('reports each advance so live queries can re-run', async () => {
		const { transport } = transportOf([[change(1, 'create', 'p1', { name: 'Ada' })]]);
		const store = createLocalStore();
		const onAdvance = vi.fn();
		const client = createSyncClient({
			transport,
			sink: { apply: store.apply, reset: store.reset },
			batchSize: 10,
			onAdvance
		});
		await client.drain();
		expect(onAdvance).toHaveBeenCalledWith({ xid: 1, sequence: 1 });
	});

	it('shares one pass between concurrent drains so no batch applies twice', async () => {
		const { transport, requested } = transportOf([[change(1, 'create', 'p1', { name: 'Ada' })]]);
		const store = createLocalStore();
		const client = createSyncClient({
			transport,
			sink: { apply: store.apply, reset: store.reset },
			batchSize: 10
		});
		const [first, second] = await Promise.all([client.drain(), client.drain()]);
		expect(first).toBe(second);
		expect(requested).toHaveLength(1);
	});

	it('surfaces a transport failure without advancing the cursor', async () => {
		const store = createLocalStore();
		const onError = vi.fn();
		const client = createSyncClient({
			transport: {
				head: async () => ORIGIN_CURSOR,
				diff: async () => {
					throw new Error('offline');
				}
			},
			sink: { apply: store.apply, reset: store.reset },
			onError
		});
		expect(await client.drain()).toBe(0);
		expect(onError).toHaveBeenCalled();
		expect(client.cursor()).toEqual(ORIGIN_CURSOR);
	});

	it('stops pulling once stopped', async () => {
		const { transport, requested } = transportOf([
			[change(1, 'create', 'p1', { name: 'Ada' })],
			[change(2, 'create', 'p2', { name: 'Grace' })]
		]);
		const store = createLocalStore();
		const client = createSyncClient({
			transport,
			sink: { apply: store.apply, reset: store.reset },
			batchSize: 1
		});
		client.stop();
		expect(await client.drain()).toBe(0);
		expect(requested).toHaveLength(0);
	});
});

describe('cursor ordering', () => {
	it('orders by transaction then sequence, matching the outbox', () => {
		expect(compareCursors({ xid: 1, sequence: 9 }, { xid: 2, sequence: 0 })).toBeLessThan(0);
		expect(compareCursors({ xid: 2, sequence: 3 }, { xid: 2, sequence: 1 })).toBeGreaterThan(0);
		expect(compareCursors({ xid: 2, sequence: 1 }, { xid: 2, sequence: 1 })).toBe(0);
	});

	it('recognises a reset batch', () => {
		expect(isResetBatch([change(1, 'create', 'p1', {})])).toBe(false);
		expect(
			isResetBatch([
				{ cursor: { xid: 1, sequence: 1 }, collection: '*', recordId: 'reset', operation: 'reset' }
			])
		).toBe(true);
	});
});
