import { describe, expect, it, afterEach } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, ConversationId } from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCall,
	scriptedTranscript,
	toolResultFor
} from './agents-canonical-ai-fixture.js';

/**
 * The agent compacting itself.
 *
 * Automatic compaction is the runtime deciding a turn is close to the model's window. This is the
 * other one: the agent has finished a phase of work and says so, and the intermediate steps stop
 * being worth carrying. Both write the same checkpoint through the same code; what differs is who
 * asked, which is why the annotation records an `origin` rather than the panel inferring one.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const runTurn = async (
	ai: ReturnType<typeof scriptedTranscript>['ai'],
	conversationId: ConversationId
) => {
	harness = await makeBoltTestRuntime(testWorkspace(), { ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	await harness.runtime.runPromise(
		agents.submit(harness.effectId('submit'), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Reconcile the ledger, then tidy up.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
	return harness.runtime.runPromise(
		agents.execute(harness.effectId('execute'), adminSubject, conversationId)
	);
};

const checkpoints = (conversationId: ConversationId) =>
	harness!.database.query(
		`select annotation->>'origin' as origin, annotation->'retainedMessageIds' as retained
		 from conversation_message
		 where conversation_id = $1 and annotation->>'tag' = 'compact'
		 order by sequence`,
		[conversationId]
	);

describe('the compact tool', () => {
	it('checkpoints on request, well under the model window, and continues the turn', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000c01');
		// The checkpoint generation is answered canned by the fixture and consumes no script entry.
		const { ai, feed, requests } = scriptedTranscript([
			assistantToolCall('compact', { reason: 'The reconciliation is finished.' }, 'compact-1'),
			assistantText('Tidied up.')
		]);
		const result = await runTurn(ai, conversationId);
		expect(result.status).toBe('done');

		// The tool answers immediately and says the checkpoint is the loop's job, not its own.
		expect(toolResultFor(requests.at(-1)!, 'compact')).toEqual({
			checkpoint: 'scheduled',
			reason: 'The reconciliation is finished.'
		});

		// Nothing here is near the window: this checkpoint exists because the agent asked for it.
		const [checkpoint] = await checkpoints(conversationId);
		expect(checkpoint).toMatchObject({ origin: 'requested' });

		/**
		 * The instruction says who asked. The wording is not decoration — the fixture and the panel
		 * both read it, and a checkpoint the model was told to write "automatically" when an agent
		 * asked for it would describe the turn wrongly in its own transcript.
		 */
		const compactPrompt = requests[1]!;
		expect(JSON.stringify(compactPrompt.messages.at(-1)?.content)).toContain('Requested Compact:');
		expect(feed.map((step) => step.automaticCompact)).toEqual([false, true, false]);
		expect(feed).toHaveLength(3);
	});

	it('retains the current instruction and this turn’s own messages across the checkpoint', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000c02');
		const { ai } = scriptedTranscript([
			assistantToolCall('compact', { reason: 'Phase one is done.' }, 'compact-1'),
			assistantText('Phase two complete.')
		]);
		expect((await runTurn(ai, conversationId)).status).toBe('done');

		const [checkpoint] = (await checkpoints(conversationId)) as ReadonlyArray<{
			retained: ReadonlyArray<string>;
		}>;
		const thisTurn = (await harness!.database.query(
			`select id from conversation_message
			 where conversation_id = $1 and turn_id is not null and annotation->>'tag' is distinct from 'compact'`,
			[conversationId]
		)) as ReadonlyArray<{ id: string }>;
		// Everything this turn wrote before the checkpoint is named as retained, so a compaction the
		// agent asked for mid-turn cannot discard the work it was in the middle of.
		for (const { id } of thisTurn.slice(0, 2)) expect(checkpoint!.retained).toContain(id);
	});

	it('refuses to compact more than three times in one turn, and says so once', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000c03');
		const request = (n: number) =>
			assistantToolCall('compact', { reason: `Checkpoint ${n}.` }, `compact-${n}`);
		const { ai } = scriptedTranscript([
			request(1),
			request(2),
			request(3),
			// The fourth is refused, so no checkpoint generation follows it.
			request(4),
			assistantText('Done anyway.')
		]);
		expect((await runTurn(ai, conversationId)).status).toBe('done');
		expect(await checkpoints(conversationId)).toHaveLength(3);

		const system = await harness!.database.query(
			`select message from conversation_message
			 where conversation_id = $1 and author->>'kind' = 'system'`,
			[conversationId]
		);
		expect(JSON.stringify(system)).toContain('requested more than 3 times in one turn');
	});
});
