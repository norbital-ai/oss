import { eq, getColumns } from 'drizzle-orm';
import { integration_cursor } from '@norbital-ai/platform-utils/system/workspace-schema';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { createRecord, updateRecord } from '$lib/server/collection/collection_ops.server.js';
import { createBeforeApi } from '$lib/server/collection/hook-api.server.js';
import { runIntegrationReceivePipeline } from '$lib/server/run/collection_pipeline.js';

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
	readonly reason?: string;
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
	readonly eventId: string;
}): Promise<string | null> {
	const ctx = getWorkspace({ provision: true });
	const bindingKey = integrationBindingKey(params.integrationName, params.bindingName);
	const claimed = await ctx.tenantDb.query<{ norbital_id: string }>({
		text: `INSERT INTO integration_inbound_event
		            (integration_name, binding_name, binding_key, event_id, receipt_key, status)
		     VALUES ($1, $2, $3, $4, $5, 'received')
		 ON CONFLICT (receipt_key) DO NOTHING
		  RETURNING norbital_id`,
		values: [
			params.integrationName,
			params.bindingName,
			bindingKey,
			params.eventId,
			`${bindingKey}:${params.eventId}`
		]
	});
	return claimed.rows[0]?.norbital_id ?? null;
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
	const receiptId = params.eventId
		? await claimInboundEvent({
				integrationName: params.integrationName,
				bindingName: params.bindingName,
				eventId: params.eventId
			})
		: null;
	if (params.eventId && !receiptId) return { imported: 0, status: 'duplicate' };

	let records: Awaited<ReturnType<typeof runIntegrationReceivePipeline>>;
	try {
		records = await runIntegrationReceivePipeline({
			integrationName: params.integrationName,
			bindingName: params.bindingName,
			collectionName: params.collectionName,
			importData: params.importData,
			api: createBeforeApi()
		});
	} catch (cause) {
		// Nothing has been written yet, and that is exactly why this is a *result* rather than a throw:
		// the binding's `input` schema is parsed before the pipeline runs and the pipeline only computes,
		// so a failure here is total. A caller holding the wire can answer the sender "this payload will
		// never be accepted" instead of "retry", which is the difference between one rejection and a
		// provider redelivering a malformed body until it gives up.
		const reason = cause instanceof Error ? cause.message : String(cause);
		if (receiptId) {
			await settleInboundEvent(receiptId, {
				status: 'failed',
				error: reason,
				completed_at: new Date().toISOString()
			});
		}
		return { imported: 0, status: 'refused', reason };
	}

	try {
		const ctx = getWorkspace({ provision: true });
		for (const record of records) {
			await createRecord(ctx, params.collectionName, record, { isElevated: true });
		}
		if (receiptId) {
			await settleInboundEvent(receiptId, {
				status: 'imported',
				imported: records.length,
				completed_at: new Date().toISOString()
			});
		}
		return { imported: records.length, status: 'imported' };
	} catch (cause) {
		// The claim stays, and this one does throw. Rows are written one at a time, so a failure part-way
		// through has already had effects; replaying the same delivery would duplicate whatever landed
		// before it threw. A `failed` row that says why is the honest outcome, and it is visible.
		if (receiptId) {
			await settleInboundEvent(receiptId, {
				status: 'failed',
				error: cause instanceof Error ? cause.message : String(cause),
				completed_at: new Date().toISOString()
			});
		}
		throw cause;
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
				importData: { event_id: params.eventId, event: params.event, payload: params.payload }
			})
		)
	);
	return {
		handled: matching.length,
		imported: results.reduce((total, result) => total + result.imported, 0)
	};
}
