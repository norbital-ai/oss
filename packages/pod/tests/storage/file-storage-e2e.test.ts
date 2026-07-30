import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostFileStorageBinding } from '@norbital-ai/platform-utils/runtime/binding';
import { dockerAvailable } from '../support/pg-harness.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';

const hasDocker = dockerAvailable();
const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};
const otherUser: Identity = {
	userId: '33333333-3333-4333-8333-333333333333',
	userName: 'Other User',
	email: 'other@it.local',
	role: 'basic'
};

function memoryStorage(objects: Map<string, Uint8Array>): HostFileStorageBinding {
	return {
		async put(key, body) {
			objects.set(key, new Uint8Array(body));
		},
		async get(key) {
			return objects.get(key) ?? null;
		},
		async delete(key) {
			objects.delete(key);
		}
	};
}

describe.skipIf(!hasDocker)('Pod file storage — runtime E2E', () => {
	let harness: PodRuntimeHarness;
	const objects = new Map<string, Uint8Array>();

	beforeAll(async () => {
		harness = await bootPodRuntime('construction', { fileStorage: memoryStorage(objects) });
	}, 180_000);

	afterAll(async () => {
		await harness?.stop();
	});

	it('stores bytes in the host while Pod owns metadata, authorization, and deletion', async () => {
		const bytes = new TextEncoder().encode('pod-owned metadata, host-owned bytes');
		const upload = await harness.request(
			{
				method: 'POST',
				path: 'files/upload',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					file_name: 'proof.txt',
					mime_type: 'text/plain',
					file_size: bytes.byteLength,
					data_base64: Buffer.from(bytes).toString('base64')
				})
			},
			admin
		);
		expect(upload.status).toBe(200);
		const asset = (await upload.json()) as { norbital_id: string };
		const stored = await harness.pool.query<{
			storage_key: string;
			owner_user_id: string;
		}>(`SELECT storage_key, owner_user_id FROM document_asset WHERE norbital_id = $1::uuid`, [
			asset.norbital_id
		]);
		expect(stored.rows[0]?.owner_user_id).toBe(admin.userId);
		expect(objects.get(stored.rows[0]!.storage_key)).toEqual(bytes);

		const denied = await harness.request(
			{
				method: 'POST',
				path: 'files/delete',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ record_id: asset.norbital_id })
			},
			otherUser
		);
		expect(denied.status).toBe(403);
		expect(objects.has(stored.rows[0]!.storage_key)).toBe(true);

		const removed = await harness.request(
			{
				method: 'POST',
				path: 'files/delete',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ record_id: asset.norbital_id })
			},
			admin
		);
		expect(removed.status).toBe(200);
		expect(objects.has(stored.rows[0]!.storage_key)).toBe(false);
		expect(
			(
				await harness.pool.query(`SELECT 1 FROM document_asset WHERE norbital_id = $1::uuid`, [
					asset.norbital_id
				])
			).rowCount
		).toBe(0);
	});
});
