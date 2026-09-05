import { Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	ModelId,
	TaskSubmitRequest,
	TaskControlRequest,
	type AIRequest,
	type AIResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { assistantText, successfulAI } from './agents-canonical-ai-fixture.js';

const first = ModelId.make('openrouter/provider/first');
const second = ModelId.make('openrouter/provider/second');
const taskId = '00000000-0000-4000-8000-000000000d01';
let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const fixture = async () => {
	const requests: Array<Extract<AIRequest, { _tag: 'Generate' }>> = [];
	let models = [first, second];
	let defaultModel = first;
	const generated = successfulAI((request) => {
		requests.push(request);
		return assistantText('Done.');
	});
	const ai: FacilityBinding<AIRequest, AIResponse> = {
		call: (metadata, request, signal) =>
			request._tag === 'Catalog'
				? Promise.resolve({
						_tag: 'Success',
						value: {
							_tag: 'Catalog',
							languageModels: models.map((id) => ({ id })),
							defaultLanguageModelId: defaultModel,
							embeddingModels: [{ id: first }],
							defaultEmbeddingModelId: first
						}
					})
				: generated.call(metadata, request, signal)
	};
	harness = await makeBoltTestRuntime(undefined, { ai });
	const runtime = harness;
	const agents = await runtime.runtime.runPromise(Agents.Service);
	const submit = (label: string, modelId: string) =>
		runtime.runtime.runPromise(
			agents.submit(
				runtime.effectId(label),
				adminSubject,
				Schema.decodeUnknownSync(TaskSubmitRequest)({
					taskId,
					agentId: 'web',
					message: Agents.userAgentInput(label),
					mode: 'agent',
					priority: 'normal',
					modelId
				})
			)
		);
	const execute = (label: string) =>
		runtime.runtime.runPromise(
			agents.execute(
				runtime.effectId(label),
				adminSubject,
				Schema.decodeUnknownSync(TaskSubmitRequest)({
					taskId,
					agentId: 'web',
					message: Agents.userAgentInput('unused'),
					mode: 'agent',
					priority: 'normal'
				}).taskId
			)
		);
	return {
		runtime,
		agents,
		requests,
		submit,
		execute,
		catalog: (next: Array<ModelId>, selected: ModelId) => {
			models = next;
			defaultModel = selected;
		}
	};
};

describe('per-directive agent model selection', () => {
	it('pins each queued choice and preserves it when the host default changes', async () => {
		const { runtime, requests, submit, execute, catalog } = await fixture();
		const admitted = await submit('use second', second);
		expect((await submit('use second', second)).directiveId).toBe(admitted.directiveId);
		await submit('then use first', first);
		catalog([first, second], second);
		await execute('execute second');
		await execute('execute first');
		expect(requests.map((request) => request.modelId)).toEqual([second, first]);
		expect(
			await runtime.database.query(
				'select model_id from agent_inbox where task_id = $1 order by sequence',
				[taskId]
			)
		).toEqual([{ model_id: second }, { model_id: first }]);
		expect(
			await runtime.database.query(
				'select model_id from agent_run where task_id = $1 order by epoch',
				[taskId]
			)
		).toEqual([{ model_id: second }, { model_id: first }]);
	});

	it('rejects an unregistered choice before writing a task or directive', async () => {
		const { runtime, submit } = await fixture();
		await expect(submit('bad model', 'openrouter/provider/unknown')).rejects.toThrow(/unavailable/);
		expect(await runtime.database.query('select id from agent_task')).toEqual([]);
		expect(await runtime.database.query('select id from agent_inbox')).toEqual([]);
	});

	it('does not silently switch a queued turn when its selected model is removed', async () => {
		const { runtime, requests, submit, execute, catalog } = await fixture();
		await submit('selected second', second);
		catalog([first], first);
		await expect(execute('removed choice')).rejects.toThrow(/unavailable/);
		expect(requests).toEqual([]);
		expect(
			await runtime.database.query('select status from agent_task where id = $1', [taskId])
		).toEqual([{ status: 'attention' }]);
	});

	it('uses the selected recovery model when resuming a stopped task', async () => {
		const { runtime, agents, requests, submit, execute } = await fixture();
		await submit('original first', first);
		const control = (action: 'stop' | 'resume', modelId?: string) =>
			runtime.runtime.runPromise(
				agents.control(
					runtime.effectId(action),
					adminSubject,
					Schema.decodeUnknownSync(TaskControlRequest)({
						taskId,
						action,
						...(modelId ? { modelId } : {})
					})
				)
			);
		await control('stop');
		await control('resume', second);
		await execute('resumed second');
		expect(requests.map((request) => request.modelId)).toEqual([second]);
	});

	it('exposes only configured language models under the agent access policy', async () => {
		const { runtime, agents } = await fixture();
		expect(
			await runtime.runtime.runPromise(
				agents.models(runtime.effectId('catalog'), adminSubject, AgentId.make('web'))
			)
		).toEqual({ languageModels: [{ id: first }, { id: second }], defaultLanguageModelId: first });
		await expect(
			runtime.runtime.runPromise(
				agents.models(
					runtime.effectId('hidden catalog'),
					{ ...adminSubject, admin: false, teamPath: [], policies: [] },
					AgentId.make('web')
				)
			)
		).rejects.toThrow();
	});
});
