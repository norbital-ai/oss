import { eq, getColumns } from 'drizzle-orm';
import { integration_cursor } from '@norbital-ai/platform-utils/system/workspace-schema';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { createRecord } from '$lib/server/collection/collection_ops.server.js';
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
 * Run one inbound binding's import pipeline and write what it produced.
 *
 * The pipeline returning rows is not the same as rows existing — until this ran, every inbound path
 * ended at a value nobody stored, which is why a `receive` binding could be declared, dispatched, and
 * still leave the collection empty. Writes are elevated: the caller is a schedule or a system event,
 * not a person, so there is no requestor whose policy could scope them.
 */
export async function importIntegrationRecords(params: {
	readonly integrationName: string;
	readonly bindingName: string;
	readonly collectionName: string;
	readonly importData: unknown;
}): Promise<{ readonly imported: number }> {
	const records = await runIntegrationReceivePipeline({
		integrationName: params.integrationName,
		bindingName: params.bindingName,
		collectionName: params.collectionName,
		importData: params.importData,
		api: createBeforeApi()
	});
	const ctx = getWorkspace({ provision: true });
	for (const record of records) {
		await createRecord(ctx, params.collectionName, record, { isElevated: true });
	}
	return { imported: records.length };
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
