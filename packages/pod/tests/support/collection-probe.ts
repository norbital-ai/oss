import type { PodRuntimeHarness } from './pod-runtime-harness.js';

/**
 * A collection of a booted template that a test can write to directly, plus the columns any
 * insert has to supply. Tests that need "some real collection" pick one this way rather than
 * hard-coding a name, so they keep working as the template workspaces change.
 */
export type ProbeCollection = {
	readonly name: string;
	readonly notNull: readonly { name: string; type: string }[];
};

export function sampleValue(type: string): unknown {
	if (type.includes('int') || type === 'numeric' || type.includes('double')) return 1;
	if (type === 'boolean') return false;
	if (type.includes('timestamp') || type === 'date') return new Date().toISOString();
	if (type === 'jsonb' || type === 'json') return {};
	return 'x';
}

export async function pickCollection(harness: PodRuntimeHarness): Promise<ProbeCollection> {
	const tables = await harness.pool.query<{ name: string }>(
		`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
		  WHERE n.nspname='public' AND c.relkind='r' AND c.relname !~ '_history$'
		    AND c.relname NOT IN ('mutation_log','audit_event','_approval_lock','_norbital_internal_schema',
		      '__drizzle_migrations','sync_outbox','approval_request','requestor','automation_run','user',
		      'team','policy','chat_session','integration_outbox','notification','document_asset','team_members')
		    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='norbital_id')
		  ORDER BY c.relname`
	);
	for (const { name } of tables.rows) {
		const cols = await harness.pool.query<{ column_name: string; data_type: string }>(
			`SELECT column_name, data_type FROM information_schema.columns
			  WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO'
			    AND column_name NOT LIKE 'norbital_%' AND column_default IS NULL`,
			[name]
		);
		const notNull = cols.rows.map((r) => ({ name: r.column_name, type: r.data_type }));
		try {
			await serverInsert(harness, { name, notNull });
			return { name, notNull };
		} catch {
			// required FK — try next
		}
	}
	throw new Error('no server-insertable collection');
}

/**
 * Insert a row on the server exactly as collection_ops would: one transaction carrying `via_ops`,
 * the data write, and the change-feed row. `approvalRequestId` stamps the row the way a gated
 * create does, so the record is live but held by a pending request.
 */
export async function serverInsert(
	harness: PodRuntimeHarness,
	collection: ProbeCollection,
	approvalRequestId?: string
): Promise<string> {
	const client = await harness.pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops','on',true)`);
		const values = collection.notNull.map((c) => sampleValue(c.type));
		const cols = collection.notNull.map((c) => `"${c.name}"`);
		if (approvalRequestId) {
			cols.push('"norbital_approval_id"');
			values.push(approvalRequestId);
		}
		const placeholders = values.map((_v, i) => `$${i + 1}`);
		const sql =
			cols.length > 0
				? `INSERT INTO "${collection.name}" (${cols.join(',')}) VALUES (${placeholders.join(',')}) RETURNING norbital_id`
				: `INSERT INTO "${collection.name}" DEFAULT VALUES RETURNING norbital_id`;
		const inserted = await client.query<{ norbital_id: string }>(sql, values);
		const id = inserted.rows[0]!.norbital_id;
		await client.query(
			`INSERT INTO sync_outbox (collection, record_id, action, row_version) VALUES ($1,$2,'create',1)`,
			[collection.name, id]
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

export async function waitFor(
	predicate: () => Promise<boolean>,
	timeoutMs = 10000
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

/** Delete a row the way collection_ops does: one via_ops transaction, data plus feed row. */
export async function deleteServerRow(
	harness: PodRuntimeHarness,
	collection: string,
	recordId: string
): Promise<void> {
	const client = await harness.pool.connect();
	try {
		await client.query('BEGIN');
		await client.query(`SELECT set_config('norbital.via_ops','on',true)`);
		await client.query(`DELETE FROM "${collection}" WHERE norbital_id = $1::uuid`, [recordId]);
		await client.query(
			`INSERT INTO sync_outbox (collection, record_id, action) VALUES ($1,$2::uuid,'delete')`,
			[collection, recordId]
		);
		await client.query('COMMIT');
	} catch (err) {
		await client.query('ROLLBACK').catch(() => undefined);
		throw err;
	} finally {
		client.release();
	}
}
