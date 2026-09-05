import { afterEach, describe, expect, it } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, TaskId } from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { assistantText, scriptedTranscript } from './agents-canonical-ai-fixture.js';

const AUTO_COMPACT_PROMPT_BYTES = 64 * 1_024;
const LARGE_INSTRUCTION = `Compaction stress ${'x'.repeat(AUTO_COMPACT_PROMPT_BYTES)}`;

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const runAgentTask = async (
	ai: ReturnType<typeof scriptedTranscript>['ai'],
	name: string,
	mode: 'agent' | 'compact',
	message: string
) => {
	harness = await makeBoltTestRuntime(testWorkspace(), { ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	const taskId = TaskId.make(`00000000-0000-4000-8000-0000000008${name}`);
	await harness.runtime.runPromise(
		agents.submit(harness.effectId(`submit:${name}`), adminSubject, {
			taskId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput(message),
			mode: DirectiveMode.make(mode),
			priority: DirectivePriority.make('normal')
		})
	);
	const result = await harness.runtime.runPromise(
		agents.execute(harness.effectId(`execute:${name}`), adminSubject, taskId)
	);
	return { agents, taskId, result };
};

describe('auto-compaction degraded paths', () => {
	it('records a degraded turn when the retained projection stays over the bound after one checkpoint', async () => {
		const { ai, feed } = scriptedTranscript([
			assistantText('Proceeding over the degraded projection.')
		]);
		const { taskId, result } = await runAgentTask(ai, '01', 'agent', LARGE_INSTRUCTION);
		expect(result.status).toBe('done');
		expect(feed[0]).toMatchObject({ automaticCompact: true, maxOutputTokens: 1_536 });
		// One checkpoint per run: the second Generate is the turn itself, not a second summary.
		expect(feed[1]).toMatchObject({ automaticCompact: false });
		expect(feed[1]?.promptBytes).toBeGreaterThan(AUTO_COMPACT_PROMPT_BYTES);
		expect(feed).toHaveLength(2);
		expect(
			await harness!.database.query(
				`select count(*)::int as n from agent_message
				 where task_id = $1 and annotation->>'tag' = 'compact'`,
				[taskId]
			)
		).toEqual([{ n: 1 }]);
		const system = await harness!.database.query(
			`select message from agent_message
			 where task_id = $1 and author->>'kind' = 'system'
			 order by sequence`,
			[taskId]
		);
		expect(JSON.stringify(system)).toContain(
			'Automatic Compact left the projection above the context bound'
		);
		expect(JSON.stringify(system)).toContain('without a second checkpoint');
	});

	it('meters the automatic compact generation as its own usage settlement', async () => {
		const { ai, feed } = scriptedTranscript([assistantText('Continuing after the checkpoint.')]);
		const { taskId } = await runAgentTask(ai, '02', 'agent', LARGE_INSTRUCTION);
		const usage = await harness!.database.query(
			`select usage.call_id, usage.settlement_id, usage.settlement_state, usage.operation
			 from agent_usage usage
			 join agent_run run on run.id = usage.run_id
			 where run.task_id = $1
			 order by usage.call_id`,
			[taskId]
		);
		expect(usage).toHaveLength(2);
		// feed[0] is the auto-compact Generate, feed[1] the turn itself.
		const compactCallId = usage.find((row) => row['call_id'] === feed[0]?.callId);
		const turnCallId = usage.find((row) => row['call_id'] === feed[1]?.callId);
		expect(compactCallId).toMatchObject({
			settlement_state: 'attention',
			operation: 'language'
		});
		expect(compactCallId?.settlement_id).toEqual(`ai:${feed[0]?.callId}`);
		expect(turnCallId).toMatchObject({ settlement_state: 'attention' });
	});

	it('annotates a manual compact turn with origin manual and no retained ids', async () => {
		const { ai } = scriptedTranscript([assistantText('Retained: the open export decisions.')]);
		const { taskId, result } = await runAgentTask(
			ai,
			'03',
			'compact',
			'Summarize the durable context.'
		);
		expect(result.status).toBe('idle');
		expect(
			await harness!.database.query(
				`select annotation->>'origin' as origin, annotation->'retainedMessageIds' as retained
				 from agent_message
				 where task_id = $1 and annotation->>'tag' = 'compact'`,
				[taskId]
			)
		).toEqual([{ origin: 'manual', retained: [] }]);
	});
});
