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
import { pickCollection, serverInsert, type ProbeCollection } from '../support/collection-probe.js';

/**
 * A withdrawn approval, end to end: the HTTP endpoint the Withdraw button calls, the rollback it
 * performs, the change feed, the SSE socket, and the local replica a synced UI actually reads.
 *
 * Every layer in that chain is real here — the built runtime, a Node HTTP server, a live
 * `text/event-stream`, and PGlite. That matters because each layer can hold the record on its own:
 * the server can roll the row back and never announce it, the tailer can hold the announcement
 * below its horizon, and the client can receive it and fail to apply it. A test that stops at the
 * database proves only that the row is gone from the database, which is not what a user sees.
 */

requireDocker();

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = '44444444-4444-4444-8444-444444444444';
const CONFIG_ID = '33333333-3333-4333-8333-333333333333';

const admin: Identity = {
	userId: ADMIN_ID,
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};

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

/**
 * Open the request over an already-written record, the way `collection_ops` does for a gated
 * create: the approval row carries the lock set, and inserting it materializes the locks.
 */
async function openRequest(
	harness: PodRuntimeHarness,
	collection: string,
	recordId: string
): Promise<void> {
	const client = await harness.pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops','on',true)`);
		await client.query(
			`INSERT INTO approval_request (
			   norbital_id, organization_id, label, approval_config_id, collection_name,
			   status, approval_step_nodes, locked_record_refs
			 ) VALUES ($1::uuid, $2::uuid, 'Gated create', $3::uuid, $4, 'ONGOING', $5::jsonb, $6::jsonb)`,
			[
				APPROVAL_ID,
				harness.orgId,
				CONFIG_ID,
				collection,
				JSON.stringify([
					[
						{
							id: 'step-1',
							name: 'Manager',
							description: null,
							teams_that_can_approve: ['managers'],
							status: 'PENDING',
							history: []
						}
					]
				]),
				JSON.stringify([
					{ collection_name: collection, record_id: recordId, lock_type: 'record_mutation' }
				])
			]
		);
		await client.query(
			`INSERT INTO requestor (approval_request_id, user_id) VALUES ($1::uuid, $2::uuid)`,
			[APPROVAL_ID, ADMIN_ID]
		);
		await client.query('COMMIT');
	} catch (err) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw err;
	} finally {
		client.release();
	}
}

describe('Withdrawn approval reaches the synced client', () => {
	let harness: PodRuntimeHarness;
	let server: { url: string; close: () => Promise<void> };
	let collection: ProbeCollection;

	beforeAll(async () => {
		harness = await bootPodRuntime('construction');
		server = await harness.serveHttp(admin);
		collection = await pickCollection(harness);
	}, 300_000);

	afterAll(async () => {
		await server?.close();
		await harness?.stop();
	});

	it('drops the rolled-back record from the local replica', async () => {
		const recordId = await serverInsert(harness, collection, APPROVAL_ID);
		await openRequest(harness, collection.name, recordId);

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
			client.setSubscribedCollections([collection.name]);
			client.startStream();
			// The provisional record is what the user sees before deciding: local, and stamped.
			expect(await client.localVersion(collection.name, recordId)).not.toBeNull();

			// Exactly what the Withdraw button posts.
			const response = await fetch(`${server.url}/_runtime/remotes/withdrawApprovalRequest`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ approval_request_id: APPROVAL_ID })
			});
			expect(response.status, await response.clone().text()).toBe(200);
			const receipt = (await response.json()) as {
				sync_sequence: string;
				approval_request: { norbital_id: string; status: string };
				affected_record: { collection: string; id: string };
			};
			expect(receipt.approval_request).toMatchObject({
				norbital_id: APPROVAL_ID,
				status: 'REJECTED'
			});
			expect(receipt.affected_record).toEqual({ collection: collection.name, id: recordId });

			// The server row is gone…
			const live = await harness.pool.query(
				`SELECT 1 FROM "${collection.name}" WHERE norbital_id = $1::uuid`,
				[recordId]
			);
			expect(live.rowCount).toBe(0);

			// The command receipt is a read-your-command barrier: once the returned feed watermark
			// lands, the local copy is already gone without anyone asking it to refetch.
			expect(
				await client.waitForSequence(receipt.sync_sequence),
				`lastError=${String(client.lastError)}`
			).toBe(true);
			expect(await client.localVersion(collection.name, recordId)).toBeNull();
		} finally {
			await client.close();
		}
	});
});
