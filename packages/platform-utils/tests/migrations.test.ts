import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from '@neondatabase/serverless';
import { applyPendingMigrations } from '../src/tenant_workspace/migrations/migrations.ts';

describe('tenant migrations', () => {
	it('applies schema changes without consulting or locking inflight approvals', async () => {
		const statements: string[] = [];
		const client = {
			async query(input: string): Promise<{ rows: readonly Record<string, unknown>[] }> {
				const sql = String(input);
				statements.push(sql);
				if (sql.includes('SELECT tag, sql_hash')) return { rows: [] };
				return { rows: [] };
			}
		} as unknown as Client;

		await applyPendingMigrations(client, [
			{ tag: '0002_add_reference', sql: 'ALTER TABLE orders ADD COLUMN reference text;' }
		]);

		assert.ok(statements.some((sql) => sql.includes('ALTER TABLE orders ADD COLUMN')));
		assert.ok(statements.every((sql) => !sql.includes('approval_request')));
	});
});
