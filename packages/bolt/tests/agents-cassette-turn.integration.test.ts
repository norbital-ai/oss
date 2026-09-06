import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cassetteAi, readCassetteFile } from '@norbital-ai/test-utilities';
import type { AIRequest, AIResponse, FacilityBinding } from '@norbital-ai/bolt-protocol';
import { AgentId, DirectiveMode, DirectivePriority, TaskId } from '@norbital-ai/bolt-protocol';
import { tool } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * The recorded live probe (`tests/assets/agent-tool-turn.cassette.json`, gpt-4.1-mini,
 * one tool turn) replayed offline through the real loop. No key, no network: the cassette
 * carries provider outputs only, and every assertion below is pipeline — submit → generate →
 * tool → persist → settle — plus the latency/round-trip budgets from the matrix.
 */
const cassettePath = fileURLToPath(
	new URL('./assets/agent-tool-turn.cassette.json', import.meta.url)
);

/** Host-overhead budget: with an instant provider, the first part must persist within 1 s of execute. */
const FIRST_PART_BUDGET_MILLIS = 1_000;

const workspace = testWorkspace({
	tools: [
		tool({ name: 'summarize', description: 'Summarize records.', command: 'summarize' }),
		tool({ name: 'sandbox_files', description: 'Inspect files.', command: 'host:sandbox_files' })
	],
	skills: [{ name: 'payroll', body: '# Payroll\n\nUse the approved workflow.' }]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('cassette agent turn (offline replay of the live probe)', () => {
	it('runs the recorded turn with no extra round trips and a sub-second first part', async () => {
		const cassette = readCassetteFile(cassettePath);
		expect(cassette.turns).toHaveLength(2);
		let generates = 0;
		const inner = cassetteAi(cassette);
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (...args) => {
				if (args[1]._tag === 'Generate') generates += 1;
				return inner.call(...args);
			}
		};
		harness = await makeBoltTestRuntime(workspace, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make(recordId('task-cassette-turn'));
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit:cassette'), adminSubject, {
				taskId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Complete the task.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		const started = Date.now();
		const executing = harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:cassette'), adminSubject, taskId)
		);
		let firstPartAt = 0;
		for (;;) {
			const rows = (await harness.database.query(
				`select message->>'role' as role from agent_message where task_id = $1 order by sequence`,
				[taskId]
			)) as ReadonlyArray<{ role: string }>;
			if (rows.some((row) => row.role === 'assistant')) {
				firstPartAt = Date.now();
				break;
			}
			if (Date.now() - started > FIRST_PART_BUDGET_MILLIS) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const result = await executing;
		expect(firstPartAt).toBeGreaterThan(0);
		expect(firstPartAt - started).toBeLessThanOrEqual(FIRST_PART_BUDGET_MILLIS);
		expect(result).toMatchObject({ taskId, status: 'done' });
		// No overhead round trips: one tool turn + one final text, exactly as recorded.
		expect(generates).toBe(2);
		const runtime = harness;
		if (runtime === undefined) throw new Error('test runtime was not created');
		expect(
			await runtime.database.query(
				`select author->>'kind' as author_kind, message->>'role' as role
				 from agent_message where task_id = $1 order by sequence`,
				[taskId]
			)
		).toEqual([
			{ author_kind: 'human', role: 'user' },
			{ author_kind: 'agent', role: 'assistant' },
			{ author_kind: 'tool', role: 'tool' },
			{ author_kind: 'agent', role: 'assistant' }
		]);
		const finals = (await runtime.database.query(
			`select message from agent_message where task_id = $1 order by sequence desc limit 1`,
			[taskId]
		)) as ReadonlyArray<{ message: unknown }>;
		expect(JSON.stringify(finals[0]?.message)).toMatch(/test-workspace/);
	});

	it('fails fast on a corrupt cassette instead of running a changed pipeline', () => {
		expect(() => readCassetteFile(`${cassettePath}.missing`)).toThrow();
	});
});
