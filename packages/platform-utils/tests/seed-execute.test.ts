/**
 * The seed executor's second pass, run against two tenants in one process — which is what a full
 * `env:reset` is.
 *
 * A `user` payload's relationship links cannot use the id in the payload, because `insertSeedRows`
 * upserts users on `email` and leaves `norbital_id` alone: the founder is already in the tenant
 * under the id provisioning gave them. So the executor reads the id back by email. The read was
 * memoised in a module-level `Map` keyed on the address alone, and one process seeds every tenant,
 * so the first tenant to write an address decided its id everywhere.
 *
 * `zuyao.liu@norbital.ai` is seeded by the CRM template as `019fc6bb-…` and by the Field Operations template as
 * `09df2f93-…`. Whichever ran second inserted `team_members.user_id` pointing at the other tenant's
 * id, that row does not exist in this tenant's `user` table, and the foreign key ended the reset
 * with exit 1.
 *
 * The fake client below is two separate databases with the one foreign key enforced, so the failure
 * this reproduces is the failure Postgres raised.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Client } from '@neondatabase/serverless';

// `execute.ts` imports its neighbours by their emitted `.js` names, which is right for the build
// and unresolvable for `node --test` running the sources. Point those at the `.ts` beside them.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
			const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
			if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
		}
		return nextResolve(specifier, context);
	}
});

const { seedTemplateDataFromPlan } = await import('../src/seed/execute.ts');

const SHARED_EMAIL = 'zuyao.liu@norbital.ai';
const CRM_ZUYAO = '019fc6bb-7f21-76fd-8597-7de44181da6a';
const FIELD_OPS_ZUYAO = '09df2f93-fbe2-4d90-8a1f-be8729cc1474';
const TEAM = '019f6f10-0002-7000-8000-000000000001';

const COLUMNS: Record<string, readonly string[]> = {
	user: ['norbital_id', 'norbital_created_at', 'norbital_updated_at', 'name', 'email', 'role'],
	team: ['norbital_id', 'name'],
	team_members: ['norbital_id', 'user_id', 'team_id'],
	audit_event: [
		'norbital_id',
		'norbital_created_at',
		'norbital_updated_at',
		'event_type',
		'collection_name',
		'record_id',
		'details',
		'actor_id'
	]
};

/** One tenant database: a `user` table keyed by email, and a `team_members` table with its FK. */
function fakeTenant() {
	const userIdByEmail = new Map<string, string>();
	const memberships: { userId: string; teamId: string }[] = [];

	const client = {
		async query(
			sql: string,
			values: readonly unknown[] = []
		): Promise<{ rows: readonly Record<string, unknown>[] }> {
			if (sql.includes('information_schema.columns')) {
				const table = String(values[0]);
				return {
					rows: (COLUMNS[table] ?? []).map((column) => ({
						table_schema: 'public',
						column_name: column,
						data_type: column === 'details' ? 'jsonb' : 'text'
					}))
				};
			}
			if (sql.includes('set_config')) return { rows: [] };
			if (sql.startsWith('SELECT norbital_id FROM')) {
				const id = userIdByEmail.get(String(values[0]));
				return { rows: id ? [{ norbital_id: id }] : [] };
			}
			if (sql.includes('INSERT INTO') && sql.includes('"user"')) {
				// ON CONFLICT (email): an address already here keeps the id it already had.
				const columns = insertColumns(sql);
				for (const row of chunk(values, columns.length)) {
					const record = Object.fromEntries(columns.map((c, i) => [c, row[i]]));
					const email = String(record.email);
					if (!userIdByEmail.has(email)) userIdByEmail.set(email, String(record.norbital_id));
				}
				return { rows: [] };
			}
			if (sql.includes('INSERT INTO') && sql.includes('"team_members"')) {
				const present = new Set(userIdByEmail.values());
				for (const [userId, teamId] of chunk(values, 2)) {
					if (!present.has(String(userId))) {
						throw new Error(
							'insert or update on table "team_members" violates foreign key constraint ' +
								`"team_members_user_id_user_norbital_id_fkey" (user_id)=(${String(userId)})`
						);
					}
					memberships.push({ userId: String(userId), teamId: String(teamId) });
				}
				return { rows: [] };
			}
			return { rows: [] };
		}
	} as unknown as Client;

	return { client, userIdByEmail, memberships };
}

function insertColumns(sql: string): string[] {
	const match = /\(([^)]*)\)\s*\n?\s*VALUES/i.exec(sql);
	return (match?.[1] ?? '')
		.split(',')
		.map((column) => column.trim().replaceAll('"', ''))
		.filter(Boolean);
}

function chunk(values: readonly unknown[], size: number): unknown[][] {
	const out: unknown[][] = [];
	for (let index = 0; index < values.length; index += size) {
		out.push(values.slice(index, index + size) as unknown[]);
	}
	return out;
}

function planFor(userId: string) {
	return {
		mutations: [
			{
				step_id: 'seed:team',
				collection_name: 'team',
				payloads: [{ norbital_id: TEAM, name: 'Controllers' }]
			},
			{
				step_id: 'seed:user',
				collection_name: 'user',
				payloads: [
					{
						norbital_id: userId,
						name: 'Zu Yao Liu',
						email: SHARED_EMAIL,
						role: 'basic',
						team_members: [{ record_id: TEAM }]
					}
				]
			}
		]
	};
}

async function seedTenant(
	tenant: ReturnType<typeof fakeTenant>,
	templateKey: string,
	userId: string
): Promise<void> {
	await seedTemplateDataFromPlan({
		templateKey,
		plan: planFor(userId),
		orgId: `org-${templateKey}`,
		orgName: templateKey,
		adminId: '00000000-0000-0000-0000-0000000000ad',
		liveUrl: 'postgres://unused',
		log: () => {},
		client: tenant.client
	});
}

describe('seeding two tenants in one process', () => {
	it('links each tenant\'s team_members to that tenant\'s own user row', async () => {
		const crm = fakeTenant();
		const fieldOps = fakeTenant();

		await seedTenant(crm, 'crm', CRM_ZUYAO);
		await seedTenant(fieldOps, 'field-operations', FIELD_OPS_ZUYAO);

		assert.deepEqual(crm.memberships, [{ userId: CRM_ZUYAO, teamId: TEAM }]);
		assert.deepEqual(
			fieldOps.memberships,
			[{ userId: FIELD_OPS_ZUYAO, teamId: TEAM }],
			'the second tenant must not be linked to the first tenant\'s user id'
		);
	});

	it('is order-independent, so the reset does not depend on which template runs first', async () => {
		const fieldOps = fakeTenant();
		const crm = fakeTenant();

		await seedTenant(fieldOps, 'field-operations', FIELD_OPS_ZUYAO);
		await seedTenant(crm, 'crm', CRM_ZUYAO);

		assert.deepEqual(fieldOps.memberships, [{ userId: FIELD_OPS_ZUYAO, teamId: TEAM }]);
		assert.deepEqual(crm.memberships, [{ userId: CRM_ZUYAO, teamId: TEAM }]);
	});

	it('still reuses the id a tenant already has for an address, rather than the payload id', async () => {
		const tenant = fakeTenant();
		// Provisioning writes the founder before any seed runs, under its own id.
		const provisionedId = '2edae3a8-e1fb-4350-85c6-30451ce6495f';
		tenant.userIdByEmail.set(SHARED_EMAIL, provisionedId);

		await seedTenant(tenant, 'field-operations', FIELD_OPS_ZUYAO);

		assert.deepEqual(tenant.memberships, [{ userId: provisionedId, teamId: TEAM }]);
	});
});
