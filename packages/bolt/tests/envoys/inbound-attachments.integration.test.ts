import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
	ModelId,
	type AIRequest,
	type AIResponse,
	type CommunicationRequest,
	type CommunicationResponse,
	type FacilityBinding,
	type FileRequest,
	type FileResponse
} from '@norbital-ai/bolt-protocol';
import { envoy, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as Envoys from '../../src/runtime/envoys/envoys.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

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
	name: 'envoy-files',
	version: '1',
	collections: [],
	apps: [],
	policies: [
		policy({
			name: 'contractor',
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
			policies: ['contractor'],
			groupMessages: 'mention_or_reply',
			delegation: 'enabled',
			task: 'Record a contractor update.'
		})
	],
	integrations: [],
	requiredFacilities: []
});

const delivery = (): Envoys.EnvoyDelivery => ({
	conversationId: '6591234567@s.whatsapp.net',
	conversationKind: 'dm',
	messageId: 'message-1',
	sentAt: '2026-08-24T00:21:36.000Z',
	invocation: 'direct',
	text: 'The work is complete.',
	sender: { id: '6591234567@s.whatsapp.net', displayName: 'Sam' },
	attachments: [
		{
			provider: 'whatsapp',
			attachmentId: 'message-1:image:0',
			mimeType: 'image/png',
			fileName: 'whatsapp-message-1.png',
			byteLength: 3,
			bytesBase64: 'iVBO'
		}
	]
});

const seedSender = (runtime: BoltTestRuntime) =>
	runtime.database.query(
		`insert into "user" ("id", "name", "email", "tenantId", "channels")
		 values (md5('sam'::text)::uuid, 'Sam', 'sam@example.test', 'test-tenant', $1::jsonb)`,
		[JSON.stringify([{ type: 'whatsapp', address: '+65 9123 4567', verified: true }])]
	);

const memoryFiles = () => {
	const objects = new Map<string, Uint8Array>();
	const requests: Array<FileRequest> = [];
	const binding: FacilityBinding<FileRequest, FileResponse> = {
		call: async (_metadata, request) => {
			requests.push(request);
			switch (request._tag) {
				case 'Write':
					objects.set(request.key, request.bytes);
					return { _tag: 'Success', value: { key: request.key } };
				case 'Read': {
					const bytes = objects.get(request.key);
					return {
						_tag: 'Success',
						value: { key: request.key, ...(bytes === undefined ? {} : { bytes }) }
					};
				}
				case 'Delete':
					objects.delete(request.key);
					return { _tag: 'Success', value: { key: request.key } };
				case 'List':
					return {
						_tag: 'Success',
						value: { keys: [...objects.keys()].filter((key) => key.startsWith(request.prefix)) }
					};
			}
		}
	};
	return { binding, objects, requests };
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('Envoy Task-scoped attachments', () => {
	it('stages inbound bytes, materializes one Task document, and supplies its descriptor to Generate', async () => {
		const files = memoryFiles();
		const generations: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		const sends: Array<CommunicationRequest> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				generations.push(request);
				return { _tag: 'Success', value: generated(request, 'Recorded.') };
			}
		};
		const communication: FacilityBinding<CommunicationRequest, CommunicationResponse> = {
			call: async (_metadata, request) => {
				sends.push(request);
				return { _tag: 'Success', value: {} };
			}
		};
		harness = await makeBoltTestRuntime(definition, {
			ai,
			communication,
			files: files.binding
		});
		await seedSender(harness);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		await harness.runtime.runPromise(
			envoys.receive(harness.effectId('receive'), 'field_ops_whatsapp', delivery())
		);
		const stagedKey = [...files.objects.keys()][0];
		if (stagedKey === undefined) throw new Error('attachment was not staged');
		expect(stagedKey).toMatch(/^envoy-inbound\//);
		expect(Array.from(files.objects.get(stagedKey) ?? [])).toEqual([137, 80, 78]);

		const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
		expect(
			await harness.runtime.runPromise(
				envoys.drain(harness.effectId('drain'), 'field_ops_whatsapp', conversationId)
			)
		).toMatchObject({ drained: 1, status: 'answered' });
		const request = generations[0];
		if (request === undefined) throw new Error('Envoy Task did not generate');
		expect(request.imageAssets).toEqual([
			expect.objectContaining({
				key: expect.stringMatching(/^agent-tasks\//),
				name: 'whatsapp-message-1.png',
				mimeType: 'image/png',
				size: 3
			})
		]);
		expect(JSON.stringify(request.messages)).toContain('message-1:image:0');
		expect(JSON.stringify(request.messages)).toContain('whatsapp-message-1.png');
		expect(JSON.stringify(request.messages)).not.toContain('iVBO');
		expect(files.objects.has(stagedKey)).toBe(false);
		expect([...files.objects.keys()]).toEqual([
			expect.stringMatching(/^agent-tasks\/.+\/.+\.png$/)
		]);
		expect(sends).toEqual([
			expect.objectContaining({ _tag: 'Send', payload: { text: 'Recorded.' } })
		]);
	});

	it('restores the claimed inbound row when staged bytes disappear before Task admission', async () => {
		const files = memoryFiles();
		let generationCount = 0;
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				generationCount += 1;
				return { _tag: 'Success', value: generated(request, 'Must not run.') };
			}
		};
		harness = await makeBoltTestRuntime(definition, { ai, files: files.binding });
		await seedSender(harness);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		await harness.runtime.runPromise(
			envoys.receive(harness.effectId('receive'), 'field_ops_whatsapp', delivery())
		);
		files.objects.clear();
		const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
		await expect(
			harness.runtime.runPromise(
				envoys.drain(harness.effectId('drain'), 'field_ops_whatsapp', conversationId)
			)
		).rejects.toMatchObject({ _tag: 'Bolt.Envoys.Error' });
		expect(generationCount).toBe(0);
		expect(
			await harness.database.query(
				`select status from bolt_envoy_inbound where conversation_id = $1`,
				[conversationId]
			)
		).toEqual([{ status: 'pending' }]);
		expect(await harness.database.query(`select count(*)::int as count from agent_task`)).toEqual([
			{ count: 0 }
		]);
	});
});
