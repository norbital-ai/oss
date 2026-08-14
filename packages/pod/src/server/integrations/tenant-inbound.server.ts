import { eq, getColumns } from 'drizzle-orm';
import { integration_cursor } from '@norbital-ai/platform-utils/system/workspace-schema';
import { getWorkspace, type ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { createMany, updateRecord } from '$lib/server/collection/collection_ops.server.js';
import { withCollectionTransaction } from '$lib/server/collection/collection_transaction.server.js';
import { createBeforeApi } from '$lib/server/collection/hook-api.server.js';
import {
	parseIntegrationReceiveInput,
	runIntegrationReceivePipeline
} from '$lib/server/run/collection_pipeline.js';
import { randomUUID } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';

/** The manifest's own name for one binding, and the key its resume point is stored under. */
export function integrationBindingKey(integrationName: string, bindingName: string): string {
	return `${integrationName}:${bindingName}`;
}

export type IntegrationCursorRequest =
	| {
			readonly kind: 'integration-cursor';
			readonly action: 'read';
			readonly integrationName: string;
			readonly bindingName: string;
	  }
	| {
			readonly kind: 'integration-cursor';
			readonly action: 'write';
			readonly integrationName: string;
			readonly bindingName: string;
			readonly cursor?: string | null;
			readonly error?: string | null;
	  };

/**
 * Read or advance one pull binding's resume point.
 *
 * Lives tenant-side rather than in the job because the job has no database: under Core the pull runs
 * in the host process and reaches the tenant only over the host-command plane, exactly as the outbox
 * drain does.
 */
export async function runIntegrationCursor(request: IntegrationCursorRequest) {
	const ctx = getWorkspace({ provision: true });
	const db = ctx.drizzleDb;
	if (!db) throw new Error('Tenant database is not provisioned');
	const columns = getColumns(integration_cursor);
	const bindingKey = integrationBindingKey(request.integrationName, request.bindingName);

	if (request.action === 'read') {
		const [row] = await db
			.select({ cursor: columns.cursor })
			.from(integration_cursor)
			.where(eq(columns.binding_key, bindingKey))
			.limit(1);
		return { cursor: row?.cursor ?? null };
	}

	const values = {
		integration_name: request.integrationName,
		binding_name: request.bindingName,
		binding_key: bindingKey,
		cursor: request.cursor ?? null,
		last_pulled_at: new Date(),
		last_error: request.error ?? null
	};
	await db
		.insert(integration_cursor)
		.values(values)
		.onConflictDoUpdate({ target: columns.binding_key, set: values });
	return { cursor: values.cursor };
}

/**
 * What one inbound delivery did.
 *
 * `refused` is not an error: the binding's `input` schema turned the payload down before anything was
 * written, so the caller knows the answer is final. `duplicate` means the event id was already claimed
 * and no import ran at all.
 */
export type IntegrationImportOutcome = {
	readonly imported: number;
	readonly status: 'imported' | 'duplicate' | 'refused';
	readonly receiptId?: string;
	readonly reason?: string;
};

const INTEGRATION_IMPORT_LEASE_MS = 60_000;

type InboundReceipt = {
	readonly norbital_id: string;
	readonly integration_name: string;
	readonly binding_name: string;
	readonly collection_name: string;
	readonly import_data: unknown;
	readonly materialized_records: unknown[] | null;
	readonly attempts: number;
};

/**
 * Claim the right to import this delivery exactly once.
 *
 * Returns `null` when the receipt already exists, which is the whole duplicate defence. The claim
 * happens *before* the pipeline runs, so a redelivery — a slow acknowledgement, a provider's retry, an
 * operator pressing "resend" — costs one failed insert rather than a second copy of every row the
 * page carries. Same order and same reason as `channel_inbound_message`.
 */
async function claimInboundEvent(params: {
	readonly integrationName: string;
	readonly bindingName: string;
	readonly collectionName: string;
	readonly importData: unknown;
	readonly eventId: string;
}): Promise<string | null> {
	const ctx = getWorkspace({ provision: true });
	const bindingKey = integrationBindingKey(params.integrationName, params.bindingName);
	const claimed = await ctx.tenantDb.query<{ norbital_id: string }>({
		text: `INSERT INTO integration_inbound_event
		            (integration_name, binding_name, binding_key, collection_name, event_id, receipt_key,
		             status, import_data, next_offset, attempts, available_at)
		     VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb, 0, 0, now())
		 ON CONFLICT (receipt_key) DO NOTHING
		  RETURNING norbital_id`,
		values: [
			params.integrationName,
			params.bindingName,
			bindingKey,
			params.collectionName,
			params.eventId,
			`${bindingKey}:${params.eventId}`,
			JSON.stringify(params.importData)
		]
	});
	return claimed.rows[0]?.norbital_id ?? null;
}

// ── retention ──────────────────────────────────────────────────────────────────
//
// The ledger is a duplicate defence, and a duplicate defence is only useful for as long as a
// provider might redeliver. Past that it is a row per delivery, kept forever, on a table nothing
// reads — the table grows with tenant age instead of with anything anyone can act on.

/**
 * How long a claimed delivery stays in the ledger.
 *
 * This is the deduplication window, so it has to outlast every retry policy pointed at it: Stripe
 * gives up after about three days, most others within one. A month leaves an order of magnitude of
 * headroom, which matters because pruning a row is exactly the same as forgetting the delivery — a
 * redelivery after the cut would import a second copy. Same shape as `pruneSyncOutbox`, deliberately.
 */
const INBOUND_RETENTION_DAYS = 30;

/** Never prune below this many recent receipts, however old they are. */
const INBOUND_RETENTION_FLOOR_ROWS = 1_000;

/** How often a runtime bothers to sweep. The work is idempotent; this only limits churn. */
const INBOUND_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let lastInboundPruneAt = 0;

/**
 * Drop inbound receipts past their retention.
 *
 * The floor is expressed as "keep the newest N of the ones already outside the window", the same way
 * the sync outbox expresses it, so a quiet tenant whose every receipt is old still keeps a usable
 * duplicate window rather than being emptied by the clock alone. One statement, so a concurrent claim
 * cannot see a half-swept table.
 */
export async function pruneInboundEvents(
	ctx: Pick<ProvisionedContext, 'tenantDb'>,
	options?: { force?: boolean }
): Promise<{ deleted: number }> {
	if (!options?.force && Date.now() - lastInboundPruneAt < INBOUND_PRUNE_INTERVAL_MS) {
		return { deleted: 0 };
	}
	lastInboundPruneAt = Date.now();

	const result = await ctx.tenantDb.query<{ deleted: string }>({
		text: `WITH old AS (
		         SELECT norbital_id
		           FROM integration_inbound_event
		          WHERE norbital_created_at < now() - ($1 || ' days')::interval
		          ORDER BY norbital_created_at DESC, norbital_id DESC
		         OFFSET $2
		       ),
		       removed AS (
		         DELETE FROM integration_inbound_event
		          WHERE norbital_id IN (SELECT norbital_id FROM old)
		      RETURNING norbital_id
		       )
		       SELECT count(*)::text AS deleted FROM removed`,
		values: [String(INBOUND_RETENTION_DAYS), INBOUND_RETENTION_FLOOR_ROWS]
	});
	return { deleted: Number(result.rows[0]?.deleted ?? 0) };
}

async function settleInboundEvent(
	receiptId: string,
	values: Record<string, unknown>
): Promise<void> {
	const ctx = getWorkspace({ provision: true });
	await updateRecord(ctx, 'integration_inbound_event', receiptId, values, {
		isElevated: true
	}).catch(() => undefined);
}

/**
 * Run one inbound binding's import pipeline and write what it produced.
 *
 * The pipeline returning rows is not the same as rows existing — until this ran, every inbound path
 * ended at a value nobody stored, which is why a `receive` binding could be declared, dispatched, and
 * still leave the collection empty. Writes are elevated: the caller is a schedule, a system event, or
 * a webhook the host already authenticated, so there is no requestor whose policy could scope them.
 *
 * `eventId` is what makes a delivery repeatable-safe, and it is optional because not every inbound
 * path has one: a scheduled pull is already deduplicated by its cursor, and a system event is emitted
 * once by this pod. A webhook is the case with a real remote retry policy behind it, so it always
 * carries one — the provider's own id, or a digest of the body when the provider sends none.
 */
export async function importIntegrationRecords(params: {
	readonly integrationName: string;
	readonly bindingName: string;
	readonly collectionName: string;
	readonly importData: unknown;
	readonly eventId?: string;
}): Promise<IntegrationImportOutcome> {
	const receiptId = await claimInboundEvent({
		integrationName: params.integrationName,
		bindingName: params.bindingName,
		collectionName: params.collectionName,
		importData: params.importData,
		eventId: params.eventId ?? randomUUID()
	});
	if (!receiptId) return { imported: 0, status: 'duplicate' };
	try {
		parseIntegrationReceiveInput(params);
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		await settleInboundEvent(receiptId, {
			status: 'failed', error: reason, completed_at: new Date().toISOString()
		});
		return { imported: 0, status: 'refused', reason };
	}
	// Swept from the one path that writes the table, exactly as sync retention is swept from the one
	// path that reads its feed. Detached and swallowed: a delivery already claimed must not fail
	// because housekeeping did.
	void pruneInboundEvents(getWorkspace({ provision: true })).catch(() => undefined);
	const first = await runIntegrationImportWorker();
	if (first.status !== 'processed') {
		throw new Error('Integration import could not finish in one shot');
	}
	return {
		imported: first.imported ?? 0,
		status: 'imported',
		receiptId
	};
}

/** Claim one available receipt, recovering a worker that lost its lease without replaying a chunk. */
async function claimNextInboundEvent(): Promise<InboundReceipt | null> {
	const ctx = getWorkspace({ provision: true });
	const claimed = await ctx.tenantDb.query<InboundReceipt>({
		text: `WITH candidate AS (
		         SELECT norbital_id
		           FROM integration_inbound_event
		          WHERE collection_name IS NOT NULL
		            AND import_data IS NOT NULL
		            AND (
		              (status = 'queued' AND available_at <= now())
		              OR (status = 'processing' AND claimed_at < now() - ($1::bigint * interval '1 millisecond'))
		            )
		          ORDER BY available_at ASC, norbital_created_at ASC, norbital_id ASC
		          LIMIT 1
		          FOR UPDATE SKIP LOCKED
		       )
		       UPDATE integration_inbound_event receipt
		          SET status = 'processing', claimed_at = now(), attempts = receipt.attempts + 1
		         FROM candidate
		        WHERE receipt.norbital_id = candidate.norbital_id
		    RETURNING receipt.norbital_id, receipt.integration_name, receipt.binding_name,
		              receipt.collection_name, receipt.import_data, receipt.materialized_records,
		              receipt.attempts`,
		values: [INTEGRATION_IMPORT_LEASE_MS]
	});
	return claimed.rows[0] ?? null;
}

function recordsFromPipeline(output: unknown): Record<string, unknown>[] {
	if (!Array.isArray(output) || output.some((record) => record == null || typeof record !== 'object' || Array.isArray(record))) {
		throw new Error('Integration import pipeline must return an array of records');
	}
	return output as Record<string, unknown>[];
}

async function failInboundEvent(receipt: InboundReceipt, cause: unknown): Promise<void> {
	const ctx = getWorkspace({ provision: true });
	const reason = cause instanceof Error ? cause.message : String(cause);
	await ctx.tenantDb.query({
		text: `UPDATE integration_inbound_event
		          SET status = 'failed', error = $2, claimed_at = NULL, completed_at = now()
		        WHERE norbital_id = $1 AND status = 'processing'`,
		values: [receipt.norbital_id, reason]
	});
}

/**
 * Import one claimed receipt in a single `createMany`. The whole materialized payload is
 * written or the delivery fails — there is no leftover offset and no queued drain.
 */
export async function runIntegrationImportWorker(): Promise<{
	readonly status: 'idle' | 'processed' | 'failed';
	readonly receiptId?: string;
	readonly imported?: number;
}> {
	const receipt = await claimNextInboundEvent();
	if (!receipt) return { status: 'idle' };
	try {
		let records = receipt.materialized_records
			? recordsFromPipeline(receipt.materialized_records)
			: undefined;
		if (!records) {
			records = recordsFromPipeline(
				await runIntegrationReceivePipeline({
					integrationName: receipt.integration_name,
					bindingName: receipt.binding_name,
					collectionName: receipt.collection_name,
					importData: receipt.import_data,
					api: createBeforeApi()
				})
			);
			const ctx = getWorkspace({ provision: true });
			await ctx.tenantDb.query({
				text: `UPDATE integration_inbound_event
				          SET materialized_records = $2::jsonb, error = NULL
				        WHERE norbital_id = $1 AND status = 'processing'`,
				values: [receipt.norbital_id, JSON.stringify(records)]
			});
		}
		const total = records.length;
		const ctx = getWorkspace({ provision: true });
		await withCollectionTransaction(ctx, async () => {
			const result = await createMany(ctx, receipt.collection_name, records, {
				isElevated: true,
				recordIds: records.map((_, index) => uuidv5(String(index), receipt.norbital_id))
			});
			if (result.records.length !== total) {
				throw new Error('This function could not finish the bulk write');
			}
			await ctx.tenantDb.query({
				text: `UPDATE integration_inbound_event
				          SET imported = $2::integer, error = NULL, claimed_at = NULL,
				              status = 'imported', completed_at = now(), available_at = now()
				        WHERE norbital_id = $1 AND status = 'processing'`,
				values: [receipt.norbital_id, total]
			});
		});
		return { status: 'processed', receiptId: receipt.norbital_id, imported: total };
	} catch (cause) {
		await failInboundEvent(receipt, cause);
		return { status: 'failed', receiptId: receipt.norbital_id };
	}
}

/**
 * Deliver one system event to every `receive` binding waiting on it.
 *
 * The two halves are matched by exact event name; `assertSystemEventsAreReachable` has already
 * refused a workspace where they do not line up, so a zero here means the event genuinely has no
 * subscriber rather than a typo nobody noticed.
 */
export async function dispatchSystemEvent(params: {
	readonly eventId: string;
	readonly event: string;
	readonly payload: Record<string, unknown>;
}): Promise<{ readonly handled: number; readonly imported: number }> {
	const workspace = getTenantWorkspace();
	const matching = Object.entries(workspace.registered.integrationBindings).flatMap(
		([bindingKey, binding]) => {
			if (binding.direction !== 'receive' || binding.systemEvent !== params.event) return [];
			const separator = bindingKey.indexOf(':');
			if (separator < 1) throw new Error(`Invalid integration binding key: ${bindingKey}`);
			return [
				{
					integrationName: bindingKey.slice(0, separator),
					bindingName: bindingKey.slice(separator + 1),
					collectionName: binding.collection
				}
			];
		}
	);
	const results = await Promise.all(
		matching.map((binding) =>
			importIntegrationRecords({
				...binding,
				importData: { event_id: params.eventId, event: params.event, payload: params.payload },
				eventId: params.eventId
			})
		)
	);
	return {
		handled: matching.length,
		imported: results.reduce((total, result) => total + result.imported, 0)
	};
}
