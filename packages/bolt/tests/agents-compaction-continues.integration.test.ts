import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ConversationId
} from '@norbital-ai/bolt-protocol';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';
import * as Agents from '../src/runtime/agents/agents.js';
import { projectAgentContextView } from '../src/client/ui/agent/context-view.js';
import { pairToolCalls } from '../src/client/ui/agent/tool-rows.js';
import { projectConversationMessages, projectTurns } from '../src/client/ui/agent/transcript.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * AGENT-UI5, runtime half. A turn over the context bound compacts once and then keeps working:
 * every message it appends after the checkpoint is on the same task and run with a strictly
 * increasing sequence, and the panel's own projection over those rows keeps all of them in focus.
 * The hr-payroll host showed the rows existing but not being seen (the transcript never
 * followed its tail); this pins the half that was never in doubt so the other half stays the
 * only place to look.
 */
/** Small enough that one large instruction fills it; see `agents-pipeline-transcript` for why. */
const SMALL_CONTEXT_WINDOW_TOKENS = 1_000_000;
const AUTO_COMPACT_PROMPT_BYTES = 280 * 1_024;
const LARGE_INSTRUCTION = `Compaction stress ${'x'.repeat(AUTO_COMPACT_PROMPT_BYTES)}`;

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const cassette = readCassetteFile(
	fileURLToPath(new URL('./assets/agents-compaction-continue.cassette.json', import.meta.url))
);

describe('automatic compaction mid-turn', () => {
	it('continues the tool loop after the checkpoint with increasing sequences the panel keeps in focus', async () => {
		const { ai, feed, requests } = cassetteTranscript(cassette, SMALL_CONTEXT_WINDOW_TOKENS);
		harness = await makeBoltTestRuntime(testWorkspace(), { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000811');
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit:continue'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Continue the task.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await harness.database.query(
			`insert into conversation_message(id,conversation_id,sequence,author,message,semantic_hash) values(gen_random_uuid(),$1,2,$2,$3,'fixture-history')`,
			[
				conversationId,
				{ kind: 'agent', id: 'web' },
				{ role: 'assistant', content: [{ type: 'text', text: LARGE_INSTRUCTION }] }
			]
		);
		const result = await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:continue'), adminSubject, conversationId)
		);
		expect(result.status).toBe('done');

		// One checkpoint, then three ordinary generations: two tool calls and the reply.
		expect(feed.map((step) => step.automaticCompact)).toEqual([true, false, false, false]);
		// The summary instruction is the final user turn of the compact request, not a system line.
		const compactRequest = requests[0]!;
		const tailMessage = compactRequest.messages.at(-1)!;
		expect(tailMessage.role).toBe('user');
		expect(JSON.stringify(tailMessage.content)).toContain('Automatic Compact:');
		expect(JSON.stringify(tailMessage.content)).toContain(
			"Goal; Progress; What we learned; What's left"
		);

		const rows = await harness.database.query(
			`select id, conversation_id, sequence, turn_id, author, message, annotation
			 from conversation_message where conversation_id = $1 order by sequence`,
			[conversationId]
		);
		const runs = projectTurns(
			await harness.database.query(
				`select id, conversation_id, input_message_id, mode, phase, input_through_sequence,
				        model_id, context_window_tokens, status
				 from turn where conversation_id = $1`,
				[conversationId]
			)
		);
		expect(runs).toHaveLength(1);
		const messages = projectConversationMessages(rows);
		// Nothing the runtime wrote is lost to the panel's row decoder.
		expect(messages).toHaveLength(rows.length);

		const checkpointIndex = messages.findIndex((message) => message.annotation?.tag === 'compact');
		expect(checkpointIndex).toBeGreaterThan(0);
		const checkpoint = messages[checkpointIndex]!;
		for (const label of ['Goal', 'Progress', 'What we learned', "What's left"])
			expect(JSON.stringify(checkpoint.message.content)).toContain(`| ${label} |`);
		// The panel's row decoder keeps only the keys it projects; provenance is read off the row.
		expect(rows[checkpointIndex]).toMatchObject({
			annotation: { tag: 'compact', origin: 'automatic' }
		});
		// The checkpoint stores the summary prose and nothing else.
		expect(checkpoint.message.role).toBe('assistant');
		expect(
			typeof checkpoint.message.content === 'string'
				? ['text']
				: checkpoint.message.content.map((part) => part.type)
		).toEqual(['text']);

		// The completion note follows the checkpoint; then two tool rounds and the reply.
		const after = messages.slice(checkpointIndex + 1);
		expect(after.map((message) => message.author.kind)).toEqual([
			'system',
			'agent',
			'tool',
			'agent',
			'tool',
			'agent'
		]);
		expect(JSON.stringify(after[0]!.message.content)).toContain(
			'request that produced it has been fulfilled'
		);
		for (const [index, message] of after.entries()) {
			expect(message.conversationId).toBe(conversationId);
			expect(message.runId).toBe(runs[0]!.id);
			const previous = index === 0 ? checkpoint : after[index - 1]!;
			expect(message.sequence).toBe(previous.sequence + 1);
		}

		// The panel's projection: the checkpoint moves to history, every later row stays in focus.
		const view = projectAgentContextView({ messages, runs });
		expect(view.checkpoint?.id).toBe(checkpoint.id);
		expect(view.historyMessages.map((message) => message.id)).toEqual(
			messages
				.filter((message) => message.sequence <= checkpoint.sequence)
				.map((message) => message.id)
		);
		const focusIds = new Set(view.focusMessages.map((message) => message.id));
		for (const message of after) expect(focusIds.has(message.id)).toBe(true);
		expect(view.focusMessages.map((message) => message.sequence)).toEqual(
			[...view.focusMessages].map((message) => message.sequence).sort((left, right) => left - right)
		);
		const tools = pairToolCalls(messages);
		expect(tools.resultsByCallId.has('call_after_checkpoint_1')).toBe(true);
		expect(tools.resultsByCallId.has('call_after_checkpoint_2')).toBe(true);
	});
});
