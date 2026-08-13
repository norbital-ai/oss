import { afterEach, describe, expect, it } from 'vitest';
import { raceLocalAndServer } from '$lib/ui/state/query-race.js';
import {
	disableClientSync,
	enableClientSync,
	localFindMany,
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

describe('raceLocalAndServer', () => {
	it('starts the server request without waiting for a hung local read', async () => {
		let releaseLocal = () => {};
		const localBlocked = new Promise<void>((resolve) => {
			releaseLocal = resolve;
		});
		let serverStarted = false;
		const server = Promise.resolve().then(() => {
			serverStarted = true;
			return { rows: [{ norbital_id: 'server' }], nextCursor: null };
		});

		const raced = raceLocalAndServer(server, async () => {
			await localBlocked;
			return { rows: [{ norbital_id: 'local' }], nextCursor: null };
		});

		await flush();
		expect(serverStarted).toBe(true);
		releaseLocal();
		await expect(raced).resolves.toEqual({
			rows: [{ norbital_id: 'server' }],
			nextCursor: null
		});
	});

	it('uses a local value that arrives before the server settles', async () => {
		let releaseServer = () => {};
		const serverBlocked = new Promise<void>((resolve) => {
			releaseServer = resolve;
		});
		const absorbed: unknown[] = [];
		const server = serverBlocked.then(() => ({ rows: [{ norbital_id: 'server' }] }));
		const result = await raceLocalAndServer(
			server,
			async () => ({ rows: [{ norbital_id: 'local' }] }),
			(value) => absorbed.push(value)
		);
		expect(result).toEqual({ rows: [{ norbital_id: 'local' }] });
		releaseServer();
		await flush();
		expect(absorbed).toEqual([{ rows: [{ norbital_id: 'server' }] }]);
	});
});

describe('findMany local path vs another collection catch-up', () => {
	it('starts the server request without waiting for an in-flight catch-up of a different collection', async () => {
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

		let serverStarted = false;
		const server = Promise.resolve().then(() => {
			serverStarted = true;
			return { rows: [{ norbital_id: 'server' }], nextCursor: null };
		});

		try {
			const raced = raceLocalAndServer(server, () =>
				localFindMany(sync, 'customers', { limit: 10 })
			);
			await flush();
			expect(serverStarted).toBe(true);
			expect(ordersPages).toBeGreaterThan(1);
			releaseCustomerSelects();
			releaseOrdersRemainder();
			await raced;
		} finally {
			blockCustomerSelects = false;
			releaseCustomerSelects();
			releaseOrdersRemainder();
			await client.close();
		}
	});
});
