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
 * Data-flow timing under an emulated provider rate. The cassette replays at
 * `tokensPerSecond` (default 60 tok/s — conservative flash-class assumption, a test parameter
 * not a provider claim), and every progressive part must reach database truth on pace:
 * submit → first part within the 1 s host budget, then paced growth until the complete
 * message. Wire-to-browser sync deltas ride on this truth (lane generics in
 * `sync-sync-lane`); a headed subscriber paint is the named next test, not this one.
 */
const cassettePath = fileURLToPath(
	new URL('./assets/agent-tool-turn.cassette.json', import.meta.url)
);
const TOKENS_PER_SECOND = 60;
const FIRST_PART_BUDGET_MILLIS = 1_000;

const workspace = testWorkspace({
	tools: [tool({ name: 'summarize', description: 'Summarize records.', command: 'summarize' })]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const assistantTexts = async (
	runtime: BoltTestRuntime,
	id: string
): Promise<ReadonlyArray<{ at: number; text: string }>> => {
	const rows = (await runtime.database.query(
		`select message from agent_message where task_id = $1 and message->>'role' = 'assistant' order by sequence`,
		[id]
	)) as ReadonlyArray<{ message: { content: unknown } }>;
	const at = Date.now();
	return rows.map((row) => ({
		at,
		text:
			typeof row.message.content === 'string'
				? row.message.content
				: Array.isArray(row.message.content)
					? row.message.content
							.map((part) =>
								typeof part === 'object' && part !== null && 'text' in part
									? String((part as { text: unknown }).text ?? '')
									: ''
							)
							.join('')
					: ''
	}));
};

describe('cassette sync flow (throttled replay, measured persistence)', () => {
	it('persists progressive parts on provider pace with a sub-second first part', async () => {
		const cassette = readCassetteFile(cassettePath);
		const ai: FacilityBinding<AIRequest, AIResponse> = cassetteAi(cassette, {
			tokensPerSecond: TOKENS_PER_SECOND
		});
		harness = await makeBoltTestRuntime(workspace, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make(recordId('task-cassette-sync'));
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit:sync'), adminSubject, {
				taskId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Complete the task.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		const started = Date.now();
		const executing = harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:sync'), adminSubject, taskId)
		);
		const progression: Array<{ at: number; text: string }> = [];
		let lastLength = -1;
		for (;;) {
			const snapshots = await assistantTexts(harness, taskId);
			const latest = snapshots[snapshots.length - 1];
			if (latest !== undefined && latest.text.length !== lastLength) {
				lastLength = latest.text.length;
				progression.push({ at: latest.at - started, text: latest.text });
			}
			if (Date.now() - started > 30_000) break;
			const settled = await Promise.race([
				executing.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25))
			]);
			if (settled) {
				const final = await assistantTexts(harness, taskId);
				const finalLatest = final[final.length - 1];
				if (finalLatest !== undefined && finalLatest.text.length !== lastLength) {
					progression.push({ at: finalLatest.at - started, text: finalLatest.text });
				}
				break;
			}
		}
		const result = await executing;
		expect(result).toMatchObject({ status: 'done' });
		// The tool-call turn persists first and fast: host overhead, not provider time.
		expect(progression.length).toBeGreaterThan(0);
		expect(progression[0]!.at).toBeLessThanOrEqual(FIRST_PART_BUDGET_MILLIS);
		// The text turn arrives progressively, not all at once: at least two growth steps.
		const growth = progression.filter((snapshot) => snapshot.text.length > 0);
		expect(growth.length).toBeGreaterThanOrEqual(2);
		for (let index = 1; index < growth.length; index += 1) {
			expect(growth[index]!.text.length).toBeGreaterThanOrEqual(growth[index - 1]!.text.length);
			expect(growth[index]!.at).toBeGreaterThanOrEqual(growth[index - 1]!.at);
		}
		// Final truth is the complete recorded message.
		const complete = growth[growth.length - 1]!.text;
		expect(complete).toMatch(/test-workspace/);
	}, 30_000);
});
