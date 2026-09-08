import { describe, expect, it } from 'vitest';
import {
	modelChangeDividers,
	projectConversationMessages,
	projectTurns
} from '../src/client/ui/agent/transcript.js';
import { canonicalAgentRows } from './ui-canonical-agent-fixture.js';

const conversationId = '00000000-0000-4000-8000-000000000601';
const runA = '00000000-0000-4000-8000-000000000602';
const runB = '00000000-0000-4000-8000-000000000603';
const runC = '00000000-0000-4000-8000-000000000604';

const runRow = (id: string, modelId: string) => ({
	id,
	conversation_id: conversationId,
	input_message_id: '00000000-0000-4000-8000-000000000609',
	mode: 'agent',
	phase: 'model',
	input_through_sequence: 0,
	context_window_tokens: 1_000_000,
	model_id: modelId,
	status: 'succeeded'
});

const transcript = () =>
	projectConversationMessages(
		canonicalAgentRows([
			{ conversationId, message: { role: 'user', content: 'First question' } },
			{ conversationId, runId: runA, message: { role: 'assistant', content: 'First answer' } },
			{ conversationId, message: { role: 'user', content: 'Second question' } },
			{ conversationId, runId: runB, message: { role: 'assistant', content: 'Second answer' } },
			{ conversationId, message: { role: 'user', content: 'Third question' } },
			{ conversationId, runId: runC, message: { role: 'assistant', content: 'Third answer' } }
		])
	);

describe('AGENT-UI3 model-change divider', () => {
	it('is a pure function of the stored rows: one divider naming the second model', () => {
		const messages = transcript();
		const runs = projectTurns([
			runRow(runB, 'deepseek/deepseek-v4-flash-vision-exp'),
			runRow(runA, 'z-ai/glm-5.3-flash')
		]);
		const first = modelChangeDividers(runs, messages);
		expect([...first.entries()]).toEqual([[messages[3]!.id, 'deepseek/deepseek-v4-flash-vision-exp']]);
		// Re-projecting the same rows (what a reload does) yields the same divider at the same message.
		const again = modelChangeDividers(projectTurns(runs.map((run) => ({ ...run }))), transcript());
		expect([...again.entries()]).toEqual([...first.entries()]);
	});

	it('marks every change, including a switch back', () => {
		const messages = transcript();
		const runs = projectTurns([
			runRow(runA, 'model/a'),
			runRow(runB, 'model/b'),
			runRow(runC, 'model/a')
		]);
		expect([...modelChangeDividers(runs, messages).entries()]).toEqual([
			[messages[3]!.id, 'model/b'],
			[messages[5]!.id, 'model/a']
		]);
	});

	it('places nothing when consecutive runs share a model', () => {
		const runs = projectTurns([
			runRow(runA, 'model/a'),
			runRow(runB, 'model/a'),
			runRow(runC, 'model/a')
		]);
		expect(modelChangeDividers(runs, transcript()).size).toBe(0);
	});

	it('skips a run that persisted no message, since a divider has nowhere to go', () => {
		const messages = transcript().filter((message) => message.runId !== runB);
		const runs = projectTurns([
			runRow(runA, 'model/a'),
			runRow(runB, 'model/b'),
			runRow(runC, 'model/a')
		]);
		expect(modelChangeDividers(runs, messages).size).toBe(0);
	});
});
