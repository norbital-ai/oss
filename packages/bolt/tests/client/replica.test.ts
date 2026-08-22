import { describe, expect, it, vi } from 'vitest';
import { Effect, type Schema } from 'effect';
import {
	compareCursors,
	createSyncClient,
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

const isJsonRecord = (value: Schema.Json | undefined): value is Record<string, Schema.Json> =>
	value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);

/** Serves prepared batches in order, then nothing — the shape `sync.diff` presents to a client. */
const transportOf = (batches: ReadonlyArray<ReadonlyArray<SyncChange>>) => {
	const pending = [...batches];
	const requested: Array<SyncCursor> = [];
	return {
		requested,
		transport: {
			head: () => Effect.succeed(ORIGIN_CURSOR),
			diff: (cursor: SyncCursor) =>
				Effect.sync(() => {
					requested.push(cursor);
					return pending.shift() ?? [];
				})
		}
	};
};

const createTestSink = () => {
	const rows = new Map<string, Readonly<Record<string, unknown>>>();
	const reset = () => Effect.sync(() => rows.clear());
	const apply = (changes: ReadonlyArray<SyncChange>) =>
		Effect.sync(() => {
			for (const entry of changes) {
				if (entry.operation === 'reset') {
					rows.clear();
					continue;
				}
				if (entry.operation === 'delete') {
					rows.delete(entry.recordId);
					continue;
				}
				if (!isJsonRecord(entry.record)) continue;
				rows.set(entry.recordId, {
					...(rows.get(entry.recordId) ?? {}),
					...entry.record,
					id: entry.recordId
				});
			}
		});
	return { apply, reset, row: (id: string) => rows.get(id) };
};

describe('replica sync client', () => {
	it('walks the cursor forward across batches until the server is empty', async () => {
		const { transport, requested } = transportOf([
			[change(1, 'create', 'p1', { name: 'Ada' }), change(2, 'create', 'p2', { name: 'Grace' })],
			[change(3, 'update', 'p1', { name: 'Ada Lovelace' })]
		]);
		const store = createTestSink();
		const client = await Effect.runPromise(
			createSyncClient({
				transport,
				sink: { apply: store.apply, reset: store.reset },
				batchSize: 2
			})
		);

		expect(await Effect.runPromise(client.drain())).toBe(3);
		expect(requested).toEqual([
			{ xid: 0, sequence: 0 },
			{ xid: 1, sequence: 2 }
		]);
		expect(client.cursor()).toEqual({ xid: 1, sequence: 3 });
		expect(store.row('p1')).toMatchObject({ name: 'Ada Lovelace' });
	});

	it('stops after a short batch rather than asking again', async () => {
		const { transport, requested } = transportOf([[change(1, 'create', 'p1', { name: 'Ada' })]]);
		const store = createTestSink();
		const client = await Effect.runPromise(
			createSyncClient({
				transport,
				sink: { apply: store.apply, reset: store.reset },
				batchSize: 50
			})
		);
		expect(await Effect.runPromise(client.drain())).toBe(1);
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
		const store = createTestSink();
		await Effect.runPromise(store.apply([change(1, 'create', 'p1', { name: 'stale' })]));
		const client = await Effect.runPromise(
			createSyncClient({
				transport,
				sink: { apply: store.apply, reset: store.reset },
				batchSize: 10
			})
		);

		await Effect.runPromise(client.drain());
		expect(store.row('p1')).toBeUndefined();
		expect(store.row('p2')).toMatchObject({ name: 'Grace' });
	});

	it('reports each advance so live queries can re-run', async () => {
		const { transport } = transportOf([[change(1, 'create', 'p1', { name: 'Ada' })]]);
		const store = createTestSink();
		const onAdvance = vi.fn();
		const client = await Effect.runPromise(
			createSyncClient({
				transport,
				sink: { apply: store.apply, reset: store.reset },
				batchSize: 10,
				onAdvance: (cursor) => Effect.sync(() => onAdvance(cursor))
			})
		);
		await Effect.runPromise(client.drain());
		expect(onAdvance).toHaveBeenCalledWith({ xid: 1, sequence: 1 });
	});

	it('shares one pass between concurrent drains so no batch applies twice', async () => {
		const { transport, requested } = transportOf([[change(1, 'create', 'p1', { name: 'Ada' })]]);
		const store = createTestSink();
		const client = await Effect.runPromise(
			createSyncClient({
				transport,
				sink: { apply: store.apply, reset: store.reset },
				batchSize: 10
			})
		);
		const [first, second] = await Effect.runPromise(
			Effect.all([client.drain(), client.drain()], { concurrency: 'unbounded' })
		);
		expect(first).toBe(second);
		expect(requested).toHaveLength(1);
	});

	it('surfaces a transport failure without advancing the cursor', async () => {
		const store = createTestSink();
		const onError = vi.fn();
		const client = await Effect.runPromise(
			createSyncClient({
				transport: {
					head: () => Effect.succeed(ORIGIN_CURSOR),
					diff: () => Effect.fail(new Error('offline'))
				},
				sink: { apply: store.apply, reset: store.reset },
				onError
			})
		);
		expect(await Effect.runPromise(client.drain())).toBe(0);
		expect(onError).toHaveBeenCalled();
		expect(client.cursor()).toEqual(ORIGIN_CURSOR);
	});

	it('stops pulling once stopped', async () => {
		const { transport, requested } = transportOf([
			[change(1, 'create', 'p1', { name: 'Ada' })],
			[change(2, 'create', 'p2', { name: 'Grace' })]
		]);
		const store = createTestSink();
		const client = await Effect.runPromise(
			createSyncClient({
				transport,
				sink: { apply: store.apply, reset: store.reset },
				batchSize: 1
			})
		);
		client.stop();
		expect(await Effect.runPromise(client.drain())).toBe(0);
		expect(requested).toHaveLength(0);
	});
});

describe('cursor ordering', () => {
	it('orders by transaction then sequence, matching the outbox', () => {
		expect(compareCursors({ xid: 1, sequence: 9 }, { xid: 2, sequence: 0 })).toBeLessThan(0);
		expect(compareCursors({ xid: 2, sequence: 3 }, { xid: 2, sequence: 1 })).toBeGreaterThan(0);
		expect(compareCursors({ xid: 2, sequence: 1 }, { xid: 2, sequence: 1 })).toBe(0);
	});
});
