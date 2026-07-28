import type { ProvisionedContext, TenantDbClient } from '$lib/server/bootstrap/workspace_store.js';
import { error } from './http_error.js';
import { AsyncLocalStorage } from 'node:async_hooks';

type DrizzleDb = NonNullable<ProvisionedContext['drizzleDb']>;

const activeCollectionTransaction = new AsyncLocalStorage<TenantDbClient>();

export async function withCollectionTransaction<T>(
	ctx: ProvisionedContext,
	operation: () => Promise<T>
): Promise<T> {
	if (activeCollectionTransaction.getStore() === ctx.tenantDb) return operation();
	if (!ctx.tenantDb.transaction) {
		throw error(500, 'Tenant database does not support atomic collection transactions.');
	}
	return ctx.tenantDb.transaction(async () => {
		// Mark this transaction as the authoritative collection-ops path. The tenant
		// client pins one connection behind the transaction, so this transaction-local
		// GUC is visible to every subsequent write (including drizzle mutations, which
		// route through the same client) and satisfies the _ops_guard trigger. It resets
		// automatically on COMMIT/ROLLBACK.
		await ctx.tenantDb.query(`SELECT set_config('norbital.via_ops', 'on', true)`);
		return activeCollectionTransaction.run(ctx.tenantDb, operation);
	});
}

export async function withMutationDb<T>(
	ctx: ProvisionedContext,
	operation: (db: DrizzleDb) => Promise<T>
): Promise<T> {
	const db = ctx.drizzleDb;
	if (!db) throw error(500, 'Tenant database is not provisioned');
	if (activeCollectionTransaction.getStore() === ctx.tenantDb) return operation(db);
	return db.transaction(
		(tx) => operation(tx as DrizzleDb) // stupidity: boundary-cast — Drizzle transaction exposes the mutation database surface but omits the root database brand.
	);
}
