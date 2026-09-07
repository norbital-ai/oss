import { describe, expect, it } from 'vitest';
import {
	modelChangeDividers,
	projectAgentMessages,
	projectAgentRuns
} from '../src/client/ui/agent/transcript.js';
import { canonicalAgentRows } from './ui-canonical-agent-fixture.js';

const taskId = '00000000-0000-4000-8000-000000000601';
const runA = '00000000-0000-4000-8000-000000000602';
const runB = '00000000-0000-4000-8000-000000000603';
const runC = '00000000-0000-4000-8000-000000000604';

const runRow = (id: string, modelId: string) => ({
	id,
	task_id: taskId,
	directive_id: '00000000-0000-4000-8000-000000000609',
	epoch: 1,
	mode: 'agent',
	phase: 'model',
	input_through_sequence: 0,
	model_id: modelId,
	status: 'succeeded'
});

const transcript = () =>
	projectAgentMessages(
		canonicalAgentRows([
			{ taskId, message: { role: 'user', content: 'First question' } },
			{ taskId, runId: runA, message: { role: 'assistant', content: 'First answer' } },
			{ taskId, message: { role: 'user', content: 'Second question' } },
			{ taskId, runId: runB, message: { role: 'assistant', content: 'Second answer' } },
			{ taskId, message: { role: 'user', content: 'Third question' } },
			{ taskId, runId: runC, message: { role: 'assistant', content: 'Third answer' } }
		])
	);

describe('AGENT-UI3 model-change divider', () => {
	it('is a pure function of the stored rows: one divider naming the second model', () => {
		const messages = transcript();
		const runs = projectAgentRuns([
			runRow(runB, 'deepseek/deepseek-v4-flash-vision-exp'),
			runRow(runA, 'z-ai/glm-5.3-flash')
		]);
		const first = modelChangeDividers(runs, messages);
		expect([...first.entries()]).toEqual([[messages[3]!.id, 'deepseek/deepseek-v4-flash-vision-exp']]);
		// Re-projecting the same rows (what a reload does) yields the same divider at the same message.
		const again = modelChangeDividers(projectAgentRuns(runs.map((run) => ({ ...run }))), transcript());
		expect([...again.entries()]).toEqual([...first.entries()]);
	});

	it('marks every change, including a switch back', () => {
		const messages = transcript();
		const runs = projectAgentRuns([
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
		const runs = projectAgentRuns([
			runRow(runA, 'model/a'),
			runRow(runB, 'model/a'),
			runRow(runC, 'model/a')
		]);
		expect(modelChangeDividers(runs, transcript()).size).toBe(0);
	});

	it('skips a run that persisted no message, since a divider has nowhere to go', () => {
		const messages = transcript().filter((message) => message.runId !== runB);
		const runs = projectAgentRuns([
			runRow(runA, 'model/a'),
			runRow(runB, 'model/b'),
			runRow(runC, 'model/a')
		]);
		expect(modelChangeDividers(runs, messages).size).toBe(0);
	});
});
