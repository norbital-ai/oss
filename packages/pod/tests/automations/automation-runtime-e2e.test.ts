import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { requireDocker } from '../support/pg-harness.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';

requireDocker();

const ADMIN: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};

type DeliveredNotification = {
	organizationId: string;
	recipientUserId: string;
	subject: string;
	message: string;
	channels: string[];
};

/**
 * CRM is the template that declares a change-feed automation (`user.created`), which is the only
 * form whose dispatch depends on a host draining the feed. Construction's automations are all cron.
 */
describe('Automations run off the change feed against a compiled runtime', () => {
	let runtime: PodRuntimeHarness;
	const delivered: DeliveredNotification[] = [];

	beforeAll(async () => {
		runtime = await bootPodRuntime('crm', {
			facilities: {
				notifications: {
					send: async (input: DeliveredNotification) => {
						delivered.push(input);
						return Object.fromEntries(input.channels.map((channel) => [channel, { sent: true }]));
					}
				}
			}
		});
	}, 600_000);

	afterAll(async () => {
		await runtime?.stop();
	});

	async function run(body: unknown): Promise<{ status: number; payload: unknown }> {
		const response = await runtime.request(
			{ method: 'POST', path: 'runtime/run', body: JSON.stringify(body) },
			ADMIN
		);
		return { status: response.status, payload: await response.json().catch(() => null) };
	}

	async function pump(): Promise<{ dispatched: number }> {
		const { status, payload } = await run({ kind: 'automation', action: 'pump' });
		expect(status).toBe(200);
		return payload as { dispatched: number };
	}

	it('refuses an automation the workspace does not declare', async () => {
		const { status } = await run({ kind: 'automation', automationName: 'not_a_real_automation' });
		expect(status).toBeGreaterThanOrEqual(400);
	});

	it('dispatches a declared collection-event automation once per committed change', async () => {
		// Start from the current feed head so seed rows written during provisioning are not counted.
		for (let drain = 0; drain < 20 && (await pump()).dispatched >= 0; drain += 1) {
			const { rows } = await runtime.pool.query<{ behind: string }>(
				`SELECT count(*)::text AS behind
				   FROM sync_outbox o, _norbital_automation_cursor c
				  WHERE o.xid < pg_snapshot_xmin(pg_current_snapshot())
				    AND (o.xid > c.xid::xid8 OR (o.xid = c.xid::xid8 AND o.seq > c.seq::bigint))`
			);
			if (Number(rows[0]?.behind ?? 0) === 0) break;
		}

		const userId = '33333333-3333-4333-8333-333333333333';
		await runtime.pool.query(
			`INSERT INTO "user" (norbital_id, name, email, role, status)
			 VALUES ($1, 'Ada Lovelace', 'ada@it.local', 'member', 'active')`,
			[userId]
		);
		// The trigger fires on the committed row via the outbox, not on the INSERT itself.
		await runtime.pool.query(
			`INSERT INTO sync_outbox (collection, record_id, action, row_version)
			 VALUES ('user', $1, 'create', 1)`,
			[userId]
		);

		const first = await pump();
		expect(first.dispatched).toBe(1);

		const activities = await runtime.pool.query<{ subject: string }>(
			`SELECT subject FROM activities WHERE regarding_id = $1`,
			[userId]
		);
		expect(activities.rows.map((row) => row.subject)).toEqual(['User onboarded']);

		// The durable cursor is what makes this exactly-once: a second drain over the same feed
		// position must not re-run the effect.
		expect((await pump()).dispatched).toBe(0);
		const afterSecondPump = await runtime.pool.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM activities WHERE regarding_id = $1`,
			[userId]
		);
		expect(afterSecondPump.rows[0]?.n).toBe('1');
	});

	it('records every dispatched run in automation_run so a failure is visible', async () => {
		const runs = await runtime.pool.query<{ automation_name: string; status: string }>(
			`SELECT automation_name, status FROM automation_run
			  WHERE automation_name = 'user_onboarding' ORDER BY started_at DESC`
		);
		expect(runs.rows).toHaveLength(1);
		expect(runs.rows[0]?.status).toBe('success');
	});
});
