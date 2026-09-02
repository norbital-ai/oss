import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	TaskId
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { assistantText, successfulAI } from './canonical-ai-fixture.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('canonical Task admission vertical slice', () => {
	it('atomically admits a Task message and directive before executing the Task', async () => {
		harness = await makeBoltTestRuntime(undefined, {
			ai: successfulAI(() => assistantText('Hello back.'))
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make('00000000-0000-4000-8000-000000000101');
		const request = {
			taskId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Hello'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		};

		const admitted = await harness.runtime.runPromise(
			agents.submit(harness.effectId('task-submit'), adminSubject, request)
		);
		expect(admitted.directiveId).toEqual(expect.any(String));
		expect(
			await harness.database.query(
				`select
					(select count(*)::int from agent_task where id = $1) as tasks,
					(select count(*)::int from agent_message where task_id = $1) as messages,
					(select count(*)::int from agent_inbox where task_id = $1) as directives,
					(select count(*)::int from agent_run where task_id = $1) as runs`,
				[taskId]
			)
		).toEqual([{ tasks: 1, messages: 1, directives: 1, runs: 0 }]);
		expect(
			await harness.database.query(
				`select command, status, input->>'taskId' as task_id
				 from bolt_task
				 where effect_id = $1`,
				[`tasks.execute:${taskId}:${admitted.directiveId}`]
			)
		).toEqual([{ command: 'tasks.execute', status: 'pending', task_id: taskId }]);
		expect(
			await harness.database.query(
				`select task.status, message.message->>'role' as role,
					inbox.state, inbox.claimed_run_id
				 from agent_task task
				 join agent_message message on message.task_id = task.id
				 join agent_inbox inbox on inbox.task_id = task.id
				 where task.id = $1`,
				[taskId]
			)
		).toEqual([{ status: 'ready', role: 'user', state: 'queued', claimed_run_id: null }]);

		const executed = await harness.runtime.runPromise(
			agents.execute(harness.effectId('task-execute'), adminSubject, taskId)
		);
		expect(executed).toMatchObject({ taskId, status: 'done' });
		expect(JSON.stringify(executed.output)).toContain('Hello back.');
		expect(
			await harness.database.query(
				`select task.status, inbox.state, run.status as run_status,
					count(message.id)::int as messages
				 from agent_task task
				 join agent_inbox inbox on inbox.task_id = task.id
				 join agent_run run on run.task_id = task.id
				 join agent_message message on message.task_id = task.id
				 where task.id = $1
				 group by task.status, inbox.state, run.status`,
				[taskId]
			)
		).toEqual([{ status: 'done', state: 'settled', run_status: 'succeeded', messages: 2 }]);
	});

	it('persists Plan mode as an active Plan revision and leaves the Task ready', async () => {
		harness = await makeBoltTestRuntime(undefined, {
			ai: successfulAI(() =>
				assistantText('Objective: finish the migration. Verify: all canonical gates pass.')
			)
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make('00000000-0000-4000-8000-000000000102');
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('plan-submit'), adminSubject, {
				taskId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Plan the clean migration.'),
				mode: DirectiveMode.make('plan'),
				priority: DirectivePriority.make('normal')
			})
		);
		const result = await harness.runtime.runPromise(
			agents.execute(harness.effectId('plan-execute'), adminSubject, taskId)
		);
		expect(result.status).toBe('idle');
		expect(
			await harness.database.query(
				`select task.status, plan.revision, plan.status as plan_status,
					run.mode, run.phase, run.status as run_status, inbox.state
				 from agent_task task
				 join agent_plan plan on plan.id = task.active_plan_id
				 join agent_run run on run.task_id = task.id
				 join agent_inbox inbox on inbox.task_id = task.id
				 where task.id = $1`,
				[taskId]
			)
		).toEqual([{
			status: 'ready',
			revision: 1,
			plan_status: 'active',
			mode: 'plan',
			phase: 'model',
			run_status: 'succeeded',
			state: 'settled'
		}]);
	});
});
