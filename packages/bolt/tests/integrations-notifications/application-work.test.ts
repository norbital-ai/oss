import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { envoy, integration, policy, workspace } from '../../src/authoring/index.js';
import { buildSchemaPlan } from '../../src/compiler/schema-plan.js';
import { Envoys } from '../../src/runtime/envoys/envoys.js';
import { Database } from '../../src/runtime/facilities/database.js';
import { Notification } from '../../src/runtime/notifications/notifications.js';
import { makeBoltTestRuntime } from '../support/bolt-test-layer.js';

const supportEnvoy = () =>
	envoy({
		name: 'support',
		transport: 'whatsapp',
		audience: 'authenticated',
		policies: ['member'],
		task: 'Answer support questions for this member.'
	});

/** A workspace whose only distinguishing feature is that it declares an envoy at all. */
const envoyedWorkspace = () =>
	workspace({
		name: 'envoyed',
		version: '1',
		collections: [],
		apps: [],
		policies: [policy({ name: 'member', effect: 'allow', actions: ['read'] })],
		automations: [],
		envoys: [supportEnvoy()],
		integrations: [],
		prompt: 'You are the test workspace agent.',
		tools: [],
		skills: [],
		requiredFacilities: []
	});

describe('Envoys, Integrations, and Notifications owners', () => {
	it('preserves transport-neutral envoy routing declarations', () =>
		expect(supportEnvoy()).toMatchObject({
			transport: 'whatsapp',
			audience: 'authenticated',
			policies: ['member']
		}));
	/**
	 * The declaration used to carry `connector` and `conflict` — a host-side registry key no host had
	 * an entry in, and a three-valued merge policy nothing read. What it carries now is what a pull
	 * actually needs, and the one field it refuses to be without is the identity column: without it
	 * a second run cannot recognise the rows the first run wrote, which is the whole difference
	 * between a mirror and a duplicate machine.
	 */
	it('refuses an inbound binding with no external identity to key on', () =>
		expect(() =>
			integration({
				name: 'accounts.erp',
				collection: 'accounts',
				connection: { baseUrl: 'https://erp.example/api' },
				webhooks: [],
				send: [],
				receive: [
					{
						name: 'customers',
						schedule: '0 * * * *',
						method: 'GET',
						path: '/customers',
						identityColumn: '  '
					}
				]
			})
		).toThrow(/identity column/));
	/**
	 * The plan is the only thing that creates these two tables — no migration lineage and no
	 * hand-written DDL anywhere else provisions them. Asserting the step ids is what makes a
	 * regression visible as "the plan stopped planning it" rather than as a missing-relation error
	 * from whichever query happened to run first.
	 */
	it('plans the envoy tables the envoy runtime reads and writes', () => {
		const ids = buildSchemaPlan(envoyedWorkspace()).steps.map(({ id }) => id);
		expect(ids).toContain('bolt:envoy-registrations');
		expect(ids).toContain('bolt:envoy-receipts');
	});

	/**
	 * Provisions a database from that plan and asks `status` the question it exists to answer.
	 *
	 * This runs against a real database rather than a stub because the defect was never in the
	 * TypeScript: `status` typechecked perfectly and failed on `relation "bolt_channel_receipts" does
	 * not exist`. Only executing the statement can tell the two apart — which is also why this is the
	 * test that proves the table rename actually reached a provisioned database.
	 */
	it('answers envoy status against a freshly provisioned database', async () => {
		const harness = await makeBoltTestRuntime(envoyedWorkspace());
		try {
			const status = (effectId: string) =>
				harness.runtime.runPromise(
					Effect.flatMap(Envoys.Service, (envoys) =>
						envoys.status(harness.effectId(effectId), 'support')
					)
				);
			expect(await status('status:before')).toEqual({
				envoy: 'support',
				registered: false,
				received: 0,
				replied: 0
			});
			// Twice, because `register` leans on `on conflict do nothing` for idempotency and that clause
			// is a no-op unless `envoy_name` actually carries a unique constraint. A second row would
			// not change `exists(...)`, so only counting rows can catch a registrations table planned
			// without its primary key.
			for (const attempt of ['register:first', 'register:second']) {
				await harness.runtime.runPromise(
					Effect.flatMap(Envoys.Service, (envoys) =>
						envoys.register(harness.effectId(attempt), 'support')
					)
				);
			}
			expect(await status('status:after')).toEqual({
				envoy: 'support',
				registered: true,
				received: 0,
				replied: 0
			});
			const registrations = await harness.runtime.runPromise(
				Effect.flatMap(Database.Service, (database) =>
					database.execute(harness.effectId('count'), {
						_tag: 'Query',
						sql: 'select count(*)::int as registrations from bolt_envoy_registrations',
						parameters: []
					})
				)
			);
			expect(registrations.rows[0]).toMatchObject({ registrations: 1 });
		} finally {
			await harness.dispose();
		}
	});

	it('rejects malformed notification envelopes', () =>
		expect(() =>
			Schema.decodeUnknownSync(Notification)({ id: '', recipient: '', payload: {}, read: false })
		).toThrow());
});
