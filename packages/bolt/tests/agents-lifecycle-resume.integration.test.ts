import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ModelId,
	TaskId,
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

const languageModelId = ModelId.make('test:language');
const embeddingModelId = ModelId.make('test:embedding');
const encodeMessage = Schema.encodeSync(Prompt.Message);

const catalog = {
	_tag: 'Catalog',
	languageModels: [{ id: languageModelId }],
	defaultLanguageModelId: languageModelId,
	embeddingModels: [{ id: embeddingModelId }],
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

const submit = (agents: Agents.Interface, runtime: BoltTestRuntime, taskId: TaskId, text: string) =>
	agents.submit(runtime.effectId(`submit:${taskId}`), adminSubject, {
		taskId,
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
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				announceProvider();
				await providerHeld;
				return { _tag: 'Success', value: generated(request, 'stale provider answer') };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make(recordId('task-stop-provider-boundary'));
		await harness.runtime.runPromise(submit(agents, harness, taskId, 'Start the work.'));

		const running = harness.runtime.runPromise(
			agents.execute(harness.effectId('execute'), adminSubject, taskId)
		);
		await providerStarted;
		expect(
			await harness.runtime.runPromise(
				agents.control(harness.effectId('stop'), adminSubject, { taskId, action: 'stop' })
			)
		).toEqual({ taskId, status: 'stopped' });
		releaseProvider();
		await expect(running).rejects.toMatchObject({ _tag: 'Bolt.TaskRuntime.Error' });

		expect(
			await harness.database.query(
				`select task.status as task_status, run.status as run_status
				 from agent_task task join agent_run run on run.task_id = task.id
				 where task.id = $1`,
				[taskId]
			)
		).toEqual([{ task_status: 'stopped', run_status: 'stopped' }]);
		expect(
			await harness.database.query('select state from agent_inbox where task_id = $1', [taskId])
		).toEqual([{ state: 'cancelled' }]);
		expect(
			await harness.database.query(
				`select count(*)::int as count from agent_message
				 where task_id = $1 and author->>'kind' = 'agent'`,
				[taskId]
			)
		).toEqual([{ count: 0 }]);
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
		const taskId = TaskId.make(recordId('task-stopped-admission'));
		await harness.runtime.runPromise(submit(agents, harness, taskId, 'Initial work.'));
		await harness.runtime.runPromise(
			agents.control(harness.effectId('stop'), adminSubject, { taskId, action: 'stop' })
		);

		await harness.runtime.runPromise(
			submit(agents, harness, taskId, 'Continue with this message.')
		);
		expect(
			await harness.database.query(
				'select state from agent_inbox where task_id = $1 order by sequence',
				[taskId]
			)
		).toEqual([{ state: 'cancelled' }, { state: 'queued' }]);
		expect(
			await harness.runtime.runPromise(
				agents.execute(harness.effectId('follow-up'), adminSubject, taskId)
			)
		).toMatchObject({ status: 'done' });
	});
});
