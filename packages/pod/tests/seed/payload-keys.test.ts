import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from 'pg';
import {
	seedTemplateDataFromPlan,
	type SeedExecutionPlan,
	type SeedSidecarKeys
} from '@norbital-ai/platform-utils/seed/execute';
import { startPostgres, requireDocker, type PgHarness } from '../support/pg-harness.js';
import { applyPodSchema } from '../support/pod-schema.js';

/**
 * The executor's payload key contract, against the real DDL and a real `information_schema`.
 *
 * The behaviour under test used to be the opposite one: a payload key that was not a column was
 * filtered out and inserted nothing, silently. That shipped three defects in a single week — the
 * worst being a seed that wrote `user_name`, so every seeded user landed with a NULL `name` and
 * nobody could sign in to a fresh tenant at all. Nothing failed; the seed reported success.
 *
 * So these tests assert the two halves that make the drift survivable: the seed aborts naming the
 * key (and the column it probably meant), and it aborts having written nothing — including not
 * having run `clearBefore`, which would otherwise trade a silent drift for a wiped tenant.
 */

requireDocker();

const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '11111111-1111-4111-8111-111111111111';

/** A join table shaped the way the relationship pass requires: `<singular>_id` plus one more `_id`. */
const TEAM_MEMBERSHIP_SQL = `
	CREATE TABLE IF NOT EXISTS team_membership (
		user_id UUID NOT NULL,
		team_id UUID NOT NULL
	);
`;

type SeedRun = {
	readonly log: string[];
	readonly run: () => Promise<void>;
};

describe('the seed executor payload key contract (real Postgres)', () => {
	let harness: PgHarness | undefined;
	let client: Client | undefined;

	beforeAll(async () => {
		harness = await startPostgres();
		client = new Client({ connectionString: harness.connectionString });
		await client.connect();
		await applyPodSchema(client);
		await client.query(TEAM_MEMBERSHIP_SQL);
	}, 180_000);

	afterAll(async () => {
		await client?.end();
		harness?.stop();
	});

	beforeEach(async () => {
		if (!client) return;
		await client.query(`SELECT set_config('norbital.via_ops', 'on', false)`);
		await client.query('TRUNCATE team_membership, audit_event, "user" CASCADE');
	});

	function seed(plan: SeedExecutionPlan, sidecarKeys?: SeedSidecarKeys): SeedRun {
		const log: string[] = [];
		return {
			log,
			run: async () => {
				if (!client || !harness) throw new Error('harness not started');
				await seedTemplateDataFromPlan({
					templateKey: 'payload-keys',
					plan,
					orgId: ORG_ID,
					orgName: 'Payload Keys',
					adminId: ADMIN_ID,
					liveUrl: harness.connectionString,
					log: (message) => log.push(message),
					// stupidity: boundary-cast -- seed execution uses only the shared pg query contract.
					client: client as unknown as NonNullable<
						Parameters<typeof seedTemplateDataFromPlan>[0]['client']
					>,
					...(sidecarKeys ? { sidecarKeys } : {})
				});
			}
		};
	}

	function userStep(
		record: Record<string, unknown>,
		stepId = 'seed_users'
	): SeedExecutionPlan['mutations'][number] {
		return {
			step_id: stepId,
			collection_name: 'user',
			payloads: [
				{
					norbital_id: crypto.randomUUID(),
					norbital_created_at: new Date().toISOString(),
					norbital_updated_at: new Date().toISOString(),
					...record
				}
			]
		};
	}

	async function userCount(): Promise<number> {
		const result = await client!.query<{ count: string }>('SELECT count(*) FROM "user"');
		return Number(result.rows[0]?.count ?? '0');
	}

	it('seeds a clean payload, columns and relationships alike', async () => {
		const teamId = crypto.randomUUID();
		const seeding = seed({
			version: 1,
			mutations: [
				userStep({
					email: 'clean@example.com',
					name: 'Ada Lovelace',
					team_membership: [{ record_id: teamId }]
				})
			]
		});
		await seeding.run();

		const rows = await client!.query<{ name: string | null }>(
			`SELECT name FROM "user" WHERE email = 'clean@example.com'`
		);
		expect(rows.rows[0]?.name).toBe('Ada Lovelace');
		const links = await client!.query<{ team_id: string }>('SELECT team_id FROM team_membership');
		expect(links.rows.map((row) => row.team_id)).toEqual([teamId]);
		expect(seeding.log).toContain('Seeded user: 1 rows, 1 links');
	});

	it('aborts on the exact defect that shipped: `user_name` instead of `name`', async () => {
		const seeding = seed({
			version: 1,
			mutations: [userStep({ email: 'drift@example.com', user_name: 'Ada Lovelace' })]
		});

		await expect(seeding.run()).rejects.toThrow(/user_name/);
		await expect(seeding.run()).rejects.toThrow(/closest column: "name"/);
		await expect(seeding.run()).rejects.toThrow(/seed_users/);
		// The row must not exist at all — a partially seeded user is the state that produced the
		// original 401, where the account was present but unusable.
		expect(await userCount()).toBe(0);
	});

	it('names every drifted key in one abort, with its row count', async () => {
		const seeding = seed({
			version: 1,
			mutations: [
				{
					step_id: 'seed_users',
					collection_name: 'user',
					payloads: [
						{ norbital_id: crypto.randomUUID(), email: 'a@example.com', phone: '1', metadata: {} },
						{ norbital_id: crypto.randomUUID(), email: 'b@example.com', phone: '2' }
					]
				}
			]
		});

		const error = await seeding.run().catch((cause: unknown) => cause);
		const message = error instanceof Error ? error.message : String(error);
		expect(message).toMatch(/2 payload key\(s\)/);
		expect(message).toMatch(/"user"\."phone" is not a column, in 2 row\(s\)/);
		expect(message).toMatch(/"user"\."metadata" is not a column, in 1 row\(s\)/);
	});

	it('refuses a step whose table is not in the schema', async () => {
		const seeding = seed({
			version: 1,
			mutations: [
				{
					step_id: 'seed_invoices',
					collection_name: 'invoice',
					payloads: [{ norbital_id: crypto.randomUUID(), total: 10 }]
				}
			]
		});
		await expect(seeding.run()).rejects.toThrow(/no table "invoice" in this schema/);
	});

	it('refuses links no join table can carry back to the collection', async () => {
		const seeding = seed({
			version: 1,
			mutations: [
				userStep({
					email: 'links@example.com',
					favourite_teams: [{ record_id: crypto.randomUUID() }]
				})
			]
		});
		await expect(seeding.run()).rejects.toThrow(/looks like a relationship/);
		expect(await userCount()).toBe(0);
	});

	it('aborts before clearBefore, so a bad plan cannot empty the tenant', async () => {
		await seed({
			version: 1,
			mutations: [userStep({ email: 'survivor@example.com', name: 'Survivor' })]
		}).run();
		expect(await userCount()).toBe(1);

		const drifted = seed({
			version: 1,
			clearBefore: ['user'],
			mutations: [userStep({ email: 'replacement@example.com', user_name: 'Replacement' })]
		});
		await expect(drifted.run()).rejects.toThrow(/user_name/);
		expect(await userCount()).toBe(1);
	});

	it('lets a declared sidecar key through, and logs why', async () => {
		const seeding = seed(
			{
				version: 1,
				mutations: [
					userStep({
						email: 'sidecar@example.com',
						name: 'Grace Hopper',
						avatar_source: { path: 'seed/grace.png' }
					})
				]
			},
			{
				user: {
					avatar_source: 'the caller uploads the bytes and rewrites the row before seeding'
				}
			}
		);
		await seeding.run();

		expect(await userCount()).toBe(1);
		expect(seeding.log.join('\n')).toMatch(
			/Sidecar payload keys honoured .*"user"\."avatar_source" — the caller uploads the bytes/
		);
	});

	it('refuses a sidecar declared for a key that is a column', async () => {
		const seeding = seed(
			{
				version: 1,
				mutations: [userStep({ email: 'liar@example.com', name: 'Real Column' })]
			},
			{ user: { name: 'consumed before execution' } }
		);
		await expect(seeding.run()).rejects.toThrow(/is declared a sidecar but IS a column/);
	});

	it('refuses a sidecar declared without a reason', async () => {
		const seeding = seed(
			{
				version: 1,
				mutations: [userStep({ email: 'silent@example.com', name: 'No Reason', extra: 1 })]
			},
			{ user: { extra: '   ' } }
		);
		await expect(seeding.run()).rejects.toThrow(/declared a sidecar with no reason/);
	});
});
