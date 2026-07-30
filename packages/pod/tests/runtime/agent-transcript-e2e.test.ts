import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HostAiBinding } from '@norbital-ai/platform-utils/runtime/binding';
import { dockerAvailable } from '../support/pg-harness.js';
import {
	bootPodRuntime,
	type Identity,
	type PodRuntimeHarness
} from '../support/pod-runtime-harness.js';

const hasDocker = dockerAvailable();
const admin: Identity = {
	userId: '22222222-2222-4222-8222-222222222222',
	userName: 'IT Admin',
	email: 'admin@it.local',
	role: 'admin'
};

describe.skipIf(!hasDocker)('Pod AI and automation transcript — runtime E2E', () => {
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

		const shape = await harness.request(
			{
				method: 'POST',
				path: 'sync/shape',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection: 'agent_run_step', pageSize: 100 })
			},
			admin
		);
		expect(shape.status).toBe(200);
		const transcript = (await shape.json()) as {
			rows: Array<{
				automation_run_id: string;
				sequence: number;
				kind: string;
				role?: string | null;
				content?: string | null;
				tool_name?: string | null;
			}>;
		};
		const steps = transcript.rows
			.filter((step) => step.automation_run_id === result.runId)
			.sort((left, right) => left.sequence - right.sequence);
		expect(steps.map((step) => step.kind)).toEqual([
			'message',
			'tool_call',
			'tool_result',
			'message'
		]);
		expect(steps.map((step) => step.role)).toEqual(['user', null, null, 'assistant']);
		expect(steps[1]).toMatchObject({ tool_name: 'describe_workspace' });
		expect(steps[3]).toMatchObject({ content: 'The workspace is ready.' });

		const run = await harness.pool.query<{ status: string }>(
			`SELECT status FROM automation_run WHERE norbital_id = $1::uuid`,
			[result.runId]
		);
		expect(run.rows[0]?.status).toBe('success');
	});
});
