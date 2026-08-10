import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { pgTable, text, uuid, vector } from 'drizzle-orm/pg-core';
import { requireDocker, startPostgres, type PgHarness } from '../support/pg-harness.js';
import { SCHEMA_FUNCTIONS_SQL } from '$lib/vite/schema-functions-sql.js';
import { createWorkspaceContext } from '$lib/server/bootstrap/workspace_store.js';
import type { ProvisionedContext, TenantDbClient } from '$lib/server/bootstrap/workspace_store.js';
import { directFindNearest } from '$lib/server/collection/collection_vector.server.js';

requireDocker();

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

/** 8-dim 0/1 embeddings — L2 distance equals √Hamming. */
const photoHashes = pgTable('photo_hashes', {
	norbital_id: uuid().primaryKey(),
	label: text().notNull(),
	perceptual_embedding: vector({ dimensions: 8 }).notNull()
});

const embeddings = pgTable('embeddings', {
	norbital_id: uuid().primaryKey(),
	label: text().notNull(),
	embedding: vector({ dimensions: 3 }).notNull()
});

describe('pgvector findNearest', () => {
	let pg: PgHarness;
	let client: Client;
	let ctx: ProvisionedContext;

	beforeAll(async () => {
		pg = await startPostgres();
		client = new Client({ connectionString: pg.connectionString });
		await client.connect();
		await client.query(SCHEMA_FUNCTIONS_SQL);
		await client.query(`
			CREATE TABLE photo_hashes (
				norbital_id uuid PRIMARY KEY,
				label text NOT NULL,
				perceptual_embedding vector(8) NOT NULL
			);
			CREATE TABLE embeddings (
				norbital_id uuid PRIMARY KEY,
				label text NOT NULL,
				embedding vector(3) NOT NULL
			);
			CREATE INDEX photo_hashes_hnsw ON photo_hashes
				USING hnsw (perceptual_embedding vector_l2_ops);
			CREATE INDEX embeddings_hnsw ON embeddings
				USING hnsw (embedding vector_cosine_ops);
		`);

		await client.query(`
			INSERT INTO photo_hashes (norbital_id, label, perceptual_embedding) VALUES
				('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'exact', '[1,1,1,1,0,0,0,0]'),
				('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'near',  '[1,1,1,1,0,0,0,1]'),
				('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'far',   '[0,0,0,0,1,1,1,1]');
			INSERT INTO embeddings (norbital_id, label, embedding) VALUES
				('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'a', '[1,0,0]'),
				('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'b', '[0.9,0.1,0]'),
				('ffffffff-ffff-4fff-8fff-ffffffffffff', 'c', '[0,1,0]');
		`);

		const tenantDb: TenantDbClient = {
			query: async (textOrConfig, params) => {
				const text = typeof textOrConfig === 'string' ? textOrConfig : (textOrConfig.text ?? '');
				const values =
					typeof textOrConfig === 'string'
						? params
						: (textOrConfig.values ?? textOrConfig.params ?? params);
				const result = await client.query(text, values as unknown[]);
				return { rows: result.rows, rowCount: result.rowCount ?? undefined };
			}
		};

		ctx = createWorkspaceContext({
			provision: 'provisioned',
			manifestCtx: {
				findRelationship: () => undefined,
				getRelationshipsForCollection: () => [],
				getCollection: () => ({})
			} as unknown as Parameters<typeof createWorkspaceContext>[0]['manifestCtx'],
			organization: { norbital_id: ORG_ID, name: 'Test' },
			baseScope: {
				requestor: { norbital_id: USER_ID, role: 'admin' },
				organization: { norbital_id: ORG_ID, name: 'Test' }
			} as unknown as Parameters<typeof createWorkspaceContext>[0]['baseScope'],
			tenantDb,
			tableRegistry: {
				photo_hashes: photoHashes,
				embeddings
			}
		});
	}, 180_000);

	afterAll(async () => {
		await client?.end().catch(() => {});
		pg?.stop();
	});

	it('returns L2 neighbors for binary embeddings (√Hamming ≤ 1)', async () => {
		const rows = await directFindNearest(ctx, 'photo_hashes', {
			column: 'perceptual_embedding',
			probe: [1, 1, 1, 1, 0, 0, 0, 0],
			metric: 'l2',
			maxDistance: 1, // √1 Hamming
			limit: 10
		});
		expect(rows.map((row) => row.label)).toEqual(['exact', 'near']);
		expect(rows[0]?.distance).toBeCloseTo(0, 5);
		expect(rows[1]?.distance).toBeCloseTo(1, 5);
	});

	it('returns cosine neighbors for float embeddings', async () => {
		const rows = await directFindNearest(ctx, 'embeddings', {
			column: 'embedding',
			probe: [1, 0, 0],
			metric: 'cosine',
			limit: 2
		});
		expect(rows.map((row) => row.label)).toEqual(['a', 'b']);
		expect(rows[0]?.distance).toBeCloseTo(0, 5);
	});

	it('honors excludeIds', async () => {
		const rows = await directFindNearest(ctx, 'photo_hashes', {
			column: 'perceptual_embedding',
			probe: [1, 1, 1, 1, 0, 0, 0, 0],
			metric: 'l2',
			maxDistance: 3,
			limit: 10,
			excludeIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
		});
		expect(rows.every((row) => row.norbital_id !== 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(
			true
		);
	});
});
