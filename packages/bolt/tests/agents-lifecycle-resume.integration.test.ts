import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { afterEach, describe, expect, it } from 'vitest';
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
import { fileURLToPath } from 'node:url';
import { cassetteAi, readCassetteFile } from '@norbital-ai/test-utilities';

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

const submit = (agents: Agents.Interface, runtime: BoltTestRuntime, conversationId: ConversationId, text: string) =>
	agents.submit(runtime.effectId(`submit:${conversationId}`), adminSubject, {
		conversationId,
		agentId: AgentId.make('web'),
		message: Agents.userAgentInput(text),
		mode: DirectiveMode.make('agent'),
		priority: DirectivePriority.make('normal')
	});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('Task stop and run-fence boundaries', () => {
	it('lets stop invalidate an in-flight provider completion before it can persist output', async () => {
		let releaseProvider!: () => void;
		const providerHeld = new Promise<void>((resolve) => (releaseProvider = resolve));
		let announceProvider!: () => void;
		const providerStarted = new Promise<void>((resolve) => (announceProvider = resolve));
		const inner = cassetteAi(cassette('agents-lifecycle-stale'));
		let held = false;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (metadata, request, signal, onProgress) => {
				if (request._tag === 'Generate' && !held) {
					held = true;
					announceProvider();
					return providerHeld.then(() => inner.call(metadata, request, signal, onProgress));
				}
				return inner.call(metadata, request, signal, onProgress);
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make(recordId('task-stop-provider-boundary'));
		await harness.runtime.runPromise(submit(agents, harness, conversationId, 'Start the work.'));

		const running = harness.runtime.runPromise(
			agents.execute(harness.effectId('execute'), adminSubject, conversationId)
		);
		await providerStarted;
		expect(
			await harness.runtime.runPromise(
				agents.control(harness.effectId('stop'), adminSubject, { conversationId, action: 'stop' })
			)
		).toEqual({ conversationId, status: 'stopped' });
		releaseProvider();
		await expect(running).rejects.toMatchObject({ _tag: 'Bolt.TaskRuntime.Error' });

		expect(
			await harness.database.query(
				`select task.status as task_status, run.status as run_status
				 from conversation task join turn run on run.conversation_id = task.id
				 where task.id = $1`,
				[conversationId]
			)
		).toEqual([{ task_status: 'stopped', run_status: 'stopped' }]);
		expect(
			await harness.database.query('select state from conversation_message where conversation_id = $1 and state is not null', [conversationId])
		).toEqual([{ state: 'cancelled' }]);
		expect(
			await harness.database.query(
				`select count(*)::int as count from conversation_message
				 where conversation_id = $1 and author->>'kind' = 'agent'`,
				[conversationId]
			)
		).toEqual([{ count: 0 }]);
	});

	it('settles an interrupted turn as failed with a sentence, instead of leaving it running', async () => {
		let announceProvider!: () => void;
		const providerStarted = new Promise<void>((resolve) => (announceProvider = resolve));
		const inner = cassetteAi(cassette('agents-lifecycle-stale'));
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: (metadata, request, signal, onProgress) => {
				if (request._tag !== 'Generate') return inner.call(metadata, request, signal, onProgress);
				announceProvider();
				// A provider that never answers; the interruption is what ends this call.
				return new Promise(() => undefined);
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make(recordId('task-interrupted-turn'));
		await harness.runtime.runPromise(submit(agents, harness, conversationId, 'Start the work.'));

		const controller = new AbortController();
		const running = harness.runtime.runPromise(
			agents.execute(harness.effectId('execute'), adminSubject, conversationId),
			{ signal: controller.signal }
		);
		await providerStarted;
		controller.abort();
		await expect(running).rejects.toBeDefined();

		expect(
			await harness.database.query(
				`select task.status as task_status, task.active_turn_id, run.status as run_status
				 from conversation task join turn run on run.conversation_id = task.id
				 where task.id = $1`,
				[conversationId]
			)
		).toEqual([{ task_status: 'failed', active_turn_id: null, run_status: 'failed' }]);
		expect(
			await harness.database.query(
				`select message->>'content' as content from conversation_message
				 where conversation_id = $1 and author->>'kind' = 'system'`,
				[conversationId]
			)
		).toEqual([{ content: 'Task failed: The turn was interrupted.' }]);
	});

	it('accepts a follow-up in a stopped conversation without reviving cancelled instructions', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) =>
				request._tag === 'Catalog'
					? { _tag: 'Success', value: catalog }
					: request._tag === 'Generate'
						? { _tag: 'Success', value: generated(request, 'done') }
						: {
								_tag: 'Failure',
								error: {
									code: 'unsupported',
									message: 'embedding is not bound',
									retryable: false,
									outcome: 'known'
								}
							}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make(recordId('task-stopped-admission'));
		await harness.runtime.runPromise(submit(agents, harness, conversationId, 'Initial work.'));
		await harness.runtime.runPromise(
			agents.control(harness.effectId('stop'), adminSubject, { conversationId, action: 'stop' })
		);

		await harness.runtime.runPromise(
			submit(agents, harness, conversationId, 'Continue with this message.')
		);
		expect(
			await harness.database.query(
				'select state from conversation_message where conversation_id = $1 and state is not null order by sequence',
				[conversationId]
			)
		).toEqual([{ state: 'cancelled' }, { state: 'queued' }]);
		expect(
			await harness.runtime.runPromise(
				agents.execute(harness.effectId('follow-up'), adminSubject, conversationId)
			)
		).toMatchObject({ status: 'done' });
	});
});
