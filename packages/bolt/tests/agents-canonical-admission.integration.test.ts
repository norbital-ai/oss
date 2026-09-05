import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	MessageId,
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

describe('canonical Task admission vertical slice', () => {
	it('retains messages queued while a provider is working and answers them in the same conversation', async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const prompts: unknown[] = [];
		harness = await makeBoltTestRuntime(undefined, {
			ai: successfulAI(async (request, index) => {
				prompts.push(request.messages);
				if (index === 0) {
					started.resolve();
					await release.promise;
				}
				return assistantText(`Reply ${index}`);
			})
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make('00000000-0000-4000-8000-000000000120');
		const submit = (text: string) =>
			harness!.runtime.runPromise(
				agents.submit(harness!.effectId(text), adminSubject, {
					taskId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput(text),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal')
				})
			);
		await submit('Initial instruction');
		const running = harness.runtime.runPromise(
			agents.execute(harness.effectId('first-run'), adminSubject, taskId)
		);
		await started.promise;
		try {
			await submit('Queued during generation');
		} finally {
			release.resolve();
		}
		await running;
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('next-run'), adminSubject, taskId)
		);
		expect(prompts).toHaveLength(2);
		expect(JSON.stringify(prompts[1])).toContain('Queued during generation');
		expect(
			await harness.database.query(
				'select state from agent_inbox where task_id = $1 order by sequence',
				[taskId]
			)
		).toEqual([{ state: 'settled' }, { state: 'settled' }]);
		expect(
			await harness.database.query(
				'select count(*)::int as count from agent_message where task_id = $1',
				[taskId]
			)
		).toEqual([{ count: 4 }]);
	});

	it('separates intentional repeated messages while retaining retry idempotency', async () => {
		harness = await makeBoltTestRuntime(undefined, {
			ai: successfulAI(() => assistantText('Hello back.'))
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make('00000000-0000-4000-8000-000000000110');
		const request = {
			taskId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('hi'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal'),
			submissionId: MessageId.make('00000000-0000-4000-8000-000000000111')
		};
		const first = await harness.runtime.runPromise(
			agents.submit(harness.effectId('send'), adminSubject, request)
		);
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute'), adminSubject, taskId)
		);
		const retry = await harness.runtime.runPromise(
			agents.submit(harness.effectId('retry'), adminSubject, request)
		);
		expect(retry).toEqual(first);
		const next = {
			...request,
			submissionId: MessageId.make('00000000-0000-4000-8000-000000000112')
		};
		const second = await harness.runtime.runPromise(
			agents.submit(harness.effectId('send-again'), adminSubject, next)
		);
		expect(second.directiveId).not.toEqual(first.directiveId);
		await expect(
			harness.runtime.runPromise(
				agents.submit(harness.effectId('changed-retry'), adminSubject, {
					...next,
					message: Agents.userAgentInput('changed')
				})
			)
		).rejects.toThrow(/submission ID/);
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute-again'), adminSubject, taskId)
		);
		expect(
			await harness.database.query(
				'select count(*)::int as count from agent_message where task_id = $1',
				[taskId]
			)
		).toEqual([{ count: 4 }]);
	});

	it('continues a completed conversation with its previous transcript and queues further instructions', async () => {
		const prompts: unknown[] = [];
		harness = await makeBoltTestRuntime(undefined, {
			ai: successfulAI((request) => {
				prompts.push(request.messages);
				return assistantText(`Reply ${prompts.length}`);
			})
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make('00000000-0000-4000-8000-000000000109');
		const submit = (key: string, text: string) =>
			harness!.runtime.runPromise(
				agents.submit(harness!.effectId(key), adminSubject, {
					taskId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput(text),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal')
				})
			);
		await submit('initial', 'Remember reference amber');
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('first'), adminSubject, taskId)
		);
		const original = await harness.database.query(
			'select * from agent_message where task_id = $1 order by sequence',
			[taskId]
		);
		await submit('followup', 'Continue using that reference');
		await submit('queued', 'Also include the next instruction');
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('second'), adminSubject, taskId)
		);
		expect(JSON.stringify(prompts.at(-1))).toContain('Remember reference amber');
		expect(JSON.stringify(prompts.at(-1))).toContain('Reply 1');
		expect(JSON.stringify(prompts.at(-1))).not.toContain('Also include the next instruction');
		await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:queued-follow-up'), adminSubject, taskId)
		);
		expect(JSON.stringify(prompts.at(-1))).toContain('Also include the next instruction');
		expect(
			await harness.database.query(
				'select * from agent_message where task_id = $1 and sequence <= 2 order by sequence',
				[taskId]
			)
		).toEqual(original);
		expect(
			await harness.database.query('select count(*)::int as count from agent_task where id = $1', [
				taskId
			])
		).toEqual([{ count: 1 }]);
		expect(
			await harness.database.query(
				'select status from agent_run where task_id = $1 order by epoch',
				[taskId]
			)
		).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }, { status: 'succeeded' }]);
	});

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
		).toEqual([
			{
				status: 'ready',
				revision: 1,
				plan_status: 'active',
				mode: 'plan',
				phase: 'model',
				run_status: 'succeeded',
				state: 'settled'
			}
		]);
	});
});
