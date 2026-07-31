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
	pickCollection,
	serverInsert,
	waitFor,
	type ProbeCollection
} from '../support/collection-probe.js';
requireDocker();

/**
 * The approval request is itself a record a synced client reads: the Approval tab of a record
 * detail renders `approval_request.status`. Every status transition the server makes — an
 * approver's decision, a withdrawal, and the restart a *revision* performs — must therefore
 * reach the change feed, or a client keeps showing the status it last fetched while the
 * database has moved on.
 *
 * This is the seam a revision depends on: nothing on the client asks for the approval request
 * again after a record is revised, so the only thing that can correct the tab is the feed.
 */

const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = '55555555-5555-4555-8555-555555555555';
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

describe('An approval status change reaches the synced client', () => {
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

	it('updates the local approval_request row when the request changes status', async () => {
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
			await client.shapeSubscribe({ collection: 'approval_request', pageSize: 200 });
			client.startStream();
			const initial = await client.queryLocal<{ status: string }>(
				`SELECT status FROM approval_request WHERE norbital_id = $1`,
				[APPROVAL_ID]
			);
			expect(initial[0]?.status).toBe('ONGOING');

			const response = await fetch(`${server.url}/_runtime/remotes/withdrawApprovalRequest`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ approval_request_id: APPROVAL_ID })
			});
			expect(response.status, await response.clone().text()).toBe(200);

			const live = await harness.pool.query<{ status: string }>(
				`SELECT status FROM approval_request WHERE norbital_id = $1::uuid`,
				[APPROVAL_ID]
			);
			expect(live.rows[0]?.status).toBe('REJECTED');

			const converged = await waitFor(async () => {
				const rows = await client.queryLocal<{ status: string }>(
					`SELECT status FROM approval_request WHERE norbital_id = $1`,
					[APPROVAL_ID]
				);
				return rows[0]?.status === 'REJECTED';
			});
			expect(converged, `lastError=${String(client.lastError)}`).toBe(true);
		} finally {
			await client.close();
		}
	});
});
