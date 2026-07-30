import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Client } from '@neondatabase/serverless';
import { applyPendingMigrations } from '../src/tenant_workspace/migrations/migrations.ts';

type QueryResult = { rows: readonly Record<string, unknown>[] };

function clientWithActiveApprovals(): { client: Client; statements: string[] } {
	const statements: string[] = [];
	const client = {
		async query(input: string): Promise<QueryResult> {
			const sql = String(input);
			statements.push(sql);
			if (sql.includes('SELECT tag, sql_hash')) return { rows: [] };
			if (sql.includes("to_regclass('public.approval_request')")) {
				return { rows: [{ exists: true }] };
			}
			if (sql.includes('count(*)::text')) return { rows: [{ count: '2' }] };
			return { rows: [] };
		}
	} as unknown as Client;
	return { client, statements };
}

describe('tenant migration approval guard', () => {
	it('refuses executable schema migrations while approvals are active', async () => {
		const { client, statements } = clientWithActiveApprovals();
		await assert.rejects(
			applyPendingMigrations(client, [
				{ tag: '0002_add_reference', sql: 'ALTER TABLE orders ADD COLUMN reference text;' }
			]),
			/Cannot migrate tenant schema while 2 approval requests are active/
		);
		assert.ok(statements.some((sql) => sql.includes('LOCK TABLE approval_request')));
		assert.ok(!statements.some((sql) => sql.includes('ALTER TABLE orders ADD COLUMN')));
	});

	it('does not inspect approvals when every migration is already applied', async () => {
		const statements: string[] = [];
		const client = {
			async query(input: string): Promise<QueryResult> {
				const sql = String(input);
				statements.push(sql);
				if (sql.includes('SELECT tag, sql_hash')) {
					return { rows: [{ tag: '0001_initial', sql_hash: null }] };
				}
				return { rows: [] };
			}
		} as unknown as Client;

		await applyPendingMigrations(client, [
			{ tag: '0001_initial', sql: 'CREATE TABLE orders (id uuid);' }
		]);
		assert.ok(!statements.some((sql) => sql.includes('approval_request')));
	});
});
