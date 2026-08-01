import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostAiBinding } from '@norbital-ai/platform-utils/runtime/binding';
import { PodSyncClient } from '$lib/client/sync/pod-sync-client.js';
import type { SyncFetch } from '$lib/client/sync/types.js';
import { requireDocker } from '../support/pg-harness.js';
import { createClientDb } from '../support/pglite-node.js';
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

/** Every collection a conversation is made of, plus the run that owns an automation's transcript. */
const CONVERSATION_COLLECTIONS = [
	'chat_session',
	'chat_message',
	'chat_turn',
	'automation_run'
] as const;

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

describe('Conversations and runs replicate to their owner', () => {
	let harness: PodRuntimeHarness;
	let clientSchemaSql: string;
	let adaChat: { runId: string; chatId: string | null };
	let graceChat: { runId: string; chatId: string | null };

	const ai: HostAiBinding = {
		async chat() {
			return { text: 'Noted.', stopReason: 'end', usage: { totalTokens: 3 } };
		}
	};

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

		const messages = await shape(harness, 'chat_message', ada);
		expect(messages.status).toBe(200);
		const chatIds = new Set(messages.rows.map((row) => row.chat_id));
		expect(chatIds.has(adaChat.chatId)).toBe(true);
		expect(chatIds.has(graceChat.chatId)).toBe(false);
		// Not merely non-empty: the transcript has to actually be there, or "scoped" is vacuous.
		expect(messages.rows.length).toBeGreaterThanOrEqual(2);
	});

	it('scopes a run to whoever requested it', async () => {
		const runs = await shape(harness, 'automation_run', ada);
		expect(runs.status).toBe(200);
		expect(runs.rows.map((row) => row.norbital_id)).toContain(adaChat.runId);
		expect(runs.rows.map((row) => row.norbital_id)).not.toContain(graceChat.runId);
		expect(runs.rows.every((row) => row.requested_by_user_id === ada.userId)).toBe(true);
	});

	/**
	 * `chat_turn` replicates, and is empty — Pod's loop does not write one.
	 *
	 * It is a Core-era table: the loop stores each `AiMessage` in `chat_message` verbatim, so replay
	 * is a read and there is nothing left for a turn row to hold. Asserted rather than left implicit,
	 * so a future port that starts writing turns finds a test that says what changed.
	 */
	it('replicates chat_turn, which nothing in Pod writes', async () => {
		const turns = await shape(harness, 'chat_turn', ada);
		expect(turns.status).toBe(200);
		expect(turns.rows).toEqual([]);
		const anyTurn = await harness.pool.query(`SELECT count(*)::int AS n FROM chat_turn`);
		expect(anyTurn.rows[0]).toEqual({ n: 0 });
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
			await client.shapeSubscribe({ collection: 'chat_message', pageSize: 200 });
			client.setSubscribedCollections(['chat_message']);
			client.startStream();
			const before = await client.count('chat_message');

			// A reply arriving from anywhere — another tab, a channel, this run continuing — is a row on
			// the stream. The panel reads the replica, so it needs no notification of its own. Sent
			// against the existing run, which is how the panel continues a conversation.
			await chat(harness, ada, 'Anything else?', adaChat.runId);

			const arrived = await waitFor(async () => (await client.count('chat_message')) > before);
			expect(arrived, `lastError=${String(client.lastError)}`).toBe(true);
			const rows = await client.queryLocal<{ chat_id: string }>(
				`SELECT chat_id FROM chat_message`,
				[]
			);
			// The continuation landed in the open conversation, and Grace's is still not here.
			expect(rows.some((row) => row.chat_id === adaChat.chatId)).toBe(true);
			expect(rows.some((row) => row.chat_id === graceChat.chatId)).toBe(false);
		} finally {
			await client.close();
		}
	});
});
