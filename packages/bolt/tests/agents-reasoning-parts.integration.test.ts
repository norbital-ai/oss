import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
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
import { scriptedTranscript, successfulAI } from './agents-canonical-ai-fixture.js';

/**
 * Reasoning is captured, always.
 *
 * The provider reasons whether or not anybody asked — GLM 5.3 Flash refuses to disable it
 * (`400 Reasoning is mandatory for this endpoint`) — so the workspace pays for reasoning on every
 * turn. It used to throw all of it away: a hardcoded flag said reasoning was never requested, and
 * every reasoning part was filtered out before the assistant message was persisted. Now the part
 * the provider already sent is stored in the column that already accepts it, because
 * `ReasoningPart` is a member of Effect's `AssistantMessagePart`.
 *
 * The literal `None.` that GLM and DeepSeek emit when nothing was thought is kept too. It is what
 * the model said, and a transcript that silently edits what the model said is not a transcript.
 * Whether an empty one is *shown* is the renderer's decision, and it is asserted there.
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
const storedMessages = async (
	conversationId: ConversationId
): Promise<ReadonlyArray<StoredMessage>> =>
	(
		await harness!.database.query(
			'select message from conversation_message where conversation_id = $1 order by sequence',
			[conversationId]
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

describe('reasoning parts through the agent loop', () => {
	it.each([false, true])(
		'continues a reasoning-only reply once (repeated: %s)',
		async (repeated) => {
			const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000923');
			let calls = 0;
			const ai = successfulAI((request) => {
				calls += 1;
				expect(request.maxOutputTokens).toBeGreaterThan(2_048);
				return calls === 1 || repeated
					? encode(
							Prompt.assistantMessage({ content: [Prompt.reasoningPart({ text: 'Thinking.' })] })
						)
					: reply('Ready.', 'The ledger reconciles.');
			});
			harness = await makeBoltTestRuntime(testWorkspace(), { ai });
			const agents = await harness.runtime.runPromise(Agents.Service);
			await harness.runtime.runPromise(
				agents.submit(harness.effectId('submit'), adminSubject, {
					conversationId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput('Check the payroll.'),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal')
				})
			);
			const result = harness.runtime.runPromise(
				agents.execute(harness.effectId('execute'), adminSubject, conversationId)
			);
			if (repeated) await expect(result).rejects.toThrow('no answer or tool call');
			else expect((await result).status).toBe('done');
			expect(calls).toBe(2);
			const messages = await storedMessages(conversationId);
			expect(JSON.stringify(messages)).toContain('Your previous generation contained no answer');
		}
	);

	it('persists the reasoning the provider sent, alongside the text', async () => {
		const literal = ConversationId.make('00000000-0000-4000-8000-000000000921');
		const worded = ConversationId.make('00000000-0000-4000-8000-000000000922');
		const { ai } = scriptedTranscript([
			reply('None.', 'Payroll is balanced.'),
			reply('Considering the ledger before answering.', 'The ledger reconciles.')
		]);
		harness = await makeBoltTestRuntime(testWorkspace(), { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		for (const [name, conversationId] of [
			['literal', literal],
			['worded', worded]
		] as const) {
			await harness.runtime.runPromise(
				agents.submit(harness.effectId(`submit:${name}`), adminSubject, {
					conversationId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput('Check the payroll.'),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('normal')
				})
			);
			const settled = await harness.runtime.runPromise(
				agents.execute(harness.effectId(`execute:${name}`), adminSubject, conversationId)
			);
			expect(settled.status).toBe('done');
		}

		const literalMessages = await storedMessages(literal);
		const literalReplies = literalMessages.filter(({ role }) => role === 'assistant');
		expect(literalReplies).toHaveLength(1);
		expect(partTypes(literalReplies[0]!)).toEqual(['reasoning', 'text']);
		expect(JSON.stringify(literalMessages)).toContain('None.');
		expect(JSON.stringify(literalMessages)).toContain('Payroll is balanced.');

		const wordedMessages = await storedMessages(worded);
		const wordedReplies = wordedMessages.filter(({ role }) => role === 'assistant');
		expect(wordedReplies).toHaveLength(1);
		expect(partTypes(wordedReplies[0]!)).toEqual(['reasoning', 'text']);
		expect(JSON.stringify(wordedMessages)).toContain('Considering the ledger');
	});
});
