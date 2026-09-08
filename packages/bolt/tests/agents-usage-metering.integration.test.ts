import { Schema } from 'effect';
import { Prompt, Response } from 'effect/unstable/ai';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { cassetteAi, readCassetteFile } from '@norbital-ai/test-utilities';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ModelId,
	ProviderCallId,
	ConversationId,
	type AIRequest,
	type AIResponse,
	type FacilityBinding,
	type ProviderObservation
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
const encodeUsage = Schema.encodeSync(Response.Usage);
const catalog = {
	_tag: 'Catalog',
	languageModels: [{ id: languageModelId, contextWindowTokens: 1_000_000 }],
	defaultLanguageModelId: languageModelId,
	embeddingModels: [{ id: embeddingModelId, contextWindowTokens: 1_000_000 }],
	defaultEmbeddingModelId: embeddingModelId
} satisfies AIResponse;

const usage = (input: number, output: number) =>
	encodeUsage(
		new Response.Usage({
			inputTokens: {
				uncached: input,
				total: input,
				cacheRead: undefined,
				cacheWrite: undefined
			},
			outputTokens: { total: output, text: output, reasoning: undefined }
		})
	);

const observation = (
	request: Extract<AIRequest, { readonly _tag: 'Generate' }>,
	complete: boolean
): ProviderObservation => ({
	callId: request.callId,
	provider: 'test',
	model: request.modelId,
	operation: 'language',
	usage: usage(10, 4),
	...(complete
		? {
				charge: { currency: 'USD', coefficient: 25n, scale: 6 },
				chargeSource: 'provider' as const,
				pricingVersion: 'provider-receipt-v1'
			}
		: {})
});

const generated = (
	request: Extract<AIRequest, { readonly _tag: 'Generate' }>,
	message: Prompt.MessageEncoded,
	providerObservation: ProviderObservation
): Extract<AIResponse, { readonly _tag: 'Generated' }> => {
	if (request.output._tag !== 'Message') throw new Error('expected Message generation');
	return {
		_tag: 'Generated',
		result: { _tag: 'Message', message },
		observation: providerObservation
	};
};

const text = (value: string) =>
	encodeMessage(Prompt.assistantMessage({ content: [Prompt.textPart({ text: value })] }));
const toolCall = (id: string) =>
	encodeMessage(
		Prompt.assistantMessage({
			content: [
				Prompt.toolCallPart({
					id,
					name: 'describe_workspace',
					params: {},
					providerExecuted: false
				})
			]
		})
	);

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const execute = async (ai: FacilityBinding<AIRequest, AIResponse>, name: string) => {
	harness = await makeBoltTestRuntime(undefined, { ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	const conversationId = ConversationId.make(recordId(`usage-${name}`));
	await harness.runtime.runPromise(
		agents.submit(harness.effectId(`submit:${name}`), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Record provider evidence.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
	return {
		conversationId,
		result: await harness.runtime.runPromise(
			agents.execute(harness.effectId(`execute:${name}`), adminSubject, conversationId)
		)
	};
};

describe('immutable provider observations', () => {
	it('stores one exact pending settlement row for every provider attempt', async () => {
		const ai = cassetteAi(cassette('agents-usage-complete'));
		const { result, conversationId } = await execute(ai, 'complete');
		expect(result).toMatchObject({ conversationId, status: 'done' });
		const runtime = harness;
		if (runtime === undefined) throw new Error('test runtime was not created');
		expect(
			await runtime.database.query(
				`select provider, model, operation, charge, charge_source, pricing_version,
				 settlement_id, settlement_state
				 from turn_usage where turn_id in
				 (select id from turn where conversation_id = $1)
				 order by call_id`,
				[conversationId]
			)
		).toEqual([
			expect.objectContaining({
				provider: 'openrouter',
				model: 'openrouter/z-ai/glm-5.3-flash',
				operation: 'language',
				charge: { currency: 'USD', coefficient: '25', scale: 6 },
				charge_source: 'provider',
				pricing_version: 'provider-receipt-v1',
				settlement_id: expect.stringMatching(/^ai:/),
				settlement_state: 'pending'
			}),
			expect.objectContaining({
				provider: 'openrouter',
				model: 'openrouter/z-ai/glm-5.3-flash',
				operation: 'language',
				charge: { currency: 'USD', coefficient: '25', scale: 6 },
				charge_source: 'provider',
				pricing_version: 'provider-receipt-v1',
				settlement_id: expect.stringMatching(/^ai:/),
				settlement_state: 'pending'
			})
		]);
	});

	it('marks incomplete billing evidence for attention without inventing a charge', async () => {
		const ai = cassetteAi(cassette('agents-usage-incomplete'));
		const { result, conversationId } = await execute(ai, 'incomplete');
		expect(result.status).toBe('done');
		const runtime = harness;
		if (runtime === undefined) throw new Error('test runtime was not created');
		expect(
			await runtime.database.query(
				`select charge, charge_source, pricing_version, settlement_state
				 from turn_usage where turn_id in
				 (select id from turn where conversation_id = $1)`,
				[conversationId]
			)
		).toEqual([
			{ charge: null, charge_source: null, pricing_version: null, settlement_state: 'attention' }
		]);
	});

	it('rejects an observation whose provider call identity does not match the request', async () => {
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				return {
					_tag: 'Success',
					value: generated(request, text('Wrong receipt.'), {
						...observation(request, true),
						callId: ProviderCallId.make('wrong-call')
					})
				};
			}
		};
		await expect(execute(ai, 'wrong-call')).rejects.toMatchObject({
			_tag: 'Bolt.TaskRuntime.Error'
		});
	});
});
