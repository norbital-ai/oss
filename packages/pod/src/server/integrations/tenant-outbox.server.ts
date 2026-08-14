import { and, eq, getColumns, inArray, lte, or, sql } from 'drizzle-orm';
import { integration_outbox } from '@norbital-ai/platform-utils/system/workspace-schema';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import { z } from 'zod';
import { rowsPerMutationStatement } from '$lib/server/collection/collection_transaction.server.js';

type MutationAction = 'create' | 'update' | 'delete';
export const OUTBOX_CLAIM_LEASE_MS = 5 * 60 * 1000;

const outboundBindingsSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

function bindings(value: unknown): readonly [string, Record<string, unknown>][] {
	const parsed = outboundBindingsSchema.safeParse(value);
	return parsed.success ? Object.entries(parsed.data) : [];
}

function activeOutboundBindings(
	ctx: ProvisionedContext,
	collection: string,
	action: MutationAction,
	record: Record<string, unknown>,
	previous?: Record<string, unknown>
) {
	return Object.entries(ctx.manifestCtx.manifest.integrations ?? {}).flatMap(
		([integrationName, integration]) =>
			bindings(integration.definition.outbound)
				.filter(([bindingName, binding]) => {
					if (binding.collection !== collection || binding.trigger !== 'collection-events') {
						return false;
					}
					const runtime =
						getTenantWorkspace().registered.integrationBindings[
							`${integrationName}:${bindingName}`
						];
					if (!runtime || runtime.direction !== 'send') return false;
					if (typeof runtime.on === 'string') return runtime.on === action;
					const predicate = runtime.on[action];
					if (typeof predicate !== 'function') return false;
					const event = action === 'update' ? { previous: previous ?? record, record } : { record };
					return Reflect.apply(predicate, undefined, [event]) === true;
				})
				.map(([bindingName]) => ({ integrationName, bindingName }))
	);
}

export async function emitOutboundRows(
	db: NonNullable<ProvisionedContext['drizzleDb']>,
	ctx: ProvisionedContext,
	collection: string,
	action: MutationAction,
	record: Record<string, unknown>,
	previous?: Record<string, unknown>
): Promise<void> {
	await emitOutboundRowsMany(db, ctx, collection, action, [{ record, previous }]);
}

/** Rows per INSERT — six bind parameters each, far inside Postgres' 65,535 limit. */
const OUTBOUND_CHUNK = rowsPerMutationStatement(6);

/**
 * The same delivery rows for a whole batch, in as few statements as the batch allows.
 *
 * Bulk mutations write their records with one statement; queuing outbound deliveries a row at a
 * time would make the integration feed — not the data — the cost of the write on a remote database.
 * Bindings are still evaluated per record (the `on` predicate sees each record and its previous
 * state), and the rows still co-commit with the mutation in the order given.
 */
export async function emitOutboundRowsMany(
	db: NonNullable<ProvisionedContext['drizzleDb']>,
	ctx: ProvisionedContext,
	collection: string,
	action: MutationAction,
	entries: readonly {
		readonly record: Record<string, unknown>;
		readonly previous?: Record<string, unknown>;
	}[]
): Promise<void> {
	const values = entries.flatMap(({ record, previous }) => {
		const recordId = record.norbital_id;
		if (typeof recordId !== 'string') return [];
		return activeOutboundBindings(ctx, collection, action, record, previous).map(
			({ integrationName, bindingName }) => ({
				integration_name: integrationName,
				binding_name: bindingName,
				collection_name: collection,
				record_id: recordId,
				action,
				payload: record
			})
		);
	});
	for (let from = 0; from < values.length; from += OUTBOUND_CHUNK) {
		await db.insert(integration_outbox).values(values.slice(from, from + OUTBOUND_CHUNK));
	}
}

export type TenantOutboxRequest =
	| { readonly kind: 'outbox'; readonly action: 'claim'; readonly limit?: number }
	| { readonly kind: 'outbox'; readonly action: 'delivered'; readonly ids: readonly string[] }
	| {
			readonly kind: 'outbox';
			readonly action: 'failed';
			readonly ids: readonly string[];
			readonly error: string;
			readonly retryAt: string;
	  };

export async function runTenantOutbox(request: TenantOutboxRequest) {
	const ctx = (await import('$lib/server/bootstrap/workspace_store.js')).getWorkspace({
		provision: true
	});
	const db = ctx.drizzleDb;
	if (!db) throw new Error('Tenant database is not provisioned');
	const columns = getColumns(integration_outbox);
	if (request.action === 'claim') {
		const limit = Math.min(Math.max(request.limit ?? 50, 1), 200);
		return db.transaction(async (tx) => {
			const now = new Date();
			const leaseExpiredAt = new Date(now.getTime() - OUTBOX_CLAIM_LEASE_MS);
			const rows = await tx
				.select()
				.from(integration_outbox)
				.where(
					or(
						and(inArray(columns.status, ['pending', 'failed']), lte(columns.available_at, now)),
						and(eq(columns.status, 'processing'), lte(columns.claimed_at, leaseExpiredAt))
					)
				)
				.orderBy(columns.available_at)
				.limit(limit)
				.for('update', { skipLocked: true });
			if (rows.length === 0) return [];
			const ids = rows.map((row) => row.norbital_id);
			await tx
				.update(integration_outbox)
				.set({
					status: 'processing',
					claimed_at: now,
					attempts: sql`${columns.attempts} + 1`
				})
				.where(inArray(columns.norbital_id, ids));
			return rows;
		});
	}
	if (request.ids.length === 0) return { updated: 0 };
	if (request.action === 'delivered') {
		const rows = await db
			.update(integration_outbox)
			.set({ status: 'delivered', delivered_at: new Date(), last_error: null })
			.where(and(inArray(columns.norbital_id, [...request.ids]), eq(columns.status, 'processing')))
			.returning({ id: columns.norbital_id });
		return { updated: rows.length };
	}
	const rows = await db
		.update(integration_outbox)
		.set({
			status: sql`case when ${columns.attempts} >= 10 then 'dead_letter' else 'failed' end`,
			available_at: new Date(request.retryAt),
			last_error: request.error,
			claimed_at: null
		})
		.where(and(inArray(columns.norbital_id, [...request.ids]), eq(columns.status, 'processing')))
		.returning({ id: columns.norbital_id });
	return { updated: rows.length };
}
