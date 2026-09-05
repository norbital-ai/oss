import { afterEach, describe, expect, it } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, TaskId } from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCall,
	scriptedTranscript
} from './agents-canonical-ai-fixture.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('steering admitted during an active run', () => {
	it('delivers steering at the next model step in the same run without consuming a normal queued message', async () => {
		let releaseGeneration!: () => void;
		const generationHeld = new Promise<void>((resolve) => {
			releaseGeneration = resolve;
		});
		let announceGeneration!: () => void;
		const generationStarted = new Promise<void>((resolve) => {
			announceGeneration = resolve;
		});
		const { ai, requests } = scriptedTranscript([
			async () => {
				announceGeneration();
				await generationHeld;
				return assistantToolCall('describe_workspace', {}, 'inspect-workspace');
			},
			assistantText('Steered answer.'),
			assistantText('Follow-up answer.')
		]);
		harness = await makeBoltTestRuntime(testWorkspace(), { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make('00000000-0000-4000-8000-000000000c01');
		const submit = (name: string, text: string, priority: 'normal' | 'steer' = 'normal') =>
			harness!.runtime.runPromise(
				agents.submit(harness!.effectId(`submit:${name}`), adminSubject, {
					taskId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput(text),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make(priority)
				})
			);
		await submit('first', 'Start the work.');
		const execution = harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:first'), adminSubject, taskId)
		);
		await generationStarted;
		try {
			await submit('follow-up', 'Include the newly queued detail.');
			await submit('steer', 'Do the steered thing first.', 'steer');
		} finally {
			releaseGeneration();
		}
		expect((await execution).status).toBe('idle');
		expect(
			await harness.database.query('select status from agent_task where id = $1', [taskId])
		).toEqual([{ status: 'ready' }]);
		expect(
			await harness.database.query(
				"select id from bolt_task where effect_id like $1 and status = 'pending'",
				[`tasks.execute:${taskId}:settled:%`]
			)
		).toHaveLength(1);
		// The first generation was already running; the next model step receives only the steer.
		expect(requests[0] && JSON.stringify(requests[0])).not.toContain('steered thing');

		expect(requests).toHaveLength(2);
		const steerTranscript = JSON.stringify(requests[1]);
		expect(steerTranscript).toContain('Do the steered thing first.');
		expect(steerTranscript).not.toContain('Include the newly queued detail.');
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:follow-up'), adminSubject, taskId)
		);
		const followUpTranscript = JSON.stringify(requests[2]);
		expect(followUpTranscript).toContain('Include the newly queued detail.');
		expect(followUpTranscript).toContain('Do the steered thing first.');

		expect(
			await harness.database.query(
				`select sequence, priority, state from agent_inbox where task_id = $1 order by sequence`,
				[taskId]
			)
		).toEqual([
			{ sequence: 1, priority: 'normal', state: 'settled' },
			{ sequence: 2, priority: 'normal', state: 'settled' },
			{ sequence: 3, priority: 'steer', state: 'settled' }
		]);
		const claimed = await harness.database.query(
			`select sequence, claimed_run_id from agent_inbox where task_id = $1 order by sequence`,
			[taskId]
		);
		expect(claimed[2]?.['claimed_run_id']).toBe(claimed[0]?.['claimed_run_id']);
		expect(claimed[1]?.['claimed_run_id']).not.toBe(claimed[0]?.['claimed_run_id']);
	});
});
