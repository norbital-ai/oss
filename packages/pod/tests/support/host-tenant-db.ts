import type { HostDbBinding } from '@norbital-ai/platform-utils/runtime/binding';
import type { Pool } from 'pg';
import { PostgresHostDbBinding } from '../../src/host/db.js';
import { createTenantDbFromBinding } from '../../src/server/bootstrap/tenant_db_binding.js';
import type { TenantDbClient } from '../../src/server/bootstrap/workspace_store.js';

/** SQL text a recorder or assertion can read from a string or a query config. */
export function statementText(input: unknown): string {
	if (typeof input === 'string') return input;
	const text = (input as { text?: string }).text;
	return typeof text === 'string' ? text : '';
}

function recordBinding(inner: HostDbBinding, statements: string[]): HostDbBinding {
	return {
		query(sql, params) {
			statements.push(statementText(sql));
			return inner.query(sql, params);
		},
		begin() {
			statements.push('BEGIN');
			return inner.begin();
		},
		txQuery(transactionId, sql, params) {
			statements.push(statementText(sql));
			return inner.txQuery(transactionId, sql, params);
		},
		commit(transactionId) {
			statements.push('COMMIT');
			return inner.commit(transactionId);
		},
		rollback(transactionId) {
			statements.push('ROLLBACK');
			return inner.rollback(transactionId);
		},
		batch(batchStatements) {
			for (const statement of batchStatements) statements.push(statementText(statement));
			return inner.batch(batchStatements);
		},
		txBatch(transactionId, batchStatements) {
			for (const statement of batchStatements) statements.push(statementText(statement));
			return inner.txBatch(transactionId, batchStatements);
		}
	};
}

/**
 * The same tenant DB path `pod start` uses: `PostgresHostDbBinding` plus `createTenantDbFromBinding`.
 * Pass the suite's pool so fixture SQL and guest queries share one server without a second pool.
 */
export function createHostTenantDb(
	connectionString: string,
	options: { readonly pool?: Pool; readonly statements?: string[] } = {}
): { readonly tenantDb: TenantDbClient; close(): Promise<void> } {
	const inner = new PostgresHostDbBinding(connectionString, {
		...(options.pool ? { pool: options.pool } : {})
	});
	const binding = options.statements ? recordBinding(inner, options.statements) : inner;
	return {
		tenantDb: createTenantDbFromBinding(binding),
		close: () => inner.close()
	};
}
