import { afterEach, describe, expect, it } from 'vitest';
import { workspaceRuntimeOperations } from '$lib/ui/state/client.js';
import { RemoteQueryResourceManager } from '$lib/ui/state/remote-query.svelte.js';
import {
	disableClientSync,
	enableClientSync,
	setLocalSchema,
	type LocalCollectionSchema
} from '$lib/ui/sync/client-sync.js';
import { PodSyncClient, type PgliteLike } from '$lib/ui/sync/pod-sync-client.js';
import type { SyncFetch } from '$lib/ui/sync/types.js';
import { createClientDb } from '../support/pglite-node.js';

const SCHEMA = `CREATE TABLE customers (
	norbital_id text PRIMARY KEY,
	norbital_row_version integer,
	name text
);
CREATE TABLE orders (
	norbital_id text PRIMARY KEY,
	norbital_row_version integer,
	status text
);`;

function installSchema(): void {
	setLocalSchema(
		new Map<string, LocalCollectionSchema>([
			[
				'customers',
				{
					name: 'customers',
					columns: ['norbital_id', 'norbital_row_version', 'name'],
					fieldKinds: {
						norbital_id: 'string',
						norbital_row_version: 'number',
						name: 'string'
					},
					searchFields: ['name'],
					relationships: []
				}
			],
			[
				'orders',
				{
					name: 'orders',
					columns: ['norbital_id', 'norbital_row_version', 'status'],
					fieldKinds: {
						norbital_id: 'string',
						norbital_row_version: 'number',
						status: 'string'
					},
					searchFields: ['status'],
					relationships: []
				}
			]
		])
	);
}

async function flush(times = 8): Promise<void> {
	for (let index = 0; index < times; index += 1) await Promise.resolve();
}

afterEach(() => {
	disableClientSync();
});

describe('visible reads race the server past background catch-up', () => {
	it('starts findMany against the server without waiting for another collection catch-up', async () => {
		installSchema();
		const raw = await createClientDb();
		let releaseCustomerSelects = () => {};
		const customerSelectsBlocked = new Promise<void>((resolve) => {
			releaseCustomerSelects = resolve;
		});
		let blockCustomerSelects = false;
		const db: PgliteLike = {
			query: async (sql, params) => {
				if (blockCustomerSelects && /FROM\s+"customers"/i.test(sql)) {
					await customerSelectsBlocked;
				}
				return raw.query(sql, params);
			},
			exec: (sql) => raw.exec(sql),
			close: () => raw.close?.()
		};

		let releaseOrdersRemainder = () => {};
		const ordersRemainderBlocked = new Promise<void>((resolve) => {
			releaseOrdersRemainder = resolve;
		});
		let ordersPages = 0;
		const syncFetch: SyncFetch = async (path, init) => {
			if (path.startsWith('sync/shape')) {
				const payload = JSON.parse(String(init.body ?? '{}')) as { collection?: string };
				if (payload.collection === 'orders') {
					ordersPages += 1;
					if (ordersPages > 1) await ordersRemainderBlocked;
					return new Response(
						JSON.stringify({
							rows: [
								{ norbital_id: `o${ordersPages}`, norbital_row_version: 1, status: 'open' }
							],
							nextCursor: ordersPages === 1 ? 'more' : null,
							watermark: '0'
						}),
						{ headers: { 'content-type': 'application/json' } }
					);
				}
			}
			return new Response(JSON.stringify({ rows: [], nextCursor: null, watermark: '0' }), {
				headers: { 'content-type': 'application/json' }
			});
		};

		const client = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: SCHEMA,
			fetch: syncFetch
		});
		await client.bootstrap();
		await client.upsertRows('customers', [
			{ norbital_id: 'c1', norbital_row_version: 1, name: 'Acme' }
		]);
		const sync = enableClientSync(client);
		await sync.registry.register('customers');

		const orders = sync.registry.register('orders');
		await orders;
		blockCustomerSelects = true;

		let findManyStarted = false;
		const previousFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url.includes('/_runtime/collections/findMany')) {
				findManyStarted = true;
				return new Response(JSON.stringify({ rows: [{ norbital_id: 'server' }], nextCursor: null }), {
					headers: { 'content-type': 'application/json' }
				});
			}
			return previousFetch(input, init);
		};

		try {
			const query = workspaceRuntimeOperations.db.findMany({
				collection: 'customers',
				limit: 10,
				trace: `race-${crypto.randomUUID()}`
			});
			await flush();
			expect(findManyStarted).toBe(true);
			expect(query.current).toBeUndefined();
			expect(query.loading).toBe(true);
		} finally {
			globalThis.fetch = previousFetch;
			blockCustomerSelects = false;
			releaseCustomerSelects();
			releaseOrdersRemainder();
			await client.close();
		}
	});
});

describe('remote query abort and cached current', () => {
	it('does not clear loading when generation N aborts and current is still undefined', async () => {
		const manager = new RemoteQueryResourceManager<string>();
		let loads = 0;
		const query = manager.query('abort-generation', (signal) => {
			loads += 1;
			if (loads === 1) {
				return new Promise<string>((_resolve, reject) => {
					signal?.addEventListener('abort', () => {
						reject(new DOMException('Aborted', 'AbortError'));
					});
				});
			}
			return new Promise<string>(() => {});
		});

		expect(query.loading).toBe(true);
		expect(query.current).toBeUndefined();
		await flush();
		void query.refresh();
		await flush();
		expect(loads).toBe(2);
		expect(query.current).toBeUndefined();
		expect(query.loading).toBe(true);
	});

	it('keeps loading true when the same generation aborts before any value exists', async () => {
		const manager = new RemoteQueryResourceManager<string>();
		const query = manager.query('abort-empty', async () => {
			throw new DOMException('Aborted', 'AbortError');
		});
		expect(query.loading).toBe(true);
		await flush();
		expect(query.current).toBeUndefined();
		expect(query.loading).toBe(true);
	});

	it('shows cached current while a refresh is in flight', async () => {
		const manager = new RemoteQueryResourceManager<string[]>();
		let loads = 0;
		let resolveRefresh: (value: string[]) => void = () => {};
		const query = manager.query('cached-refresh', () => {
			loads += 1;
			if (loads === 1) return Promise.resolve(['cached']);
			return new Promise<string[]>((resolve) => {
				resolveRefresh = resolve;
			});
		});

		await query;
		expect(query.current).toEqual(['cached']);
		expect(query.loading).toBe(false);

		const refresh = query.refresh();
		await flush();
		expect(query.current).toEqual(['cached']);
		expect(query.loading).toBe(false);
		const tableLoading = query.current === undefined;
		expect(tableLoading).toBe(false);

		resolveRefresh(['next']);
		await refresh;
		expect(query.current).toEqual(['next']);
		expect(query.loading).toBe(false);
	});
});
