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

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('Task resume control', () => {
	it('creates an explicit durable resume directive and executes it under a new run epoch', async () => {
		const prompts: Array<ReadonlyArray<unknown>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				prompts.push(request.messages);
				return { _tag: 'Success', value: generated(request, 'Resumed from durable history.') };
			}
		};
		harness = await makeBoltTestRuntime(undefined, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const taskId = TaskId.make(recordId('task-explicit-resume'));
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit'), adminSubject, {
				taskId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Continue this from durable history.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await harness.runtime.runPromise(
			agents.control(harness.effectId('stop'), adminSubject, { taskId, action: 'stop' })
		);
		expect(
			await harness.runtime.runPromise(
				agents.control(harness.effectId('resume'), adminSubject, { taskId, action: 'resume' })
			)
		).toEqual({ taskId, status: 'ready' });

		expect(
			await harness.runtime.runPromise(
				agents.execute(harness.effectId('execute:resume'), adminSubject, taskId)
			)
		).toMatchObject({ taskId, status: 'done' });
		expect(JSON.stringify(prompts[0])).toContain('Continue this from durable history.');
		expect(JSON.stringify(prompts[0])).toContain('Resume this Task from durable epoch');
		expect(
			await harness.database.query(
				`select task.status, task.epoch, run.status as run_status, run.epoch as run_epoch
				 from agent_task task join agent_run run on run.task_id = task.id
				 where task.id = $1`,
				[taskId]
			)
		).toEqual([{ status: 'done', epoch: 1, run_status: 'succeeded', run_epoch: 1 }]);
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
		const taskId = TaskId.make(recordId('task-failed-resume'));
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit'), adminSubject, {
				taskId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Doomed work.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await expect(
			harness.runtime.runPromise(
				agents.execute(harness.effectId('execute'), adminSubject, taskId)
			)
		).rejects.toMatchObject({ message: expect.stringContaining('PROBE_FAILURE_REASON') });
		expect(
			await harness.database.query(
				`select task.status, message.author->>'kind' as author, message.message::text as body
				 from agent_task task join agent_message message on message.task_id = task.id
				 where task.id = $1 order by message.sequence`,
				[taskId]
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
				agents.control(harness.effectId('resume'), adminSubject, { taskId, action: 'resume' })
			)
		).toEqual({ taskId, status: 'ready' });
	});

	it('refuses resume for a Task that is not stopped or awaiting attention', async () => {
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
		const taskId = TaskId.make(recordId('task-invalid-resume'));
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit'), adminSubject, {
				taskId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Ready work.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await expect(
			harness.runtime.runPromise(
				agents.control(harness.effectId('resume'), adminSubject, { taskId, action: 'resume' })
			)
		).rejects.toMatchObject({ _tag: 'Bolt.AccessControl.AccessDenied' });
	});
});
