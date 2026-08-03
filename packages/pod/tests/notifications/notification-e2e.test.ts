import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostMessagingBinding } from '@norbital-ai/platform-utils/runtime/binding';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { workspaceJobs } from '$lib/host/jobs.js';
import { PodSyncClient } from '$lib/ui/sync/pod-sync-client.js';
import type { SyncFetch } from '$lib/ui/sync/types.js';
import { requireDocker } from '../support/pg-harness.js';
import { createClientDb } from '../support/pglite-node.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';

requireDocker();

const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};
/** The addressee. Deliberately not an admin — an admin short-circuits every policy deny. */
const recipient: Identity = {
	userId: '33333333-3333-4333-8333-333333333333',
	userName: 'Site Engineer',
	email: 'engineer@it.local',
	role: 'basic'
};
/** A second plain member, so "not visible to anyone else" is a filter and not a blanket refusal. */
const bystander: Identity = {
	userId: '44444444-4444-4444-8444-444444444444',
	userName: 'Other Member',
	email: 'other@it.local',
	role: 'basic'
};

/**
 * An `after` hook on a real collection, calling the real `api.sendNotification`.
 *
 * Written over a private copy of the template rather than into it: the shared templates are the
 * subject of every other suite, and a hook that fires on every `rfis` create would change theirs.
 */
const RFI_NOTIFY_HOOK = `import type { Hooks } from './$types.js';

export default {
	create: {
		after: async ({ record, api }) => {
			await api.sendNotification({
				recipient_user_id: '${recipient.userId}',
				subject: 'RFI raised: ' + record.title,
				message: 'An RFI is waiting on your answer.',
				channels: ['system', 'email'],
				notification_category: 'rfi',
				cta: { label: 'Open RFI', url: '/app/construction_project_workspace' }
			});
		}
	}
} satisfies Hooks;
`;

type SentNotification = {
	readonly channel: string;
	readonly recipientUserId: string;
	readonly subject: string;
	readonly message: string;
	readonly cta: { readonly label: string; readonly url: string } | null;
};

function syncFetchFor(harness: PodRuntimeHarness, identity: Identity): SyncFetch {
	return (path, init) =>
		harness.request(
			{
				method: init.method,
				path,
				body: init.body,
				signal: init.signal,
				headers: init.accept ? { accept: init.accept, 'content-type': 'application/json' } : {}
			},
			identity
		);
}

async function shapeRows(
	harness: PodRuntimeHarness,
	collection: string,
	identity: Identity
): Promise<Record<string, unknown>[]> {
	const response = await harness.request(
		{
			method: 'POST',
			path: 'sync/shape',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ collection, pageSize: 200 })
		},
		identity
	);
	if (response.status !== 200) return [];
	return ((await response.json()) as { rows: Record<string, unknown>[] }).rows;
}

async function createRfi(harness: PodRuntimeHarness, title: string): Promise<void> {
	const response = await harness.request(
		{
			method: 'POST',
			path: 'collections/create',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ collection: 'rfis', input: { title } })
		},
		admin
	);
	expect(response.status, await response.text()).toBe(200);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	// stupidity:allow A6 -- polling a converging replica is the point of this helper.
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

describe('Pod notifications — delivery and disclosure E2E', () => {
	let harness: PodRuntimeHarness;
	let clientSchemaSql: string;
	const sent: SentNotification[] = [];
	let refuse = false;

	const messaging: HostMessagingBinding = {
		async listChannels() {
			return ['email'];
		},
		async listTransports() {
			return [];
		},
		async sendVia() {
			throw new Error('this host carries no channel transports');
		},
		async send(input) {
			if (refuse) return { sent: false, reason: 'provider is down' };
			sent.push({
				channel: input.channel,
				recipientUserId: input.recipientUserId,
				subject: input.subject,
				message: input.message,
				cta: input.cta ?? null
			});
			return { sent: true };
		}
	};

	/** The drain exactly as a host runs it: `workspaceJobs`, dispatching over the control plane. */
	async function drainNotificationOutbox(manifest: NorbitalManifest): Promise<void> {
		const jobs = workspaceJobs({
			manifest,
			dispatch: (body) => harness.hostCommand(body),
			messaging,
			organizationId: harness.orgId
		});
		const drain = jobs.find((job) => job.name === 'pod:notification-outbox');
		expect(drain, 'workspaceJobs did not register the notification outbox drain').toBeDefined();
		await drain!.run();
	}

	beforeAll(async () => {
		harness = await bootPodRuntime(
			'construction',
			{ messaging },
			{ sources: { 'src/collections/rfis/+hooks.ts': RFI_NOTIFY_HOOK } }
		);
		for (const identity of [recipient, bystander]) {
			await harness.pool.query(
				`INSERT INTO "user" (norbital_id, email, name, role, status)
				 VALUES ($1::uuid, $2, $3, $4, 'active')
				 ON CONFLICT (norbital_id) DO NOTHING`,
				[identity.userId, identity.email, identity.userName, identity.role]
			);
		}
		clientSchemaSql = await harness
			.request({ method: 'GET', path: 'sync/schema' }, admin)
			.then((response) => response.text());
	}, 240_000);

	afterAll(async () => {
		await harness?.stop();
	});

	it('carries a hook notification to the host over messaging and to the recipient in-app', async () => {
		const manifest = (await harness.hostCommand({ kind: 'getManifest' })) as NorbitalManifest;
		await createRfi(harness, 'Slab rebar clash');

		// One `sendNotification` splits by channel: `system` is the in-app row, everything else is a
		// delivery the host owes. Both are written in the caller's transaction, so an RFI that failed
		// to commit could not leave a notification behind.
		const inApp = await harness.pool.query<{
			recipient_user_id: string;
			subject: string;
			channels: string[];
			cta_url: string | null;
			read_at: string | null;
		}>(`SELECT recipient_user_id, subject, channels, cta_url, read_at FROM notification`);
		expect(inApp.rows).toHaveLength(1);
		expect(inApp.rows[0]?.recipient_user_id).toBe(recipient.userId);
		expect(inApp.rows[0]?.subject).toBe('RFI raised: Slab rebar clash');
		expect(inApp.rows[0]?.channels).toEqual(['system']);
		expect(inApp.rows[0]?.cta_url).toBe('/app/construction_project_workspace');
		expect(inApp.rows[0]?.read_at).toBeNull();

		const queued = await harness.pool.query<{ channel: string; status: string }>(
			`SELECT channel, status FROM notification_outbox`
		);
		expect(queued.rows).toEqual([{ channel: 'email', status: 'pending' }]);
		// Nothing has been handed to the host yet — the outbox is the whole point.
		expect(sent).toHaveLength(0);

		await drainNotificationOutbox(manifest);
		expect(sent).toEqual([
			{
				channel: 'email',
				recipientUserId: recipient.userId,
				subject: 'RFI raised: Slab rebar clash',
				message: 'An RFI is waiting on your answer.',
				cta: { label: 'Open RFI', url: '/app/construction_project_workspace' }
			}
		]);
		const settled = await harness.pool.query<{ status: string; delivered_at: string | null }>(
			`SELECT status, delivered_at FROM notification_outbox`
		);
		expect(settled.rows[0]?.status).toBe('delivered');
		expect(settled.rows[0]?.delivered_at).not.toBeNull();

		// A second drain must find nothing: a delivered row is claimed once, or every restart of the
		// job would re-send every notification the workspace has ever raised.
		await drainNotificationOutbox(manifest);
		expect(sent).toHaveLength(1);
	});

	it('retries a refused delivery instead of losing it', async () => {
		const manifest = (await harness.hostCommand({ kind: 'getManifest' })) as NorbitalManifest;
		refuse = true;
		await createRfi(harness, 'Refused delivery');
		await drainNotificationOutbox(manifest);
		const failed = await harness.pool.query<{ status: string; last_error: string | null }>(
			`SELECT status, last_error FROM notification_outbox WHERE subject = 'RFI raised: Refused delivery'`
		);
		expect(failed.rows[0]?.status).toBe('failed');
		expect(failed.rows[0]?.last_error).toContain('provider is down');

		refuse = false;
		// `available_at` carries the backoff; a test must not sit out a real one.
		await harness.pool.query(
			`UPDATE notification_outbox SET available_at = now() WHERE status = 'failed'`
		);
		await drainNotificationOutbox(manifest);
		expect(sent.map((entry) => entry.subject)).toContain('RFI raised: Refused delivery');
		const recovered = await harness.pool.query<{ status: string }>(
			`SELECT status FROM notification_outbox WHERE subject = 'RFI raised: Refused delivery'`
		);
		expect(recovered.rows[0]?.status).toBe('delivered');
	});

	it('replicates a notification to its recipient and to nobody else', async () => {
		// The DDL every authenticated client receives. `notification` is a client collection; the
		// outbox is operational plumbing carrying nothing a browser can act on.
		expect(clientSchemaSql).toContain('CREATE TABLE IF NOT EXISTS "notification" (');
		expect(clientSchemaSql).not.toContain('"notification_outbox"');

		const mine = await shapeRows(harness, 'notification', recipient);
		expect(mine.length).toBeGreaterThan(0);
		expect(mine.every((row) => row.recipient_user_id === recipient.userId)).toBe(true);

		const theirs = await shapeRows(harness, 'notification', bystander);
		expect(theirs).toEqual([]);

		// The outbox is unreachable over sync whatever the caller asks for, at any role.
		const outbox = await harness.request(
			{
				method: 'POST',
				path: 'sync/shape',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection: 'notification_outbox', pageSize: 10 })
			},
			recipient
		);
		expect(outbox.status).not.toBe(200);
	});

	it('reaches an open replica live, without the client asking again', async () => {
		const db = await createClientDb();
		const client = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: clientSchemaSql,
			fetch: syncFetchFor(harness, recipient)
		});
		await client.bootstrap();
		try {
			await client.shapeSubscribe({ collection: 'notification', pageSize: 200 });
			client.setSubscribedCollections(['notification']);
			client.startStream();
			const before = await client.count('notification');

			await createRfi(harness, 'Live arrival');

			// No second `shapeSubscribe`, no poll: the row must arrive on the stream the shell already
			// holds open, which is what makes an unread badge move on its own.
			const arrived = await waitFor(async () => (await client.count('notification')) > before);
			expect(arrived, `lastError=${String(client.lastError)}`).toBe(true);
			const rows = await client.queryLocal<{ subject: string; recipient_user_id: string }>(
				`SELECT subject, recipient_user_id FROM notification`,
				[]
			);
			expect(rows.map((row) => row.subject)).toContain('RFI raised: Live arrival');
			expect(rows.every((row) => row.recipient_user_id === recipient.userId)).toBe(true);
		} finally {
			await client.close();
		}
	});

	it('lets a recipient mark their own notification read, and nobody else theirs', async () => {
		const target = await harness.pool.query<{ norbital_id: string }>(
			`SELECT norbital_id FROM notification ORDER BY norbital_created_at LIMIT 1`
		);
		const notificationId = target.rows[0]!.norbital_id;

		const mine = await harness.request(
			{
				method: 'POST',
				path: 'sync/mutate',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					mutations: [
						{
							clientId: 'mark-read',
							collection: 'notification',
							action: 'update',
							row: { norbital_id: notificationId, read_at: new Date().toISOString() }
						}
					]
				})
			},
			recipient
		);
		expect(mine.status).toBe(200);
		const result = (await mine.json()) as { results: { status: string; reason?: string }[] };
		expect(result.results[0]?.status, result.results[0]?.reason).toBe('confirmed');
		const marked = await harness.pool.query<{ read_at: string | null }>(
			`SELECT read_at FROM notification WHERE norbital_id = $1::uuid`,
			[notificationId]
		);
		expect(marked.rows[0]?.read_at).not.toBeNull();

		// Somebody else's notification is not theirs to touch, even to mark read.
		const theirs = await harness.request(
			{
				method: 'POST',
				path: 'sync/mutate',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					mutations: [
						{
							clientId: 'mark-other-read',
							collection: 'notification',
							action: 'update',
							row: { norbital_id: notificationId, read_at: new Date().toISOString() }
						}
					]
				})
			},
			bystander
		);
		const denied = (await theirs.json()) as { results: { status: string }[] };
		expect(denied.results[0]?.status).toBe('rejected');

		// Nor is the notification's text theirs to rewrite. Only `read_at` is self-service.
		const rewrite = await harness.request(
			{
				method: 'POST',
				path: 'sync/mutate',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					mutations: [
						{
							clientId: 'rewrite',
							collection: 'notification',
							action: 'update',
							row: { norbital_id: notificationId, subject: 'Rewritten' }
						}
					]
				})
			},
			recipient
		);
		const refused = (await rewrite.json()) as { results: { status: string }[] };
		expect(refused.results[0]?.status).toBe('rejected');
	});
});
