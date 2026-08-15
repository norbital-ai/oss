import {
	type ProvisionedContext,
	type TenantDbClient,
	withTenantSqlTransaction
} from '$lib/server/bootstrap/workspace_store.js';
import { error } from '$lib/server/http.js';
import { createAsyncStore } from '$lib/server/async-store.js';

/** Keep headroom below PostgreSQL's 65,535 bind-parameter ceiling. */
export const MUTATION_PARAMETER_BUDGET = 60_000;

export function rowsPerMutationStatement(columnsPerRow: number, rowCap = Infinity): number {
	if (!Number.isInteger(columnsPerRow) || columnsPerRow < 1) {
		throw new Error('Mutation statement column count must be a positive integer.');
	}
	return Math.max(1, Math.min(rowCap, Math.floor(MUTATION_PARAMETER_BUDGET / columnsPerRow)));
}

type DrizzleDb = NonNullable<ProvisionedContext['drizzleDb']>;

const activeCollectionTransaction = createAsyncStore<TenantDbClient>();

export async function withCollectionTransaction<T>(
	ctx: ProvisionedContext,
	operation: () => Promise<T>
): Promise<T> {
	if (activeCollectionTransaction.getStore() === ctx.tenantDb) return operation();
	if (!ctx.tenantDb.transaction) {
		throw error(500, 'Tenant database does not support atomic collection transactions.');
	}
	return ctx.tenantDb.transaction(async () => {
		// `begin` already sets `norbital.via_ops` on the pinned connection. Do not
		// spend another isolate→host RPC on the same GUC.
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
	return withTenantSqlTransaction(ctx, operation);
}
