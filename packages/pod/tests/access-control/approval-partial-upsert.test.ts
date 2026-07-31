import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startPostgres, requireDocker, type PgHarness } from '../support/pg-harness.js';
import { applyPodSchema, seedApprovalRequest } from '../support/pod-schema.js';

/**
 * Why every writer of `approval_request` must carry the identity columns it loaded.
 *
 * The privileged writer (`persistApprovalRequest`) is an `INSERT … ON CONFLICT (norbital_id) DO
 * UPDATE` over only the columns its caller passed. That reads like an UPDATE for an existing row,
 * but Postgres builds and constraint-checks the proposed tuple *before* it looks for the conflict:
 * a caller that passes only the columns it means to change hits a NOT NULL violation on
 * `organization_id` — a column the target row has had all along.
 *
 * This is not a constraint to relax. It is why a caller like `autoResolveApprovalRequest` passes
 * `organization_id`, `label`, `approval_config_id` and `collection_name` straight through from the
 * row it just loaded, the way `withdrawApprovalRequest` and `processAction` do.
 */

requireDocker();
const APPROVAL_A = '11111111-1111-4111-8111-111111111111';

describe('approval_request upsert requires the identity columns', () => {
	let pg: PgHarness;
	let pool: Pool;

	beforeAll(async () => {
		pg = await startPostgres();
		pool = new Pool({ connectionString: pg.connectionString, max: 4 });
		await applyPodSchema(pool);
		await seedApprovalRequest(pool, APPROVAL_A);
	}, 180_000);

	afterAll(async () => {
		await pool?.end().catch(() => undefined);
		pg?.stop();
	});

	function upsert(columns: Record<string, unknown>): Promise<unknown> {
		const names = ['norbital_id', ...Object.keys(columns)];
		const values = [APPROVAL_A, ...Object.values(columns)];
		const placeholders = names.map((_name, index) => `$${index + 1}`);
		const assignments = Object.keys(columns).map((name) => `${name} = EXCLUDED.${name}`);
		return pool.query(
			`INSERT INTO approval_request (${names.join(', ')}) VALUES (${placeholders.join(', ')})
			 ON CONFLICT (norbital_id) DO UPDATE SET ${assignments.join(', ')}`,
			values
		);
	}

	it('rejects a status-only upsert of an existing row', async () => {
		await expect(
			upsert({ status: 'APPROVED', approval_step_nodes: '[]', locked_record_refs: '[]' })
		).rejects.toThrow(/null value in column "organization_id".*not-null constraint/s);
	});

	it('accepts the same upsert once the loaded identity is carried through', async () => {
		const existing = await pool.query<{
			organization_id: string;
			label: string;
			approval_config_id: string;
			collection_name: string;
		}>(
			`SELECT organization_id, label, approval_config_id, collection_name
			   FROM approval_request WHERE norbital_id = $1::uuid`,
			[APPROVAL_A]
		);
		const row = existing.rows[0]!;
		await upsert({
			organization_id: row.organization_id,
			label: row.label,
			approval_config_id: row.approval_config_id,
			collection_name: row.collection_name,
			status: 'APPROVED',
			approval_step_nodes: '[]',
			locked_record_refs: '[]'
		});
		const after = await pool.query<{ status: string }>(
			`SELECT status FROM approval_request WHERE norbital_id = $1::uuid`,
			[APPROVAL_A]
		);
		expect(after.rows[0]?.status).toBe('APPROVED');
	});
});
