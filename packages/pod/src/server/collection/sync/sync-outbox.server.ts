import { sql } from 'drizzle-orm';
import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import type { ProvisionedContext, TenantDbClient } from '$lib/server/bootstrap/workspace_store.js';
import { rowsPerMutationStatement } from '../mutation-batching.js';

export type SyncOutboxAction = 'create' | 'update' | 'delete';

/** Rows per INSERT. Four bind parameters each, so this stays far inside Postgres' 65,535 limit. */
const OUTBOX_CHUNK = rowsPerMutationStatement(6);

function outboxValues(
	collection: string,
	action: SyncOutboxAction,
	record: Record<string, unknown>,
	originScope: Record<string, unknown>
) {
	const recordId = record[SYSTEM_COLUMN_NAMES.PKEY];
	if (typeof recordId !== 'string') return null;
	const rawVersion = record[SYSTEM_COLUMN_NAMES.ROW_VERSION];
	const rowVersion = typeof rawVersion === 'number' ? rawVersion : null;
	return sql`(${collection}, ${recordId}::uuid, ${action}, ${rowVersion}, ${JSON.stringify(originScope)}::jsonb, ${JSON.stringify(record)}::jsonb)`;
}

/**
 * Append one row to the sync-engine change feed (`sync_outbox`) inside the caller's
 * authoritative collection transaction. Because the drizzle mutation db routes through
 * the same pinned connection as the data write + audit + history, this row co-commits
 * atomically with the mutation — never lost, never partial. Ordering/watermarking is the
 * tailer's job (see outbox-tailer.server.ts); here we only stamp the committed fact.
 *
 * `xid` and `seq` are assigned by the table defaults (pg_current_xact_id / BIGSERIAL).
 */
export async function emitSyncOutbox(
	db: NonNullable<ProvisionedContext['drizzleDb']>,
	collection: string,
	action: SyncOutboxAction,
	record: Record<string, unknown>,
	originScope: Record<string, unknown> = {}
): Promise<void> {
	await emitSyncOutboxMany(db, collection, action, [record], originScope);
}

/**
 * The same feed rows for a whole batch, in as few statements as the batch allows.
 *
 * A bulk create writes its records with one `INSERT`; stamping the feed a row at a time would
 * then make the change feed — not the data — the cost of the write. Against a remote database
 * that is decisive: a payroll build persisting 1,290 rows spent ~23 seconds of its ~25 in this
 * loop, one network round trip per row, and hit the runtime's request timeout as the population
 * grew. Rows still co-commit with the mutation, and `seq` is still assigned in the order given,
 * so the tailer sees exactly what it saw before.
 */
export async function emitSyncOutboxMany(
	db: NonNullable<ProvisionedContext['drizzleDb']>,
	collection: string,
	action: SyncOutboxAction,
	records: readonly Record<string, unknown>[],
	originScope: Record<string, unknown> = {}
): Promise<void> {
	const values = records
		.map((record) => outboxValues(collection, action, record, originScope))
		.filter((row) => row != null);
	for (let from = 0; from < values.length; from += OUTBOX_CHUNK) {
		await db.execute(
			sql`INSERT INTO sync_outbox (collection, record_id, action, row_version, origin_scope, record_snapshot)
			    VALUES ${sql.join(values.slice(from, from + OUTBOX_CHUNK), sql`, `)}`
		);
	}
}

/**
 * The same feed row, written through the raw tenant client.
 *
 * `approval_service` is the other authorized writer of collection tables. It cannot go through
 * drizzle's mutation surface — resolving a request restores, resurrects or drops a row with
 * privileged SQL under the terminal-transition bypass, and it UPSERTs the `approval_request`
 * row itself — but what it produces is an ordinary record change, and a record change that never
 * reaches the feed never reaches a synced client.
 * Keeping the statement here means the feed still has exactly one shape and one owner.
 */
export async function emitSyncOutboxRow(
	tenantDb: TenantDbClient,
	collection: string,
	action: SyncOutboxAction,
	recordId: string,
	rowVersion: number | null,
	originScope: Record<string, unknown> = {},
	recordSnapshot: Record<string, unknown> = { norbital_id: recordId }
): Promise<void> {
	await tenantDb.query(
		`INSERT INTO sync_outbox (collection, record_id, action, row_version, origin_scope, record_snapshot)
		 VALUES ($1, $2::uuid, $3, $4, $5::jsonb, $6::jsonb)`,
		[
			collection,
			recordId,
			action,
			rowVersion,
			JSON.stringify(originScope),
			JSON.stringify(recordSnapshot)
		]
	);
}
