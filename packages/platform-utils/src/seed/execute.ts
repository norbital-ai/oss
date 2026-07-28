import { Client as PgClient } from '@neondatabase/serverless';
import { z } from 'zod';
import { typeGuard } from '@norbital-ai/std/schema';
import { qualifiedTableName } from '../tenant_db/schema.js';

export type SeedExecutionPlan = {
	readonly version: 1;
	readonly clearBefore?: ReadonlyArray<string>;
	readonly mutations: ReadonlyArray<{
		readonly collection_name: string;
		readonly payloads: ReadonlyArray<Record<string, unknown>>;
	}>;
};

interface SeedProvenanceSummary {
	readonly collectionName: string;
	readonly rowCount: number;
	readonly relationshipCount: number;
}

export function seedProvenanceRecords(input: {
	readonly templateKey: string;
	readonly adminId: string;
	readonly summaries: readonly SeedProvenanceSummary[];
}): Record<string, unknown>[] {
	const createdAt = new Date().toISOString();
	return input.summaries
		.filter((summary) => summary.collectionName !== 'audit_event')
		.map((summary) => ({
			norbital_id: crypto.randomUUID(),
			norbital_created_at: createdAt,
			norbital_updated_at: createdAt,
			event_type: 'seed',
			collection_name: summary.collectionName,
			record_id: null,
			details: {
				source: 'template_seed',
				template_key: input.templateKey,
				row_count: summary.rowCount,
				relationship_count: summary.relationshipCount
			},
			actor_id: input.adminId
		}));
}

const SEED_STRIP_FIELDS = new Set([
	'norbital_sys_period',
	'norbital_row_version',
	'norbital_approval_id'
]);

const escapeIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;

function sanitizeSeedRecord(record: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (!SEED_STRIP_FIELDS.has(key)) out[key] = value;
	}
	return out;
}

function singularCollectionName(collectionName: string): string {
	if (collectionName.endsWith('ies')) return `${collectionName.slice(0, -3)}y`;
	if (collectionName.endsWith('s')) return collectionName.slice(0, -1);
	return collectionName;
}

type SeedTableMetadata = {
	readonly schema: string;
	readonly columns: ReadonlySet<string>;
	readonly arrayColumns: ReadonlySet<string>;
};

const seedTableMetadataCache = new WeakMap<PgClient, Map<string, SeedTableMetadata>>();

async function tableMetadata(client: PgClient, tableName: string): Promise<SeedTableMetadata> {
	const clientCache = seedTableMetadataCache.get(client) ?? new Map<string, SeedTableMetadata>();
	seedTableMetadataCache.set(client, clientCache);
	const cached = clientCache.get(tableName);
	if (cached) return cached;
	const result = await client.query<{
		table_schema: string;
		column_name: string;
		data_type: string;
	}>(
		`SELECT table_schema, column_name, data_type
		   FROM information_schema.columns
		  WHERE table_schema IN ('public', 'norbital_auth')
		    AND table_name = $1
		  ORDER BY CASE table_schema WHEN 'public' THEN 0 ELSE 1 END`,
		[tableName]
	);
	const schema = result.rows[0]?.table_schema ?? 'public';
	const metadata = {
		schema,
		columns: new Set(result.rows.map((row) => row.column_name)),
		arrayColumns: new Set(
			result.rows.filter((row) => row.data_type === 'ARRAY').map((row) => row.column_name)
		)
	};
	clientCache.set(tableName, metadata);
	return metadata;
}

async function tableColumns(client: PgClient, tableName: string): Promise<ReadonlySet<string>> {
	return (await tableMetadata(client, tableName)).columns;
}

async function qualifiedExistingTable(client: PgClient, tableName: string): Promise<string> {
	const metadata = await tableMetadata(client, tableName);
	return `${escapeIdentifier(metadata.schema)}.${escapeIdentifier(tableName)}`;
}

function seedColumnValue(value: unknown, sqlArray: boolean): unknown {
	if (value == null) return value;
	if (Array.isArray(value)) return sqlArray ? value : JSON.stringify(value);
	if (typeof value === 'object') return JSON.stringify(value);
	return value;
}

/** Neon/Postgres bind limit is 65535 params; keep headroom for statement overhead. */
const SEED_INSERT_PARAM_BUDGET = 60_000;

async function insertSeedRows(input: {
	readonly client: PgClient;
	readonly collection: string;
	readonly rows: readonly Record<string, unknown>[];
}): Promise<number> {
	if (input.rows.length === 0) return 0;
	const metadata = await tableMetadata(input.client, input.collection);
	const columns = metadata.columns;
	const sanitized = input.rows
		.map(sanitizeSeedRecord)
		.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => columns.has(key))));
	const insertColumns = [...new Set(sanitized.flatMap((row) => Object.keys(row)))];
	if (insertColumns.length === 0) return 0;

	const updateColumns = insertColumns.filter((column) => column !== 'norbital_id');
	const updateSql =
		updateColumns.length > 0
			? `DO UPDATE SET ${updateColumns
					.map((column) => `${escapeIdentifier(column)} = EXCLUDED.${escapeIdentifier(column)}`)
					.join(', ')}`
			: 'DO NOTHING';
	const conflictTarget =
		input.collection === 'user' && insertColumns.includes('email') ? 'email' : 'norbital_id';
	const rowsPerBatch = Math.max(1, Math.floor(SEED_INSERT_PARAM_BUDGET / insertColumns.length));

	// stupidity:allow A6 -- batches share one client and preserve deterministic upsert order
	for (let offset = 0; offset < sanitized.length; offset += rowsPerBatch) {
		const batch = sanitized.slice(offset, offset + rowsPerBatch);
		const values: unknown[] = [];
		const rowSql = batch.map((row) => {
			const placeholders = insertColumns.map((column) => {
				values.push(seedColumnValue(row[column], metadata.arrayColumns.has(column)));
				return `$${values.length}`;
			});
			return `(${placeholders.join(', ')})`;
		});
		await input.client.query(
			`INSERT INTO ${qualifiedTableName(input.collection)}
			 (${insertColumns.map(escapeIdentifier).join(', ')})
			 VALUES ${rowSql.join(', ')}
			 ON CONFLICT (${escapeIdentifier(conflictTarget)}) ${updateSql}`,
			values
		);
	}
	return input.rows.length;
}

/**
 * Template seeding is an authoritative bulk load that writes tenant collection tables
 * with raw INSERT/DELETE rather than through collection_ops. The _ops_guard trigger
 * rejects writes that do not carry the `norbital.via_ops` GUC, so the seed connection
 * declares itself as an authorized writer for its (dedicated, short-lived) session.
 */
async function authorizeSeedWrites(client: PgClient): Promise<void> {
	await client.query(`SELECT set_config('norbital.via_ops', 'on', false)`);
}

const seedUserIdByEmailCache = new Map<string, string>();

async function seedSourceId(input: {
	readonly client: PgClient;
	readonly collection: string;
	readonly row: Record<string, unknown>;
}): Promise<string | null> {
	if (input.collection !== 'user' || typeof input.row.email !== 'string') {
		return typeof input.row.norbital_id === 'string' ? input.row.norbital_id : null;
	}
	const email = input.row.email.toLowerCase();
	const cached = seedUserIdByEmailCache.get(email);
	if (cached) return cached;
	const result = await input.client.query<{ norbital_id: string }>(
		`SELECT norbital_id FROM ${qualifiedTableName('user')} WHERE email = $1 LIMIT 1`,
		[email]
	);
	const id = result.rows[0]?.norbital_id;
	if (id) seedUserIdByEmailCache.set(email, id);
	return id ?? null;
}

async function insertSeedRelationships(input: {
	readonly client: PgClient;
	readonly collection: string;
	readonly rows: readonly Record<string, unknown>[];
}): Promise<number> {
	let inserted = 0;
	const sourceColumn = `${singularCollectionName(input.collection)}_id`;
	// stupidity:allow A6 -- relationship rows depend on each source row being resolved first
	for (const row of input.rows) {
		const sourceId = await seedSourceId({
			client: input.client,
			collection: input.collection,
			row
		});
		if (!sourceId) continue;
		// stupidity:allow A6 -- relation metadata and inserts share the ordered database client
		for (const [relationshipName, links] of Object.entries(row)) {
			if (!Array.isArray(links)) continue;
			if (!links.every((link) => typeGuard(z.object({ record_id: z.string() }), link))) {
				continue;
			}
			const relationColumns = await tableColumns(input.client, relationshipName);
			if (!relationColumns.has(sourceColumn)) continue;
			const targetColumn = [...relationColumns].find(
				(column) =>
					column.endsWith('_id') &&
					column !== sourceColumn &&
					column !== 'norbital_id' &&
					column !== 'norbital_approval_id'
			);
			if (!targetColumn) continue;
			const values: unknown[] = [];
			const rowSql: string[] = [];
			for (const link of links as Array<{ record_id?: unknown; norbital_id?: unknown }>) {
				const targetId = link.record_id ?? link.norbital_id;
				if (typeof targetId !== 'string') continue;
				values.push(sourceId, targetId);
				rowSql.push(`($${values.length - 1}, $${values.length})`);
			}
			if (rowSql.length === 0) continue;
			await input.client.query(
				`INSERT INTO ${await qualifiedExistingTable(input.client, relationshipName)}
				 (${escapeIdentifier(sourceColumn)}, ${escapeIdentifier(targetColumn)})
				 VALUES ${rowSql.join(', ')}`,
				values
			);
			inserted += rowSql.length;
		}
	}
	return inserted;
}

/**
 * Execute a seed plan against a live tenant DB. The caller resolves the tenant
 * connection string (live zone) so this module stays free of apps/core facilities.
 */
export async function seedTemplateDataFromPlan(input: {
	readonly templateKey: string;
	readonly plan: SeedExecutionPlan;
	readonly orgId: string;
	readonly orgName: string;
	readonly adminId: string;
	readonly liveUrl: string;
	readonly log: (message: string) => void;
	readonly client?: PgClient;
}): Promise<void> {
	if (input.plan.mutations.length === 0) {
		input.log(`Template "${input.templateKey}" has no seed mutations`);
		return;
	}

	input.log(
		`Seeding template "${input.templateKey}" (${input.plan.mutations.length} bulk seed steps)...`
	);

	if (input.plan.clearBefore?.length) {
		const client = input.client ?? new PgClient({ connectionString: input.liveUrl });
		if (!input.client) await client.connect();
		await authorizeSeedWrites(client);
		try {
			// stupidity:allow A6 -- deletes are dependency-ordered by the authored seed plan
			for (const collection of input.plan.clearBefore) {
				await client.query(`DELETE FROM ${qualifiedTableName(collection)}`);
			}
			input.log(`Cleared seeded collections (${input.plan.clearBefore.join(', ')}).`);
		} finally {
			if (!input.client) await client.end();
		}
	}

	const client = input.client ?? new PgClient({ connectionString: input.liveUrl });
	if (!input.client) await client.connect();
	await authorizeSeedWrites(client);
	try {
		const summaries: SeedProvenanceSummary[] = [];
		// stupidity:allow A6 -- seed mutations are an ordered plan with cross-step references
		for (const mutation of input.plan.mutations) {
			const inserted = await insertSeedRows({
				client,
				collection: mutation.collection_name,
				rows: mutation.payloads
			});
			const links = await insertSeedRelationships({
				client,
				collection: mutation.collection_name,
				rows: mutation.payloads
			});
			summaries.push({
				collectionName: mutation.collection_name,
				rowCount: inserted,
				relationshipCount: links
			});
			input.log(`Seeded ${mutation.collection_name}: ${inserted} rows, ${links} links`);
		}
		const provenance = seedProvenanceRecords({
			templateKey: input.templateKey,
			adminId: input.adminId,
			summaries
		});
		await insertSeedRows({ client, collection: 'audit_event', rows: provenance });
		input.log(`Recorded ${provenance.length} seed provenance events.`);
	} finally {
		if (!input.client) await client.end();
	}

	input.log(
		`Template seed "${input.templateKey}" complete (${input.plan.mutations.length} bulk steps).`
	);
}
