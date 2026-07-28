import type { Client, Pool } from 'pg';
import { SCHEMA_FUNCTIONS_SQL, SCHEMA_POST_DDL_SQL } from '$lib/vite/schema-functions-sql.js';

type Queryable = Pick<Client | Pool, 'query'>;

/** A collection table carrying the full norbital system columns, like a compiled tenant table. */
const ORDERS_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS orders (
		norbital_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		norbital_created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
		norbital_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
		norbital_sys_period TEXT NOT NULL DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text),
		norbital_row_version INTEGER NOT NULL DEFAULT 1,
		norbital_approval_id UUID,
		status TEXT
	);
`;

/**
 * The system collections the approval lifecycle is written against, with the same columns
 * workspace-schema.ts compiles for a real tenant. They exist before post-DDL so the shipped SQL
 * finds `approval_request` and attaches `_approval_lock_sync` plus the `_approval_lock` foreign
 * key — the pieces that make a lock follow its request's status.
 */
const APPROVAL_TABLES_SQL = `
	CREATE TABLE IF NOT EXISTS "user" (
		norbital_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		norbital_created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
		norbital_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
		norbital_sys_period TEXT NOT NULL DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text),
		norbital_row_version INTEGER NOT NULL DEFAULT 1,
		norbital_approval_id UUID,
		email TEXT NOT NULL UNIQUE,
		name TEXT
	);

	CREATE TABLE IF NOT EXISTS approval_request (
		norbital_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		norbital_created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
		norbital_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
		norbital_sys_period TEXT NOT NULL DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text),
		norbital_row_version INTEGER NOT NULL DEFAULT 1,
		norbital_approval_id UUID,
		organization_id UUID NOT NULL,
		label TEXT NOT NULL,
		approval_config_id UUID NOT NULL,
		collection_name TEXT NOT NULL,
		status TEXT NOT NULL,
		approval_step_nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
		locked_record_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
		closed_at TIMESTAMPTZ
	);

	CREATE TABLE IF NOT EXISTS requestor (
		norbital_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		norbital_created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
		norbital_updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
		norbital_sys_period TEXT NOT NULL DEFAULT tstzrange(CURRENT_TIMESTAMP, NULL, '[)'::text),
		norbital_row_version INTEGER NOT NULL DEFAULT 1,
		norbital_approval_id UUID,
		approval_request_id UUID NOT NULL REFERENCES approval_request(norbital_id),
		user_id UUID NOT NULL REFERENCES "user"(norbital_id)
	);
`;

/**
 * Apply the real pod tenant internals to a fresh database, exactly as the migration applier
 * does: schema functions first, then the collection table(s), then post-DDL (which creates
 * sync_outbox and attaches _ops_guard / _approval_lock_gate per collection table). Using the
 * production SQL constants means these tests exercise the shipped DDL, not a hand-rolled copy.
 */
export async function applyPodSchema(client: Queryable): Promise<void> {
	await client.query(SCHEMA_FUNCTIONS_SQL);
	await client.query(ORDERS_TABLE_SQL);
	await client.query(APPROVAL_TABLES_SQL);
	await client.query(SCHEMA_POST_DDL_SQL);
}

/**
 * An open request for suites that fabricate `_approval_lock` rows by hand to exercise the gate.
 * A lock belongs to a request — `fk_approval_lock_request` says so — so it needs one to point at.
 */
export async function seedApprovalRequest(
	client: Queryable,
	approvalRequestId: string
): Promise<void> {
	await client.query(
		`INSERT INTO approval_request (
		   norbital_id, organization_id, label, approval_config_id, collection_name, status
		 ) VALUES ($1::uuid, gen_random_uuid(), 'Test request', gen_random_uuid(), 'orders', 'ONGOING')
		 ON CONFLICT (norbital_id) DO NOTHING`,
		[approvalRequestId]
	);
}
