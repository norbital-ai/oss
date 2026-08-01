import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostAiBinding } from '@norbital-ai/platform-utils/runtime/binding';
import { requireDocker } from '../support/pg-harness.js';
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

/** A second, non-admin member — the transcript guard must not hand them someone else's session. */
const member: Identity = {
	userId: '33333333-3333-4333-8333-333333333333',
	userName: 'Field Member',
	email: 'member@it.local',
	role: 'basic'
};

describe('Pod AI and automation transcript — runtime E2E', () => {
	let harness: PodRuntimeHarness;
	let calls = 0;
	const ai: HostAiBinding = {
		async chat(input) {
			calls += 1;
			if (calls === 1) {
				expect(input.tools?.map((tool) => tool.name)).toEqual([
					'describe_workspace',
					'read_collection'
				]);
				return {
					text: '',
					toolCalls: [{ id: 'tool-1', name: 'describe_workspace', input: {} }],
					stopReason: 'tool_use',
					usage: { totalTokens: 10 }
				};
			}
			expect(input.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'tool-1' });
			return {
				text: 'The workspace is ready.',
				stopReason: 'end',
				usage: { totalTokens: 7 }
			};
		}
	};

	beforeAll(async () => {
		harness = await bootPodRuntime('construction', { ai });
	}, 180_000);

	afterAll(async () => {
		await harness?.stop();
	});

	it('runs the Pod-owned loop and exposes completed turns through ordinary synced rows', async () => {
		const response = await harness.request(
			{
				method: 'POST',
				path: 'agent/start',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'Describe this workspace.' })
			},
			admin
		);
		expect(response.status).toBe(200);
		const result = (await response.json()) as { runId: string; text: string };
		expect(result.text).toBe('The workspace is ready.');
		expect(calls).toBe(2);

		// The transcript is a sequence of AiMessages, one per row, replayable without reconstruction.
		const session = await harness.pool.query<{ norbital_id: string }>(
			`SELECT norbital_id FROM chat_session WHERE automation_run_id = $1::uuid`,
			[result.runId]
		);
		expect(session.rows).toHaveLength(1);

		const shape = await harness.request(
			{
				method: 'POST',
				path: 'sync/shape',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection: 'chat_message', pageSize: 100 })
			},
			admin
		);
		expect(shape.status).toBe(200);
		const transcript = (await shape.json()) as {
			rows: Array<{
				chat_id: string;
				seq: number;
				role: string;
				parts: Array<{
					role: string;
					content: string;
					toolCallId?: string;
					toolCalls?: Array<{ name: string }>;
				}> | null;
			}>;
		};
		const steps = transcript.rows
			.filter((row) => row.chat_id === session.rows[0]?.norbital_id)
			.sort((left, right) => left.seq - right.seq);

		// user prompt, the assistant turn carrying its tool call, the tool result, the final answer.
		expect(steps.map((step) => step.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
		expect(steps[1]?.parts?.[0]?.toolCalls?.[0]?.name).toBe('describe_workspace');
		expect(steps[2]?.parts?.[0]?.toolCallId).toBeTruthy();
		expect(steps[3]?.parts?.[0]?.content).toBe('The workspace is ready.');

		// A transcript belongs to its session's owner. An admin short-circuits every policy deny, so the
		// isolation has to be proved with a plain member — and the member needs a session of their own,
		// or the assertion passes for the wrong reason (no sessions means denied outright, so an empty
		// result would prove nothing about filtering).
		await harness.pool.query(
			`INSERT INTO "user" (norbital_id, email, name, role, status)
			 VALUES ($1::uuid, 'member@it.local', 'Field Member', 'basic', 'active')
			 ON CONFLICT (norbital_id) DO NOTHING`,
			[member.userId]
		);
		const ownSession = await harness.pool.query<{ norbital_id: string }>(
			`INSERT INTO chat_session (user_id, title, visibility)
			 VALUES ($1::uuid, 'Member session', 'personal') RETURNING norbital_id`,
			[member.userId]
		);
		await harness.pool.query(
			`INSERT INTO chat_message (chat_id, role, seq, parts)
			 VALUES ($1::uuid, 'user', 1, '[{"role":"user","content":"mine"}]'::jsonb)`,
			[ownSession.rows[0]!.norbital_id]
		);

		const otherShape = await harness.request(
			{
				method: 'POST',
				path: 'sync/shape',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection: 'chat_message', pageSize: 100 })
			},
			member
		);
		const otherRows =
			otherShape.status === 200
				? ((await otherShape.json()) as { rows: Array<{ chat_id: string }> }).rows
				: [];
		// Their own message is visible — so the guard is filtering, not just refusing.
		expect(otherShape.status).toBe(200);
		expect(otherRows.filter((row) => row.chat_id === ownSession.rows[0]?.norbital_id)).toHaveLength(
			1
		);
		// The automation's session belongs to the admin, and must not appear.
		expect(otherRows.filter((row) => row.chat_id === session.rows[0]?.norbital_id)).toHaveLength(0);

		const run = await harness.pool.query<{ status: string }>(
			`SELECT status FROM automation_run WHERE norbital_id = $1::uuid`,
			[result.runId]
		);
		expect(run.rows[0]?.status).toBe('success');
	});
});
