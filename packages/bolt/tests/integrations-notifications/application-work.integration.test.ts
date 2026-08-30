import { Effect, Schema } from 'effect';
import { and, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { SYSTEM_MODEL_TABLES } from '../../src/authoring/system-models.js';
import { envoy, integration, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { buildSchemaPlan } from '../../src/compiler/schema-plan.js';
import * as Envoys from '../../src/runtime/envoys/envoys.js';
import * as Database from '../../src/runtime/facilities/database.js';
import {
	Notification,
	Service as NotificationsService
} from '../../src/runtime/notifications/notifications.js';
import { aliased, composer, executeBuilt, jsonTextEquals } from '../../src/runtime/persistence.js';
import { makeBoltTestRuntime } from '../support/bolt-test-layer.js';

const {
	bolt_audit: audit,
	bolt_envoy_registrations: envoyRegistrations,
	bolt_notifications: notifications,
	bolt_sync_outbox: syncOutbox
} = SYSTEM_MODEL_TABLES;

const supportEnvoy = () =>
	envoy({
		name: 'support',
		transport: 'whatsapp',
		audience: 'authenticated',
		policies: ['member'],
		delegation: 'enabled',
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
				policies: [],
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
		expect(ids).toContain('collection:bolt_envoy_registrations');
		expect(ids).toContain('collection:bolt_envoy_receipts');
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
					executeBuilt(
						harness.effectId('count'),
						database,
						composer
							.select({ registrations: aliased(count(), 'registrations') })
							.from(envoyRegistrations)
					)
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

	it('publishes an enqueued notification through the replica outbox', async () => {
		const harness = await makeBoltTestRuntime(envoyedWorkspace());
		try {
			const notification = {
				id: '019f6f10-0006-7000-8000-000000000001',
				recipient: 'user-1',
				payload: { text: 'Payroll approved' },
				read: false
			};
			await harness.runtime.runPromise(
				Effect.flatMap(NotificationsService, (notifications) =>
					notifications.enqueue(harness.effectId('notification:enqueue'), notification)
				)
			);
			// A replay is the same enqueue: neither the notification nor its audit evidence is duplicated.
			await harness.runtime.runPromise(
				Effect.flatMap(NotificationsService, (notifications) =>
					notifications.enqueue(harness.effectId('notification:enqueue:replay'), notification)
				)
			);
			const read = (query: Parameters<typeof executeBuilt>[2]) =>
				harness.runtime.runPromise(
					Effect.flatMap(Database.Service, (database) =>
						executeBuilt(harness.effectId('notification:verify'), database, query)
					)
				);
			expect(
				(
					await read(
						composer
							.select({
								id: notifications.id,
								recipient: notifications.recipient,
								payload: notifications.payload,
								read: notifications.read
							})
							.from(notifications)
							.where(eq(notifications.id, notification.id))
					)
				).rows
			).toEqual([notification]);
			expect(
				(
					await read(
						composer
							.select({ collection_name: syncOutbox.collection_name })
							.from(syncOutbox)
							.where(eq(syncOutbox.collection_name, 'bolt_notifications'))
					)
				).rows
			).toEqual([{ collection_name: 'bolt_notifications' }]);
			expect(
				(
					await read(
						composer
							.select({ kind: audit.kind, subject_id: audit.subject_id })
							.from(audit)
							.where(
								and(
									eq(audit.kind, 'notification_enqueued'),
									jsonTextEquals(audit.payload, 'notificationId', notification.id)
								)
							)
					)
				).rows
			).toEqual([{ kind: 'notification_enqueued', subject_id: notification.recipient }]);
		} finally {
			await harness.dispose();
		}
	});
});
