import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { requireDocker, startPostgres, type PgHarness } from '../support/pg-harness.js';
import { workspaceExclusionsDdl } from '$lib/vite/workspace-exclusions-sql.js';
import { SCHEMA_FUNCTIONS_SQL } from '$lib/vite/schema-functions-sql.js';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';

requireDocker();

/**
 * The emitted DDL has to survive contact with a real server: `EXCLUDE USING gist` over mixed
 * equality/range members needs `btree_gist`, and Postgres refuses any STABLE expression in a
 * constraint — which is why the date projection goes through `norbital_daterange`.
 */
const MANIFEST: NorbitalManifest = {
	version: 1,
	collections: {
		contribution_treatments: {
			collection_name: 'contribution_treatments',
			description: null,
			record_label: null,
			icon: null,
			extensions: {
				indexes: [],
				exclusions: [
					{
						name: 'contribution_treatments_no_overlap',
						elements: [
							{ expr: 'component_type_id', with: '=' },
							{ expr: 'statutory_contribution_id', with: '=' },
							{ expr: 'norbital_daterange(effective_range)', with: '&&' }
						]
					}
				]
			},
			hooks: {},
			pipelines: {},
			system: null
		}
	},
	relationships: {},
	apps: {},
	handlers: {},
	automations: {}
};

function row(componentType: number, start: string, end: string): string {
	return `INSERT INTO contribution_treatments (component_type_id, statutory_contribution_id, effective_range)
		VALUES (${componentType}, 1, '{"start":"${start}T00:00:00.000Z","end":"${end}T00:00:00.000Z"}')`;
}

describe('exclusion DDL on a real server', () => {
	let pg: PgHarness;
	let client: Client;

	beforeAll(async () => {
		pg = await startPostgres();
		client = new Client({ connectionString: pg.connectionString });
		await client.connect();
		await client.query(SCHEMA_FUNCTIONS_SQL);
		await client.query(`CREATE TABLE contribution_treatments (
			norbital_id serial PRIMARY KEY,
			component_type_id int,
			statutory_contribution_id int,
			effective_range jsonb
		)`);
	});

	afterAll(async () => {
		await client?.end().catch(() => {});
		pg?.stop();
	});

	it('applies, re-applies without work, and rejects an overlap with SQLSTATE 23P01', async () => {
		const ddl = workspaceExclusionsDdl(MANIFEST);
		await client.query(ddl);
		// Deploy runs this file on every checkpoint; the guard must make a second pass a no-op.
		await client.query(ddl);

		await client.query(row(1, '2025-01-01', '2025-06-01'));
		// Adjacent, not overlapping — the range is half-open.
		await client.query(row(1, '2025-06-01', '2025-09-01'));
		// Same period but a different component — the equality members keep them apart.
		await client.query(row(2, '2025-01-01', '2025-06-01'));

		await expect(client.query(row(1, '2025-03-01', '2025-09-01'))).rejects.toMatchObject({
			code: '23P01'
		});
	});
});

describe('schema-functions.sql', () => {
	it('installs btree_gist so a gist exclusion can mix equality and range members', () => {
		expect(SCHEMA_FUNCTIONS_SQL).toContain('CREATE EXTENSION IF NOT EXISTS "btree_gist"');
		expect(SCHEMA_FUNCTIONS_SQL).not.toContain('CREATE EXTENSION IF NOT EXISTS "temporal_tables"');
		expect(SCHEMA_FUNCTIONS_SQL).toContain('FUNCTION _norbital_versioning()');
	});

	it('installs pgvector for bit/vector nearest-neighbor indexes', () => {
		expect(SCHEMA_FUNCTIONS_SQL).toContain('CREATE EXTENSION IF NOT EXISTS "vector"');
	});

	it('declares an IMMUTABLE daterange projection for date-range JSONB columns', () => {
		expect(SCHEMA_FUNCTIONS_SQL).toContain('FUNCTION norbital_daterange(payload JSONB)');
		expect(SCHEMA_FUNCTIONS_SQL).toContain('IMMUTABLE');
	});
});
