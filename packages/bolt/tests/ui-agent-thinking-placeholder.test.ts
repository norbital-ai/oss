import { expect, it } from 'vitest';
import { projectConversationMessages, projectTurns, turnWaitingSeconds } from '../src/client/ui/agent/transcript.js';
import { canonicalAgentRows } from './ui-canonical-agent-fixture.js';

const conversationId = '00000000-0000-4000-8000-000000000101';
const runId = '00000000-0000-4000-8000-000000000102';
const startedAt = Date.parse('2026-09-09T01:28:56.000Z');
const turn = (status: 'running' | 'succeeded') =>
	projectTurns([
		{
			id: runId,
			conversation_id: conversationId,
			input_message_id: '00000000-0000-4000-8000-000000000103',
			mode: 'agent',
			phase: 'model',
			input_through_sequence: 0,
			model_id: 'test:language',
			context_window_tokens: 1_000,
			status,
			created_at: new Date(startedAt).toISOString()
		}
	])[0];

it('counts the seconds a running turn has shown nothing, until its first agent row', () => {
	expect(turnWaitingSeconds(turn('running'), [], startedAt + 21_400)).toBe(21);
	expect(turnWaitingSeconds(turn('running'), [], startedAt - 5_000)).toBe(0);
	expect(turnWaitingSeconds(turn('succeeded'), [], startedAt + 21_400)).toBeNull();
	expect(turnWaitingSeconds(undefined, [], startedAt)).toBeNull();
	const rows = projectConversationMessages(
		canonicalAgentRows([
			{
				conversationId,
				runId,
				message: { role: 'assistant', content: [{ type: 'reasoning', text: '' }] },
				annotation: { tag: 'generation', callId: 'fixture', sequence: 0, activeParts: [0] }
			}
		])
	);
	expect(turnWaitingSeconds(turn('running'), rows, startedAt + 21_400)).toBeNull();
});
