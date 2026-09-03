import { afterEach, describe, expect, it } from 'vitest';
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
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('Task admission projection', () => {
	it('commits one Task, message, and directive and deduplicates the same admission', async () => {
		harness = await makeBoltTestRuntime(testWorkspace());
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make('00000000-0000-4000-8000-000000000401');
		const request = {
			taskId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Run payroll'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		};
		const first = await harness.runtime.runPromise(
			agents.submit(harness.effectId('task-admission:first'), adminSubject, request)
		);
		const retry = await harness.runtime.runPromise(
			agents.submit(harness.effectId('task-admission:retry'), adminSubject, request)
		);
		expect(retry.directiveId).toBe(first.directiveId);

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
		const followUp = await harness.runtime.runPromise(
			agents.submit(harness.effectId('task-admission:follow-up'), adminSubject, {
				...request,
				message: Agents.userAgentInput('Include the contractor run.')
			})
		);
		expect(followUp.directiveId).not.toBe(first.directiveId);
		expect(
			await harness.database.query(
				`select
					(select count(*)::int from agent_task where id = $1) as tasks,
					(select count(*)::int from agent_message where task_id = $1) as messages,
					(select count(*)::int from agent_inbox where task_id = $1) as directives`,
				[taskId]
			)
		).toEqual([{ tasks: 1, messages: 2, directives: 2 }]);
	});
});
