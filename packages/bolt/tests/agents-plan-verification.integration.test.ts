import { afterEach, describe, expect, it } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, ConversationId } from '@norbital-ai/bolt-protocol';
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
import { fileURLToPath } from 'node:url';
import { cassetteMessage, cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const PLAN_BODY =
	'Objective: ship the export. Approach: read the registry first. Verify: describe_workspace returns the registry.';

const openPlanTask = async (
	ai: ReturnType<typeof cassetteTranscript>['ai'],
	name: string
): Promise<{ agents: Agents.Interface; conversationId: ConversationId }> => {
	harness = await makeBoltTestRuntime(testWorkspace(), { ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	const conversationId = ConversationId.make(`00000000-0000-4000-8000-0000000007${name}`);
	await harness.runtime.runPromise(
		agents.submit(harness.effectId(`submit:plan:${name}`), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Plan the export work.'),
			mode: DirectiveMode.make('plan'),
			priority: DirectivePriority.make('normal')
		})
	);
	const planned = await harness.runtime.runPromise(
		agents.execute(harness.effectId(`execute:plan:${name}`), adminSubject, conversationId)
	);
	expect(planned.status).toBe('idle');
	return { agents, conversationId };
};

const submitAgentTurn = async (
	agents: Agents.Interface,
	name: string,
	conversationId: ConversationId
): Promise<void> => {
	await harness!.runtime.runPromise(
		agents.submit(harness!.effectId(`submit:${name}`), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Execute the Active Plan.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
};

const executeAgentTurn = (agents: Agents.Interface, name: string, conversationId: ConversationId) =>
	harness!.runtime.runPromise(agents.execute(harness!.effectId(name), adminSubject, conversationId));

const verdictAnnotations = async (conversationId: ConversationId) =>
	harness!.database.query(
		`select annotation->>'planId' as plan_id, annotation->>'complete' as complete,
			annotation->'gaps' as gaps
		 from conversation_message
		 where conversation_id = $1 and annotation->>'tag' = 'plan-verdict'
		 order by sequence`,
		[conversationId]
	);

describe('Plan auto-verifier', () => {
	it('replaces the complete plan and preserves a queued message delivered after its checkpoint', async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const revisedBody =
			'Objective: ship the export. Approach: preserve the registry and add validation. Verify: both checks pass.';
		const planCassette = cassette('agents-plan-replace');
		const twin = cassetteTranscript(planCassette);
		const requests = twin.requests;
		let held = false;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (metadata, request, signal, onProgress) => {
				if (request._tag === 'Generate' && !held) {
					held = true;
					return twin.ai.call(metadata, request, signal, onProgress);
				}
				if (request._tag === 'Generate' && twin.requests.length === 1) {
					started.resolve();
					return release.promise.then(() => twin.ai.call(metadata, request, signal, onProgress));
				}
				return twin.ai.call(metadata, request, signal, onProgress);
			}
		};
		const { agents, conversationId } = await openPlanTask(ai, '08');
		await harness!.runtime.runPromise(
			agents.submit(harness!.effectId('revise-plan'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Add validation.'),
				mode: 'plan',
				priority: 'normal'
			})
		);
		const running = executeAgentTurn(agents, 'revision-execute', conversationId);
		await started.promise;
		try {
			await harness!.runtime.runPromise(
				agents.submit(harness!.effectId('queued-during-plan'), adminSubject, {
					conversationId,
					agentId: AgentId.make('web'),
					message: userMessageWithAttachments('Also keep a copy of the result.', [
						{
							key: Agents.conversationAssetStorageKey(conversationId, 'requirements', 'requirements.txt'),
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
		await executeAgentTurn(agents, 'queued-after-plan', conversationId);
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
				'select revision, body, status from plan where conversation_id = $1 order by revision',
				[conversationId]
			)
		).toEqual([
			{ revision: 1, body: PLAN_BODY, status: 'superseded' },
			{ revision: 2, body: revisedBody, status: 'verified' }
		]);
	});

	it('sends the model back on an incomplete verdict, then settles verified with the verdict annotations', async () => {
		const { ai, feed, verdictRequests } = cassetteTranscript(cassette('agents-plan-incomplete'));
		const { agents, conversationId } = await openPlanTask(ai, '01');
		await submitAgentTurn(agents, 'agent:01', conversationId);

		const first = await executeAgentTurn(agents, 'execute:01:a', conversationId);
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

		const second = await executeAgentTurn(agents, 'execute:01:b', conversationId);
		expect(second.status).toBe('done');
		// Plan + two implementing turns; verdict Generates are recorded separately.
		expect(feed).toHaveLength(3);
		expect(verdictRequests).toHaveLength(2);

		const verdicts = await verdictAnnotations(conversationId);
		expect(verdicts).toHaveLength(2);
		expect(verdicts[0]).toMatchObject({ complete: 'false' });
		expect(verdicts[0]?.gaps).toEqual(['No durable evidence that the export ran']);
		expect(verdicts[1]).toMatchObject({ complete: 'true' });
		expect(verdicts[1]?.plan_id).toEqual(verdicts[0]?.plan_id);

		expect(
			await harness!.database.query(
				`select plan.status, task.status as task_status
				 from conversation task
				 join plan plan on plan.id = task.active_plan_id
				 where task.id = $1`,
				[conversationId]
			)
		).toEqual([{ status: 'verified', task_status: 'done' }]);
		const usage = await harness!.database.query(
			`select count(*)::int as n, count(distinct settlement_id)::int as d
			 from turn_usage usage
			 join turn run on run.id = usage.turn_id
			 where run.conversation_id = $1`,
			[conversationId]
		);
		expect(usage).toEqual([{ n: 5, d: 5 }]);
	});

	it('stalls the Plan in attention after the third incomplete verdict and queues nothing further', async () => {
		const { ai, verdictRequests } = cassetteTranscript(cassette('agents-plan-stall'));
		const { agents, conversationId } = await openPlanTask(ai, '02');
		await submitAgentTurn(agents, 'agent:02', conversationId);

		expect((await executeAgentTurn(agents, 'execute:02:a', conversationId)).status).toBe('idle');
		expect((await executeAgentTurn(agents, 'execute:02:b', conversationId)).status).toBe('idle');
		const third = await executeAgentTurn(agents, 'execute:02:c', conversationId);
		expect(third.status).toBe('attention');
		expect(verdictRequests).toHaveLength(3);

		const finalVerdict = await harness!.database.query(
			`select message
			 from conversation_message
			 where conversation_id = $1 and annotation->>'tag' = 'plan-verdict'
			 order by sequence desc
			 limit 1`,
			[conversationId]
		);
		expect(JSON.stringify(finalVerdict[0]?.message)).toContain(
			'Plan verification 3/3: incomplete.'
		);
		expect(JSON.stringify(finalVerdict[0]?.message)).toContain('Gap 3');

		expect(
			await harness!.database.query(
				`select plan.status, task.status as task_status
				 from conversation task
				 join plan plan on plan.id = task.active_plan_id
				 where task.id = $1`,
				[conversationId]
			)
		).toEqual([{ status: 'stalled', task_status: 'attention' }]);
		expect(
			await harness!.database.query(
				`select count(*)::int as n from conversation_message where conversation_id = $1 and state = 'queued'`,
				[conversationId]
			)
		).toEqual([{ n: 0 }]);
	});
});
