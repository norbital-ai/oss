import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest } from '@norbital-ai/bolt-protocol';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	TaskId
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { assistantText, successfulAI } from './agents-canonical-ai-fixture.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const taskRequest = (taskId: TaskId, text: string, priority: 'normal' | 'steer' = 'normal') => ({
	taskId,
	agentId: AgentId.make('web'),
	message: Agents.userAgentInput(text),
	mode: DirectiveMode.make('agent'),
	priority: DirectivePriority.make(priority)
});

describe('Task directive queue', () => {
	it('durably queues a follow-up outside the active run input boundary', async () => {
		let releaseGeneration!: () => void;
		const generationHeld = new Promise<void>((resolve) => {
			releaseGeneration = resolve;
		});
		let announceGeneration!: () => void;
		const generationStarted = new Promise<void>((resolve) => {
			announceGeneration = resolve;
		});
		const generated: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		const ai = successfulAI(async (request) => {
			generated.push(request);
			announceGeneration();
			await generationHeld;
			return assistantText('First Task answer.');
		});
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make('00000000-0000-4000-8000-000000000501');
		await harness.runtime.runPromise(
			agents.submit(
				harness.effectId('queue:first-submit'),
				adminSubject,
				taskRequest(taskId, 'Start the work.')
			)
		);
		const execution = harness.runtime.runPromise(
			agents.execute(harness.effectId('queue:first-execute'), adminSubject, taskId)
		);
		await generationStarted;
		const followUp = await harness.runtime.runPromise(
			agents.submit(
				harness.effectId('queue:follow-up-submit'),
				adminSubject,
				taskRequest(taskId, 'Include the newly queued detail.')
			)
		);
		expect(followUp.directiveId).toEqual(expect.any(String));
		releaseGeneration();
		expect((await execution).status).toBe('done');

		expect(generated).toHaveLength(1);
		expect(JSON.stringify(generated[0]?.messages)).not.toContain('newly queued detail');
		expect(
			await harness.database.query(
				`select sequence, state, priority, claimed_run_id is not null as claimed
				 from agent_inbox where task_id = $1 order by sequence`,
				[taskId]
			)
		).toEqual([
			{ sequence: 1, state: 'settled', priority: 'normal', claimed: true },
			{ sequence: 2, state: 'queued', priority: 'normal', claimed: false }
		]);
		expect(
			await harness.database.query(
				`select input_through_sequence, status from agent_run where task_id = $1`,
				[taskId]
			)
		).toEqual([{ input_through_sequence: 1, status: 'succeeded' }]);
	});

	it('claims a steering directive ahead of an older normal directive', async () => {
		const generated: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		harness = await makeBoltTestRuntime(undefined, {
			ai: successfulAI((request) => {
				generated.push(request);
				return assistantText('Steering applied.');
			})
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make('00000000-0000-4000-8000-000000000502');
		await harness.runtime.runPromise(
			agents.submit(
				harness.effectId('priority:normal'),
				adminSubject,
				taskRequest(taskId, 'Normal work.')
			)
		);
		const steering = await harness.runtime.runPromise(
			agents.submit(
				harness.effectId('priority:steer'),
				adminSubject,
				taskRequest(taskId, 'Do this first.', 'steer')
			)
		);
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('priority:execute'), adminSubject, taskId)
		);

		expect(generated).toHaveLength(1);
		expect(JSON.stringify(generated[0]?.messages)).toContain('Do this first.');
		expect(
			await harness.database.query(
				`select id, sequence, priority, state
				 from agent_inbox where task_id = $1 order by sequence`,
				[taskId]
			)
		).toEqual([
			expect.objectContaining({ sequence: 1, priority: 'normal', state: 'queued' }),
			{ id: steering.directiveId, sequence: 2, priority: 'steer', state: 'settled' }
		]);
	});
});
