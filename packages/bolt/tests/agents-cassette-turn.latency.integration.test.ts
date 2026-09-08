import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cassetteAi, readCassetteFile } from '@norbital-ai/test-utilities';
import type {
	AIRequest,
	AIResponse,
	FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { AgentId, DirectiveMode, DirectivePriority, ConversationId } from '@norbital-ai/bolt-protocol';
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

/** Host-overhead budget: with an instant provider, the first part must persist within 100 ms of execute. */
const FIRST_PART_BUDGET_MILLIS = 100;
/**
 * The provider is asked within 100 ms of the user pressing send.
 *
 * Measured from `agents.submit` starting to the AI binding receiving the turn's first `Generate`,
 * in-process, over ten turns of one conversation, at p95. Admission and the turn are one call:
 * `conversations.send` admits the message and answers it without a durable row in between, so the
 * host's own contribution on Colony is the one warm isolate hop (~86 ms p50 in `profile-guest-hop`)
 * that carried the send in, and nothing after it.
 */
const SEND_TO_PROVIDER_P95_BUDGET_MILLIS = 100;
const LATENCY_TURNS = 10;

const workspace = testWorkspace({
	tools: [
		tool({ name: 'summarize', description: 'Summarize records.', command: 'summarize' }),
		tool({ name: 'sandbox_files', description: 'Inspect files.', command: 'host:sandbox_files' })
	],
	skills: [{ name: 'payroll', body: '# Payroll\n\nUse the approved workflow.' }]
});

const percentile = (values: ReadonlyArray<number>, fraction: number): number => {
	const sorted = values.toSorted((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[index] ?? Number.NaN;
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('cassette agent turn (offline replay of the live probe)', () => {
	it('runs the recorded turn with no extra round trips and a sub-100 ms first part', async () => {
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
		const conversationId = ConversationId.make(recordId('task-cassette-turn'));
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit:cassette'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Complete the task.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		const started = Date.now();
		const executing = harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:cassette'), adminSubject, conversationId)
		);
		let firstPartAt = 0;
		for (;;) {
			const rows = (await harness.database.query(
				`select message->>'role' as role from conversation_message where conversation_id = $1 order by sequence`,
				[conversationId]
			)) as ReadonlyArray<{ role: string }>;
			if (rows.some((row) => row.role === 'assistant')) {
				firstPartAt = Date.now();
				break;
			}
			if (Date.now() - started > FIRST_PART_BUDGET_MILLIS) break;
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		const result = await executing;
		expect(firstPartAt).toBeGreaterThan(0);
		expect(firstPartAt - started).toBeLessThanOrEqual(FIRST_PART_BUDGET_MILLIS);
		expect(result).toMatchObject({ conversationId, status: 'done' });
		// No overhead round trips: one tool turn + one final text, exactly as recorded.
		expect(generates).toBe(2);
		const runtime = harness;
		if (runtime === undefined) throw new Error('test runtime was not created');
		expect(
			await runtime.database.query(
				`select author->>'kind' as author_kind, message->>'role' as role
				 from conversation_message where conversation_id = $1 order by sequence`,
				[conversationId]
			)
		).toEqual([
			{ author_kind: 'human', role: 'user' },
			{ author_kind: 'agent', role: 'assistant' },
			{ author_kind: 'tool', role: 'tool' },
			{ author_kind: 'agent', role: 'assistant' }
		]);
		const finals = (await runtime.database.query(
			`select message from conversation_message where conversation_id = $1 order by sequence desc limit 1`,
			[conversationId]
		)) as ReadonlyArray<{ message: unknown }>;
		expect(JSON.stringify(finals[0]?.message)).toMatch(/test-workspace/);
	});

	// A wall-clock budget: this file is the `latency` suite (vitest.config.ts), one fork, run after
	// the parallel integration pass, because the same turns measured 77 ms p95 alone and 116 to
	// 130 ms with three other forks on the CPU. The printed per-turn numbers are the evidence.
	it('reaches the provider within 100 ms of send at p95 over ten turns, in one invocation', async () => {
		const cassette = readCassetteFile(cassettePath);
		// One replay per turn: the cassette carries outputs only, and every turn of the conversation
		// replays the same tool call and final text against a transcript one turn longer.
		let inner = cassetteAi(cassette);
		let sendStartedAt = 0;
		let awaitingProvider = false;
		/** Per turn: the send starting → the provider being asked, with nothing in between. */
		const latencies: Array<number> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (...args) => {
				if (args[1]._tag === 'Generate' && awaitingProvider) {
					awaitingProvider = false;
					latencies.push(performance.now() - sendStartedAt);
				}
				return inner.call(...args);
			}
		};
		harness = await makeBoltTestRuntime(workspace, { ai });
		const runtime = harness;
		const agents = await runtime.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make(recordId('task-cassette-latency'));
		for (let turn = 0; turn < LATENCY_TURNS; turn += 1) {
			inner = cassetteAi(cassette);
			awaitingProvider = true;
			sendStartedAt = performance.now();
			/**
			 * The send, whole: admit the message and answer it, in this call.
			 *
			 * This is what `conversations.send` binds to, and the two lines are the measurement. There
			 * is no durable occurrence between them any more — no row to write, no wake to carry it, no
			 * claim for a host to win — so the number below is the runtime's own overhead and nothing
			 * else's.
			 */
			await runtime.runtime.runPromise(
				agents.submit(runtime.effectId(`submit:latency:${turn}`), adminSubject, {
					conversationId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput(`Turn ${turn + 1}: complete the task.`),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal')
				})
			);
			await runtime.runtime.runPromise(
				agents.answerQueued(runtime.effectId(`answer:latency:${turn}`), adminSubject, conversationId)
			);
		}
		expect(latencies).toHaveLength(LATENCY_TURNS);
		const p95 = percentile(latencies, 0.95);
		// Printed so a run leaves the numbers behind, not only a verdict, and per turn because the
		// transcript the runtime reads back grows by four messages a turn and the cost follows it.
		console.info(
			`AGENT-LAT send→provider over ${LATENCY_TURNS} turns: p50 ${percentile(latencies, 0.5).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${Math.max(...latencies).toFixed(1)} ms; per turn ${latencies.map((value) => value.toFixed(0)).join(' ')} ms`
		);
		expect(p95).toBeLessThanOrEqual(SEND_TO_PROVIDER_P95_BUDGET_MILLIS);
		// Nothing was queued behind the agent: a turn is not a task, and no row was written for one.
		expect(
			await runtime.database.query(`select command from bolt_task where command = 'tasks.execute'`)
		).toEqual([]);
		expect(
			(await runtime.database.query(
				`select count(*)::int as count from conversation_message where conversation_id = $1 and message->>'role' = 'user'`,
				[conversationId]
			)) as ReadonlyArray<{ count: number }>
		).toEqual([{ count: LATENCY_TURNS }]);
	});

	it('fails fast on a corrupt cassette instead of running a changed pipeline', () => {
		expect(() => readCassetteFile(`${cassettePath}.missing`)).toThrow();
	});
});
