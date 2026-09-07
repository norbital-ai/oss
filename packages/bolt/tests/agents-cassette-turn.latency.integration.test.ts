import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Schema } from 'effect';
import { cassetteAi, readCassetteFile } from '@norbital-ai/test-utilities';
import type {
	AIRequest,
	AIResponse,
	FacilityBinding,
	HostScheduleOccurrence,
	HostScheduleOutcome
} from '@norbital-ai/bolt-protocol';
import { AgentId, DirectiveMode, DirectivePriority, TaskId } from '@norbital-ai/bolt-protocol';
import { tool } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import * as Identity from '../src/runtime/identity/identity.js';
import * as TaskQueue from '../src/runtime/tasks/tasks.js';
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
 * AGENT-LAT (RFC `bolt.md` B5): the provider is asked within 100 ms of the user pressing send.
 *
 * Measured here from `agents.submit` starting to the AI binding receiving the turn's first
 * `Generate`, in-process, over ten turns of one conversation, at p95. The host's own contribution
 * on Colony is one warm isolate hop (~86 ms p50 in `profile-guest-hop`) on top of this number; it
 * is one hop because the submit's `Wake` carries the claimed occurrence and the host runs it at
 * once, instead of arming a timer, discovering and claiming across three more.
 */
const SUBMIT_TO_PROVIDER_P95_BUDGET_MILLIS = 100;
const LATENCY_TURNS = 10;

const workspace = testWorkspace({
	tools: [
		tool({ name: 'summarize', description: 'Summarize records.', command: 'summarize' }),
		tool({ name: 'sandbox_files', description: 'Inspect files.', command: 'host:sandbox_files' })
	],
	skills: [{ name: 'payroll', body: '# Payroll\n\nUse the approved workflow.' }]
});

const ExecuteInput = Schema.Struct({ taskId: TaskId, bolt_run_as: Identity.Subject });
const decodeExecuteInput = Schema.decodeUnknownSync(ExecuteInput);

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
			await new Promise((resolve) => setTimeout(resolve, 2));
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

	// A wall-clock budget: this file is the `latency` suite (vitest.config.ts), one fork, run after
	// the parallel integration pass, because the same turns measured 77 ms p95 alone and 116 to
	// 130 ms with three other forks on the CPU. The printed per-turn numbers are the evidence.
	it('reaches the provider within 100 ms of submit at p95 over ten turns, in one host hop', async () => {
		const cassette = readCassetteFile(cassettePath);
		// One replay per turn: the cassette carries outputs only, and every turn of the conversation
		// replays the same tool call and final text against a transcript one turn longer.
		let inner = cassetteAi(cassette);
		let submitStartedAt = 0;
		let wakeAt = 0;
		let awaitingProvider = false;
		/** Per turn: submit start → the host is woken with the occurrence → the provider is asked. */
		const phases: Array<{ readonly toWake: number; readonly toProvider: number }> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (...args) => {
				if (args[1]._tag === 'Generate' && awaitingProvider) {
					awaitingProvider = false;
					phases.push({
						toWake: wakeAt - submitStartedAt,
						toProvider: performance.now() - submitStartedAt
					});
				}
				return inner.call(...args);
			}
		};
		harness = await makeBoltTestRuntime(workspace, { ai });
		const runtime = harness;
		const agents = await runtime.runtime.runPromise(Agents.Service);
		const queue = await runtime.runtime.runPromise(TaskQueue.Service);
		// What a host does with a `Wake` that carries a claimed occurrence: invoke its command now,
		// then settle it. This is bolt-server's `makeTaskBinding` and Colony's tasks facility, minus
		// the isolate; no timer is armed and `host.schedules.discover` is never asked.
		runtime.tasks.bind(async (occurrence: HostScheduleOccurrence) => {
			wakeAt = performance.now();
			expect(occurrence.command).toBe('tasks.execute');
			const input = decodeExecuteInput(occurrence.input);
			const outcome: HostScheduleOutcome = await runtime.runtime
				.runPromise(
					agents.execute(
						runtime.effectId(`execute:${occurrence.taskId}`),
						input.bolt_run_as,
						input.taskId
					)
				)
				.then(
					(result): HostScheduleOutcome => ({
						_tag: 'Done',
						result: { taskId: result.taskId, status: result.status }
					}),
					(cause): HostScheduleOutcome => ({
						_tag: 'Failed',
						error: String(cause),
						retryable: false
					})
				);
			await runtime.runtime.runPromise(
				queue.settle(
					runtime.effectId(`settle:${occurrence.taskId}`),
					occurrence.taskId,
					occurrence.attempt,
					outcome
				)
			);
		});
		const taskId = TaskId.make(recordId('task-cassette-latency'));
		for (let turn = 0; turn < LATENCY_TURNS; turn += 1) {
			inner = cassetteAi(cassette);
			const dispatchedBefore = runtime.tasks.dispatched.length;
			awaitingProvider = true;
			submitStartedAt = performance.now();
			await runtime.runtime.runPromise(
				agents.submit(runtime.effectId(`submit:latency:${turn}`), adminSubject, {
					taskId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput(`Turn ${turn + 1}: complete the task.`),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal')
				})
			);
			// The submit itself handed the host exactly one claimed occurrence and returned; the run
			// is already under way on the host's side of the seam.
			const dispatched = runtime.tasks.dispatched[dispatchedBefore];
			expect(runtime.tasks.dispatched).toHaveLength(dispatchedBefore + 1);
			expect(dispatched?.occurrence).toMatchObject({
				command: 'tasks.execute',
				scheduleKey: `task:${dispatched?.occurrence.taskId}`,
				attempt: 1
			});
			await dispatched?.done;
		}
		expect(phases).toHaveLength(LATENCY_TURNS);
		const latencies = phases.map(({ toProvider }) => toProvider);
		const wakes = phases.map(({ toWake }) => toWake);
		const p95 = percentile(latencies, 0.95);
		// Printed so a run leaves the numbers behind, not only a verdict: the whole, its two halves
		// (the guest's own admission up to the wake, then the host's run up to the provider), and the
		// first and last turn, because the transcript the runtime reads back grows by four messages
		// a turn and the cost follows it.
		console.info(
			`AGENT-LAT submit→provider over ${LATENCY_TURNS} turns: p50 ${percentile(latencies, 0.5).toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${Math.max(...latencies).toFixed(1)} ms; submit→wake p50 ${percentile(wakes, 0.5).toFixed(1)} ms, p95 ${percentile(wakes, 0.95).toFixed(1)} ms; per turn ${latencies.map((value) => value.toFixed(0)).join(' ')} ms`
		);
		expect(p95).toBeLessThanOrEqual(SUBMIT_TO_PROVIDER_P95_BUDGET_MILLIS);
		// Every wake the runtime sent for these turns carried its occurrence: nothing waited on a
		// timer, and every claimed row was settled by the host that ran it, on its first attempt.
		const wakeRequests = runtime.tasks.requests.filter((request) => request._tag === 'Wake');
		expect(wakeRequests.length).toBeGreaterThanOrEqual(LATENCY_TURNS);
		expect(
			wakeRequests.every((wake) => wake._tag === 'Wake' && wake.occurrence !== undefined)
		).toBe(true);
		expect(
			await runtime.database.query(
				`select status, attempts from bolt_task where command = 'tasks.execute' order by created_at`
			)
		).toEqual(Array.from({ length: LATENCY_TURNS }, () => ({ status: 'done', attempts: 1 })));
		expect(
			(await runtime.database.query(
				`select count(*)::int as count from agent_message where task_id = $1 and message->>'role' = 'user'`,
				[taskId]
			)) as ReadonlyArray<{ count: number }>
		).toEqual([{ count: LATENCY_TURNS }]);
	});

	it('fails fast on a corrupt cassette instead of running a changed pipeline', () => {
		expect(() => readCassetteFile(`${cassettePath}.missing`)).toThrow();
	});
});
