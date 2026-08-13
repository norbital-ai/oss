import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PodSyncClient } from '$lib/ui/sync/pod-sync-client.js';
import type { SyncFetch } from '$lib/ui/sync/types.js';
import { requireDocker } from '../support/pg-harness.js';
import { createClientDb } from '../support/pglite-node.js';
import { testAiBinding } from '../support/ai-binding.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';

requireDocker();

/**
 * Two plain members, and never an admin as the subject.
 *
 * An admin short-circuits every policy deny, so a scoping assertion made through one passes whatever
 * the guard does. Both members hold conversations of their own, so an empty result for the other is
 * a filter doing its job rather than a blanket refusal that would prove nothing.
 */
const ada: Identity = {
	userId: '55555555-5555-4555-8555-555555555555',
	userName: 'Ada',
	email: 'ada@it.local',
	role: 'basic'
};
const grace: Identity = {
	userId: '66666666-6666-4666-8666-666666666666',
	userName: 'Grace',
	email: 'grace@it.local',
	role: 'basic'
};

/** The tenant aggregate plus the run that owns an automation's execution lifecycle. */
const CONVERSATION_COLLECTIONS = ['chat_session', 'automation_run'] as const;

function storedArray(value: unknown): readonly Record<string, unknown>[] {
	if (Array.isArray(value)) return value as readonly Record<string, unknown>[];
	if (typeof value === 'string') return JSON.parse(value) as readonly Record<string, unknown>[];
	return [];
}

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

async function shape(
	harness: PodRuntimeHarness,
	collection: string,
	identity: Identity
): Promise<{ status: number; rows: Record<string, unknown>[] }> {
	const response = await harness.request(
		{
			method: 'POST',
			path: 'sync/shape',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ collection, pageSize: 200 })
		},
		identity
	);
	if (response.status !== 200) return { status: response.status, rows: [] };
	return {
		status: 200,
		rows: ((await response.json()) as { rows: Record<string, unknown>[] }).rows
	};
}

async function chat(
	harness: PodRuntimeHarness,
	identity: Identity,
	message: string,
	runId?: string
) {
	const response = await harness.request(
		{
			method: 'POST',
			path: 'remotes/agentChat',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ message, ...(runId ? { runId } : {}) })
		},
		identity
	);
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()) as { runId: string; chatId: string | null; text: string };
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

describe('Conversations and runs replicate to their owner — leftover in-guest runAgent path', () => {
	let harness: PodRuntimeHarness;
	let clientSchemaSql: string;
	let adaChat: { runId: string; chatId: string | null };
	let graceChat: { runId: string; chatId: string | null };

	const ai = testAiBinding(async () => {
		return { text: 'Noted.', stopReason: 'end', usage: { totalTokens: 3 } };
	});

	beforeAll(async () => {
		harness = await bootPodRuntime('construction', { ai });
		for (const identity of [ada, grace]) {
			await harness.pool.query(
				`INSERT INTO "user" (norbital_id, email, name, role, status)
				 VALUES ($1::uuid, $2, $3, 'basic', 'active')
				 ON CONFLICT (norbital_id) DO NOTHING`,
				[identity.userId, identity.email, identity.userName]
			);
		}
		clientSchemaSql = await harness
			.request({ method: 'GET', path: 'sync/schema' }, ada)
			.then((response) => response.text());
		adaChat = await chat(harness, ada, 'What is on site today?');
		graceChat = await chat(harness, grace, 'And for me?');
	}, 240_000);

	afterAll(async () => {
		await harness?.stop();
	});

	it('puts every conversation collection in the client replica DDL', () => {
		for (const collection of CONVERSATION_COLLECTIONS) {
			expect(clientSchemaSql, collection).toContain(`CREATE TABLE IF NOT EXISTS "${collection}" (`);
		}
		expect(clientSchemaSql).not.toContain('CREATE TABLE IF NOT EXISTS "chat_message"');
		expect(clientSchemaSql).not.toContain('CREATE TABLE IF NOT EXISTS "chat_turn"');
	});

	it('scopes a session and its messages to the member who holds it', async () => {
		expect(adaChat.chatId).toBeTruthy();
		expect(graceChat.chatId).toBeTruthy();
		expect(adaChat.chatId).not.toBe(graceChat.chatId);

		const sessions = await shape(harness, 'chat_session', ada);
		expect(sessions.status).toBe(200);
		expect(sessions.rows.map((row) => row.norbital_id)).toContain(adaChat.chatId);
		expect(sessions.rows.map((row) => row.norbital_id)).not.toContain(graceChat.chatId);
		expect(sessions.rows.every((row) => row.user_id === ada.userId)).toBe(true);

		const adaSession = sessions.rows.find((row) => row.norbital_id === adaChat.chatId);
		expect(storedArray(adaSession?.messages).length).toBeGreaterThanOrEqual(2);
		expect(storedArray(adaSession?.turns).length).toBeGreaterThanOrEqual(1);
	});

	it('scopes a run to whoever requested it', async () => {
		const runs = await shape(harness, 'automation_run', ada);
		expect(runs.status).toBe(200);
		expect(runs.rows.map((row) => row.norbital_id)).toContain(adaChat.runId);
		expect(runs.rows.map((row) => row.norbital_id)).not.toContain(graceChat.runId);
		expect(runs.rows.every((row) => row.requested_by_user_id === ada.userId)).toBe(true);
	});

	it('embeds completed turns only in the conversation owner aggregate', async () => {
		const sessions = await shape(harness, 'chat_session', ada);
		const session = sessions.rows.find((row) => row.norbital_id === adaChat.chatId);
		const turns = storedArray(session?.turns);
		expect(turns.length).toBeGreaterThanOrEqual(1);
		expect(turns.every((turn) => turn.status === 'succeeded')).toBe(true);
		const anyTurn = await harness.pool.query(
			`SELECT coalesce(sum(jsonb_array_length(turns)), 0)::int AS n FROM chat_session`
		);
		expect(anyTurn.rows[0]?.n).toBeGreaterThanOrEqual(2);
	});

	it('delivers a reply to an open replica without the panel asking again', async () => {
		const db = await createClientDb();
		const client = new PodSyncClient({
			replicaEpoch: 'test-epoch',
			db,
			schemaSql: clientSchemaSql,
			fetch: syncFetchFor(harness, ada)
		});
		await client.bootstrap();
		try {
			await client.shapeSubscribe({ collection: 'chat_session', pageSize: 200 });
			client.setSubscribedCollections(['chat_session']);
			client.startStream();
			const beforeRows = await client.queryLocal<{ messages: unknown }>(
				`SELECT messages FROM chat_session WHERE norbital_id = $1`,
				[adaChat.chatId]
			);
			const before = storedArray(beforeRows[0]?.messages).length;

			// A reply arriving from anywhere — another tab, a channel, this run continuing — is a row on
			// the stream. The panel reads the replica, so it needs no notification of its own. Sent
			// against the existing run, which is how the panel continues a conversation.
			await chat(harness, ada, 'Anything else?', adaChat.runId);

			const arrived = await waitFor(async () => {
				const rows = await client.queryLocal<{ messages: unknown }>(
					`SELECT messages FROM chat_session WHERE norbital_id = $1`,
					[adaChat.chatId]
				);
				return storedArray(rows[0]?.messages).length > before;
			});
			expect(arrived, `lastError=${String(client.lastError)}`).toBe(true);
			const rows = await client.queryLocal<{ norbital_id: string }>(
				`SELECT norbital_id FROM chat_session`
			);
			// The continuation landed in the open conversation, and Grace's is still not here.
			expect(rows.some((row) => row.norbital_id === adaChat.chatId)).toBe(true);
			expect(rows.some((row) => row.norbital_id === graceChat.chatId)).toBe(false);
		} finally {
			await client.close();
		}
	});
});
