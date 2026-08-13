import { describe, it, expect } from 'vitest';
import { SubscriptionRegistry } from '$lib/ui/sync/subscription-registry.js';
import type { PodSyncClient } from '$lib/ui/sync/pod-sync-client.js';
import type { CollectionSyncState, ShapeRequest, ShapeResponse } from '$lib/ui/sync/types.js';

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
	page?: (request: ShapeRequest, index: number) => ShapeResponse | Promise<ShapeResponse>;
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

	it('publishes live interest before a demanded collection waits behind another catch-up', async () => {
		let releaseOrders = () => {};
		const ordersBlocked = new Promise<void>((resolve) => {
			releaseOrders = resolve;
		});
		const { client, events } = stubClient({
			page: async (request) => {
				if (request.collection === 'orders') await ordersBlocked;
				return lastPage();
			}
		});
		const registry = new SubscriptionRegistry(client);

		const orders = registry.register('orders');
		await Promise.resolve();
		const sessions = registry.register('chat_session');
		await Promise.resolve();

		expect(events).toContain('subscribe:orders,chat_session');
		releaseOrders();
		await Promise.all([orders, sessions]);
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

	it('keeps the live stream up through the first page, then freezes it for remaining pages', async () => {
		const { client, events } = stubClient({
			page: (_request, index) => (index === 0 ? morePages(rowsOf(1)) : lastPage(rowsOf(1, 1)))
		});
		const registry = new SubscriptionRegistry(client);

		await registry.register('orders');
		await settle();

		expect(events).toEqual([
			'subscribe:orders',
			'shape:orders',
			'subscribe:orders',
			'stop',
			'subscribe:orders',
			'shape:orders',
			'subscribe:orders',
			'start'
		]);
	});

	it('starts a newly demanded first page while another collection is still catching up remaining pages', async () => {
		let releaseOrdersRemainder = () => {};
		const ordersRemainder = new Promise<void>((resolve) => {
			releaseOrdersRemainder = resolve;
		});
		let customersShapeStarted = false;
		const { client } = stubClient({
			page: async (request, index) => {
				if (request.collection === 'orders') {
					if (index === 0) return morePages(rowsOf(1));
					await ordersRemainder;
					return lastPage(rowsOf(1, 1));
				}
				customersShapeStarted = true;
				return lastPage();
			}
		});
		const registry = new SubscriptionRegistry(client);

		const orders = registry.register('orders');
		await orders;
		expect(registry.has('orders')).toBe(true);

		const customers = registry.register('customers');
		await Promise.resolve();
		await Promise.resolve();
		expect(customersShapeStarted).toBe(true);

		releaseOrdersRemainder();
		await customers;
		await settle();
	});

	it('holds restored state behind the live-cursor freshness barrier without re-fetching', async () => {
		const persisted = new Map<string, CollectionSyncState>([
			[
				'orders',
				{ collection: 'orders', resident: true, rows: 12, bytes: budgetForRows(12), syncedAt: 1 }
			]
		]);
		const { client, calls } = stubClient({ persisted });
		const registry = new SubscriptionRegistry(client);

		await registry.restore();
		expect(registry.has('orders')).toBe(true);
		expect(registry.isFresh('orders')).toBe(false);
		expect(registry.isHeldResident('orders')).toBe(true);
		expect(registry.isResident('orders')).toBe(false);

		await registry.register('orders');
		expect(calls.length).toBe(0);

		registry.markRestoredFresh();
		expect(registry.isFresh('orders')).toBe(true);
		expect(registry.isResident('orders')).toBe(true);
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

	describe('collections larger than the row cap', () => {
		it('stops at the row cap even when the byte budget is untouched', async () => {
			// A wide table of narrow rows: a 20k-row roster is a few MB and "fits" a 1 GiB byte
			// budget, yet downloading it is five-plus serialized round trips. The row cap must
			// window it the same way the byte budget windows a fat one.
			const { client, calls, recorded } = stubClient({
				page: (_request, index) => morePages(rowsOf(100, index * 100))
			});
			const registry = new SubscriptionRegistry(client, { maxResidentRows: 250 });

			await registry.register('orders');
			await settle();

			expect(registry.has('orders')).toBe(true);
			expect(registry.isResident('orders')).toBe(false);
			// Stops on the first page that crosses the cap; never speculatively pulls the rest.
			expect(calls.length).toBe(3);
			expect(recorded).toEqual([{ collection: 'orders', resident: false, rows: 300 }]);
		});

		it('still marks a collection resident when it ends before the row cap', async () => {
			// The cap is a ceiling, not a target: a collection that genuinely ends early is fully
			// local and gets the resident experience (counts, search, offline).
			const { client, recorded } = stubClient({
				page: (_request, index) =>
					index === 0 ? morePages(rowsOf(100)) : lastPage(rowsOf(100, 100))
			});
			const registry = new SubscriptionRegistry(client, { maxResidentRows: 1000 });

			await registry.register('orders');
			await settle();
			expect(registry.isResident('orders')).toBe(true);
			expect(recorded).toEqual([{ collection: 'orders', resident: true, rows: 200 }]);
		});

		it('exhaustion on a page boundary still wins over the row cap', async () => {
			// 250 rows exactly: the first page is also the last, so the collection is resident even
			// though it sits right at the default cap — nothing was left on the server to fetch.
			const { client, recorded } = stubClient({ page: () => lastPage(rowsOf(250)) });
			const registry = new SubscriptionRegistry(client);

			await registry.register('orders');
			await settle();
			expect(registry.isResident('orders')).toBe(true);
			expect(recorded).toEqual([{ collection: 'orders', resident: true, rows: 250 }]);
		});
	});
});
