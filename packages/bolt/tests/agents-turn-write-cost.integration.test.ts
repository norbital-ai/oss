import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cassetteAi, readCassetteFile } from '@norbital-ai/test-utilities';
import { AgentId, DirectiveMode, DirectivePriority, ConversationId } from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * What one turn costs the database, asserted as a number rather than left to a profiler.
 *
 * A turn's latency is not its writes; it is what surrounds each write, and none of that is visible
 * to a suite that only checks the transcript came out right — the expensive shape and the cheap one
 * produce identical rows. So the cost is the assertion.
 *
 * The defect these rows exist to keep out: a message written as a *nested child* of the task row
 * makes the mutate a replacement, so the write first reads back every sibling to restate the ids of
 * rows it was never going to change. Its signature in SQL is a `jsonb_agg(child.id …)` aggregation
 * standing in front of a write. It is O(conversation) per streamed token boundary, it never shows
 * up as a wrong answer, and it returns the moment anyone reaches for `writeConversation` to carry a row.
 *
 * These are ratchets. Each number is what the turn costs today, pinned so that growing the cost
 * fails rather than passing quietly. A number that moves down is a row to edit, and the edit is the
 * point.
 */

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/** The sibling read-back a nested write performs, whatever collection it is aggregating. */
const siblingAggregations = (statements: ReadonlyArray<string>): ReadonlyArray<string> =>
	statements.filter((statement) => statement.includes('jsonb_agg(child.id'));

/** Reads that project rows, as opposed to the `bolt_assert` preconditions a write carries. */
const transcriptReads = (statements: ReadonlyArray<string>): ReadonlyArray<string> =>
	statements.filter(
		(statement) => statement.startsWith('select "d0"."id"') && statement.includes('"conversation_message"')
	);

const writesTo = (statements: ReadonlyArray<string>, table: string): ReadonlyArray<string> =>
	statements.filter(
		(statement) =>
			statement.startsWith(`insert into "${table}" `) || statement.startsWith(`update "${table}" `)
	);

const runTurn = async (name: string) => {
	harness = await makeBoltTestRuntime(undefined, { ai: cassetteAi(cassette(name)) });
	const runtime = harness;
	const agents = await runtime.runtime.runPromise(Agents.Service);
	const conversationId = ConversationId.make(recordId(`cost-${name}`));
	await runtime.runtime.runPromise(
		agents.submit(runtime.effectId(`submit:${name}`), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Say hello.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
	// Only the turn is measured. Admission is its own invocation and is §4's business.
	runtime.database.forget();
	const result = await runtime.runtime.runPromise(
		agents.execute(runtime.effectId(`execute:${name}`), adminSubject, conversationId)
	);
	return { conversationId, result, statements: [...runtime.database.statements] };
};

describe('what one agent turn costs the database', () => {
	it('does not read siblings back to restate ids it is not changing', async () => {
		const { result, statements } = await runTurn('agents-admission-hello');
		expect(result.status).toBe('done');
		expect(writesTo(statements, 'conversation_message')).toHaveLength(2);

		/**
		 * None. Every row a turn writes — the message, the turn, its usage, a plan — is now addressed
		 * by its own collection, so there are no siblings to restate and nothing to read back first.
		 * This is the number the file was written to reach, and it stays at zero: a write that
		 * reintroduces the nesting reintroduces the O(conversation) read in front of it.
		 */
		expect(siblingAggregations(statements)).toHaveLength(0);
	});

	it('does not re-read the whole transcript once per streamed part', async () => {
		const { statements } = await runTurn('agents-admission-hello');

		/**
		 * Seven. Six are bounded lookups — `limit 1`, or the queued rows only — that the queue does on
		 * the message rows themselves; one is the transcript.
		 *
		 * What matters is what is *not* here: a read per streamed part. Neither this number nor the
		 * one above moves with the length of a reply, and
		 * `agents-part-streaming.integration.test.ts` is the row that proves it.
		 */
		expect(transcriptReads(statements)).toHaveLength(7);
	});

	it('writes each row once, to its own collection', async () => {
		const { statements } = await runTurn('agents-admission-hello');
		expect({
			turn: writesTo(statements, 'turn').length,
			conversation_message: writesTo(statements, 'conversation_message').length,
			conversation: writesTo(statements, 'conversation').length,
			turn_usage: writesTo(statements, 'turn_usage').length
		}).toEqual({ turn: 2, conversation_message: 2, conversation: 2, turn_usage: 1 });
	});

	/**
	 * Seven rows, four commits, and the collections a row lives in do not decide which is which.
	 *
	 * A mutate is one transaction and publishes one commit, and a commit crosses to the host — so
	 * the unit worth counting is the call. The engine always grouped roots by collection and
	 * compiled every group into a single statement plan; the public root type simply withheld the
	 * field naming a root's collection, so no caller could write across two.
	 *
	 * What that field buys is here: starting a turn creates the run, marks the message it answers
	 * answered and moves the conversation to `running` in **one** statement, and settling it writes
	 * the run and the conversation in one more. Without it those are five commits instead of two,
	 * and — the reason it matters beyond the count — a crash between them leaves a conversation
	 * `running` with no run, or a run nothing points at.
	 */
	it('commits four times, whatever collections the rows are in', async () => {
		const { statements } = await runTurn('agents-admission-hello');
		// A commit is a run of writes uninterrupted by the graph read that precedes the next one.
		const groups: Array<Array<string>> = [];
		let current: Array<string> | undefined;
		for (const statement of statements) {
			const write = /^(?:insert into|update) "([a-z_]+)"/.exec(statement)?.[1];
			if (write === undefined) {
				if (statement.includes('__bolt_graph_ordinal')) current = undefined;
				continue;
			}
			if (current === undefined) groups.push((current = []));
			current.push(write);
		}
		expect(groups).toEqual([
			// startRun: the input message, the conversation, the run.
			['conversation_message', 'conversation', 'turn'],
			// recordUsage: the provider call, alone, changing nothing else.
			['turn_usage'],
			// The assistant reply.
			['conversation_message'],
			// settleRun: the run's outcome and the conversation's, together.
			['turn', 'conversation']
		]);
	});

	it('does not write the task row once per streamed part', async () => {
		const { statements } = await runTurn('agents-admission-hello');

		/**
		 * Two, and — the property that matters — independent of how many parts stream, because no
		 * conversation write carries a passenger any more. They are the two transitions the row
		 * actually makes: `running` when the turn starts, and its settled status when it ends. Usage,
		 * steering delivery and a recall used to write it a third, fourth and fifth time to restate
		 * columns they were not changing; those writes are gone rather than folded.
		 */
		expect(writesTo(statements, 'conversation')).toHaveLength(2);
	});
});
