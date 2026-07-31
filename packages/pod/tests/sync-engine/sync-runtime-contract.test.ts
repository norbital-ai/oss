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

requireDocker();

/** Build a SyncFetch that drives the in-process pod runtime as a specific user identity. */
function syncFetchFor(harness: PodRuntimeHarness, identity: Identity): SyncFetch {
	return (path, init) =>
		harness.request(
			{
				method: init.method,
				path,
				body: init.body,
				signal: init.signal,
				headers: init.accept ? { accept: init.accept, 'content-type': 'application/json' } : {}
			},
			identity
		);
}

async function makeClient(harness: PodRuntimeHarness, identity: Identity): Promise<PodSyncClient> {
	const db = await createClientDb();
	const client = new PodSyncClient({
		replicaEpoch: 'test-epoch',
		db,
		schemaSql: harness.schemaSql,
		fetch: syncFetchFor(harness, identity)
	});
	await client.bootstrap();
	return client;
}

type CollectionInfo = { name: string; notNull: { name: string; type: string }[] };

async function tenantCollections(harness: PodRuntimeHarness): Promise<CollectionInfo[]> {
	const tables = await harness.pool.query<{ name: string }>(
		`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
		  WHERE n.nspname='public' AND c.relkind='r' AND c.relname !~ '_history$'
		    AND c.relname NOT IN ('mutation_log','audit_event','_approval_lock','_norbital_internal_schema',
		      '__drizzle_migrations','sync_outbox','approval_request','requestor','automation_run','user',
		      'team','policy','chat_session','integration_outbox','notification','document_asset','team_members')
		    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='norbital_id')
		  ORDER BY c.relname`
	);
	const infos: CollectionInfo[] = [];
	for (const { name } of tables.rows) {
		const cols = await harness.pool.query<{ column_name: string; data_type: string }>(
			`SELECT column_name, data_type FROM information_schema.columns
			  WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO'
			    AND column_name NOT LIKE 'norbital_%' AND column_default IS NULL`,
			[name]
		);
		infos.push({
			name,
			notNull: cols.rows.map((r) => ({ name: r.column_name, type: r.data_type }))
		});
	}
	return infos;
}

/** First collection we can server-insert into (no required-FK columns) — for propagation tests. */
async function pickInsertableCollection(harness: PodRuntimeHarness): Promise<CollectionInfo> {
	for (const info of await tenantCollections(harness)) {
		try {
			await serverInsert(harness, info.name, info.notNull);
			return info;
		} catch {
			// required FK/constraint we can't satisfy generically — try next
		}
	}
	throw new Error('no server-insertable tenant collection found');
}

function sampleValue(type: string): unknown {
	if (type.includes('int') || type === 'numeric' || type.includes('double')) return 1;
	if (type === 'boolean') return false;
	if (type.includes('timestamp') || type === 'date') return new Date().toISOString();
	if (type === 'jsonb' || type === 'json') return {};
	return 'x';
}

/** SQL literal for a column type, for bulk generate_series inserts. */
function literalFor(type: string): string {
	if (type.includes('int') || type === 'numeric' || type.includes('double')) return '1';
	if (type === 'boolean') return 'false';
	if (type.includes('timestamp')) return 'now()';
	if (type === 'date') return 'current_date';
	if (type === 'jsonb' || type === 'json') return `'{}'::jsonb`;
	return `'x'`;
}

/** Insert a row on the server exactly as collection_ops would: via_ops + data + sync_outbox, atomically. */
async function serverInsert(
	harness: PodRuntimeHarness,
	collection: string,
	notNull: { name: string; type: string }[]
): Promise<string> {
	const client = await harness.pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops','on',true)`);
		const cols = notNull.map((c) => `"${c.name}"`);
		const vals = notNull.map((c) => sampleValue(c.type));
		const placeholders = notNull.map((_c, i) => `$${i + 1}`);
		const insertSql =
			cols.length > 0
				? `INSERT INTO "${collection}" (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING norbital_id`
				: `INSERT INTO "${collection}" DEFAULT VALUES RETURNING norbital_id`;
		const inserted = await client.query<{ norbital_id: string }>(insertSql, vals);
		const id = inserted.rows[0]!.norbital_id;
		await client.query(
			`INSERT INTO sync_outbox (collection, record_id, action, row_version) VALUES ($1,$2,'create',1)`,
			[collection, id]
		);
		await client.query('COMMIT');
		return id;
	} catch (err) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw err;
	} finally {
		client.release();
	}
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};

/**
 * Server-side sync behaviour that only a real runtime can show.
 *
 * Deliberately narrow. This file used to also assert catch-up scoping, 10-client propagation,
 * offline reconnect, windowed 100k reads and version CONFLICT — all of which are owned by
 * `sync-e2e-comprehensive` and `pod-sync-client`, and having two files answer the same question
 * means neither is the one you fix when the answer changes. What is left is the two behaviours
 * nothing else asserts: how the runtime stores a client-local timestamp, and that an introspected
 * schema actually applies to a fresh replica. The authoritative mutation + audit contract belongs
 * to the comprehensive runtime suite.
 */
describe('Pod Sync — runtime contract (real runtime + PGlite clients)', () => {
	let harness: PodRuntimeHarness;
	let collection: string;
	let notNull: { name: string; type: string }[];

	beforeAll(async () => {
		harness = await bootPodRuntime('construction');
		const picked = await pickInsertableCollection(harness);
		collection = picked.name;
		notNull = picked.notNull;
	}, 180_000);

	afterAll(async () => {
		await harness?.stop();
	});

	it('stores client-local timestamps as UTC instants and filters the replica by that instant', async () => {
		const naiveColumns = await harness.pool.query<{ table_name: string; column_name: string }>(
			`SELECT table_name, column_name
			   FROM information_schema.columns c
			  WHERE table_schema = 'public'
			    AND data_type = 'timestamp without time zone'
			    AND EXISTS (
			      SELECT 1 FROM information_schema.columns p
			       WHERE p.table_schema = c.table_schema
			         AND p.table_name = c.table_name
			         AND p.column_name = 'norbital_id'
			    )`
		);
		expect(naiveColumns.rows).toEqual([]);

		const collectionInfos = await tenantCollections(harness);
		const temporalColumn = await harness.pool.query<{
			table_name: string;
			column_name: string;
		}>(
			`SELECT table_name, column_name
			   FROM information_schema.columns c
			  WHERE table_schema = 'public'
			    AND data_type = 'timestamp with time zone'
			    AND column_name NOT LIKE 'norbital_%'
			    AND table_name = ANY($1::text[])
			    AND EXISTS (
			      SELECT 1 FROM information_schema.columns p
			       WHERE p.table_schema = c.table_schema
			         AND p.table_name = c.table_name
			         AND p.column_name = 'norbital_id'
			    )
			  ORDER BY table_name, ordinal_position
			  LIMIT 1`,
			[collectionInfos.map((info) => info.name)]
		);
		const target = temporalColumn.rows[0]!;
		const targetInfo = collectionInfos.find((info) => info.name === target.table_name)!;
		const id = await serverInsert(harness, target.table_name, targetInfo.notNull);
		const utcInstant = new Date('2026-07-26T09:30:00+08:00').toISOString();
		expect(utcInstant).toBe('2026-07-26T01:30:00.000Z');

		const server = await harness.pool.connect();
		try {
			await server.query('BEGIN');
			await server.query(`SELECT set_config('norbital.via_ops','on',true)`);
			await server.query(
				`UPDATE "${target.table_name}" SET "${target.column_name}" = $1 WHERE norbital_id = $2`,
				[utcInstant, id]
			);
			await server.query('COMMIT');
		} catch (cause) {
			await server.query('ROLLBACK').catch(() => undefined);
			throw cause;
		} finally {
			server.release();
		}
		const stored = await harness.pool.query<{ value: Date }>(
			`SELECT "${target.column_name}" AS value FROM "${target.table_name}" WHERE norbital_id = $1`,
			[id]
		);
		expect(stored.rows[0]!.value.toISOString()).toBe(utcInstant);

		const client = await makeClient(harness, admin);
		try {
			await client.shapeSubscribe({ collection: target.table_name, pageSize: 500 });
			const local = await client.queryLocal<Record<string, unknown>>(
				`SELECT * FROM "${target.table_name}" WHERE "${target.column_name}" = $1::timestamptz`,
				[utcInstant]
			);
			expect(local.some((row) => row.norbital_id === id)).toBe(true);
		} finally {
			await client.close();
		}
	});

	it('serves an introspected client schema that applies to a fresh replica', async () => {
		const response = await harness.request({ method: 'GET', path: 'sync/schema' }, admin);
		expect(response.status).toBe(200);
		const ddl = await response.text();
		expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS "${collection}"`);
		// The introspected DDL must be valid and applicable to a fresh PGlite (the real client boot).
		const db = await createClientDb();
		try {
			await db.exec(ddl);
			const tables = await db.query<{ n: string }>(
				`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
				[collection]
			);
			expect(Number(tables.rows[0]!.n)).toBe(1);
		} finally {
			await db.close?.();
		}
	});
});
