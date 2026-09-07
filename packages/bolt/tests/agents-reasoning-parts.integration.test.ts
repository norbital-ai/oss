import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, TaskId } from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { scriptedTranscript } from './agents-canonical-ai-fixture.js';

/**
 * RFC bolt.md B2 / AGENT-UI2, the runtime half. The loop sends no reasoning request, so the run
 * records `reasoning_requested = false` and a provider reasoning part (the literal `None.` GLM and
 * DeepSeek emit when nothing was thought) is dropped before the assistant message is persisted.
 * The client reads the flag off the run row and the transcript never carries the part.
 */
const encode = Schema.encodeSync(Prompt.Message);
const reply = (reasoning: string, text: string): Prompt.MessageEncoded =>
	encode(
		Prompt.assistantMessage({
			content: [Prompt.reasoningPart({ text: reasoning }), Prompt.textPart({ text })]
		})
	);

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

type StoredMessage = Readonly<{ role: string; content: unknown }>;
const storedMessages = async (taskId: TaskId): Promise<ReadonlyArray<StoredMessage>> =>
	(
		await harness!.database.query(
			'select message from agent_message where task_id = $1 order by sequence',
			[taskId]
		)
	).map(({ message }) =>
		typeof message === 'string'
			? (JSON.parse(message) as StoredMessage)
			: (message as StoredMessage)
	);

const partTypes = (message: StoredMessage): ReadonlyArray<string> =>
	Array.isArray(message.content)
		? message.content.map((part: { type: string }) => part.type)
		: ['string'];

describe('reasoning parts through the agent loop (RFC bolt.md B2)', () => {
	it('records that reasoning was not requested and persists no reasoning part', async () => {
		const literal = TaskId.make('00000000-0000-4000-8000-000000000921');
		const worded = TaskId.make('00000000-0000-4000-8000-000000000922');
		const { ai } = scriptedTranscript([
			reply('None.', 'Payroll is balanced.'),
			reply('Considering the ledger before answering.', 'The ledger reconciles.')
		]);
		harness = await makeBoltTestRuntime(testWorkspace(), { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		for (const [name, taskId] of [
			['literal', literal],
			['worded', worded]
		] as const) {
			await harness.runtime.runPromise(
				agents.submit(harness.effectId(`submit:${name}`), adminSubject, {
					taskId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput('Check the payroll.'),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal')
				})
			);
			const settled = await harness.runtime.runPromise(
				agents.execute(harness.effectId(`execute:${name}`), adminSubject, taskId)
			);
			expect(settled.status).toBe('done');
			expect(
				await harness.database.query(
					'select reasoning_requested from agent_run where task_id = $1',
					[taskId]
				)
			).toEqual([{ reasoning_requested: false }]);
		}

		const literalMessages = await storedMessages(literal);
		const literalReplies = literalMessages.filter(({ role }) => role === 'assistant');
		expect(literalReplies).toHaveLength(1);
		expect(partTypes(literalReplies[0]!)).toEqual(['text']);
		expect(JSON.stringify(literalMessages)).not.toContain('None.');
		expect(JSON.stringify(literalMessages)).toContain('Payroll is balanced.');

		const wordedMessages = await storedMessages(worded);
		const wordedReplies = wordedMessages.filter(({ role }) => role === 'assistant');
		expect(wordedReplies).toHaveLength(1);
		expect(partTypes(wordedReplies[0]!)).toEqual(['text']);
		expect(JSON.stringify(wordedMessages)).not.toContain('Considering the ledger');
	});
});
