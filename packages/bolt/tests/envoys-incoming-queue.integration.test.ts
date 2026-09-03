import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
	ModelId,
	type AIRequest,
	type AIResponse,
	type CommunicationRequest,
	type CommunicationResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { envoy, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Envoys from '../src/runtime/envoys/envoys.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';

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

const definition = workspace({
	name: 'envoy-incoming-queue',
	version: '1',
	collections: [],
	apps: [],
	policies: [
		policy({
			name: 'operator',
			effect: 'allow',
			actions: ['*'],
			capabilities: { apps: ['*'] }
		})
	],
	teams: {},
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	automations: [],
	envoys: [
		envoy({
			name: 'field_ops_whatsapp',
			transport: 'whatsapp',
			audience: 'authenticated',
			policies: ['operator'],
			groupMessages: 'mention_or_reply',
			delegation: 'enabled',
			task: 'Handle field updates.'
		})
	],
	integrations: [],
	requiredFacilities: []
});

const delivery = (messageId: string, text: string): Envoys.EnvoyDelivery => ({
	conversationId: '6591234567@s.whatsapp.net',
	conversationKind: 'dm',
	messageId,
	sentAt: '2026-08-31T04:00:00.000Z',
	invocation: 'direct',
	text,
	sender: { id: '6591234567@s.whatsapp.net', displayName: 'Sam' },
	attachments: []
});

const seedSender = (runtime: BoltTestRuntime) =>
	runtime.database.query(
		`insert into "user" ("id", "name", "email", "tenantId", "channels")
		 values (md5('sam'::text)::uuid, 'Sam', 'sam@example.test', 'test-tenant', $1::jsonb)`,
		[JSON.stringify([{ type: 'whatsapp', address: '+65 9123 4567', verified: true }])]
	);

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('Envoy inbound Task queue', () => {
	it('claims one deterministic batch, executes one Task, and settles only that batch', async () => {
		const generations: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		const sends: Array<CommunicationRequest> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				generations.push(request);
				return { _tag: 'Success', value: generated(request, 'Both updates recorded.') };
			}
		};
		const communication: FacilityBinding<CommunicationRequest, CommunicationResponse> = {
			call: async (_metadata, request) => {
				sends.push(request);
				return { _tag: 'Success', value: { receipt: { id: `wire-${sends.length}` } } };
			}
		};
		harness = await makeBoltTestRuntime(definition, { ai, communication });
		await seedSender(harness);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		expect(
			(await harness.runtime.runPromise(
				envoys.receive(harness.effectId('receive:one'), 'field_ops_whatsapp', delivery('one', 'Start.'))
			)).status
		).toBe('buffered');
		expect(
			(await harness.runtime.runPromise(
				envoys.receive(
					harness.effectId('receive:two'),
					'field_ops_whatsapp',
					delivery('two', 'Also include the pump reading.')
				)
			)).status
		).toBe('buffered');

		const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
		expect(
			await harness.runtime.runPromise(
				envoys.drain(harness.effectId('drain'), 'field_ops_whatsapp', conversationId)
			)
		).toMatchObject({ drained: 2, status: 'answered' });
		expect(generations).toHaveLength(1);
		const prompt = JSON.stringify(generations[0]?.messages);
		expect(prompt).toContain('INBOUND BATCH');
		expect(prompt).toContain('Start.');
		expect(prompt).toContain('Also include the pump reading.');
		expect(sends).toEqual([
			{
				_tag: 'Send',
				channel: 'whatsapp',
				recipient: '6591234567@s.whatsapp.net',
				payload: { text: 'Both updates recorded.' }
			}
		]);
		expect(
			await harness.database.query(
				`select external_message_id, status from bolt_envoy_inbound
				 where conversation_id = $1 order by external_message_id`,
				[conversationId]
			)
		).toEqual([
			{ external_message_id: 'one', status: 'answered' },
			{ external_message_id: 'two', status: 'answered' }
		]);
		expect(
			await harness.database.query(
				`select status, agent_id, audience from agent_task`
			)
		).toEqual([{ status: 'done', agent_id: 'field_ops_whatsapp', audience: 'workbench' }]);
	});

	it('deduplicates provider receipts and records /steer as Task priority without the command prefix', async () => {
		const generations: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				generations.push(request);
				return { _tag: 'Success', value: generated(request, 'Safety alarm handled.') };
			}
		};
		const communication: FacilityBinding<CommunicationRequest, CommunicationResponse> = {
			call: async () => ({ _tag: 'Success', value: {} })
		};
		harness = await makeBoltTestRuntime(definition, { ai, communication });
		await seedSender(harness);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		const steered = delivery('priority', '/steer Handle the safety alarm first.');
		expect(
			(await harness.runtime.runPromise(
				envoys.receive(harness.effectId('receive:first'), 'field_ops_whatsapp', steered)
			)).status
		).toBe('buffered');
		expect(
			(await harness.runtime.runPromise(
				envoys.receive(harness.effectId('receive:duplicate'), 'field_ops_whatsapp', steered)
			)).status
		).toBe('duplicate');
		const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
		await harness.runtime.runPromise(
			envoys.drain(harness.effectId('drain'), 'field_ops_whatsapp', conversationId)
		);
		expect(JSON.stringify(generations[0]?.messages)).toContain('Handle the safety alarm first.');
		expect(JSON.stringify(generations[0]?.messages)).not.toContain('/steer');
		expect(
			await harness.database.query(`select priority from agent_inbox`)
		).toEqual([{ priority: 'steer' }]);
	});
});
