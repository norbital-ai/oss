import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
	AiChatInput,
	AiChatStreamBatch,
	HostAiBinding
} from '@norbital-ai/platform-utils/runtime/binding';
import { PodSyncClient } from '$lib/ui/sync/pod-sync-client.js';
import type { SyncFetch } from '$lib/ui/sync/types.js';
import type { ChatSessionMessage, ChatSessionTurn } from '$lib/shared/agent/chat-session.js';
import { requireDocker } from '../support/pg-harness.js';
import { createClientDb } from '../support/pglite-node.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';

requireDocker();

const member: Identity = {
	userId: '77777777-7777-4777-8777-777777777777',
	userName: 'Streaming Member',
	email: 'streaming@it.local',
	role: 'basic'
};

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== null) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error('Timed out waiting for agent state');
}

type FakeStream = {
	readonly input: AiChatInput;
	read: number;
};

type LocalSession = {
	title: string;
	messages: string | readonly ChatSessionMessage[];
	turns: string | readonly ChatSessionTurn[];
};

function storedArray<T>(value: string | readonly T[]): readonly T[] {
	return typeof value === 'string' ? (JSON.parse(value) as readonly T[]) : value;
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

describe('Pod live agent capabilities — runtime E2E', () => {
	let harness: PodRuntimeHarness;
	const releaseProvider = deferred();
	const releaseChild = deferred();
	const streams = new Map<string, FakeStream>();
	let nextStream = 0;

	const ai: HostAiBinding = {
		async chat(input) {
			expect(input.outputSchema).toBeTruthy();
			return {
				text: JSON.stringify({ title: 'Delegate sentinel check' }),
				stopReason: 'end'
			};
		},
		async startStream(input) {
			await releaseProvider.promise;
			const id = `live-${(nextStream += 1)}`;
			streams.set(id, { input, read: 0 });
			return id;
		},
		async readStream(streamId): Promise<AiChatStreamBatch> {
			const stream = streams.get(streamId);
			if (!stream) throw new Error('Unknown fake stream');
			stream.read += 1;
			const lastUser = [...stream.input.messages]
				.reverse()
				.find((message) => message.role === 'user')?.content;
			const hasToolResult = stream.input.messages.some((message) => message.role === 'tool');
			if (lastUser === 'Delegate the sentinel check.' && !hasToolResult) {
				streams.delete(streamId);
				return {
					events: [
						{
							type: 'tool_call',
							call: {
								id: 'spawn-1',
								name: 'spawn_subagent',
								input: { task: 'Return the exact child sentinel.' }
							}
						},
						{ type: 'finish', stopReason: 'tool_use' }
					],
					done: true
				};
			}
			if (lastUser === 'Return the exact child sentinel.') {
				if (stream.read === 1) {
					return {
						events: [{ type: 'text_delta', delta: 'child-' }],
						done: false
					};
				}
				await releaseChild.promise;
				streams.delete(streamId);
				return {
					events: [
						{ type: 'text_delta', delta: 'streamed' },
						{ type: 'finish', stopReason: 'end', usage: { totalTokens: 4 } }
					],
					done: true
				};
			}
			if (hasToolResult) {
				streams.delete(streamId);
				return {
					events: [
						{ type: 'text_delta', delta: 'parent-complete' },
						{ type: 'finish', stopReason: 'end', usage: { totalTokens: 5 } }
					],
					done: true
				};
			}
			throw new Error(`Unexpected fake provider transcript: ${lastUser ?? '<none>'}`);
		},
		async cancelStream(streamId) {
			streams.delete(streamId);
		}
	};

	beforeAll(async () => {
		harness = await bootPodRuntime('construction', { ai });
		await harness.pool.query(
			`INSERT INTO "user" (norbital_id, email, name, role, status)
			 VALUES ($1::uuid, $2, $3, 'basic', 'active')
			 ON CONFLICT (norbital_id) DO NOTHING`,
			[member.userId, member.email, member.userName]
		);
	}, 180_000);

	afterAll(async () => {
		await harness?.stop();
	});

	it('streams every committed text, tool, title, and terminal part into an already-open replica', async () => {
		const schemaSql = await harness
			.request({ method: 'GET', path: 'sync/schema' }, member)
			.then((response) => response.text());
		const client = new PodSyncClient({
			replicaEpoch: 'agent-live-parts',
			db: await createClientDb(),
			schemaSql,
			fetch: syncFetchFor(harness, member)
		});
		await client.bootstrap();
		await client.shapeSubscribe({ collection: 'chat_session', pageSize: 200 });
		client.setSubscribedCollections(['chat_session']);
		client.startStream();

		try {
			const response = await harness.request(
				{
					method: 'POST',
					path: 'remotes/agentChatStart',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ message: 'Delegate the sentinel check.' })
				},
				member
			);
			expect(response.status, await response.clone().text()).toBe(200);
			const accepted = (await response.json()) as {
				runId: string;
				chatId: string;
				accepted: true;
			};
			expect(accepted.accepted).toBe(true);

			const sessionArrived = await waitFor(async () => {
				const rows = await client.queryLocal<LocalSession>(
					`SELECT title, messages, turns FROM chat_session WHERE norbital_id = $1`,
					[accepted.chatId]
				);
				return rows[0] && storedArray(rows[0].messages).length === 1 ? rows[0] : null;
			});
			expect(storedArray(sessionArrived.messages)).toHaveLength(1);

			const generatedTitle = await waitFor(async () => {
				const rows = await client.queryLocal<LocalSession>(
					`SELECT title, messages, turns FROM chat_session WHERE norbital_id = $1`,
					[accepted.chatId]
				);
				return rows[0]?.title === 'Delegate sentinel check' ? rows[0] : null;
			});
			expect(generatedTitle.title).toBe('Delegate sentinel check');

			// One aggregate subscription was already tailing before the session existed. Every subsequent
			// title, message-part, and turn mutation must arrive without adding a shape or restarting it.
			releaseProvider.resolve();

			const liveChild = await waitFor(async () => {
				const rows = await client.queryLocal<LocalSession>(
					`SELECT title, messages, turns FROM chat_session WHERE norbital_id = $1`,
					[accepted.chatId]
				);
				const session = rows[0];
				if (!session) return null;
				const turns = storedArray(session.turns);
				const childTurn = turns.find((turn) => turn.subagent_id === 'subagent:spawn-1');
				const childMessage = storedArray(session.messages).find(
					(message) =>
						message.turn_id === childTurn?.norbital_id &&
						message.role === 'assistant' &&
						message.status === 'streaming'
				);
				return childTurn && childMessage ? { childTurn, childMessage } : null;
			});
			expect(liveChild.childMessage.parts[0]?.content).toBe('child-');
			expect(liveChild.childTurn.parent_turn_id).toBeTruthy();
			expect(liveChild.childTurn.subagent_id).toBe('subagent:spawn-1');

			const parentCallArrived = await waitFor(async () => {
				const rows = await client.queryLocal<LocalSession>(
					`SELECT title, messages, turns FROM chat_session WHERE norbital_id = $1`,
					[accepted.chatId]
				);
				const session = rows[0];
				return session && JSON.stringify(storedArray(session.messages)).includes('spawn_subagent')
					? session
					: null;
			});
			expect(JSON.stringify(parentCallArrived.messages)).toContain('spawn_subagent');

			releaseChild.resolve();

			const completed = await waitFor(async () => {
				const rows = await client.queryLocal<LocalSession>(
					`SELECT title, messages, turns FROM chat_session WHERE norbital_id = $1`,
					[accepted.chatId]
				);
				const messages = storedArray(rows[0]?.messages ?? []);
				return messages.some(
					(message) =>
						message.parts[0]?.content === 'parent-complete' && message.status === 'complete'
				)
					? messages
					: null;
			});
			expect(completed).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						status: 'complete',
						parts: [expect.objectContaining({ content: 'child-streamed' })]
					}),
					expect.objectContaining({
						status: 'complete',
						parts: [expect.objectContaining({ content: 'parent-complete' })]
					})
				])
			);

			const toolResultArrived = await waitFor(async () => {
				const rows = await client.queryLocal<LocalSession>(
					`SELECT title, messages, turns FROM chat_session WHERE norbital_id = $1`,
					[accepted.chatId]
				);
				const message = storedArray(rows[0]?.messages ?? []).find(
					(candidate) =>
						candidate.role === 'tool' && JSON.stringify(candidate.parts).includes('child-streamed')
				);
				return message ?? null;
			});
			expect(JSON.stringify(toolResultArrived.parts)).toContain('child-streamed');

			const turns = await waitFor(async () => {
				const rows = await client.queryLocal<LocalSession>(
					`SELECT title, messages, turns FROM chat_session WHERE norbital_id = $1`,
					[accepted.chatId]
				);
				const turns = storedArray(rows[0]?.turns ?? []);
				return turns.length === 2 && turns.every((turn) => turn.status === 'succeeded')
					? turns
					: null;
			});
			expect(turns).toHaveLength(2);
			expect(turns[0]).toMatchObject({
				status: 'succeeded',
				parent_turn_id: null,
				subagent_id: null
			});
			expect(turns[1]).toMatchObject({
				status: 'succeeded',
				parent_turn_id: expect.any(String),
				subagent_id: 'subagent:spawn-1'
			});
		} finally {
			await client.close();
		}
	});
});
