import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiChatInput, HostAiBinding } from '@norbital-ai/platform-utils/runtime/binding';
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
import { INTERACTIVE_AGENT_AUTOMATION_NAME } from '../../src/server/run/automation-dispatch.server.js';

requireDocker();

const member: Identity = {
	userId: '77777777-7777-4777-8777-777777777777',
	userName: 'Streaming Member',
	email: 'streaming@it.local',
	role: 'basic'
};

const TEST_ARTIFACT = {
	artifactId: 'test-artifact',
	checkpointId: 'test-checkpoint',
	treeHash: 'test-tree',
	runtimeVersion: 'test-runtime'
};

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== null) return value;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error('Timed out waiting for agent state');
}

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

function lastUserContent(input: { readonly messages?: readonly { role: string; content?: unknown }[] }): string {
	const lastUser = [...(input.messages ?? [])]
		.reverse()
		.find((message) => message.role === 'user')?.content;
	return typeof lastUser === 'string' ? lastUser : '';
}

function scriptedTurn(input: AiChatInput) {
	const lastUser = lastUserContent(input);
	const hasToolResult = (input.messages ?? []).some((message) => message.role === 'tool');
	if (lastUser === 'Delegate the sentinel check.' && !hasToolResult) {
		return {
			text: '',
			toolCalls: [
				{
					id: 'spawn-1',
					name: 'spawn_subagent',
					input: { task: 'Return the exact child sentinel.' }
				}
			],
			stopReason: 'tool_use' as const
		};
	}
	if (lastUser === 'Return the exact child sentinel.') {
		return {
			text: 'child-streamed',
			reasoning: 'I should return the exact sentinel.',
			stopReason: 'end' as const,
			usage: { totalTokens: 4 }
		};
	}
	if (hasToolResult) {
		return {
			text: 'parent-complete',
			stopReason: 'end' as const,
			usage: { totalTokens: 5 }
		};
	}
	throw new Error(`Unexpected fake provider transcript: ${lastUser || '<none>'}`);
}

describe('Pod live agent capabilities — runtime E2E', () => {
	let harness: PodRuntimeHarness;
	let retainedBackgroundWork = 0;

	const ai: HostAiBinding = {
		async chat(input) {
			if (input.outputSchema) {
				return {
					text: JSON.stringify({ title: 'Delegate sentinel check' }),
					stopReason: 'end'
				};
			}
			return scriptedTurn(input);
		}
	};

	beforeAll(async () => {
		harness = await bootPodRuntime('construction', {
			ai,
			runtimeLifecycle: {
				async retainBackgroundWork() {
					retainedBackgroundWork += 1;
					return `agent-lease-${retainedBackgroundWork}`;
				},
				async releaseBackgroundWork() {}
			}
		});
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

	async function latestInteractiveReceipt(): Promise<string> {
		const result = await harness.pool.query<{ norbital_id: string }>(
			`SELECT norbital_id::text FROM _norbital_automation_job
			  WHERE automation_name = $1 ORDER BY created_at DESC LIMIT 1`,
			[INTERACTIVE_AGENT_AUTOMATION_NAME]
		);
		if (!result.rows[0]) throw new Error('No interactive agent receipt');
		return result.rows[0].norbital_id;
	}

	async function pumpReceipt(receiptId: string): Promise<void> {
		const yielded: string[] = [];
		for (let step = 0; step < 16; step += 1) {
			const outcome = (await harness.hostCommand({
				kind: 'automation-events',
				action: 'run',
				receiptId,
				artifact: TEST_ARTIFACT
			})) as {
				status: 'completed' | 'failed' | 'waiting_effect';
				error?: string;
				effectId?: string;
				request?: {
					kind?: string;
					messages?: AiChatInput['messages'];
					tools?: readonly { name: string }[];
				};
			};
			if (outcome.status === 'completed') return;
			if (outcome.status === 'failed') {
				throw new Error(
					`${outcome.error ?? 'agent receipt failed'} (step ${step}; yielded ${yielded.join(' | ')})`
				);
			}
			if (outcome.status !== 'waiting_effect' || !outcome.effectId || !outcome.request) {
				throw new Error(`Unexpected agent step: ${JSON.stringify(outcome)}`);
			}
			if (outcome.request.kind !== 'ai.turn') {
				throw new Error(`Expected ai.turn, received ${outcome.request.kind}`);
			}
			const lastUser = lastUserContent({ messages: outcome.request.messages });
			yielded.push(
				`${step}:${lastUser}->tools:${(outcome.request.tools ?? []).map((tool) => tool.name).join(',')}`
			);
			const result = scriptedTurn({
				messages: outcome.request.messages ?? [],
				tools: []
			});
			await harness.hostCommand({
				kind: 'automation-events',
				action: 'settle',
				receiptId,
				effectId: outcome.effectId,
				artifact: TEST_ARTIFACT,
				outcome: { status: 'succeeded', result }
			});
		}
		throw new Error(`Agent receipt exceeded 16 durable steps (${yielded.join(' | ')})`);
	}

	it('admits an interactive turn and yields provider work instead of detaching runAgent', async () => {
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
			expect(retainedBackgroundWork).toBe(0);

			const jobs = await harness.pool.query<{
				automation_name: string;
				orchestration_status: string;
				artifact_id: string;
			}>(
				`SELECT automation_name, orchestration_status, artifact_id
				   FROM _norbital_automation_job
				  WHERE automation_name = $1`,
				[INTERACTIVE_AGENT_AUTOMATION_NAME]
			);
			expect(jobs.rows).toEqual([
				{
					automation_name: INTERACTIVE_AGENT_AUTOMATION_NAME,
					orchestration_status: 'admitted',
					artifact_id: 'guest-admit'
				}
			]);

			const sessionArrived = await waitFor(async () => {
				const rows = await client.queryLocal<LocalSession>(
					`SELECT title, messages, turns FROM chat_session WHERE norbital_id = $1`,
					[accepted.chatId]
				);
				return rows[0] && storedArray(rows[0].messages).length === 1 ? rows[0] : null;
			});
			expect(storedArray(sessionArrived.messages)).toHaveLength(1);

			await harness.hostCommand({
				kind: 'agent-conversation-titles',
				limit: 10
			});
			const generatedTitle = await waitFor(async () => {
				const rows = await client.queryLocal<LocalSession>(
					`SELECT title, messages, turns FROM chat_session WHERE norbital_id = $1`,
					[accepted.chatId]
				);
				return rows[0]?.title === 'Delegate sentinel check' ? rows[0] : null;
			});
			expect(generatedTitle.title).toBe('Delegate sentinel check');

			await harness.hostCommand({
				kind: 'automation-events',
				action: 'admit',
				artifact: TEST_ARTIFACT,
				limit: 200
			});
			await pumpReceipt(await latestInteractiveReceipt());

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
						kind: 'reasoning',
						parts: [expect.objectContaining({ content: 'I should return the exact sentinel.' })]
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
