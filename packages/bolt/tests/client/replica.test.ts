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
	record?: Record<string, Schema.Json>,
	xid = 1
): SyncChange => ({
	cursor: { xid, sequence },
	collection: 'people',
	recordId,
	operation,
	...(record === undefined ? {} : { record })
});

const reset = (cursor: SyncCursor): SyncChange => ({
	cursor,
	collection: '*',
	recordId: 'reset',
	operation: 'reset'
});

const isJsonRecord = (value: Schema.Json | undefined): value is Record<string, Schema.Json> =>
	value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);

const createTestSink = () => {
	const rows = new Map<string, Readonly<Record<string, unknown>>>();
	const resetRows = () => Effect.sync(() => rows.clear());
	const apply = (changes: ReadonlyArray<SyncChange>) =>
		Effect.sync(() => {
			for (const entry of changes) {
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
	return { apply, reset: resetRows, row: (id: string) => rows.get(id) };
};

describe('replica sync client', () => {
	it('applies one ordered SSE batch and records only its durable last cursor', async () => {
		const store = createTestSink();
		const advanced: Array<SyncCursor> = [];
		const client = await Effect.runPromise(
			createSyncClient({
				sink: { apply: store.apply, reset: store.reset },
				onAdvance: (cursor) => Effect.sync(() => advanced.push(cursor))
			})
		);

		const batch = [
			change(1, 'create', 'p1', { name: 'Ada' }),
			change(2, 'update', 'p1', { name: 'Ada Lovelace' })
		];
		expect(await Effect.runPromise(client.apply(batch))).toBe(2);
		expect(store.row('p1')).toMatchObject({ name: 'Ada Lovelace' });
		expect(client.cursor()).toEqual({ xid: 1, sequence: 2 });
		expect(advanced).toEqual([{ xid: 1, sequence: 2 }]);
	});

	it('ignores replayed entries while applying a fresh suffix after reconnect', async () => {
		const store = createTestSink();
		const applied = vi.fn(store.apply);
		const client = await Effect.runPromise(
			createSyncClient({
				sink: { apply: applied, reset: store.reset },
				initialCursor: { xid: 1, sequence: 2 }
			})
		);

		expect(
			await Effect.runPromise(
				client.apply([
					change(1, 'create', 'old', { name: 'Old' }),
					change(2, 'update', 'old', { name: 'Still old' }),
					change(3, 'create', 'fresh', { name: 'Fresh' })
				])
			)
		).toBe(1);
		expect(applied).toHaveBeenCalledWith([change(3, 'create', 'fresh', { name: 'Fresh' })]);
		expect(store.row('old')).toBeUndefined();
		expect(store.row('fresh')).toMatchObject({ name: 'Fresh' });
	});

	it('honours compaction resets and replacement-database resets that move backwards', async () => {
		const store = createTestSink();
		await Effect.runPromise(store.apply([change(1, 'create', 'stale', { name: 'Stale' })]));
		let resets = 0;
		const client = await Effect.runPromise(
			createSyncClient({
				sink: {
					apply: store.apply,
					reset: () =>
						Effect.sync(() => {
							resets += 1;
						}).pipe(Effect.andThen(store.reset()))
				},
				initialCursor: { xid: 9, sequence: 4 }
			})
		);

		// A new environment can legitimately have an outbox head below the persisted old environment.
		expect(await Effect.runPromise(client.apply([reset({ xid: 2, sequence: 1 })]))).toBe(1);
		expect(client.cursor()).toEqual({ xid: 2, sequence: 1 });
		expect(store.row('stale')).toBeUndefined();
		// Exact EventSource replay of the reset is ignored.
		expect(await Effect.runPromise(client.apply([reset({ xid: 2, sequence: 1 })]))).toBe(0);
		// A compaction horizon moves the same reset mechanism forward.
		expect(await Effect.runPromise(client.apply([reset({ xid: 12, sequence: 0 })]))).toBe(1);
		expect(resets).toBe(2);
	});

	it('refuses mixed reset and data frames without advancing', async () => {
		const store = createTestSink();
		const client = await Effect.runPromise(
			createSyncClient({ sink: { apply: store.apply, reset: store.reset } })
		);
		await expect(
			Effect.runPromise(
				client.apply([reset({ xid: 1, sequence: 1 }), change(2, 'create', 'p1', { name: 'Ada' })])
			)
		).rejects.toThrow('only change');
		expect(client.cursor()).toEqual(ORIGIN_CURSOR);
	});

	it('refuses an out-of-order data batch before writing or advancing', async () => {
		const store = createTestSink();
		const apply = vi.fn(store.apply);
		const client = await Effect.runPromise(
			createSyncClient({ sink: { apply, reset: store.reset } })
		);
		await expect(
			Effect.runPromise(
				client.apply([
					change(2, 'create', 'p2', { name: 'Grace' }),
					change(1, 'create', 'p1', { name: 'Ada' })
				])
			)
		).rejects.toThrow('out of cursor order');
		expect(apply).not.toHaveBeenCalled();
		expect(client.cursor()).toEqual(ORIGIN_CURSOR);
	});

	it('does not advance when the local database write fails', async () => {
		const client = await Effect.runPromise(
			createSyncClient({
				sink: {
					apply: () => Effect.fail(new Error('PGlite unavailable')),
					reset: () => Effect.void
				}
			})
		);
		await expect(
			Effect.runPromise(client.apply([change(1, 'create', 'p1', { name: 'Ada' })]))
		).rejects.toThrow('PGlite unavailable');
		expect(client.cursor()).toEqual(ORIGIN_CURSOR);
	});

	it('serializes overlapping DOM deliveries before the next batch observes the cursor', async () => {
		const order: Array<number> = [];
		const client = await Effect.runPromise(
			createSyncClient({
				sink: {
					apply: (changes) =>
						Effect.promise(
							() =>
								new Promise<void>((resolve) => {
									setTimeout(
										() => {
											order.push(changes[0]?.cursor.sequence ?? 0);
											resolve();
										},
										changes[0]?.cursor.sequence === 1 ? 20 : 0
									);
								})
						),
					reset: () => Effect.void
				}
			})
		);

		const [first, second] = await Promise.all([
			Effect.runPromise(client.apply([change(1, 'create', 'p1', { name: 'Ada' })])),
			Effect.runPromise(client.apply([change(2, 'create', 'p2', { name: 'Grace' })]))
		]);
		expect([first, second]).toEqual([1, 1]);
		expect(order).toEqual([1, 2]);
		expect(client.cursor()).toEqual({ xid: 1, sequence: 2 });
	});

	it('stops accepting batches once stopped', async () => {
		const store = createTestSink();
		const client = await Effect.runPromise(
			createSyncClient({ sink: { apply: store.apply, reset: store.reset } })
		);
		client.stop();
		expect(
			await Effect.runPromise(client.apply([change(1, 'create', 'p1', { name: 'Ada' })]))
		).toBe(0);
		expect(store.row('p1')).toBeUndefined();
	});
});

describe('cursor ordering', () => {
	it('orders by transaction then sequence, matching the outbox', () => {
		expect(compareCursors({ xid: 1, sequence: 9 }, { xid: 2, sequence: 0 })).toBeLessThan(0);
		expect(compareCursors({ xid: 2, sequence: 3 }, { xid: 2, sequence: 1 })).toBeGreaterThan(0);
		expect(compareCursors({ xid: 2, sequence: 1 }, { xid: 2, sequence: 1 })).toBe(0);
	});
});
