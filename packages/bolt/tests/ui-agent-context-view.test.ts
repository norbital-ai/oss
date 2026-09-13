import { describe, expect, it } from 'vitest';
import {
	compactOrigin,
	editableUserMessageText,
	projectAgentContextView
} from '../src/client/ui/agent/context-view.js';
import {
	projectConversationMessages,
	projectPlans,
	projectTurns
} from '../src/client/ui/agent/transcript.js';
import { canonicalAgentRows } from './ui-canonical-agent-fixture.js';

const conversationId = '00000000-0000-4000-8000-000000000401';
const agentTurnId = '00000000-0000-4000-8000-000000000402';
const planTurnId = '00000000-0000-4000-8000-000000000403';
const compactTurnId = '00000000-0000-4000-8000-000000000404';
const planId = '00000000-0000-4000-8000-000000000405';

const runRow = (id: string, mode: 'agent' | 'plan' | 'compact') => ({
	id,
	conversation_id: conversationId,
	input_message_id: '00000000-0000-4000-8000-000000000406',
	mode,
	phase: 'model',
	input_through_sequence: 8,
	context_window_tokens: 1_000_000,
	model_id: 'openrouter/test-model',
	status: 'succeeded'
});

describe('agent model-view projection', () => {
	it('groups retained history but keeps queued and late-consumed input after the boundary', () => {
		const rows = canonicalAgentRows([
			{ conversationId, message: { role: 'user', content: 'Original request' } },
			{ conversationId, message: { role: 'assistant', content: 'Completed work' } },
			{
				conversationId,
				message: { role: 'user', content: 'Queued request' },
				annotation: { tag: 'input' }
			},
			{
				conversationId,
				message: { role: 'user', content: 'Delivered after compaction' },
				annotation: { tag: 'input', consumedAfterSequence: 4 }
			},
			{
				conversationId,
				message: { role: 'assistant', content: 'Complete summary' },
				annotation: {
					tag: 'compact',
					origin: 'requested',
					cutoff: 3,
					retainedMessageIds: ['00000000-0000-4000-8000-000000000001']
				}
			}
		]);
		const view = projectAgentContextView({ messages: projectConversationMessages(rows), runs: [] });
		expect(view.historyMessages.map((message) => message.sequence)).toEqual([0, 1, 4]);
		expect(view.focusMessages.map((message) => message.sequence)).toEqual([2, 3]);
		expect(view.outsideMessageIds.has('00000000-0000-4000-8000-000000000001')).toBe(false);
	});

	it('keeps a planning revision visible until its replacement plan owns the transcript', () => {
		const messages = projectConversationMessages(
			canonicalAgentRows([
				{ conversationId, message: { role: 'user', content: 'Original objective' } },
				{
					conversationId,
					runId: planTurnId,
					message: { role: 'assistant', content: 'Complete plan one' }
				},
				{ conversationId, message: { role: 'user', content: 'Add validation' } },
				{
					conversationId,
					runId: agentTurnId,
					message: { role: 'assistant', content: 'Complete plan two' }
				}
			])
		);
		const runs = projectTurns([
			runRow(planTurnId, 'plan'),
			{ ...runRow(agentTurnId, 'plan'), status: 'running' }
		]);
		const plan = projectPlans([
			{
				id: planId,
				conversation_id: conversationId,
				revision: 1,
				checkpoint_sequence: 1,
				body: 'Complete plan one',
				status: 'active',
				created_at: '2026-09-01'
			}
		])[0]!;
		const working = projectAgentContextView({ messages, runs, activePlan: plan });
		expect(working.focusMessages.map((message) => message.sequence)).toEqual([2, 3]);
		expect(working.historyMessages.map((message) => message.sequence)).toEqual([0, 1]);
		const revised = projectAgentContextView({
			messages,
			runs,
			activePlan: { ...plan, revision: 2, checkpoint_sequence: 3, body: 'Complete plan two' }
		});
		expect(revised.focusMessages).toEqual([]);
		expect(revised.historyMessages).toEqual(messages);
	});

	it('separates the active Plan/Compact focus from durable transcript history', () => {
		const messages = projectConversationMessages(
			canonicalAgentRows([
				{ conversationId, message: { role: 'user', content: 'Old requirement' } },
				{ conversationId, message: { role: 'assistant', content: 'Old answer' } },
				{
					conversationId,
					runId: planTurnId,
					message: { role: 'user', content: 'Plan the replacement' }
				},
				{
					conversationId,
					runId: planTurnId,
					message: { role: 'assistant', content: 'Detailed planning turn' }
				},
				{
					conversationId,
					runId: agentTurnId,
					message: { role: 'assistant', content: 'Decisions and unresolved work' },
					annotation: {
						tag: 'compact',
						origin: 'automatic',
						cutoff: 3,
						retainedMessageIds: ['00000000-0000-4000-8000-000000000001']
					}
				},
				{
					conversationId,
					runId: agentTurnId,
					message: { role: 'user', content: 'Continue from the checkpoint' }
				},
				{
					conversationId,
					runId: agentTurnId,
					message: { role: 'assistant', content: 'Continuing' }
				}
			])
		);
		const runs = projectTurns([runRow(agentTurnId, 'agent'), runRow(planTurnId, 'plan')]);
		const [activePlan] = projectPlans([
			{
				id: planId,
				conversation_id: conversationId,
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

	/**
	 * Provenance is read from the checkpoint, not inferred from the run that wrote it.
	 *
	 * It used to be derived from `run.mode` — `compact` meant a person, `agent` meant the runtime —
	 * a second scanner that had to agree with the runtime's by hand and could not express the third
	 * case at all: an agent calling the `compact` tool on itself runs in `agent` mode and would have
	 * read as automatic. The annotation has always carried `origin`.
	 */
	it('reads Compact provenance from the checkpoint, including an agent asking for one', () => {
		const checkpoint = (origin: 'manual' | 'automatic' | 'requested') =>
			projectConversationMessages(
				canonicalAgentRows([
					{
						conversationId,
						runId: compactTurnId,
						message: { role: 'assistant', content: 'Summary' },
						annotation: { tag: 'compact', origin, cutoff: 0, retainedMessageIds: [] }
					}
				])
			)[0]!;

		expect(compactOrigin(checkpoint('manual'))).toBe('manual');
		expect(compactOrigin(checkpoint('automatic'))).toBe('automatic');
		expect(compactOrigin(checkpoint('requested'))).toBe('requested');

		// A message that is not a checkpoint has no provenance to read.
		const [plain] = projectConversationMessages(
			canonicalAgentRows([{ conversationId, message: { role: 'user', content: 'Hello' } }])
		);
		expect(compactOrigin(plain!)).toBe('unresolved');
	});

	it('allows revision only when canonical user content can be preserved as plain text', () => {
		const [plain, multipart, agent] = projectConversationMessages(
			canonicalAgentRows([
				{ conversationId, message: { role: 'user', content: 'Correct the date' } },
				{
					conversationId,
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
				{ conversationId, message: { role: 'assistant', content: 'Done' } }
			])
		);

		expect(editableUserMessageText(plain!)).toBe('Correct the date');
		expect(editableUserMessageText(multipart!)).toBeNull();
		expect(editableUserMessageText(agent!)).toBeNull();
	});
});
