import { describe, expect, it, afterEach } from 'vitest';
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
import {
	successfulAI,
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
	it.each(['empty', 'truncated', 'malformed-table', 'always-truncated'] as const)(
		'retries an invalid checkpoint once and records both receipts (%s)',
		async (invalid) => {
			const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000c09');
			const attempts: Array<{ callId: string; modelId: string; maxOutputTokens: number }> = [];
			const base = successfulAI((request, index) => {
				if (index === 0)
					return assistantToolCall(
						'describe_workspace',
						{},
						'read-before-compact',
						'Evidence '.repeat(35_000)
					);
				if (request.purpose !== 'compaction') return assistantText('Finished.');
				if (attempts.length === 0 || invalid === 'always-truncated')
					return assistantText(invalid === 'empty' ? '' : 'Partial summary ending at schema:');
				return assistantText(
					"| Section | Summary |\n| --- | --- |\n| Goal | Preserve the current apps and data. |\n| Progress | Browser acceptance passed. Draft abc123 validates. |\n| What we learned | The existing data remains intact. |\n| What's left | Next: report completion. |"
				);
			});
			const ai: typeof base = {
				call: async (...args) => {
					const [, request] = args;
					const response = await base.call(...args);
					if (
						request._tag !== 'Generate' ||
						request.purpose !== 'compaction' ||
						response._tag !== 'Success' ||
						response.value._tag !== 'Generated'
					)
						return response;
					attempts.push(request);
					return {
						...response,
						value: {
							...response.value,
							observation: {
								...response.value.observation,
								usage: {
									inputTokens: { total: 1000 },
									outputTokens: {
										total:
											invalid === 'always-truncated' ||
											(invalid === 'truncated' && attempts.length === 1)
												? request.maxOutputTokens
												: 200
									}
								},
								charge: { currency: 'USD', coefficient: 1n, scale: 3 },
								chargeSource: 'provider'
							}
						}
					};
				}
			};
			if (invalid === 'always-truncated') {
				await expect(runTurn(ai, conversationId)).rejects.toThrow('original context is preserved');
				expect(await checkpoints(conversationId)).toHaveLength(0);
			} else {
				expect((await runTurn(ai, conversationId)).status).toBe('done');
				expect(await checkpoints(conversationId)).toHaveLength(1);
				const summaries = await harness!.database.query(
					`select message from conversation_message where conversation_id = $1 and annotation->>'tag' = 'compact'`,
					[conversationId]
				);
				expect(JSON.stringify(summaries)).toContain('Browser acceptance passed');
				expect(JSON.stringify(summaries)).not.toContain('Partial summary');
			}
			expect(attempts.map((request) => request.maxOutputTokens)).toEqual([4096, 8192]);
			expect(new Set(attempts.map((request) => request.modelId)).size).toBe(1);
			expect(new Set(attempts.map((request) => request.callId)).size).toBe(2);
			const usage = await harness!.database.query(
				'select call_id from turn_usage where call_id = any($1::text[])',
				[attempts.map((request) => request.callId)]
			);
			expect(usage).toHaveLength(2);
		}
	);

	it('preserves original context when checkpoint generation returns no summary', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000c07');
		const ai = successfulAI((_request, index) =>
			index === 0
				? assistantToolCall(
						'describe_workspace',
						{},
						'read-before-empty-compact',
						'Evidence '.repeat(35_000)
					)
				: assistantText('')
		);
		await expect(runTurn(ai, conversationId)).rejects.toThrow('original context is preserved');
		expect(await checkpoints(conversationId)).toHaveLength(0);
		const rows = await harness!.database.query(
			`select count(*)::int as count from conversation_message where conversation_id = $1 and author->>'kind' = 'tool'`,
			[conversationId]
		);
		expect(rows).toEqual([{ count: 1 }]);
	});

	it('continues beyond 64 tool calls until the model completes', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000c05');
		const { ai } = scriptedTranscript([
			...Array.from({ length: 70 }, (_, i) =>
				assistantToolCall('describe_workspace', {}, `loop-${i}`)
			),
			assistantText('Completed all calls.')
		]);
		expect((await runTurn(ai, conversationId)).status).toBe('done');
		const rows = await harness!.database.query(
			`select count(*)::int as count from conversation_message where conversation_id = $1 and author->>'kind' = 'tool'`,
			[conversationId]
		);
		expect(rows).toEqual([{ count: 70 }]);
	});

	it('continues a conversation beyond the first 500 durable messages', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000c08');
		const { ai, requests } = scriptedTranscript([
			assistantText('Initial work complete.'),
			assistantText('Continued from the newest evidence.')
		]);
		await runTurn(ai, conversationId);
		await harness!.database.query(
			`insert into conversation_message (id, conversation_id, sequence, turn_id, author, message, semantic_hash)
			 select gen_random_uuid(), conversation_id, sequence + page.n, turn_id, author,
			 case when page.n = 501 then $2::jsonb else message end, semantic_hash || ':' || page.n
			 from (select * from conversation_message where conversation_id = $1 order by sequence desc limit 1) latest
			 cross join generate_series(1, 501) page(n)`,
			[conversationId, JSON.stringify(assistantText('Evidence beyond the first page: amber-501.'))]
		);
		const agents = await harness!.runtime.runPromise(Agents.Service);
		await harness!.runtime.runPromise(
			agents.submit(harness!.effectId('submit-followup'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Continue from the newest evidence.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		expect(
			(
				await harness!.runtime.runPromise(
					agents.execute(harness!.effectId('execute-followup'), adminSubject, conversationId)
				)
			).status
		).toBe('done');
		expect(JSON.stringify(requests.at(-1)!.messages)).toContain('amber-501');
		expect(JSON.stringify(requests.at(-1)!.messages)).toContain(
			'Continue from the newest evidence.'
		);
		expect(
			await harness!.database.query(
				'select count(*)::int as count, count(distinct sequence)::int as sequences from conversation_message where conversation_id = $1',
				[conversationId]
			)
		).toEqual([{ count: 505, sequences: 505 }]);
	});

	it('gives recovery guidance after repeated errors without stopping the run', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000c06');
		const { ai, requests } = scriptedTranscript([
			...Array.from({ length: 4 }, (_, i) =>
				assistantToolCall('read_skill', { name: 'nonexistent' }, `bad-${i}`)
			),
			assistantToolCall('describe_workspace', {}, 'recovered'),
			assistantText('Recovered and completed.')
		]);
		expect((await runTurn(ai, conversationId)).status).toBe('done');
		expect(
			JSON.stringify(requests.at(-1)!.messages).match(/Three identical read_skill attempts failed/g)
		).toHaveLength(1);
	});

	it('checkpoints on request, well under the model window, and continues the turn', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000c01');
		// The checkpoint generation is answered canned by the fixture and consumes no script entry.
		const { ai, feed, requests } = scriptedTranscript([
			assistantToolCall('compact', { reason: 'The reconciliation is finished.' }, 'compact-1'),
			assistantText('Tidied up.')
		]);
		const result = await runTurn(ai, conversationId);
		expect(result.status).toBe('done');

		// The completed tool exchange is summarized, and remains in the durable history.
		expect(toolResultFor(requests[1]!, 'compact')).toEqual({
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
		expect(compactPrompt.purpose).toBe('compaction');
		expect(compactPrompt.output).toEqual(requests[0]!.output);
		expect(requests[0]!.purpose).toBeUndefined();
		expect(
			requests
				.at(-1)!
				.messages.some(
					(message) =>
						message.role === 'system' &&
						JSON.stringify(message.content).includes('request that produced it has been fulfilled')
				)
		).toBe(true);
		expect(JSON.stringify(compactPrompt.messages.at(-1)?.content)).toContain('Requested Compact:');
		expect(feed.map((step) => step.automaticCompact)).toEqual([false, true, false]);
		expect(feed).toHaveLength(3);
	});

	it('retains the current instruction while summarizing completed work in the same turn', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000c02');
		const { ai, requests } = scriptedTranscript([
			assistantToolCall('compact', { reason: 'Phase one is done.' }, 'compact-1'),
			assistantText('Phase two complete.')
		]);
		expect((await runTurn(ai, conversationId)).status).toBe('done');

		const [checkpoint] = (await checkpoints(conversationId)) as ReadonlyArray<{
			retained: ReadonlyArray<string>;
		}>;
		const thisTurn = (await harness!.database.query(
			`select id from conversation_message
			 where conversation_id = $1 and author->>'kind' = 'agent' and annotation->>'tag' is distinct from 'compact'`,
			[conversationId]
		)) as ReadonlyArray<{ id: string }>;
		expect(checkpoint!.retained).toHaveLength(1);
		expect(checkpoint!.retained).not.toContain(thisTurn[0]!.id);
		expect(JSON.stringify(requests.at(-1)!.messages)).toContain('Reconcile the ledger');
		expect(toolResultFor(requests.at(-1)!, 'compact')).toBeUndefined();
	});

	it('compacts a growing million-token conversation again only after new work accumulates', async () => {
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000c04');
		const { ai, feed, requests } = scriptedTranscript([
			assistantToolCall('describe_workspace', {}, 'large-1', 'x'.repeat(270_000)),
			assistantToolCall('describe_workspace', {}, 'large-2', 'y'.repeat(270_000)),
			assistantText('Finished both phases.')
		]);
		expect((await runTurn(ai, conversationId)).status).toBe('done');
		expect(feed.map((step) => step.automaticCompact)).toEqual([false, true, false, true, false]);
		expect(JSON.stringify(requests.at(-1)!.messages).length).toBeLessThan(20_000);
		expect(await checkpoints(conversationId)).toHaveLength(2);
		expect(new Set(requests.map(({ sessionId }) => sessionId))).toEqual(new Set([conversationId]));
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
