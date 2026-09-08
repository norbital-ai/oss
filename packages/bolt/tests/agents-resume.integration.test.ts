import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ModelId,
	ConversationId,
	type AIRequest,
	type AIResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { cassetteAi, cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

const languageModelId = ModelId.make('test:language');
const embeddingModelId = ModelId.make('test:embedding');
const encodeMessage = Schema.encodeSync(Prompt.Message);
const catalog = {
	_tag: 'Catalog',
	languageModels: [{ id: languageModelId, contextWindowTokens: 1_000_000 }],
	defaultLanguageModelId: languageModelId,
	embeddingModels: [{ id: embeddingModelId, contextWindowTokens: 1_000_000 }],
	defaultEmbeddingModelId: embeddingModelId
} satisfies AIResponse;

const generated = (
	request: Extract<AIRequest, { readonly _tag: 'Generate' }>,
	text: string
): Extract<AIResponse, { readonly _tag: 'Generated' }> => {
	if (request.output._tag !== 'Message') throw new Error('expected Message generation');
	return {
		_tag: 'Generated',
		result: {
			_tag: 'Message',
			message: encodeMessage(Prompt.assistantMessage({ content: [Prompt.textPart({ text })] }))
		},
		observation: {
			callId: request.callId,
			provider: 'test',
			model: request.modelId,
			operation: 'language'
		}
	};
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('Task resume control', () => {
	it('creates an explicit durable resume message and executes it as a new turn', async () => {
		const twin = cassetteTranscript(cassette('agents-resume-explicit'));
		const prompts = twin.requests;
		const ai = twin.ai;
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make(recordId('task-explicit-resume'));
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Continue this from durable history.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('queued-followup'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Also retain the queued follow-up.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await harness.runtime.runPromise(
			agents.control(harness.effectId('stop'), adminSubject, { conversationId, action: 'stop' })
		);
		expect(
			await harness.database.query(
				'select state from conversation_message where conversation_id = $1 and state is not null order by sequence',
				[conversationId]
			)
		).toEqual([{ state: 'cancelled' }, { state: 'cancelled' }]);
		expect(
			await harness.runtime.runPromise(
				agents.control(harness.effectId('resume'), adminSubject, { conversationId, action: 'resume' })
			)
		).toEqual({ conversationId, status: 'ready' });

		expect(
			await harness.runtime.runPromise(
				agents.execute(harness.effectId('execute:resume'), adminSubject, conversationId)
			)
		).toMatchObject({ conversationId, status: 'done' });
		expect(JSON.stringify(prompts[0])).toContain('Continue this from durable history.');
		expect(JSON.stringify(prompts[0])).toContain('Resume this Task from its durable transcript');
		expect(JSON.stringify(prompts[0])).toContain('Also retain the queued follow-up.');
		expect(prompts).toHaveLength(1);
		expect(
			await harness.database.query(
				`select task.status, run.status as run_status
				 from conversation task join turn run on run.conversation_id = task.id
				 where task.id = $1`,
				[conversationId]
			)
		).toEqual([{ status: 'done', run_status: 'succeeded' }]);
	});

	it('persists the run failure as a transcript message and resumes from failed', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				return {
					_tag: 'Failure',
					error: {
						code: 'provider_down',
						message: 'PROBE_FAILURE_REASON the model endpoint refused the turn',
						retryable: false,
						outcome: 'known'
					}
				};
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make(recordId('task-failed-resume'));
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Doomed work.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await expect(
			harness.runtime.runPromise(agents.execute(harness.effectId('execute'), adminSubject, conversationId))
		).rejects.toMatchObject({ message: expect.stringContaining('PROBE_FAILURE_REASON') });
		expect(
			await harness.database.query(
				`select task.status, message.author->>'kind' as author, message.message::text as body
				 from conversation task join conversation_message message on message.conversation_id = task.id
				 where task.id = $1 order by message.sequence`,
				[conversationId]
			)
		).toEqual([
			expect.objectContaining({ status: 'failed', author: 'human' }),
			{
				status: 'failed',
				author: 'system',
				body: expect.stringContaining('PROBE_FAILURE_REASON')
			}
		]);
		expect(
			await harness.runtime.runPromise(
				agents.control(harness.effectId('resume'), adminSubject, { conversationId, action: 'resume' })
			)
		).toEqual({ conversationId, status: 'ready' });
	});

	it('refuses resume for a Task that is not stopped or awaiting attention', async () => {
		const ai = cassetteAi(cassette('agents-resume-done'));
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make(recordId('task-invalid-resume'));
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Ready work.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await expect(
			harness.runtime.runPromise(
				agents.control(harness.effectId('resume'), adminSubject, { conversationId, action: 'resume' })
			)
		).rejects.toMatchObject({ _tag: 'Bolt.AccessControl.AccessDenied' });
	});
});
