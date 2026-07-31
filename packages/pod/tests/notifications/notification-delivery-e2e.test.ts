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

const ORG_ID = '11111111-1111-4111-8111-111111111111';

type DeliveryInput = {
	organizationId: string;
	recipientUserId: string;
	subject: string;
	message: string;
	channels: string[];
	cta?: unknown;
};

/**
 * What a notification has to prove, and why each part is here.
 *
 * A notification is an effect that leaves the system, so the only failure that matters is a silent
 * one: a message the workspace believes it sent that no host ever received, or one addressed with
 * an organization other than the caller's. Both are invisible to the author — nothing throws, no
 * row is wrong — which is why they are asserted against a real compiled runtime and a real host
 * facility rather than a mocked builtin.
 *
 * CRM's `user_onboarding` automation is the authored caller: it welcomes a new user, so the
 * delivery path is exercised by product behaviour rather than by a fixture written to be tested.
 */
describe('Workspace notifications reach the host facility', () => {
	let runtime: PodRuntimeHarness;
	const delivered: DeliveryInput[] = [];
	let failNextDelivery = false;

	beforeAll(async () => {
		runtime = await bootPodRuntime('crm', {
			facilities: {
				notifications: {
					send: async (input: DeliveryInput) => {
						if (failNextDelivery) throw new Error('provider is unavailable');
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

	/** Commit a user and drain the change feed, which is what runs the onboarding automation. */
	async function onboardUser(userId: string, name: string): Promise<Response> {
		await runtime.pool.query(
			`INSERT INTO "user" (norbital_id, name, email, role, status)
			 VALUES ($1, $2, $3, 'member', 'active')`,
			[userId, name, `${name.toLowerCase().replace(/\W+/g, '.')}@it.local`]
		);
		await runtime.pool.query(
			`INSERT INTO sync_outbox (collection, record_id, action, row_version)
			 VALUES ('user', $1, 'create', 1)`,
			[userId]
		);
		return runtime.request(
			{
				method: 'POST',
				path: 'runtime/run',
				body: JSON.stringify({ kind: 'automation', action: 'pump' })
			},
			ADMIN
		);
	}

	it('delivers with the caller organization, recipient, and the default channel', async () => {
		const userId = '44444444-4444-4444-8444-444444444444';
		const response = await onboardUser(userId, 'Grace Hopper');
		expect(response.status).toBe(200);

		const welcome = delivered.filter((entry) => entry.recipientUserId === userId);
		expect(welcome).toHaveLength(1);
		// The organization is the runtime's own; a workspace cannot widen its reach by naming
		// another one in the payload.
		expect(welcome[0]?.organizationId).toBe(ORG_ID);
		expect(welcome[0]?.subject).toBe('Welcome to the workspace');
		expect(welcome[0]?.message).toContain('Grace Hopper');
		// The author named no channels. A default of "none" would be a message that is composed,
		// reported as sent, and delivered nowhere.
		expect(welcome[0]?.channels).toEqual(['web']);
	});

	it('surfaces a delivery failure as a failed automation run rather than a silent success', async () => {
		failNextDelivery = true;
		const userId = '55555555-5555-4555-8555-555555555555';
		try {
			await onboardUser(userId, 'Alan Turing');
		} finally {
			failNextDelivery = false;
		}

		expect(delivered.some((entry) => entry.recipientUserId === userId)).toBe(false);
		const runs = await runtime.pool.query<{ status: string; error: string | null }>(
			`SELECT status, error FROM automation_run
			  WHERE automation_name = 'user_onboarding' ORDER BY started_at DESC LIMIT 1`
		);
		expect(runs.rows[0]?.status).toBe('failed');
		expect(runs.rows[0]?.error ?? '').toContain('provider is unavailable');
	});
});
