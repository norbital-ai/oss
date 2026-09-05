import { afterEach, describe, expect, it } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, TaskId } from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { assistantText, scriptedTranscript } from './agents-canonical-ai-fixture.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('steering admitted during an active run', () => {
	it('claims a mid-run steer ahead of an older queued normal directive and keeps the queue order', async () => {
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
				return assistantText('First answer, ignorant of the steering.');
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
		// The active run never saw the steer: it was outside its input boundary.
		expect(requests[0] && JSON.stringify(requests[0])).not.toContain('steered thing');

		await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:steer'), adminSubject, taskId)
		);
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:follow-up'), adminSubject, taskId)
		);
		const steerTranscript = JSON.stringify(requests[1]);
		expect(steerTranscript).toContain('Do the steered thing first.');
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
		const claimOrder = await harness.database.query(
			`select run.directive_id, inbox.sequence, inbox.priority
			 from agent_run run join agent_inbox inbox on inbox.id = run.directive_id
			 where run.task_id = $1 order by run.epoch`,
			[taskId]
		);
		expect(claimOrder.map((row) => row['sequence'])).toEqual([1, 3, 2]);
		expect(claimOrder.map((row) => row['priority'])).toEqual(['normal', 'steer', 'normal']);
	});
});
