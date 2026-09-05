import { afterEach, describe, expect, it } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, TaskId } from '@norbital-ai/bolt-protocol';
import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import * as Agents from '../src/runtime/agents/agents.js';
import { userMessageWithAttachments } from '../src/runtime/agents/image-descriptors.js';
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

const PLAN_BODY =
	'Objective: ship the export. Approach: read the registry first. Verify: describe_workspace returns the registry.';

const openPlanTask = async (
	ai: ReturnType<typeof scriptedTranscript>['ai'],
	name: string
): Promise<{ agents: Agents.Interface; taskId: TaskId }> => {
	harness = await makeBoltTestRuntime(testWorkspace(), { ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	const taskId = TaskId.make(`00000000-0000-4000-8000-0000000007${name}`);
	await harness.runtime.runPromise(
		agents.submit(harness.effectId(`submit:plan:${name}`), adminSubject, {
			taskId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Plan the export work.'),
			mode: DirectiveMode.make('plan'),
			priority: DirectivePriority.make('normal')
		})
	);
	const planned = await harness.runtime.runPromise(
		agents.execute(harness.effectId(`execute:plan:${name}`), adminSubject, taskId)
	);
	expect(planned.status).toBe('idle');
	return { agents, taskId };
};

const submitAgentTurn = async (
	agents: Agents.Interface,
	name: string,
	taskId: TaskId
): Promise<void> => {
	await harness!.runtime.runPromise(
		agents.submit(harness!.effectId(`submit:${name}`), adminSubject, {
			taskId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Execute the Active Plan.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
};

const executeAgentTurn = (agents: Agents.Interface, name: string, taskId: TaskId) =>
	harness!.runtime.runPromise(agents.execute(harness!.effectId(name), adminSubject, taskId));

const verdictAnnotations = async (taskId: TaskId) =>
	harness!.database.query(
		`select annotation->>'planId' as plan_id, annotation->>'complete' as complete,
			annotation->'gaps' as gaps
		 from agent_message
		 where task_id = $1 and annotation->>'tag' = 'plan-verdict'
		 order by sequence`,
		[taskId]
	);

describe('Plan auto-verifier', () => {
	it('replaces the complete plan and preserves a queued message delivered after its checkpoint', async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const revisedBody =
			'Objective: ship the export. Approach: preserve the registry and add validation. Verify: both checks pass.';
		const { ai, requests } = scriptedTranscript([
			Schema.encodeSync(Prompt.Message)(
				Prompt.assistantMessage({
					content: [
						Prompt.reasoningPart({ text: 'Draft deliberation, excluded from the saved plan.' }),
						Prompt.textPart({ text: PLAN_BODY })
					]
				})
			),
			async () => {
				started.resolve();
				await release.promise;
				return assistantText(revisedBody);
			},
			assistantText('The queued instruction was applied.')
		]);
		const { agents, taskId } = await openPlanTask(ai, '08');
		await harness!.runtime.runPromise(
			agents.submit(harness!.effectId('revise-plan'), adminSubject, {
				taskId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Add validation.'),
				mode: 'plan',
				priority: 'normal'
			})
		);
		const running = executeAgentTurn(agents, 'revision-execute', taskId);
		await started.promise;
		try {
			await harness!.runtime.runPromise(
				agents.submit(harness!.effectId('queued-during-plan'), adminSubject, {
					taskId,
					agentId: AgentId.make('web'),
					message: userMessageWithAttachments('Also keep a copy of the result.', [
						{
							key: Agents.taskAssetStorageKey(taskId, 'requirements', 'requirements.txt'),
							name: 'requirements.txt',
							mimeType: 'text/plain',
							size: 120
						}
					]),
					mode: 'agent',
					priority: 'normal'
				})
			);
		} finally {
			release.resolve();
		}
		await running;
		expect(JSON.stringify(requests[1]?.messages)).toContain(PLAN_BODY);
		expect(JSON.stringify(requests[1]?.messages)).toContain('complete replacement plan');
		await executeAgentTurn(agents, 'queued-after-plan', taskId);
		const nextPrompt = JSON.stringify(requests[2]?.messages);
		expect(nextPrompt).toContain(revisedBody);
		expect(nextPrompt).toContain('Also keep a copy of the result.');
		expect(nextPrompt).not.toContain(PLAN_BODY);
		expect(nextPrompt).not.toContain('Plan the export work.');
		expect(requests[1]?.fileAssets).toBeUndefined();
		expect(requests[2]?.fileAssets).toMatchObject([{ name: 'requirements.txt' }]);
		expect(nextPrompt).not.toContain('norbital-file:');
		expect(
			await harness!.database.query(
				'select revision, body, status from agent_plan where task_id = $1 order by revision',
				[taskId]
			)
		).toEqual([
			{ revision: 1, body: PLAN_BODY, status: 'superseded' },
			{ revision: 2, body: revisedBody, status: 'verified' }
		]);
	});

	it('sends the model back on an incomplete verdict, then settles verified with the verdict annotations', async () => {
		const { ai, feed, verdictRequests } = scriptedTranscript(
			[
				assistantText(PLAN_BODY),
				assistantText('Implementing the export now.'),
				assistantText('Gap closed with new evidence.')
			],
			{
				verdicts: [
					{
						complete: false,
						summary: 'The export step is unevidenced.',
						gaps: ['No durable evidence that the export ran']
					},
					{ complete: true, summary: 'Every criterion is evidenced.', gaps: [] }
				]
			}
		);
		const { agents, taskId } = await openPlanTask(ai, '01');
		await submitAgentTurn(agents, 'agent:01', taskId);

		const first = await executeAgentTurn(agents, 'execute:01:a', taskId);
		expect(first.status).toBe('idle');
		expect(verdictRequests).toHaveLength(1);
		expect(verdictRequests[0]?.maxOutputTokens).toBe(768);
		const firstVerify = JSON.stringify(verdictRequests[0]?.messages);
		expect(firstVerify).toContain('Independently verify the immutable active Plan');
		expect(firstVerify).toContain('Do not trust completion claims.');
		expect(firstVerify).toContain('Active Plan revision 1');
		// The verify prompt carries the immutable Plan, not the pre-plan transcript.
		expect(firstVerify).toContain(PLAN_BODY);
		expect(firstVerify).toContain('Implementing the export now.');

		const second = await executeAgentTurn(agents, 'execute:01:b', taskId);
		expect(second.status).toBe('done');
		// Plan + two implementing turns; verdict Generates are recorded separately.
		expect(feed).toHaveLength(3);
		expect(verdictRequests).toHaveLength(2);

		const verdicts = await verdictAnnotations(taskId);
		expect(verdicts).toHaveLength(2);
		expect(verdicts[0]).toMatchObject({ complete: 'false' });
		expect(verdicts[0]?.gaps).toEqual(['No durable evidence that the export ran']);
		expect(verdicts[1]).toMatchObject({ complete: 'true' });
		expect(verdicts[1]?.plan_id).toEqual(verdicts[0]?.plan_id);

		expect(
			await harness!.database.query(
				`select plan.status, task.status as task_status
				 from agent_task task
				 join agent_plan plan on plan.id = task.active_plan_id
				 where task.id = $1`,
				[taskId]
			)
		).toEqual([{ status: 'verified', task_status: 'done' }]);
		const usage = await harness!.database.query(
			`select count(*)::int as n, count(distinct settlement_id)::int as d
			 from agent_usage usage
			 join agent_run run on run.id = usage.run_id
			 where run.task_id = $1`,
			[taskId]
		);
		expect(usage).toEqual([{ n: 5, d: 5 }]);
	});

	it('stalls the Plan in attention after the third incomplete verdict and queues nothing further', async () => {
		const { ai, verdictRequests } = scriptedTranscript(
			[
				assistantText(PLAN_BODY),
				assistantText('Implementing the export now.'),
				assistantText('Second implementation pass.'),
				assistantText('Third implementation pass.')
			],
			{
				verdicts: [1, 2, 3].map((attempt) => ({
					complete: false,
					summary: `Pass ${attempt} still lacks export evidence.`,
					gaps: [`Gap ${attempt}`]
				}))
			}
		);
		const { agents, taskId } = await openPlanTask(ai, '02');
		await submitAgentTurn(agents, 'agent:02', taskId);

		expect((await executeAgentTurn(agents, 'execute:02:a', taskId)).status).toBe('idle');
		expect((await executeAgentTurn(agents, 'execute:02:b', taskId)).status).toBe('idle');
		const third = await executeAgentTurn(agents, 'execute:02:c', taskId);
		expect(third.status).toBe('attention');
		expect(verdictRequests).toHaveLength(3);

		const finalVerdict = await harness!.database.query(
			`select message
			 from agent_message
			 where task_id = $1 and annotation->>'tag' = 'plan-verdict'
			 order by sequence desc
			 limit 1`,
			[taskId]
		);
		expect(JSON.stringify(finalVerdict[0]?.message)).toContain(
			'Plan verification 3/3: incomplete.'
		);
		expect(JSON.stringify(finalVerdict[0]?.message)).toContain('Gap 3');

		expect(
			await harness!.database.query(
				`select plan.status, task.status as task_status
				 from agent_task task
				 join agent_plan plan on plan.id = task.active_plan_id
				 where task.id = $1`,
				[taskId]
			)
		).toEqual([{ status: 'stalled', task_status: 'attention' }]);
		expect(
			await harness!.database.query(
				`select count(*)::int as n from agent_inbox where task_id = $1 and state = 'queued'`,
				[taskId]
			)
		).toEqual([{ n: 0 }]);
	});
});
