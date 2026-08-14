import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { text, uuid, type PgTable } from 'drizzle-orm/pg-core';
import { text as authoringText } from '$lib/authoring/builtin/columns.js';
import { norbitalTableInternal } from '$lib/authoring/schema/table.js';
import { startPostgres, requireDocker, type PgHarness } from '../support/pg-harness.js';
import { createHostTenantDb } from '../support/host-tenant-db.js';
import { collectionSearchWhere } from '$lib/server/collection/collection_search.server.js';
import { directFindMany } from '$lib/server/collection/collection_direct.js';
import { createWorkspaceContext } from '$lib/server/bootstrap/workspace_store.js';
import { buildSelect, setLocalSchema, type LocalCollectionSchema } from '$lib/ui/sync/local-sql.js';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';

/**
 * Search must serve whatever language a tenant stores.
 *
 * The search index is a trigram index (`gin_trgm_ops`), which indexes character trigrams — not
 * words, and not a dictionary — so the same index and the same `ILIKE '%term%'` predicate serve
 * substring search in any script. This file pins that promise with real Postgres rows in
 * Japanese, Chinese, accented Latin, Arabic and Cyrillic, and asserts the two evaluators that
 * must agree: the server's search clause (`collectionSearchWhere` → `directFindMany`) and the
 * replica's compiler (`buildSelect`, executed as SQL against the same rows the way PGlite does).
 *
 * It also pins the opt-in contract: a text column without `search: true` never matches, even
 * though its contents are on the row.
 */

requireDocker();

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

/**
 * An authored table: `title` opted into search (`text({ search: true })`), `sku` and
 * `internal_note` ordinary text — stored, displayed, never indexed or searched. The authored
 * handle carries the opt-in on its built columns, which is exactly what `collectionSearchWhere`
 * reads back through `portableCollectionField`.
 */
const catalogItems = norbitalTableInternal(
	'catalog_items',
	{
		title: authoringText({ search: true }).notNull(),
		sku: text().notNull(),
		internal_note: text()
	},
	{}
) as unknown as PgTable;

const SCHEMA_SQL = `
	CREATE TABLE catalog_items (
		norbital_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		norbital_created_at TIMESTAMPTZ DEFAULT now(),
		norbital_updated_at TIMESTAMPTZ DEFAULT now(),
		norbital_sys_period TSTZRANGE DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)') NOT NULL,
		norbital_row_version INTEGER DEFAULT 1,
		norbital_approval_id UUID,
		title TEXT NOT NULL,
		sku TEXT NOT NULL,
		internal_note TEXT
	);
`;

const ROWS: [string, string, string, string | null][] = [
	['10000000-0000-4000-8000-000000000001', 'The Office Space', 'SKU-001', '公司机密档案'],
	['10000000-0000-4000-8000-000000000002', '株式会社グローバル物流', 'SKU-002', null],
	['10000000-0000-4000-8000-000000000003', '中文产品目录', 'SKU-003', null],
	['10000000-0000-4000-8000-000000000004', 'García & Müller GmbH', 'SKU-004', null],
	['10000000-0000-4000-8000-000000000005', 'مرحبا بالعالم', 'SKU-005', null],
	['10000000-0000-4000-8000-000000000006', 'Организация поставщик', 'SKU-006', null]
];

const manifestCtx = {
	findRelationship: () => undefined,
	getRelationshipsForCollection: () => []
} as unknown as Parameters<typeof createWorkspaceContext>[0]['manifestCtx'];

/** The schema facts runtime/client.ts would publish: only `title` is searchable. */
function installLocalSchema(): void {
	setLocalSchema(
		new Map<string, LocalCollectionSchema>([
			[
				'catalog_items',
				{
					name: 'catalog_items',
					columns: ['norbital_id', 'title', 'sku', 'internal_note'],
					fieldKinds: {
						norbital_id: 'uuid',
						title: 'text',
						sku: 'text',
						internal_note: 'text'
					},
					searchFields: ['title'],
					relationships: []
				}
			]
		])
	);
}

describe('collection search across languages (real Postgres)', () => {
	let pg: PgHarness;
	let pool: Pool;
	let host: ReturnType<typeof createHostTenantDb>;
	let ctx: ProvisionedContext;

	/** The rows the server's search clause returns, by title. */
	async function serverMatches(search: string): Promise<string[]> {
		const where = collectionSearchWhere(ctx, 'catalog_items', search);
		expect(where, `server must compile a search clause for "${search}"`).toBeDefined();
		const rows = await directFindMany(ctx, 'catalog_items', { where, limit: 100 });
		return rows.map((row) => String(row.title)).sort();
	}

	/** The same search as the replica's compiler renders it, run against the same rows. */
	async function replicaMatches(search: string): Promise<string[]> {
		const built = buildSelect('catalog_items', { search, limit: 100 });
		expect(built, 'the replica must be able to compile this search locally').not.toBeNull();
		const { rows } = await pool.query<Record<string, unknown>>(built!.sql, built!.params);
		return rows.map((row) => String(row.title)).sort();
	}

	/** Both evaluators, asserted to agree, returning the rows they agreed on. */
	async function agreedMatches(search: string): Promise<string[]> {
		const [server, replica] = await Promise.all([serverMatches(search), replicaMatches(search)]);
		expect(replica, 'replica and server must resolve the same rows').toEqual(server);
		return server;
	}

	beforeAll(async () => {
		pg = await startPostgres();
		pool = new Pool({ connectionString: pg.connectionString, max: 4 });
		await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
		await pool.query(SCHEMA_SQL);
		for (const [id, title, sku, note] of ROWS) {
			await pool.query(
				`INSERT INTO catalog_items (norbital_id, title, sku, internal_note) VALUES ($1, $2, $3, $4)`,
				[id, title, sku, note]
			);
		}
		// The same trigram index the authoring layer emits for an opted-in field — created over
		// multilingual data, which it must accept without dictionaries or tokenizers.
		await pool.query(
			`CREATE INDEX catalog_items_title_search_trgm_idx ON catalog_items USING gin (title gin_trgm_ops)`
		);

		host = createHostTenantDb(pg.connectionString, { pool });

		ctx = createWorkspaceContext({
			provision: 'provisioned',
			manifestCtx,
			organization: { norbital_id: ORG_ID, name: 'Test Org' },
			baseScope: {
				requestor: { norbital_id: USER_ID, role: 'admin' },
				organization: { norbital_id: ORG_ID, name: 'Test Org' }
			} as unknown as Parameters<typeof createWorkspaceContext>[0]['baseScope'],
			tenantDb: host.tenantDb,
			tableRegistry: { catalog_items: catalogItems }
		});

		installLocalSchema();
	}, 180_000);

	afterAll(async () => {
		await host?.close();
		await pool?.end().catch(() => undefined);
		pg?.stop();
	});

	it('matches substring terms in Japanese, Chinese, Latin, Arabic and Cyrillic', async () => {
		expect(await agreedMatches('グローバル')).toEqual(['株式会社グローバル物流']);
		expect(await agreedMatches('产品')).toEqual(['中文产品目录']);
		expect(await agreedMatches('García')).toEqual(['García & Müller GmbH']);
		// Case-insensitive across scripts: the `I` in `ILIKE` folds both sides.
		expect(await agreedMatches('müller')).toEqual(['García & Müller GmbH']);
		expect(await agreedMatches('بالعالم')).toEqual(['مرحبا بالعالم']);
		expect(await agreedMatches('поставщик')).toEqual(['Организация поставщик']);
	});

	it('never matches fields that were not opted in with `search: true`', async () => {
		// `internal_note` content and `sku` are ordinary text on the row — stored, not searchable.
		expect(await agreedMatches('机密')).toEqual([]);
		expect(await agreedMatches('SKU-001')).toEqual([]);
	});
});
