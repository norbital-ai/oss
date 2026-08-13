import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { requireDocker } from '../support/pg-harness.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';
import { createClientDb } from '../support/pglite-node.js';
import { PodSyncClient } from '$lib/ui/sync/pod-sync-client.js';
import type { SyncFetch } from '$lib/ui/sync/types.js';

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
	// The runtime's introspected schema, which is what a real replica boots from: `replica.ts` takes
	// its `schemaSql` straight off the bootstrap payload this endpoint serves. The harness's own
	// `schemaSql` is a concatenation of the template's migrations, and that approximation carries
	// server-only constructs a replica cannot create — a column GENERATED from `norbital_date()`,
	// a function the migration runner installs outside the migrations.
	const response = await harness.request({ method: 'GET', path: 'sync/schema' }, identity);
	if (!response.ok) throw new Error(`sync/schema returned ${response.status}`);
	const client = new PodSyncClient({
		replicaEpoch: 'test-epoch',
		db,
		schemaSql: await response.text(),
		fetch: syncFetchFor(harness, identity)
	});
	await client.bootstrap();
	return client;
}

type CollectionInfo = { name: string; notNull: { name: string; type: string }[] };

/** The columns a caller must supply for `table` — NOT NULL, no default, not system-owned. */
async function requiredColumns(
	harness: PodRuntimeHarness,
	table: string
): Promise<{ name: string; type: string }[]> {
	const cols = await harness.pool.query<{ column_name: string; data_type: string }>(
		`SELECT column_name, data_type FROM information_schema.columns
		  WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO'
		    AND column_name NOT LIKE 'norbital_%' AND column_default IS NULL`,
		[table]
	);
	return cols.rows.map((r) => ({ name: r.column_name, type: r.data_type }));
}

/** Single-column foreign keys on `table`, as referencing column → referenced table. */
async function foreignKeys(
	harness: PodRuntimeHarness,
	table: string
): Promise<Map<string, string>> {
	const rows = await harness.pool.query<{ column_name: string; referenced_table: string }>(
		`SELECT att.attname AS column_name, target.relname AS referenced_table
		   FROM pg_constraint con
		   JOIN pg_class source ON source.oid = con.conrelid
		   JOIN pg_class target ON target.oid = con.confrelid
		   JOIN pg_attribute att ON att.attrelid = source.oid AND att.attnum = con.conkey[1]
		  WHERE con.contype = 'f'
		    AND source.relname = $1
		    AND array_length(con.conkey, 1) = 1`,
		[table]
	);
	return new Map(rows.rows.map((r) => [r.column_name, r.referenced_table]));
}

async function tenantCollections(harness: PodRuntimeHarness): Promise<CollectionInfo[]> {
	const tables = await harness.pool.query<{ name: string }>(
		`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
		  WHERE n.nspname='public' AND c.relkind='r'
		    AND c.relname !~ '_history$'
		    AND c.relname NOT IN ('audit_event','_approval_lock','_norbital_internal_schema',
		      '__drizzle_migrations','sync_outbox','approval_request','requestor','automation_run','user',
		      '_norbital_automation_job',
		      'agent_run_step','team','policy','integration_outbox','notification_outbox','notification',
		      'document_asset','team_members')
		    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='norbital_id')
		  ORDER BY c.relname`
	);
	const infos: CollectionInfo[] = [];
	for (const { name } of tables.rows) {
		infos.push({ name, notNull: await requiredColumns(harness, name) });
	}
	return infos;
}

/** First collection we can server-insert into (constraints `serverInsert` cannot satisfy are skipped). */
async function pickInsertableCollection(harness: PodRuntimeHarness): Promise<CollectionInfo> {
	for (const info of await tenantCollections(harness)) {
		try {
			await serverInsert(harness, info.name, { notNull: info.notNull });
			return info;
		} catch {
			// required FK/constraint we can't satisfy generically — try next
		}
	}
	throw new Error('no server-insertable tenant collection found');
}

function sampleValue(type: string): unknown {
	if (type === 'uuid') return crypto.randomUUID();
	if (type.includes('int') || type === 'numeric' || type.includes('double')) return 1;
	if (type === 'boolean') return false;
	if (type.includes('timestamp') || type === 'date') return new Date().toISOString();
	if (type === 'jsonb' || type === 'json') return {};
	return 'x';
}

/**
 * Insert a row on the server exactly as collection_ops would: via_ops + data + sync_outbox, atomically.
 *
 * Required columns get a synthetic sample value, except two kinds. A column referencing another
 * collection gets a real parent: a synthetic uuid satisfies its type but not its foreign key, so the
 * row it points at is inserted first (recursively — a parent has parents of its own). Without that,
 * no collection carrying an instant would be reachable, because instants live on transactional child
 * rows in every template. A column the caller names in `values` gets that value: the runtime
 * validates rows on the way out, so a column whose domain is narrower than its SQL type (an enum is
 * `text`) needs a value the model accepts, not merely one Postgres accepts.
 */
async function serverInsert(
	harness: PodRuntimeHarness,
	collection: string,
	options: {
		readonly notNull?: { name: string; type: string }[];
		readonly values?: Readonly<Record<string, unknown>>;
		readonly chain?: readonly string[];
	} = {}
): Promise<string> {
	const chain = options.chain ?? [];
	if (chain.includes(collection)) {
		throw new Error(`required foreign keys form a cycle: ${[...chain, collection].join(' -> ')}`);
	}
	const required = options.notNull ?? (await requiredColumns(harness, collection));
	const references = await foreignKeys(harness, collection);
	const values: unknown[] = [];
	for (const column of required) {
		const parent = references.get(column.name);
		const supplied = options.values?.[column.name];
		values.push(
			supplied !== undefined
				? supplied
				: parent
					? await serverInsert(harness, parent, { chain: [...chain, collection] })
					: sampleValue(column.type)
		);
	}
	const client = await harness.pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops','on',true)`);
		const cols = required.map((c) => `"${c.name}"`);
		const placeholders = required.map((_c, i) => `$${i + 1}`);
		const insertSql =
			cols.length > 0
				? `INSERT INTO "${collection}" (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING norbital_id`
				: `INSERT INTO "${collection}" DEFAULT VALUES RETURNING norbital_id`;
		const inserted = await client.query<{ norbital_id: string }>(insertSql, values);
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

const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};

/**
 * The instant this suite drives, named rather than discovered.
 *
 * `time_entries.clock_in` is a punch a worker makes against their own wall clock and the pod stores
 * as a UTC instant — precisely the round trip asserted below, so the fixture and the behaviour under
 * test are the same thing. `hr-payroll` is booted for it: every other template's temporal columns are
 * calendar days (`date`), where an instant would be a bug rather than the subject.
 *
 * This used to query for "any timestamptz column on a table with no foreign key", which is not a
 * property any template promises. It silently had no answer the moment construction's calendar days
 * were correctly retyped to `date`, and the test crashed on the empty result instead of reporting
 * that its fixture had gone.
 */
const TEMPLATE = 'hr-payroll';
const INSTANT_COLLECTION = 'time_entries';
const INSTANT_COLUMN = 'clock_in';

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

	beforeAll(async () => {
		harness = await bootPodRuntime(TEMPLATE);
		collection = (await pickInsertableCollection(harness)).name;
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

		// The fixture is a precondition, not a discovery: state what this test needs and fail saying so
		// if the template stops providing it, rather than crashing on an empty scavenge result.
		const declared = await harness.pool.query<{ data_type: string }>(
			`SELECT data_type FROM information_schema.columns
			  WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
			[INSTANT_COLLECTION, INSTANT_COLUMN]
		);
		expect(
			declared.rows[0]?.data_type,
			`this test drives the client-local wall clock -> UTC instant round trip through ` +
				`${TEMPLATE}'s ${INSTANT_COLLECTION}.${INSTANT_COLUMN}, which must therefore exist and be ` +
				`an instant (timestamptz). If that column was renamed, dropped, or correctly retyped to a ` +
				`calendar day, point this test at another genuine instant column — do not relax it.`
		).toBe('timestamp with time zone');

		// `state` is an enum the runtime validates when it reads the row back for the replica, so the
		// generic `'x'` text sample would make `sync/shape` reject a row Postgres accepted. OPEN is
		// what a punch that has clocked in and not yet out actually is.
		const id = await serverInsert(harness, INSTANT_COLLECTION, { values: { state: 'OPEN' } });
		const utcInstant = new Date('2026-07-26T09:30:00+08:00').toISOString();
		expect(utcInstant).toBe('2026-07-26T01:30:00.000Z');

		const server = await harness.pool.connect();
		try {
			await server.query('BEGIN');
			await server.query(`SELECT set_config('norbital.via_ops','on',true)`);
			await server.query(
				`UPDATE "${INSTANT_COLLECTION}" SET "${INSTANT_COLUMN}" = $1 WHERE norbital_id = $2`,
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
			`SELECT "${INSTANT_COLUMN}" AS value FROM "${INSTANT_COLLECTION}" WHERE norbital_id = $1`,
			[id]
		);
		expect(stored.rows[0]!.value.toISOString()).toBe(utcInstant);

		const client = await makeClient(harness, admin);
		try {
			await client.shapeSubscribe({ collection: INSTANT_COLLECTION, pageSize: 500 });
			const local = await client.queryLocal<Record<string, unknown>>(
				`SELECT * FROM "${INSTANT_COLLECTION}" WHERE "${INSTANT_COLUMN}" = $1::timestamptz`,
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
