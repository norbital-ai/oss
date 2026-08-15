import type { DbQueryConfig, HostDbBinding } from '@norbital-ai/platform-utils/runtime/binding';
import type {
	TenantDbClient,
	TenantDbQueryFn,
	TenantDbQueryInput,
	TenantDbQueryResult
} from './workspace_store.js';
import { AsyncLocalStorage } from 'node:async_hooks';
export type { HostDbBinding } from '@norbital-ai/platform-utils/runtime/binding';

export type CompilableSql = {
	readonly toSQL: () => { readonly sql: string; readonly params: unknown[] };
};

export function compileDrizzleStatement(query: CompilableSql): TenantDbQueryInput {
	const compiled = query.toSQL();
	return { text: compiled.sql, values: [...compiled.params] };
}

export async function executeTenantBatch(
	client: TenantDbClient,
	statements: readonly CompilableSql[]
): Promise<readonly TenantDbQueryResult[]> {
	if (!client.batch) {
		throw new Error('Tenant database does not support batched statements');
	}
	return client.batch(statements.map(compileDrizzleStatement));
}

type DrizzleLikeQuery = {
	readonly text?: string;
	readonly rowMode?: 'array';
	readonly values?: readonly unknown[];
	readonly params?: readonly unknown[];
};

function normalizeBindingQuery(sql: string | DrizzleLikeQuery, params?: unknown[]): DbQueryConfig {
	if (typeof sql === 'string') {
		return { text: sql, values: params ?? [] };
	}
	return {
		text: sql.text ?? '',
		...(sql.rowMode ? { rowMode: sql.rowMode } : {}),
		values: sql.values ?? sql.params ?? params ?? []
	};
}

function mapTenantDbQueryResult<T>(result: {
	readonly rows: readonly unknown[];
	readonly rowCount?: number;
}): TenantDbQueryResult<T> {
	// Boundary: host isolate returns row objects; callers supply the expected row
	// type parameter. Single assertion at the runtime boundary (rows widen to T).
	return result as TenantDbQueryResult<T>;
}

/**
 * Wraps the host db binding as {@link TenantDbClient}. During `transaction()` the host pins one
 * connection behind a `txId`; all `query()` calls route through `txQuery(txId, …)` so GUCs and
 * mutations share that connection. Outside a transaction, queries use the pooled `query`.
 */
export function createTenantDbFromBinding(binding: HostDbBinding): TenantDbClient {
	const transactionStorage = new AsyncLocalStorage<string>();

	const routedQuery: TenantDbQueryFn = async <T = Record<string, unknown>>(
		sql: TenantDbQueryInput,
		params?: unknown[]
	) => {
		const query = normalizeBindingQuery(sql, params);
		const txId = transactionStorage.getStore();
		const result = txId ? await binding.txQuery(txId, query) : await binding.query(query);
		return mapTenantDbQueryResult<T>(result);
	};

	return {
		query: routedQuery,
		async batch(statements) {
			const configs = statements.map((statement) => normalizeBindingQuery(statement));
			const txId = transactionStorage.getStore();
			const results = txId
				? await binding.txBatch(txId, configs)
				: await binding.batch(configs);
			return results.map((result) => mapTenantDbQueryResult(result));
		},
		async transaction<T>(fn: (tx: { query: TenantDbQueryFn }) => Promise<T>): Promise<T> {
			const txId = await binding.begin();
			try {
				const result = await transactionStorage.run(txId, () => fn({ query: routedQuery }));
				await binding.commit(txId);
				return result;
			} catch (error) {
				await binding.rollback(txId);
				throw error;
			}
		}
	};
}
