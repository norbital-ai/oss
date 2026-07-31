import { Client as PgClient } from '@neondatabase/serverless';
import { z } from 'zod';
import { typeGuard } from '@norbital-ai/std/schema';
import { nearestName } from '@norbital-ai/std/string';
import { qualifiedTableName } from '../tenant_db/schema.js';
import type { CompiledSeedPlan } from './plan.js';

/**
 * The plan this module executes. Identical to {@link CompiledSeedPlan} by construction — a seed is
 * compiled into exactly what the executor runs, and keeping one type is what stops a field added on
 * the authoring side (like `step_id`) from being invisible here.
 */
export type SeedExecutionPlan = CompiledSeedPlan;

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

// ── What a seed payload key is allowed to be ─────────────────────────────────

/**
 * A payload key that is none of the three things below aborts the seed.
 *
 * This module used to filter every payload down to `columns.has(key)` and insert what survived. A
 * key that was not a column was not an error — it was a value that quietly never landed, and the
 * row seeded looking populated while the column stayed NULL. Three defects shipped that way in one
 * week: users seeded with a NULL `name` so nobody could sign in to a fresh tenant at all, dead
 * `phone`/`metadata` keys carried for months, and 51 drifted keys across one template's seed whose
 * rows landed mostly empty with nothing to say so.
 *
 * None of those was a deliberate drop. A dropped key is a typo, or the schema moved and the seed
 * did not follow — so the executor now states the three things a key may be, and refuses anything
 * else *before* it writes a row:
 *
 *   1. a column of the target table,
 *   2. a relationship key the second pass consumes (see {@link relationTargetColumn}),
 *   3. a declared sidecar (see {@link SeedSidecarKeys}).
 *
 * A failed seed costs one run. A silently dropped key costs whatever is built on the belief that
 * the value is there.
 */
export type SeedPayloadKeyViolation = {
	/** The authoring step the key came from, or where the offending declaration lives. */
	readonly step: string;
	readonly collection: string;
	readonly key: string;
	/** How many payloads carry it — a schema drift usually hits every row in the step. */
	readonly rowCount: number;
	readonly reason:
		| 'unknown-table'
		| 'unknown-column'
		| 'unresolvable-relation'
		| 'sidecar-is-column'
		| 'sidecar-unexplained';
	/** Closest real column, when one is near enough that a rename or typo is the likely cause. */
	readonly suggestion?: string;
};

/**
 * Keys a caller consumes itself, before the plan reaches the executor: collection → key → why.
 *
 * There is exactly one real instance of this and it is worth stating, because the alternative is
 * that the next person to meet the abort widens the check back open for everyone. Core's
 * `seedDocumentAssets` reads `document_asset.metadata.seed_asset` to find a file on disc, verify its
 * size and SHA-256, and upload the bytes — then hands the same plan here. The key is an instruction
 * to the caller travelling inside the payload, not tenant data, and it is deliberately never a
 * column.
 *
 * Three things keep this from becoming a general escape hatch:
 *
 * - It is declared at the **call site that consumes the key**, not centrally, so an exemption lives
 *   beside the code that earns it and dies with it.
 * - It is `collection.key` exactly. There are no wildcards, and no way to exempt a table.
 * - The reason is a required non-empty sentence, and the executor **logs every sidecar it honoured**
 *   on each run. An exemption nobody can justify in prose is an exemption that reads as drift in the
 *   seed log.
 *
 * Declaring a key that *is* a column is itself an error: the executor would insert it, so the
 * exemption is a lie about what happens. Delete the declaration instead.
 */
export type SeedSidecarKeys = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** Table name → its column names; an empty set means the table does not exist. */
export type SeedColumnLookup = (tableName: string) => Promise<ReadonlySet<string>>;

const seedRelationLinkSchema = z.object({ record_id: z.string() });

/** True when a value has the shape the relationship pass consumes. */
// stupidity:allow R5b -- canonical Zod-backed guard shared by the check and the relationship insert
function isRelationLinkArray(value: unknown): value is ReadonlyArray<{ record_id: string }> {
	return Array.isArray(value) && value.every((link) => typeGuard(seedRelationLinkSchema, link));
}

/**
 * The column a relationship key's links land in, or null when the executor would drop them.
 *
 * Shared by the check and by {@link insertSeedRelationships} on purpose: if the two disagreed, the
 * check would bless links that the insert then silently discards — the exact failure this exists to
 * end.
 */
async function relationTargetColumn(input: {
	readonly columnsOf: SeedColumnLookup;
	readonly collection: string;
	readonly relationshipName: string;
}): Promise<string | null> {
	const relationColumns = await input.columnsOf(input.relationshipName);
	const sourceColumn = `${singularCollectionName(input.collection)}_id`;
	if (!relationColumns.has(sourceColumn)) return null;
	return (
		[...relationColumns].find(
			(column) =>
				column.endsWith('_id') &&
				column !== sourceColumn &&
				column !== 'norbital_id' &&
				column !== 'norbital_approval_id'
		) ?? null
	);
}

async function sidecarDeclarationViolations(input: {
	readonly columnsOf: SeedColumnLookup;
	readonly sidecarKeys: SeedSidecarKeys;
}): Promise<SeedPayloadKeyViolation[]> {
	const violations: SeedPayloadKeyViolation[] = [];
	// stupidity:allow A6 -- each collection's columns come from the same ordered database client
	for (const [collection, keys] of Object.entries(input.sidecarKeys)) {
		const columns = await input.columnsOf(collection);
		for (const [key, reason] of Object.entries(keys)) {
			if (reason.trim().length === 0) {
				violations.push({
					step: 'sidecar declaration',
					collection,
					key,
					rowCount: 0,
					reason: 'sidecar-unexplained'
				});
			} else if (columns.has(key)) {
				violations.push({
					step: 'sidecar declaration',
					collection,
					key,
					rowCount: 0,
					reason: 'sidecar-is-column'
				});
			}
		}
	}
	return violations;
}

/** Every payload key in a plan that the executor cannot account for. */
export async function seedPayloadKeyViolations(input: {
	readonly plan: SeedExecutionPlan;
	readonly columnsOf: SeedColumnLookup;
	readonly sidecarKeys?: SeedSidecarKeys;
}): Promise<SeedPayloadKeyViolation[]> {
	const violations: SeedPayloadKeyViolation[] = input.sidecarKeys
		? await sidecarDeclarationViolations({
				columnsOf: input.columnsOf,
				sidecarKeys: input.sidecarKeys
			})
		: [];
	// stupidity:allow A6 -- every step's columns are read through the same ordered database client
	for (const [index, mutation] of input.plan.mutations.entries()) {
		const collection = mutation.collection_name;
		const step = mutation.step_id ?? `mutation #${index + 1}`;
		const columns = await input.columnsOf(collection);
		if (columns.size === 0) {
			violations.push({
				step,
				collection,
				key: '*',
				rowCount: mutation.payloads.length,
				reason: 'unknown-table'
			});
			continue;
		}
		const sidecars = input.sidecarKeys?.[collection] ?? {};
		const counts = new Map<string, { count: number; relationShaped: boolean }>();
		for (const payload of mutation.payloads) {
			for (const [key, value] of Object.entries(payload)) {
				if (SEED_STRIP_FIELDS.has(key) || columns.has(key) || Object.hasOwn(sidecars, key)) {
					continue;
				}
				const seen = counts.get(key);
				if (seen) seen.count += 1;
				else counts.set(key, { count: 1, relationShaped: isRelationLinkArray(value) });
			}
		}
		// stupidity:allow A6 -- relationship tables are resolved through the same ordered client
		for (const [key, { count, relationShaped }] of counts) {
			if (
				relationShaped &&
				(await relationTargetColumn({
					columnsOf: input.columnsOf,
					collection,
					relationshipName: key
				}))
			) {
				continue;
			}
			const suggestion = relationShaped
				? undefined
				: nearestName(key, columns, suggestionLimit(key));
			violations.push({
				step,
				collection,
				key,
				rowCount: count,
				reason: relationShaped ? 'unresolvable-relation' : 'unknown-column',
				...(suggestion ? { suggestion } : {})
			});
		}
	}
	return violations;
}

/** Half the key's length keeps `worker_code` → `worker_number` but drops unrelated pairings. */
function suggestionLimit(key: string): number {
	return Math.max(2, Math.ceil(key.length / 2));
}

export function describeSeedPayloadKeyViolations(
	templateKey: string,
	violations: readonly SeedPayloadKeyViolation[]
): string {
	const lines = violations.map((violation) => {
		const where = `  ${violation.step} → "${violation.collection}"."${violation.key}"`;
		switch (violation.reason) {
			case 'unknown-table':
				return `  ${violation.step} → no table "${violation.collection}" in this schema (${violation.rowCount} row(s) would vanish)`;
			case 'unresolvable-relation':
				return `${where} looks like a relationship, but no join table links it back to "${violation.collection}" (${violation.rowCount} row(s))`;
			case 'sidecar-is-column':
				return `${where} is declared a sidecar but IS a column, so it is inserted — delete the declaration`;
			case 'sidecar-unexplained':
				return `${where} is declared a sidecar with no reason — say what consumes it before execution`;
			default:
				return `${where} is not a column, in ${violation.rowCount} row(s)${
					violation.suggestion ? ` (closest column: "${violation.suggestion}")` : ''
				}`;
		}
	});
	return (
		`Seed "${templateKey}" writes ${violations.length} payload key(s) this schema cannot accept:\n` +
		`${lines.join('\n')}\n` +
		'Nothing was written. A key that is not a column would be dropped without a word, so the row ' +
		'would seed looking populated while the column stayed NULL. Rename the key to the column it ' +
		'meant, delete it if it is stale, or add the column to the workspace.'
	);
}

/** Refuse a plan whose payloads carry keys this schema cannot accept. Writes nothing. */
export async function assertSeedPayloadKeys(input: {
	readonly templateKey: string;
	readonly plan: SeedExecutionPlan;
	readonly columnsOf: SeedColumnLookup;
	readonly sidecarKeys?: SeedSidecarKeys;
}): Promise<void> {
	const violations = await seedPayloadKeyViolations(input);
	if (violations.length === 0) return;
	throw new Error(describeSeedPayloadKeyViolations(input.templateKey, violations));
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
	// Projection, not a filter: every key here has already been proven to be a column, a
	// relationship the next pass consumes, or a declared sidecar (see assertSeedPayloadKeys).
	// What this drops is only the last two, which by definition do not belong in the INSERT.
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
	const columnsOf: SeedColumnLookup = (tableName) => tableColumns(input.client, tableName);
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
			if (!isRelationLinkArray(links)) continue;
			const targetColumn = await relationTargetColumn({
				columnsOf,
				collection: input.collection,
				relationshipName
			});
			if (!targetColumn) continue;
			const values: unknown[] = [];
			const rowSql: string[] = [];
			for (const link of links) {
				values.push(sourceId, link.record_id);
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
 * The provenance rows this module writes for itself, shaped as a plan step so the same check
 * covers them. Their keys are the executor's own, but `audit_event` is a tenant table like any
 * other — a seed that recorded nothing because that table moved would be exactly as quiet as the
 * drift this refuses.
 */
function provenanceProbeMutation(adminId: string): SeedExecutionPlan['mutations'][number] {
	return {
		step_id: 'seed provenance (written by the executor)',
		collection_name: 'audit_event',
		payloads: seedProvenanceRecords({
			templateKey: 'probe',
			adminId,
			summaries: [{ collectionName: 'probe', rowCount: 0, relationshipCount: 0 }]
		})
	};
}

/** Every honoured sidecar, printed on every run so an exemption cannot accumulate unread. */
function describeHonouredSidecars(sidecarKeys: SeedSidecarKeys | undefined): string | null {
	const honoured = Object.entries(sidecarKeys ?? {}).flatMap(([collection, keys]) =>
		Object.entries(keys).map(([key, reason]) => `"${collection}"."${key}" — ${reason}`)
	);
	return honoured.length > 0
		? `Sidecar payload keys honoured (consumed before execution, never inserted): ${honoured.join('; ')}`
		: null;
}

/**
 * Execute a seed plan against a live tenant DB. The caller resolves the tenant
 * connection string (live zone) so this module stays free of host-application facilities.
 *
 * Every payload key is checked against the live schema before the first write. The check is here
 * rather than in any one caller because this is the single point every seed in the world passes
 * through, and because the schema it must be checked against only exists once the tenant has
 * migrated — this is the first moment the drift is visible, and the last before it is invisible
 * again. See {@link SeedPayloadKeyViolation}.
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
	/** Payload keys the caller consumes itself before seeding; see {@link SeedSidecarKeys}. */
	readonly sidecarKeys?: SeedSidecarKeys;
}): Promise<void> {
	if (input.plan.mutations.length === 0) {
		input.log(`Template "${input.templateKey}" has no seed mutations`);
		return;
	}

	input.log(
		`Seeding template "${input.templateKey}" (${input.plan.mutations.length} bulk seed steps)...`
	);

	const client = input.client ?? new PgClient({ connectionString: input.liveUrl });
	if (!input.client) await client.connect();
	try {
		// Before `clearBefore` deletes anything: a plan that cannot land in full must not have
		// emptied the tenant's collections on its way to failing.
		await assertSeedPayloadKeys({
			templateKey: input.templateKey,
			plan: {
				...input.plan,
				mutations: [...input.plan.mutations, provenanceProbeMutation(input.adminId)]
			},
			columnsOf: (tableName) => tableColumns(client, tableName),
			...(input.sidecarKeys ? { sidecarKeys: input.sidecarKeys } : {})
		});
		const sidecarNote = describeHonouredSidecars(input.sidecarKeys);
		if (sidecarNote) input.log(sidecarNote);

		await authorizeSeedWrites(client);
		if (input.plan.clearBefore?.length) {
			// stupidity:allow A6 -- deletes are dependency-ordered by the authored seed plan
			for (const collection of input.plan.clearBefore) {
				await client.query(`DELETE FROM ${qualifiedTableName(collection)}`);
			}
			input.log(`Cleared seeded collections (${input.plan.clearBefore.join(', ')}).`);
		}

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
