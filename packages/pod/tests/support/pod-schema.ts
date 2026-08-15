import type { Client, Pool } from 'pg';
import { text } from 'drizzle-orm/pg-core';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/payload/postgres';
import {
	NON_TEMPORAL_SYSTEM_COLLECTIONS,
	systemTables
} from '@norbital-ai/platform-utils/system/workspace-schema';
import { defineModel, defineModels, defineRuntimeRegistry } from '$lib/authoring/filesystem.js';
import { SCHEMA_FUNCTIONS_SQL, schemaPostDdlSql } from '$lib/vite/schema-functions-sql.js';

/** What a workspace with no tenant opt-out passes: the system collections that declare no history. */
export const POD_SCHEMA_POST_DDL_SQL = schemaPostDdlSql(NON_TEMPORAL_SYSTEM_COLLECTIONS);

type Queryable = Pick<Client | Pool, 'query'>;

/**
 * The tenant collection these suites write through. Same constructor as a workspace model, so
 * system columns and history come from the authoring layer rather than a second CREATE TABLE.
 */
const tenant = defineRuntimeRegistry({
	models: defineModels({
		orders: defineModel(
			{
				status: text(),
				tags: text().array()
			},
			{ history: true }
		)
	}),
	relationships: () => ({})
});

export const orders = tenant.tables.orders;

function collectionTables(): Record<string, unknown> {
	return {
		...Object.fromEntries(
			Object.entries(systemTables).map(([name, entry]) => [name, entry.table])
		),
		...tenant.tables
	};
}

let collectionDdl: Promise<string> | undefined;

async function collectionDdlSql(): Promise<string> {
	const empty = await generateDrizzleJson({});
	const current = await generateDrizzleJson(collectionTables());
	const statements = await generateMigration(empty, current);
	return statements.filter((statement) => statement.trim().length > 0).join(';\n');
}

/**
 * Apply the real pod tenant internals to a fresh database, exactly as the migration applier
 * does: schema functions first, then the drizzle collection tables, then post-DDL (which seeds
 * singleton rows and attaches _ops_guard / _approval_lock_gate per collection table).
 */
export async function applyPodSchema(client: Queryable): Promise<void> {
	collectionDdl ??= collectionDdlSql();
	await client.query(SCHEMA_FUNCTIONS_SQL);
	await client.query(await collectionDdl);
	await client.query(POD_SCHEMA_POST_DDL_SQL);
}

/**
 * A `user` row the real `audit_event.actor_id` foreign key can point at.
 * Hand-rolled test DDL used to omit that constraint; the collection schema does not.
 */
export async function seedTestUser(
	client: Queryable,
	userId: string,
	email = 'actor@example.com'
): Promise<void> {
	await client.query(
		`INSERT INTO "user" (norbital_id, email) VALUES ($1::uuid, $2)
		 ON CONFLICT (norbital_id) DO NOTHING`,
		[userId, email]
	);
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
