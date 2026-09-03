import { describe, expect, it } from 'vitest';
import {
	compactOrigin,
	editableUserMessageText,
	projectAgentContextView
} from '../src/client/ui/agent/context-view.js';
import {
	projectAgentMessages,
	projectAgentPlans,
	projectAgentRuns
} from '../src/client/ui/agent/transcript.js';
import { canonicalAgentRows } from './ui-canonical-agent-fixture.js';

const taskId = '00000000-0000-4000-8000-000000000401';
const agentRunId = '00000000-0000-4000-8000-000000000402';
const planRunId = '00000000-0000-4000-8000-000000000403';
const compactRunId = '00000000-0000-4000-8000-000000000404';
const planId = '00000000-0000-4000-8000-000000000405';

const runRow = (id: string, mode: 'agent' | 'plan' | 'compact') => ({
	id,
	task_id: taskId,
	directive_id: '00000000-0000-4000-8000-000000000406',
	epoch: 1,
	mode,
	phase: 'model',
	input_through_sequence: 8,
	model_id: 'openrouter/test-model',
	capability_snapshot: {},
	status: 'succeeded'
});

describe('agent model-view projection', () => {
	it('separates the active Plan/Compact focus from durable transcript history', () => {
		const messages = projectAgentMessages(
			canonicalAgentRows([
				{ taskId, message: { role: 'user', content: 'Old requirement' } },
				{ taskId, message: { role: 'assistant', content: 'Old answer' } },
				{
					taskId,
					runId: planRunId,
					message: { role: 'user', content: 'Plan the replacement' }
				},
				{
					taskId,
					runId: planRunId,
					message: { role: 'assistant', content: 'Detailed planning turn' }
				},
				{
					taskId,
					runId: agentRunId,
					message: { role: 'assistant', content: 'Decisions and unresolved work' },
					annotation: {
						tag: 'compact',
						cutoff: 3,
						retainedMessageIds: ['00000000-0000-4000-8000-000000000001']
					}
				},
				{
					taskId,
					runId: agentRunId,
					message: { role: 'user', content: 'Continue from the checkpoint' }
				},
				{
					taskId,
					runId: agentRunId,
					message: { role: 'assistant', content: 'Continuing' }
				}
			])
		);
		const runs = projectAgentRuns([
			runRow(agentRunId, 'agent'),
			runRow(planRunId, 'plan')
		]);
		const [activePlan] = projectAgentPlans([
			{
				id: planId,
				task_id: taskId,
				revision: 2,
				checkpoint_sequence: 1,
				body: 'Replace the runtime and verify it.',
				status: 'active',
				created_at: '2026-09-01T00:00:00.000Z'
			}
		]);

		const view = projectAgentContextView({ messages, runs, activePlan });

		expect(view.checkpoint?.sequence).toBe(4);
		expect(view.checkpointOrigin).toBe('automatic');
		expect(view.focusMessages.map((message) => message.sequence)).toEqual([5, 6]);
		expect([...view.outsideMessageIds]).toEqual([
			'00000000-0000-4000-8000-000000000001',
			'00000000-0000-4000-8000-000000000002',
			'00000000-0000-4000-8000-000000000003',
			'00000000-0000-4000-8000-000000000004'
		]);
		expect(view.detailMessageIds).toEqual(
			new Set([
				'00000000-0000-4000-8000-000000000003',
				'00000000-0000-4000-8000-000000000004',
				'00000000-0000-4000-8000-000000000005'
			])
		);
	});

	it('distinguishes manual and automatic Compact checkpoints from canonical run mode', () => {
		const [checkpoint] = projectAgentMessages(
			canonicalAgentRows([
				{
					taskId,
					runId: compactRunId,
					message: { role: 'assistant', content: 'Manual summary' },
					annotation: { tag: 'compact', cutoff: 0, retainedMessageIds: [] }
				}
			])
		);
		const compactRuns = projectAgentRuns([runRow(compactRunId, 'compact')]);
		const automaticRuns = projectAgentRuns([runRow(compactRunId, 'agent')]);

		expect(compactOrigin(checkpoint!, compactRuns)).toBe('manual');
		expect(compactOrigin(checkpoint!, automaticRuns)).toBe('automatic');
		expect(compactOrigin(checkpoint!, [])).toBe('unresolved');
	});

	it('allows revision only when canonical user content can be preserved as plain text', () => {
		const [plain, multipart, agent] = projectAgentMessages(
			canonicalAgentRows([
				{ taskId, message: { role: 'user', content: 'Correct the date' } },
				{
					taskId,
					message: {
						role: 'user',
						content: [
							{ type: 'text', text: 'Use this file' },
							{
								type: 'file',
								data: 'data:text/plain;base64,QQ==',
								mediaType: 'text/plain',
								fileName: 'a.txt'
							}
						]
					}
				},
				{ taskId, message: { role: 'assistant', content: 'Done' } }
			])
		);

		expect(editableUserMessageText(plain!)).toBe('Correct the date');
		expect(editableUserMessageText(multipart!)).toBeNull();
		expect(editableUserMessageText(agent!)).toBeNull();
	});
});
