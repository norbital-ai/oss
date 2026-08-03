import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDocker } from '../support/pg-harness.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';

requireDocker();

const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};

async function insertSite(harness: PodRuntimeHarness, name: string): Promise<string> {
	const client = await harness.pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		const result = await client.query<{ norbital_id: string }>(
			`INSERT INTO sites (name) VALUES ($1) RETURNING norbital_id`,
			[name]
		);
		await client.query('COMMIT');
		return result.rows[0]!.norbital_id;
	} catch (cause) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw cause;
	} finally {
		client.release();
	}
}

describe('Pod pipelines — compiled runtime contract', () => {
	let harness: PodRuntimeHarness;

	beforeAll(async () => {
		harness = await bootPodRuntime('field-operations');
	}, 180_000);

	afterAll(async () => {
		await harness?.stop();
	});

	it('authorizes, scopes, invokes, and serializes an authored export pipeline', async () => {
		const selectedId = await insertSite(harness, 'Alpha Site');
		await insertSite(harness, 'Unselected Site');

		const response = await harness.request(
			{
				method: 'POST',
				path: 'collections/export',
				body: JSON.stringify({ collection_name: 'sites', record_ids: [selectedId] })
			},
			admin
		);
		expect(response.status).toBe(200);
		const manifests = (await response.json()) as Array<{
			label: string;
			attachments: Array<{ name: string; contentType: string; content: unknown }>;
			metadata: { site_id: string; schema: string };
		}>;

		expect(manifests).toHaveLength(1);
		expect(manifests[0]).toMatchObject({
			label: 'Field operations interoperability bundle · Alpha Site',
			metadata: { site_id: selectedId, schema: 'norbital.field_operations.interoperability.v1' }
		});
		expect(manifests[0]!.attachments.map((attachment) => attachment.name)).toEqual([
			'field_ops_Alpha_Site.json',
			'field_ops_Alpha_Site_jobs.csv',
			'field_ops_Alpha_Site_job_assignments.csv',
			'field_ops_Alpha_Site_variations.csv',
			'field_ops_Alpha_Site_photo_evidence.csv'
		]);
		expect(manifests[0]!.attachments[0]).toMatchObject({
			contentType: 'JSON',
			content: {
				schema: 'norbital.field_operations.interoperability.v1',
				site: { norbital_id: selectedId, name: 'Alpha Site' }
			}
		});
	});
});
