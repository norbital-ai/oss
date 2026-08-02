import { describe, expect, it } from 'vitest';
import { reconcileDeclaredPolicies } from '../../src/lib/server/bootstrap/policy_reconcile.server.js';

/**
 * A policy condition is stored as jsonb. A callback does not survive that, and the grant then lands
 * with `conditions: {}` — which the permission guard reads as unconditional access to the whole
 * collection. A narrowing that inverts into a widening is the worst failure a permission rule has.
 *
 * There are two gates. The type is the first: `PolicyWhere` removes `RAW`, so a policy written as
 * `satisfies Policy` will not compile with one. This covers the second — reconciliation, which is the
 * last moment before storage and the only gate a manifest from elsewhere passes through.
 *
 * An earlier guard lived inside `definePolicy` and was useless, because every policy file is written
 * as `export default {...} satisfies Policy` and never calls it. Its tests passed while the hole
 * stayed open, which is why this one drives the real entry point.
 */
const client = { query: async () => ({ rows: [{ inserted: true }] }) };

function manifestWith(where: unknown) {
	return {
		policies: {
			field_agent: {
				key: 'field_agent',
				name: 'Field agent',
				grants: [{ collection: 'quotes', action: 'read', where }]
			}
		}
	} as never;
}

describe('policy conditions must survive storage', () => {
	it('refuses a callback, naming the path it found', async () => {
		await expect(reconcileDeclaredPolicies(client, manifestWith({ RAW: () => 1 }))).rejects.toThrow(
			/function at where\.RAW/
		);
	});

	it('finds one nested inside AND, not just at the top level', async () => {
		await expect(
			reconcileDeclaredPolicies(client, manifestWith({ AND: [{ RAW: () => 1 }] }))
		).rejects.toThrow(/where\.AND\[0\]\.RAW/);
	});

	it('stores $sql, which is a string and survives', async () => {
		await expect(
			reconcileDeclaredPolicies(
				client,
				manifestWith({ $sql: '"owner_id" = ${requestor.norbital_id}' })
			)
		).resolves.toMatchObject({ created: 1, updated: 0 });
	});

	it('stores an ordinary field condition carrying a scope placeholder', async () => {
		await expect(
			reconcileDeclaredPolicies(
				client,
				manifestWith({ owner_id: { eq: '${requestor.norbital_id}' } })
			)
		).resolves.toMatchObject({ created: 1, updated: 0 });
	});
});
