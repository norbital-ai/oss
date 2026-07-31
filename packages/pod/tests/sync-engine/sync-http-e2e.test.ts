import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { requireDocker } from '../support/pg-harness.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';
import { createClientDb } from '../support/pglite-node.js';
import { PodSyncClient } from '$lib/client/sync/pod-sync-client.js';
import type { SyncFetch } from '$lib/client/sync/types.js';
import {
	deleteServerRow,
	pickCollection,
	serverInsert,
	waitFor,
	type ProbeCollection
} from '../support/collection-probe.js';

requireDocker();

const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};

/** SyncFetch that talks to a real standalone-pod HTTP server over the network (Node global fetch). */
function httpSyncFetch(baseUrl: string): SyncFetch {
	return (path, init) =>
		fetch(`${baseUrl}/_runtime/${path}`, {
			method: init.method,
			headers: {
				...(init.body ? { 'content-type': 'application/json' } : {}),
				...(init.accept ? { accept: init.accept } : {})
			},
			...(init.body ? { body: init.body } : {}),
			signal: init.signal
		});
}

describe('Pod Sync — standalone HTTP transport (real socket + SSE)', () => {
	let harness: PodRuntimeHarness;
	let server: { url: string; close: () => Promise<void> };
	let collection: ProbeCollection;

	beforeAll(async () => {
		harness = await bootPodRuntime('construction');
		server = await harness.serveHttp(admin);
		collection = await pickCollection(harness);
	}, 180_000);

	afterAll(async () => {
		await server?.close();
		await harness?.stop();
	});

	it('propagates a committed change over the network via the SSE stream', async () => {
		const db = await createClientDb();
		const client = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: harness.schemaSql,
			fetch: httpSyncFetch(server.url)
		});
		await client.bootstrap();
		try {
			await client.shapeSubscribe({ collection: collection.name, pageSize: 200 });
			client.startStream();
			const id = await serverInsert(harness, collection);
			// The diff must arrive over a real HTTP/SSE socket and be applied to the local replica.
			const converged = await waitFor(
				async () => (await client.localVersion(collection.name, id)) !== null
			);
			expect(converged, `lastError=${String(client.lastError)}`).toBe(true);
		} finally {
			await client.close();
		}
	});

	/**
	 * A backlog is resolved concurrently — each diff re-reads its row under policy, and doing that
	 * one row at a time makes the feed's latency the batch size times a network round trip. What
	 * concurrency must not cost is emission order: a record's `create` and its later `delete` land
	 * in the same batch, and if the delete were emitted first the client would resurrect a record
	 * the server no longer has. The two are separated here by a crowd of unrelated rows, so an
	 * implementation that emitted diffs as they resolved rather than in feed order would show it.
	 */
	it('keeps a backlog in feed order, so a later delete still wins', async () => {
		const doomed = await serverInsert(harness, collection);
		for (let filler = 0; filler < 20; filler++) await serverInsert(harness, collection);
		await deleteServerRow(harness, collection.name, doomed);

		const db = await createClientDb();
		const client = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: harness.schemaSql,
			fetch: httpSyncFetch(server.url)
		});
		await client.bootstrap();
		try {
			// No catch-up: the whole burst must arrive through the stream as one backlog. Interest is
			// declared explicitly, because the server resolves contents only for subscribed
			// collections — an unsubscribed stream advances the cursor and sends no rows.
			client.subscribeCollection(collection.name);
			client.startStream();
			const drained = await waitFor(async () => (await client.count(collection.name)) >= 20);
			expect(drained, `lastError=${String(client.lastError)}`).toBe(true);
			expect(await client.localVersion(collection.name, doomed)).toBeNull();
		} finally {
			await client.close();
		}
	});

	it('serves the introspected schema and returns policy-scoped rows over HTTP', async () => {
		const schema = await fetch(`${server.url}/_runtime/sync/schema`).then((r) => r.text());
		// Additive DDL: a bare table carrying the primary key, then a column at a time.
		expect(schema).toContain(`CREATE TABLE IF NOT EXISTS "${collection.name}"`);
		expect(schema).toContain(`ALTER TABLE "${collection.name}" ADD COLUMN IF NOT EXISTS`);

		const id = await serverInsert(harness, collection);
		const page = await fetch(`${server.url}/_runtime/sync/shape`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ collection: collection.name, pageSize: 200 })
		}).then((r) => r.json() as Promise<{ rows: { norbital_id: string }[] }>);
		const row = page.rows.find((r) => r.norbital_id === id);
		expect(row, 'inserted row present in the HTTP shape page').toBeDefined();

		const head = await fetch(`${server.url}/_runtime/sync/head`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}'
		}).then((r) => r.json() as Promise<{ sequence: string }>);
		expect(head.sequence).toMatch(/^\d+$/);
	});

	it('rejects a create that does not carry a client-minted UUIDv7', async () => {
		const response = await fetch(`${server.url}/_runtime/sync/mutate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				mutations: [
					{
						clientId: 'invalid-create-id',
						collection: collection.name,
						action: 'create',
						row: { norbital_id: '00000000-0000-4000-8000-000000000000' }
					}
				]
			})
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			results: [
				{
					clientId: 'invalid-create-id',
					status: 'rejected',
					reason: 'INVALID_CREATE_ID'
				}
			]
		});
	});

	it('advances across unsubscribed outbox rows without resolving or emitting them', async () => {
		const db = await createClientDb();
		const client = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: harness.schemaSql,
			fetch: httpSyncFetch(server.url)
		});
		await client.bootstrap();
		try {
			await client.shapeSubscribe({ collection: collection.name, pageSize: 200 });
			client.startStream();
			const inserted = await harness.pool.query<{ seq: string }>(
				`INSERT INTO sync_outbox (collection, record_id, action, row_version)
				 VALUES ('not_subscribed', gen_random_uuid(), 'create', 1)
				 RETURNING seq::text AS seq`
			);
			const target = BigInt(inserted.rows[0]!.seq);
			const advanced = await waitFor(async () => {
				const meta = await client.queryLocal<{ value: string }>(
					`SELECT value FROM _pod_meta WHERE key = 'cursor'`
				);
				if (!meta[0]) return false;
				return BigInt((JSON.parse(meta[0].value) as { seq: string }).seq) >= target;
			});
			expect(advanced, `lastError=${String(client.lastError)}`).toBe(true);
			expect(client.lastError).toBeUndefined();
		} finally {
			await client.close();
		}
	});

	it('invalidates the replica immediately when a policy-bearing scope changes', async () => {
		const db = await createClientDb();
		const client = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: harness.schemaSql,
			fetch: httpSyncFetch(server.url)
		});
		await client.bootstrap();
		let resets = 0;
		client.onReset(() => (resets += 1));
		try {
			await client.shapeSubscribe({ collection: collection.name, pageSize: 200 });
			expect(await client.count(collection.name)).toBeGreaterThan(0);
			client.startStream();
			await harness.pool.query(
				`INSERT INTO sync_outbox (collection, record_id, action, row_version)
				 VALUES ('policy', gen_random_uuid(), 'update', 1)`
			);
			const reset = await waitFor(async () => resets === 1);
			expect(reset, `lastError=${String(client.lastError)}`).toBe(true);
			expect(await client.count(collection.name)).toBe(0);
		} finally {
			await client.close();
		}
	});
});
