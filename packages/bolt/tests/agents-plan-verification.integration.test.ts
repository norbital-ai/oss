import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	ConversationId,
	PlanId,
	ModelId,
	type AIRequest,
	type AIResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	successfulAI,
	assistantText,
	assistantToolCall,
	scriptedTranscript
} from './agents-canonical-ai-fixture.js';
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
const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000701');
const PLAN = '# Export\nRead the source registry. Verify the export with a durable receipt.';
const createPlan = (id = 'create-plan') =>
	assistantToolCall('update_plan', { operation: 'replace', expectedRevision: 0, body: PLAN }, id);
const open = async (ai: FacilityBinding<AIRequest, AIResponse>) => {
	harness = await makeBoltTestRuntime(testWorkspace(), { ai });
	return harness.runtime.runPromise(Agents.Service);
};
const submit = async (
	agents: Agents.Interface,
	message: string,
	mode: 'plan' | 'agent' = 'plan'
) => {
	const current = (
		await harness!.database.query(
			'select id,status from plan where conversation_id=$1 order by revision desc limit 1',
			[conversationId]
		)
	)[0];
	return harness!.runtime.runPromise(
		agents.submit(harness!.effectId(`submit:${message}`), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput(message),
			mode,
			priority: 'normal',
			...(mode === 'agent' && current?.status === 'draft'
				? { planAction: { action: 'execute' as const, planId: PlanId.make(String(current.id)) } }
				: {})
		})
	);
};
const execute = (agents: Agents.Interface, name: string) =>
	harness!.runtime.runPromise(
		agents.execute(harness!.effectId(name), adminSubject, conversationId)
	);
const plans = () =>
	harness!.database.query(
		'select revision, body, status from plan where conversation_id = $1 order by revision',
		[conversationId]
	);

describe('root Plan lifecycle', () => {
	it('keeps discussion separate from exact draft revisions, then archives it only on execution', async () => {
		const { ai, requests, verdictRequests } = scriptedTranscript([
			assistantText('What should the export contain?'),
			createPlan(),
			assistantText('The draft is ready for review.'),
			assistantToolCall(
				'update_plan',
				{
					operation: 'patch',
					expectedRevision: 1,
					oldText: 'source registry',
					newText: 'source registry and schema'
				},
				'patch-plan'
			),
			assistantText('Added the schema check.'),
			assistantText('Execution evidence.')
		]);
		const agents = await open(ai);
		await submit(agents, 'PLANNING_ONLY_BRIEF');
		expect((await execute(agents, 'discuss')).status).toBe('idle');
		expect(await plans()).toEqual([]);
		await submit(agents, 'Create the export plan.');
		await execute(agents, 'create');
		expect(await plans()).toEqual([{ revision: 1, body: PLAN, status: 'draft' }]);
		await submit(agents, 'Also inspect the schema.');
		await execute(agents, 'patch');
		expect(await plans()).toEqual([
			{ revision: 1, body: PLAN, status: 'superseded' },
			{
				revision: 2,
				body: PLAN.replace('source registry', 'source registry and schema'),
				status: 'draft'
			}
		]);
		expect(JSON.stringify(requests[4]?.messages)).toContain('What should the export contain?');
		expect(verdictRequests).toHaveLength(0);
		await submit(agents, 'Execute this plan.', 'agent');
		expect((await execute(agents, 'implement')).status).toBe('done');
		const input = JSON.stringify(requests[5]?.messages);
		expect(input).toContain('source registry and schema');
		expect(input).toContain('Execute this plan.');
		expect(input).not.toContain('PLANNING_ONLY_BRIEF');
		expect(input).not.toContain('What should the export contain?');
		expect(input).not.toContain('Added the schema check.');
		expect((await plans()).at(-1)?.status).toBe('verified');
		const transcript = await harness!.database.query(
			'select message from conversation_message where conversation_id=$1',
			[conversationId]
		);
		expect(JSON.stringify(transcript)).toContain('PLANNING_ONLY_BRIEF');
		expect(JSON.stringify(transcript)).toContain('Added the schema check.');
	});

	it('resumes a stopped planning turn without entering execution', async () => {
		const { ai, requests, verdictRequests } = scriptedTranscript([
			createPlan(),
			assistantText('Draft ready.'),
			assistantText('Planning resumed.')
		]);
		const agents = await open(ai);
		await submit(agents, 'Create a plan.');
		await execute(agents, 'plan');
		await harness!.runtime.runPromise(
			agents.control(harness!.effectId('stop'), adminSubject, { conversationId, action: 'stop' })
		);
		await harness!.runtime.runPromise(
			agents.control(harness!.effectId('resume'), adminSubject, {
				conversationId,
				action: 'resume'
			})
		);
		await execute(agents, 'resumed-plan');
		expect((await plans()).at(-1)?.status).toBe('draft');
		expect(verdictRequests).toHaveLength(0);
		expect(JSON.stringify(requests.at(-1)?.output)).toContain('update_plan');
		expect(
			await harness!.database.query(
				'select mode from turn where conversation_id=$1 order by created_at desc limit 1',
				[conversationId]
			)
		).toEqual([{ mode: 'plan' }]);
	});

	it('leaves a verified plan complete when the next ordinary request arrives', async () => {
		const { ai, requests, verdictRequests } = scriptedTranscript([
			createPlan(),
			assistantText('Draft ready.'),
			assistantText('Execution evidence.'),
			assistantText('A separate answer.')
		]);
		const agents = await open(ai);
		await submit(agents, 'Create a plan.');
		await execute(agents, 'plan');
		await submit(agents, 'Execute.', 'agent');
		await execute(agents, 'execute');
		expect(verdictRequests).toHaveLength(1);
		await submit(agents, 'Explain one workspace capability.', 'agent');
		await execute(agents, 'new-request');
		expect(verdictRequests).toHaveLength(1);
		expect(JSON.stringify(requests.at(-1)?.messages)).toContain('Verified Plan revision');
		expect((await plans()).at(-1)?.status).toBe('verified');
	});

	it('requires an explicit current-revision execution action and deletes a draft without a model call', async () => {
		const { ai, requests } = scriptedTranscript([
			createPlan(),
			assistantText('Draft ready.'),
			assistantText('Ordinary agent conversation.'),
			createPlan('recreated-plan'),
			assistantText('New draft ready.')
		]);
		const agents = await open(ai);
		await submit(agents, 'Create a plan.');
		await execute(agents, 'plan');
		const id = PlanId.make(
			String(
				(
					await harness!.database.query('select active_plan_id from conversation where id=$1', [
						conversationId
					])
				)[0]?.active_plan_id
			)
		);
		const input = {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Start.'),
			mode: 'agent' as const,
			priority: 'normal' as const
		};
		await expect(
			harness!.runtime.runPromise(agents.submit(harness!.effectId('bypass'), adminSubject, input))
		).rejects.toThrow('Invalid Plan transition');
		await expect(
			harness!.runtime.runPromise(
				agents.submit(harness!.effectId('stale-execute'), adminSubject, {
					...input,
					planAction: {
						action: 'execute',
						planId: PlanId.make('00000000-0000-4000-8000-000000000999')
					}
				})
			)
		).rejects.toThrow('Invalid Plan transition');
		await harness!.runtime.runPromise(
			agents.submit(harness!.effectId('delete-plan'), adminSubject, {
				...input,
				message: Agents.userAgentInput('Delete plan.'),
				modelId: ModelId.make('openrouter/unavailable'),
				planAction: { action: 'delete', planId: id }
			})
		);
		await execute(agents, 'after-delete');
		expect(requests).toHaveLength(2);
		expect(
			await harness!.database.query('select active_plan_id,status from conversation where id=$1', [
				conversationId
			])
		).toEqual([{ active_plan_id: null, status: 'done' }]);
		expect((await plans()).at(-1)?.status).toBe('discarded');
		await submit(agents, 'Continue normally.', 'agent');
		await execute(agents, 'normal');
		expect(JSON.stringify(requests[2]?.messages)).not.toContain('Active Plan revision');
		await submit(agents, 'Create another plan.');
		await execute(agents, 'new-plan');
		expect((await plans()).at(-1)).toMatchObject({ revision: 2, status: 'draft', body: PLAN });
	});

	it('pauses execution before pending tools, revises in isolation, and parks queued execution until the button transition', async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const twin = scriptedTranscript([
			createPlan(),
			assistantText('Draft ready.'),
			assistantToolCall('write_collection', {}, 'must-not-run'),
			assistantText('Which change do you want?'),
			assistantToolCall(
				'update_plan',
				{
					operation: 'patch',
					expectedRevision: 1,
					oldText: 'source registry',
					newText: 'source registry and schema'
				},
				'revise'
			),
			assistantText('Draft revised.'),
			assistantText('New plan executed.'),
			assistantText('Queued follow-up handled.')
		]);
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (metadata, request, signal, onProgress) => {
				if (
					request._tag === 'Generate' &&
					request.output._tag === 'Message' &&
					twin.requests.length === 2
				) {
					started.resolve();
					await release.promise;
				}
				return twin.ai.call(metadata, request, signal, onProgress);
			}
		};
		const agents = await open(ai);
		await submit(agents, 'ARCHIVED_INITIAL_DISCUSSION');
		await execute(agents, 'plan');
		await submit(agents, 'Execute plan.', 'agent');
		const running = execute(agents, 'first-execution');
		await started.promise;
		try {
			await submit(agents, 'LATER_EXECUTION_INPUT', 'agent');
			const id = PlanId.make(
				String(
					(
						await harness!.database.query('select active_plan_id from conversation where id=$1', [
							conversationId
						])
					)[0]?.active_plan_id
				)
			);
			await harness!.runtime.runPromise(
				agents.submit(harness!.effectId('revise-action'), adminSubject, {
					conversationId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput('Pause for revision.'),
					mode: 'plan',
					priority: 'steer',
					planAction: { action: 'revise', planId: id }
				})
			);
		} finally {
			release.resolve();
		}
		expect((await running).status).toBe('idle');
		expect(twin.verdictRequests).toHaveLength(0);
		await execute(agents, 'prepare-revision');
		expect((await plans()).at(-1)?.status).toBe('draft');
		expect(JSON.stringify(twin.requests[3]?.messages)).toContain('this call was not executed');
		expect(JSON.stringify(twin.requests[3]?.messages)).not.toContain('ARCHIVED_INITIAL_DISCUSSION');
		await execute(agents, 'cannot-run-parked');
		expect(twin.requests).toHaveLength(4);
		await submit(agents, 'Also inspect the schema.');
		await execute(agents, 'revise-plan');
		await submit(agents, 'Execute revised plan.', 'agent');
		await execute(agents, 'execute-revised');
		await execute(agents, 'consume-parked');
		expect(JSON.stringify(twin.requests[6]?.messages)).not.toContain('Which change do you want?');
		expect(JSON.stringify(twin.requests[7]?.messages)).toContain('LATER_EXECUTION_INPUT');
		expect((await plans()).at(-1)?.status).toBe('verified');
	});

	it('deleting an executed Plan preserves its archive and the subsequent evidence', async () => {
		const { ai, requests } = scriptedTranscript([
			createPlan(),
			assistantText('Planning discussion reply.'),
			assistantText('EXECUTION_EVIDENCE'),
			assistantText('New work.')
		]);
		const agents = await open(ai);
		await submit(agents, 'ARCHIVED_REQUIREMENTS');
		await execute(agents, 'draft');
		await submit(agents, 'Execute plan.', 'agent');
		await execute(agents, 'work');
		const id = PlanId.make(
			String(
				(
					await harness!.database.query('select active_plan_id from conversation where id=$1', [
						conversationId
					])
				)[0]?.active_plan_id
			)
		);
		await harness!.runtime.runPromise(
			agents.submit(harness!.effectId('delete-executed'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Delete plan.'),
				mode: 'agent',
				priority: 'normal',
				planAction: { action: 'delete', planId: id }
			})
		);
		await submit(agents, 'Continue normally.', 'agent');
		await execute(agents, 'normal');
		const prompt = JSON.stringify(requests.at(-1)?.messages);
		expect(prompt).not.toContain('ARCHIVED_REQUIREMENTS');
		expect(prompt).not.toContain('Planning discussion reply.');
		expect(prompt).not.toContain('Active Plan revision');
		expect(prompt).toContain('EXECUTION_EVIDENCE');
		expect(prompt).toContain('Continue normally.');
		expect(
			JSON.stringify(
				await harness!.database.query(
					'select message from conversation_message where conversation_id=$1',
					[conversationId]
				)
			)
		).toContain('ARCHIVED_REQUIREMENTS');
	});

	it('refuses stale and ambiguous patches without losing the draft', async () => {
		const { ai, requests } = scriptedTranscript([
			createPlan(),
			assistantToolCall(
				'update_plan',
				{ operation: 'patch', expectedRevision: 0, oldText: 'source', newText: 'schema' },
				'stale'
			),
			assistantToolCall(
				'update_plan',
				{ operation: 'patch', expectedRevision: 1, oldText: 'missing', newText: 'schema' },
				'missing'
			),
			assistantText('Draft preserved.')
		]);
		const agents = await open(ai);
		await submit(agents, 'Create and revise.');
		await execute(agents, 'patch-guards');
		expect(JSON.stringify(requests[2]?.messages)).toContain('Plan revision changed');
		expect(JSON.stringify(requests[3]?.messages)).toContain('oldText must match exactly once');
		expect(await plans()).toEqual([{ revision: 1, body: PLAN, status: 'draft' }]);
	});

	it('enforces the planning tool boundary even when the model attempts forbidden calls', async () => {
		const forbidden = [
			'write_collection',
			'read_collection',
			'todo',
			'compact',
			'subagent',
			'workspace_validate',
			'workspace_apply'
		];
		const { ai, requests } = scriptedTranscript([
			...forbidden.map((name, i) => assistantToolCall(name, {}, `forbidden-${i}`)),
			createPlan(),
			assistantText('Only the plan changed.')
		]);
		const agents = await open(ai);
		await submit(agents, 'Investigate without changing source.');
		await execute(agents, 'tool-boundary');
		const first = requests[0]!;
		if (first.output._tag !== 'Message') throw Error('Expected tools');
		expect(first.output.tools?.map((t) => t.name).sort()).toEqual(
			['describe_workspace', 'list_skills', 'read_skill', 'update_plan'].sort()
		);
		const failures = await harness!.database.query(
			"select message from conversation_message where conversation_id=$1 and author->>'kind'='tool'",
			[conversationId]
		);
		expect(JSON.stringify(failures).match(/ToolNotAllowed/g)).toHaveLength(forbidden.length);
		expect(await plans()).toEqual([{ revision: 1, body: PLAN, status: 'draft' }]);
	});

	it('rejects planning on a delegated conversation before making a provider call', async () => {
		const { ai, requests } = scriptedTranscript([assistantText('A root conversation.')]);
		const agents = await open(ai);
		await submit(agents, 'Create root.', 'agent');
		await execute(agents, 'root');
		const childId = ConversationId.make('00000000-0000-4000-8000-000000000702');
		// Persist a genuine child lineage; the public admission path must refuse its plan request.
		await harness!.database.query(
			`insert into conversation(id,workbench_id,subject_id,agent_id,audience,parent_id,status) select $1,workbench_id,subject_id,agent_id,audience,id,'ready' from conversation where id=$2`,
			[childId, conversationId]
		);
		await expect(
			harness!.runtime.runPromise(
				agents.submit(harness!.effectId('child-plan'), adminSubject, {
					conversationId: childId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput('Plan it.'),
					mode: 'plan',
					priority: 'normal'
				})
			)
		).rejects.toThrow('Only a root conversation');
		expect(requests).toHaveLength(1);
	});

	it('continues beyond three independent verifications and accounts for each call', async () => {
		const { ai, requests, verdictRequests } = scriptedTranscript(
			[
				createPlan(),
				assistantText('Review the draft.'),
				...Array.from({ length: 5 }, (_, i) => assistantText(`Execution evidence ${i + 1}.`))
			],
			{
				verdicts: [
					...Array.from({ length: 4 }, (_, i) => ({
						complete: false,
						summary: `Missing evidence ${i + 1}`,
						gaps: [`Check ${i + 1}`]
					})),
					{ complete: true, summary: 'All checks evidenced.', gaps: [] }
				]
			}
		);
		const agents = await open(ai);
		await submit(agents, 'PLAN_PRIVATE_DISCUSSION');
		await execute(agents, 'plan');
		await submit(agents, 'Execute plan.', 'agent');
		for (let i = 0; i < 5; i++)
			expect((await execute(agents, `verify-cycle-${i}`)).status).toBe(i === 4 ? 'done' : 'idle');
		expect(verdictRequests).toHaveLength(5);
		expect(
			verdictRequests.every(
				(r) => r.modelId === requests[0]?.modelId && r.sessionId === conversationId
			)
		).toBe(true);
		expect(verdictRequests[0]?.messages[0]?.role).toBe('system');
		expect(JSON.stringify(verdictRequests[0]?.messages)).toContain(
			'independent verification agent'
		);
		expect(JSON.stringify(verdictRequests[0]?.messages)).not.toContain('PLAN_PRIVATE_DISCUSSION');
		expect(JSON.stringify(requests[3]?.messages)).toContain('Check 1');
		expect((await plans()).at(-1)?.status).toBe('verified');
		expect(
			await harness!.database.query(
				`select count(*)::int as n, count(distinct call_id)::int as distinct_calls from turn_usage where turn_id in (select id from turn where conversation_id=$1)`,
				[conversationId]
			)
		).toEqual([{ n: 12, distinct_calls: 12 }]);
	});

	it('budgets the independent verifier and compacts oversized evidence before reviewing', async () => {
		const summaries: Array<{ messages: unknown; maxOutputTokens: number }> = [];
		const verdicts: Array<{ messages: unknown; maxOutputTokens: number }> = [];
		const ai = successfulAI(
			(request, index) => {
				if (request.purpose === 'compaction') {
					summaries.push(request);
					return assistantText(
						"| Section | Summary |\n| --- | --- |\n| Goal | Verify the active Plan. |\n| Progress | The source registry was inspected, receipt abc123. |\n| What we learned | The evidence exceeds one model window. |\n| What's left | Independently review the acceptance evidence. |"
					);
				}
				return index === 0
					? createPlan()
					: assistantText(index === 1 ? 'Draft ready.' : 'Execution evidence '.repeat(55_000));
			},
			{
				onVerdict: (request) => {
					verdicts.push(request);
				}
			}
		);
		const agents = await open(ai);
		await submit(agents, 'Plan.');
		await execute(agents, 'plan');
		await submit(agents, 'Execute plan.', 'agent');
		expect((await execute(agents, 'work')).status).toBe('done');
		expect(summaries.length).toBeGreaterThan(1);
		expect(verdicts).toHaveLength(1);
		expect(JSON.stringify(verdicts[0]?.messages)).toContain('receipt abc123');
		expect(
			[...summaries, ...verdicts].every(
				(r) =>
					new TextEncoder().encode(JSON.stringify(r.messages)).byteLength * 2 +
						r.maxOutputTokens +
						4096 <
					1_000_000
			)
		).toBe(true);
	});

	it.each(['stop', 'delete'] as const)(
		'does not auto-steer after %s during an in-flight verifier',
		async (action) => {
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const twin = scriptedTranscript(
				[createPlan(), assistantText('Plan ready.'), assistantText('Execution evidence.')],
				{
					verdicts: [
						{ complete: false, summary: 'Still missing a check.', gaps: ['Run the check.'] }
					]
				}
			);
			const ai: FacilityBinding<AIRequest, AIResponse> = {
				call: async (metadata, request, signal, onProgress) => {
					if (request._tag === 'Generate' && request.output._tag === 'PlanVerdict') {
						started.resolve();
						await release.promise;
					}
					return twin.ai.call(metadata, request, signal, onProgress);
				}
			};
			const agents = await open(ai);
			await submit(agents, 'Plan first.');
			await execute(agents, 'plan');
			await submit(agents, 'Execute plan.', 'agent');
			const running = execute(agents, 'execute');
			await started.promise;
			try {
				if (action === 'stop')
					await harness!.runtime.runPromise(
						agents.control(harness!.effectId('stop'), adminSubject, {
							conversationId,
							action: 'stop'
						})
					);
				else {
					const id = PlanId.make(
						String(
							(
								await harness!.database.query(
									'select active_plan_id from conversation where id=$1',
									[conversationId]
								)
							)[0]?.active_plan_id
						)
					);
					await harness!.runtime.runPromise(
						agents.submit(harness!.effectId('delete'), adminSubject, {
							conversationId,
							agentId: AgentId.make('web'),
							message: Agents.userAgentInput('Delete plan.'),
							mode: 'agent',
							priority: 'normal',
							planAction: { action: 'delete', planId: id }
						})
					);
				}
			} finally {
				release.resolve();
			}
			await running;
			expect(
				await harness!.database.query('select status from conversation where id=$1', [
					conversationId
				])
			).toEqual([{ status: action === 'stop' ? 'stopped' : 'done' }]);
			expect(
				await harness!.database.query(
					"select count(*)::int as n from conversation_message where conversation_id=$1 and state='queued'",
					[conversationId]
				)
			).toEqual([{ n: 0 }]);
			expect((await plans()).at(-1)?.status).toBe(action === 'stop' ? 'active' : 'discarded');
		}
	);
});
