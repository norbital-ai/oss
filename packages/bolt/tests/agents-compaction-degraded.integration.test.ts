import { successfulAI, assistantText } from './agents-canonical-ai-fixture.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ConversationId
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { fileURLToPath } from 'node:url';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';

/** Small enough that one large instruction fills it; see `agents-pipeline-transcript` for why. */
const SMALL_CONTEXT_WINDOW_TOKENS = 1_000_000;
const AUTO_COMPACT_PROMPT_BYTES = 280 * 1_024;
const LARGE_INSTRUCTION = `Compaction stress ${'x'.repeat(AUTO_COMPACT_PROMPT_BYTES)}`;

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

const runConversation = async (
	ai: ReturnType<typeof cassetteTranscript>['ai'],
	name: string,
	mode: 'agent' | 'compact',
	message: string,
	history?: string
) => {
	harness = await makeBoltTestRuntime(testWorkspace(), { ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	const conversationId = ConversationId.make(`00000000-0000-4000-8000-0000000008${name}`);
	await harness.runtime.runPromise(
		agents.submit(harness.effectId(`submit:${name}`), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput(message === LARGE_INSTRUCTION ? 'Continue.' : message),
			mode: DirectiveMode.make(mode),
			priority: DirectivePriority.make('normal')
		})
	);
	if (message === LARGE_INSTRUCTION || history !== undefined)
		await harness.database.query(
			`insert into conversation_message(id,conversation_id,sequence,author,message,semantic_hash) values(gen_random_uuid(),$1,2,$2,$3,'fixture-history')`,
			[conversationId, { kind: 'agent', id: 'web' }, assistantText(history ?? LARGE_INSTRUCTION)]
		);
	const result = await harness.runtime.runPromise(
		agents.execute(harness.effectId(`execute:${name}`), adminSubject, conversationId)
	);
	return { agents, conversationId, result };
};

describe('auto-compaction degraded paths', () => {
	it('rejects an oversized retained instruction without spending on an ineffective compaction', async () => {
		const requests: Array<{ purpose?: string; messages: unknown; maxOutputTokens: number }> = [];
		const ai = successfulAI((request) => {
			requests.push(request);
			return assistantText('Checkpoint: the full original request remains in history.');
		});
		await expect(runConversation(ai, '01', 'agent', '不可压缩'.repeat(90_000))).rejects.toThrow(
			'No oversized model request was sent'
		);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000801');
		expect(requests).toEqual([]);
		const rows = await harness!.database.query(
			'select message from conversation_message where conversation_id=$1',
			[conversationId]
		);
		expect(JSON.stringify(rows)).toContain('不可压缩'.repeat(90_000));
		expect(JSON.stringify(rows)).toContain('No oversized model request was sent');
	});

	it('folds legacy history larger than the window in bounded calls, then continues normally', async () => {
		const requests: Array<{ purpose?: string; messages: unknown; maxOutputTokens: number }> = [];
		const ai = successfulAI((request) => {
			requests.push(request);
			return assistantText(
				request.purpose === 'compaction'
					? "| Section | Summary |\n| --- | --- |\n| Goal | Original constraints preserved. |\n| Progress | Prior evidence reviewed. |\n| What we learned | The transcript exceeds the model window. |\n| What's left | Continue the remaining check. |"
					: 'Finished.'
			);
		});
		const history = 'Legacy evidence '.repeat(65_000);
		const { result, conversationId } = await runConversation(
			ai,
			'04',
			'agent',
			'Continue.',
			history
		);
		expect(result.status).toBe('done');
		expect(requests.filter((r) => r.purpose === 'compaction').length).toBeGreaterThan(1);
		expect(requests.at(-1)?.purpose).toBeUndefined();
		expect(
			requests.every(
				(r) =>
					new TextEncoder().encode(JSON.stringify(r.messages)).byteLength * 2 +
						r.maxOutputTokens +
						4096 <
					1_000_000
			)
		).toBe(true);
		expect(JSON.stringify(requests.at(-1)?.messages)).not.toContain(history);
		expect(
			JSON.stringify(
				await harness!.database.query(
					'select message from conversation_message where conversation_id=$1',
					[conversationId]
				)
			)
		).toContain(history);
	});

	it('meters the automatic compact generation as its own usage settlement', async () => {
		const { ai, feed } = cassetteTranscript(
			cassette('agents-compaction-02'),
			SMALL_CONTEXT_WINDOW_TOKENS
		);
		const { conversationId } = await runConversation(ai, '02', 'agent', LARGE_INSTRUCTION);
		const usage = await harness!.database.query(
			`select usage.call_id, usage.settlement_id, usage.settlement_state, usage.operation
			 from turn_usage usage
			 join turn run on run.id = usage.turn_id
			 where run.conversation_id = $1
			 order by usage.call_id`,
			[conversationId]
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

	it.each([false, true])(
		'retries malformed manual summaries without losing history (fails=%s)',
		async (alwaysInvalid) => {
			const requests: Array<{ callId: string; modelId: string; maxOutputTokens: number }> = [];
			const summary =
				"| Section | Summary |\n| --- | --- |\n| Goal | Preserve the workspace and finish its export. |\n| Progress | Draft abc123 validated. |\n| What we learned | Export must preserve attachments. |\n| What's left | Export the validated draft. |";
			const ai = successfulAI((request) => {
				expect(request.purpose).toBe('compaction');
				requests.push(request);
				return assistantText(
					alwaysInvalid || requests.length === 1 ? 'Summary missing the goal.' : summary
				);
			});
			const pending = runConversation(
				ai,
				'05',
				'compact',
				'Summarize our work.',
				'KEEP_THIS_ORIGINAL_HISTORY'
			);
			if (alwaysInvalid) await expect(pending).rejects.toThrow('original context is preserved');
			else expect((await pending).result.status).toBe('idle');
			expect(requests.map((r) => r.maxOutputTokens)).toEqual([4096, 8192]);
			expect(new Set(requests.map((r) => r.modelId)).size).toBe(1);
			expect(new Set(requests.map((r) => r.callId)).size).toBe(2);
			const rows = await harness!.database.query(
				'select message, annotation from conversation_message where conversation_id=$1',
				['00000000-0000-4000-8000-000000000805']
			);
			expect(JSON.stringify(rows)).toContain('KEEP_THIS_ORIGINAL_HISTORY');
			expect(
				rows.filter((row) => (row['annotation'] as { tag?: string } | null)?.tag === 'compact')
			).toHaveLength(alwaysInvalid ? 0 : 1);
			expect(
				await harness!.database.query(
					'select call_id from turn_usage where call_id=any($1::text[])',
					[requests.map((r) => r.callId)]
				)
			).toHaveLength(2);
		}
	);

	it.each(['extra column', 'empty cell', 'oversized'])(
		'retries a malformed table (%s) and accepts escaped pipes',
		async (problem) => {
			const valid =
				"| Section | Summary |\n| --- | --- |\n| Goal | A |\n| Progress | Checked a \\| b. |\n| What we learned | Keep escaped pipes. |\n| What's left | Send the final report. |";
			const invalid = valid.replace(
				'| Goal | A |',
				problem === 'extra column'
					? '| Goal | A | B |'
					: problem === 'empty cell'
						? '| Goal |   |'
						: `| Goal | ${'word '.repeat(801)} |`
			);
			let calls = 0;
			const ai = successfulAI(() => assistantText(++calls === 1 ? invalid : valid));
			expect((await runConversation(ai, '06', 'compact', 'Summarize.')).result.status).toBe('idle');
			expect(calls).toBe(2);
		}
	);

	it('annotates a manual compact turn with origin manual and no retained ids', async () => {
		const { ai } = cassetteTranscript(
			cassette('agents-compaction-03'),
			SMALL_CONTEXT_WINDOW_TOKENS
		);
		const { conversationId, result } = await runConversation(
			ai,
			'03',
			'compact',
			'Summarize the durable context.'
		);
		expect(result.status).toBe('idle');
		expect(
			await harness!.database.query(
				`select annotation->>'origin' as origin, annotation->'retainedMessageIds' as retained
				 from conversation_message
				 where conversation_id = $1 and annotation->>'tag' = 'compact'`,
				[conversationId]
			)
		).toEqual([{ origin: 'manual', retained: [] }]);
	});
});
