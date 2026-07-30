import { describe, it, expect } from 'vitest';
import { SubscriptionRegistry } from '$lib/client/sync/subscription-registry.js';
import type { PodSyncClient } from '$lib/client/sync/pod-sync-client.js';
import type { CollectionSyncState, ShapeRequest, ShapeResponse } from '$lib/client/sync/types.js';

/** A page with no `nextCursor` is the last one — that is the whole exhaustion signal. */
function lastPage(rows: Record<string, unknown>[] = []): ShapeResponse {
	return { rows, nextCursor: null, watermark: '0' };
}

function morePages(rows: Record<string, unknown>[]): ShapeResponse {
	return { rows, nextCursor: 'next', watermark: '0' };
}

function rowsOf(count: number, offset = 0): Record<string, unknown>[] {
	return Array.from({ length: count }, (_v, i) => ({ norbital_id: String(offset + i) }));
}

/**
 * The residency budget is measured in bytes, but these tests reason in rows. The stub's rows have
 * a fixed shape, so one is converted to the other by measuring the encoding the registry itself
 * charges against the budget.
 */
function budgetForRows(count: number): number {
	return JSON.stringify(rowsOf(count)).length;
}

type Stub = {
	client: PodSyncClient;
	calls: ShapeRequest[];
	recorded: { collection: string; resident: boolean; rows: number }[];
	notified: string[];
	events: string[];
};

function stubClient(options?: {
	page?: (request: ShapeRequest, index: number) => ShapeResponse;
	persisted?: Map<string, CollectionSyncState>;
}): Stub {
	const calls: ShapeRequest[] = [];
	const recorded: { collection: string; resident: boolean; rows: number }[] = [];
	const notified: string[] = [];
	const events: string[] = [];
	const client = {
		shapeSubscribe: async (request: ShapeRequest) => {
			events.push(`shape:${request.collection}`);
			const index = calls.length;
			calls.push(request);
			return options?.page?.(request, index) ?? lastPage();
		},
		loadSyncState: async () => options?.persisted ?? new Map<string, CollectionSyncState>(),
		recordSyncState: async (collection: string, resident: boolean, rows: number) => {
			recorded.push({ collection, resident, rows });
		},
		setSubscribedCollections: (collections: Iterable<string>) =>
			events.push(`subscribe:${[...collections].join(',')}`),
		notifyCollection: (collection: string) => notified.push(collection),
		startStream: () => {
			events.push('start');
		},
		stopStream: async () => {
			events.push('stop');
		}
	} as unknown as PodSyncClient;
	return { client, calls, recorded, notified, events };
}

/** `register` resolves on the first page; let the background catch-up finish. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SubscriptionRegistry', () => {
	it('catches a collection up once, no matter how many times it is registered', async () => {
		const { client, calls } = stubClient();
		const registry = new SubscriptionRegistry(client);

		await registry.register('orders');
		await registry.register('orders');
		expect(calls.length).toBe(1);
		expect(registry.size).toBe(1);
	});

	it('collapses concurrent registrations into one catch-up', async () => {
		const { client, calls } = stubClient();
		const registry = new SubscriptionRegistry(client);

		await Promise.all([registry.register('orders'), registry.register('orders')]);
		expect(calls.length).toBe(1);
		expect(registry.size).toBe(1);
	});

	it('is keyed by collection, so query variations cost nothing extra', async () => {
		// The point of collection-level sync: filtering and sorting are local afterwards, so there
		// is no second catch-up to pay for.
		const { client, calls } = stubClient();
		const registry = new SubscriptionRegistry(client);

		await registry.register('orders');
		await registry.register('orders');
		await registry.register('customers');
		expect(calls.length).toBe(2);
		expect(registry.size).toBe(2);
	});

	it('marks a fully-fetched collection resident and persists that', async () => {
		const { client, recorded } = stubClient({ page: () => lastPage(rowsOf(1)) });
		const registry = new SubscriptionRegistry(client);

		await registry.register('orders');
		await settle();
		expect(registry.isResident('orders')).toBe(true);
		expect(recorded).toEqual([{ collection: 'orders', resident: true, rows: 1 }]);
	});

	it('notifies once the first page lands so warm rows reach the UI', async () => {
		const { client, notified } = stubClient({ page: () => lastPage(rowsOf(1)) });
		const registry = new SubscriptionRegistry(client);

		await registry.register('orders');
		await settle();
		// Without this the rows sit in PGlite unread until an unrelated change invalidates.
		expect(notified).toContain('orders');
	});

	it('freezes the feed until catch-up completes, then subscribes before replaying it', async () => {
		const { client, events } = stubClient({
			page: (_request, index) => (index === 0 ? morePages(rowsOf(1)) : lastPage(rowsOf(1, 1)))
		});
		const registry = new SubscriptionRegistry(client);

		await registry.register('orders');
		await settle();

		expect(events).toEqual([
			'stop',
			'shape:orders',
			'subscribe:orders',
			'shape:orders',
			'subscribe:orders',
			'start'
		]);
	});

	it('restores persisted state so a reload reads locally without re-fetching', async () => {
		const persisted = new Map<string, CollectionSyncState>([
			['orders', { collection: 'orders', resident: true, rows: 12, syncedAt: 1 }]
		]);
		const { client, calls } = stubClient({ persisted });
		const registry = new SubscriptionRegistry(client);

		await registry.restore();
		expect(registry.has('orders')).toBe(true);
		expect(registry.isResident('orders')).toBe(true);

		await registry.register('orders');
		expect(calls.length).toBe(0);
	});

	it('leaves a collection unregistered when catch-up fails, so the next read retries', async () => {
		let fail = true;
		const calls: ShapeRequest[] = [];
		const client = {
			shapeSubscribe: async (request: ShapeRequest) => {
				calls.push(request);
				if (fail) throw new Error('offline');
				return lastPage();
			},
			loadSyncState: async () => new Map<string, CollectionSyncState>(),
			recordSyncState: async () => {},
			setSubscribedCollections: () => {},
			notifyCollection: () => {},
			startStream: () => {},
			stopStream: async () => {}
		} as unknown as PodSyncClient;
		const registry = new SubscriptionRegistry(client);

		await registry.register('orders');
		expect(registry.size).toBe(0);
		fail = false;
		await registry.register('orders');
		expect(calls.length).toBe(2);
		expect(registry.size).toBe(1);
	});

	describe('collections larger than the residency budget', () => {
		it('stops at the cap and marks the collection windowed, not resident', async () => {
			// Stands in for a slice of any size beyond the budget — a million rows behaves
			// identically, because the client stops as soon as it is over budget.
			const { client, calls, recorded } = stubClient({
				page: (_request, index) => morePages(rowsOf(100, index * 100))
			});
			const registry = new SubscriptionRegistry(client, { residencyBytes: budgetForRows(250) });

			await registry.register('orders');
			await settle();

			expect(registry.has('orders')).toBe(true);
			expect(registry.isResident('orders')).toBe(false);
			// Bounded work: it stops on the first page that takes it to the cap, and never
			// speculatively pulls the rest of an unbounded collection.
			expect(calls.length).toBe(3);
			expect(recorded).toEqual([{ collection: 'orders', resident: false, rows: 300 }]);
		});

		it('serves the first page before the budget is exhausted', async () => {
			const { client, calls } = stubClient({
				page: (_request, index) => morePages(rowsOf(100, index * 100))
			});
			const registry = new SubscriptionRegistry(client, { residencyBytes: budgetForRows(1000) });

			// The read unblocks on page 1, not on the whole catch-up — a large collection must not
			// hold up the first paint.
			await registry.register('orders');
			expect(registry.has('orders')).toBe(true);
			expect(calls.length).toBeLessThan(10);
		});

		it('keeps a windowed collection windowed across a reload', async () => {
			const persisted = new Map<string, CollectionSyncState>([
				['orders', { collection: 'orders', resident: false, rows: 25_000, bytes: 1, syncedAt: 1 }]
			]);
			const { client } = stubClient({ persisted });
			const registry = new SubscriptionRegistry(client);

			await registry.restore();
			// Readable, but never treated as complete — counts and search still go to the server.
			expect(registry.has('orders')).toBe(true);
			expect(registry.isResident('orders')).toBe(false);
		});
	});
});
