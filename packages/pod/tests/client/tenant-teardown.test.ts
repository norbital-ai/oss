import { describe, it, expect, afterEach } from 'vitest';
import {
	disableClientSync,
	localFindMany,
	setLocalSchema,
	enableClientSync,
	getClientSync,
	type LocalCollectionSchema
} from '$lib/client/sync/client-sync.js';
import { PodSyncClient } from '$lib/client/sync/pod-sync-client.js';
import { teardownClientSync } from '$lib/client/sync/replica.js';
import { createClientDb } from '../support/pglite-node.js';
import type { SyncFetch } from '$lib/client/sync/types.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Switching organizations without reloading the document is only safe if every piece of
 * tenant-scoped module state is dropped. These pin the pieces individually, because the failure
 * they guard against is silent: one survivor and the next organization is shown the previous
 * one's records.
 */
const noopFetch: SyncFetch = async () =>
	new Response('{}', { headers: { 'content-type': 'application/json' } });

afterEach(() => disableClientSync());

describe('leaving a tenant drops everything scoped to it', () => {
	/**
	 * The teardown enumerates the caches it clears, and enumeration rots: the way this breaks is
	 * someone adding a seventh `RemoteQueryResourceManager` and not adding it to the list. That
	 * cannot be caught by exercising the function — the new cache simply survives the switch and
	 * shows the previous organization's rows. So the source is checked against itself.
	 */
	it('clears every query cache the module declares, not just the ones remembered', () => {
		const source = readFileSync(
			fileURLToPath(new URL('../../src/lib/runtime/client.ts', import.meta.url)),
			'utf8'
		);
		const declared = [...source.matchAll(/const (\w+) = new RemoteQueryResourceManager</g)].map(
			(match) => match[1]
		);
		expect(declared.length).toBeGreaterThan(0);

		const reset = /export function resetWorkspaceRuntime\(\): void \{[\s\S]*?\n\}/.exec(
			source
		)?.[0];
		expect(reset).toBeDefined();
		for (const name of declared) {
			expect(reset, `resetWorkspaceRuntime must clear ${name}`).toContain(name!);
		}
		// And the collection client, which is built from the departing tenant's manifest.
		expect(reset).toContain('initializedWorkspaceClient');
	});

	it('drops the published schema, so the next tenant cannot compile against this one', async () => {
		const schema = new Map<string, LocalCollectionSchema>([
			[
				'employees',
				{
					name: 'employees',
					columns: ['norbital_id'],
					fieldKinds: { norbital_id: 'string' },
					searchFields: [],
					relationships: []
				}
			]
		]);
		setLocalSchema(schema);

		const db = await createClientDb();
		await db.exec('CREATE TABLE employees (norbital_id text PRIMARY KEY)');
		const client = new PodSyncClient({ db, schemaSql: '', fetch: noopFetch });
		await client.bootstrap();
		const sync = enableClientSync(client);
		try {
			disableClientSync();
			expect(getClientSync()).toBeUndefined();

			// The schema is gone with it: a read compiled now has no columns or relationships to
			// work from, so it cannot silently produce the previous tenant's shape.
			expect(await localFindMany(sync, 'employees', {})).toBeNull();
		} finally {
			await client.close();
		}
	});
});

/**
 * The teardown that an organization switch depends on, exercised end to end against a real PGlite.
 *
 * This is the leak-critical path: `switchOrganization` unmounts the tree and calls these, then
 * mounts again. If any of it is a no-op the next organization is handed the previous one's
 * database handle, its rows, or its "this device already has data" answer.
 */
describe('teardownClientSync leaves nothing of the departing tenant behind', () => {
	it('closes the replica and forgets the sync handle', async () => {
		const db = await createClientDb();
		await db.exec('CREATE TABLE employees (norbital_id text PRIMARY KEY)');
		const client = new PodSyncClient({ db, schemaSql: '', fetch: noopFetch });
		await client.bootstrap();
		await client.upsertRows('employees', [{ norbital_id: 'tenant-a-row' }]);
		enableClientSync(client);
		expect(getClientSync()).toBeDefined();

		await teardownClientSync();

		// The handle is gone, so nothing can reach the old replica through the module.
		expect(getClientSync()).toBeUndefined();
		// And the connection is actually closed, not merely dereferenced — a leaked SharedWorker
		// port would outlive every switch for the life of the tab.
		await expect(client.queryLocal('SELECT 1')).rejects.toBeTruthy();
	});

	it('is safe to call when no replica was ever opened', async () => {
		// The switch runs this unconditionally; a tenant whose replica failed to open must not
		// turn a workspace switch into an unhandled rejection.
		await expect(teardownClientSync()).resolves.toBeUndefined();
	});

	it('lets the next tenant open its own replica afterwards', async () => {
		const first = await createClientDb();
		await first.exec('CREATE TABLE employees (norbital_id text PRIMARY KEY)');
		const clientA = new PodSyncClient({ db: first, schemaSql: '', fetch: noopFetch });
		await clientA.bootstrap();
		enableClientSync(clientA);
		await teardownClientSync();

		// A fresh client for organization B installs cleanly — `enableClientSync` returns early if
		// one is already active, so a teardown that failed to clear it would silently hand B the
		// handle belonging to A.
		const second = await createClientDb();
		const clientB = new PodSyncClient({ db: second, schemaSql: '', fetch: noopFetch });
		await clientB.bootstrap();
		const syncB = enableClientSync(clientB);
		try {
			expect(getClientSync()).toBe(syncB);
			expect(syncB.client).toBe(clientB);
		} finally {
			await clientB.close();
		}
	});
});
