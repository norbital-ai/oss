import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
	ModelId,
	type AIRequest,
	type AIResponse,
	type FacilityBinding,
	type FileRequest,
	type FileResponse
} from '@norbital-ai/bolt-protocol';
import { envoy, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Envoys from '../src/runtime/envoys/envoys.js';
import {
	makeBoltTestRuntime,
	receiveChat,
	recordingCommunication,
	testChannels,
	type BoltTestRuntime,
	type TestChatDelivery
} from './support/bolt-test-layer.js';

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

const assistantText = (text: string) =>
	encodeMessage(Prompt.assistantMessage({ content: [Prompt.textPart({ text })] }));

const assistantToolCall = (id: string, name: string, params: unknown) =>
	encodeMessage(
		Prompt.assistantMessage({
			content: [Prompt.toolCallPart({ id, name, params, providerExecuted: false })]
		})
	);

const generated = (
	request: Extract<AIRequest, { readonly _tag: 'Generate' }>,
	message: Prompt.MessageEncoded
): Extract<AIResponse, { readonly _tag: 'Generated' }> => {
	if (request.output._tag !== 'Message') throw new Error('expected Message generation');
	return {
		_tag: 'Generated',
		result: {
			_tag: 'Message',
			message
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
	channels: testChannels('whatsapp'),
	envoys: [
		envoy({
			name: 'field_ops_whatsapp',
			channel: 'whatsapp',
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

const delivery = (): TestChatDelivery => ({
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
			kind: 'image',
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

describe('Envoy channel attachments', () => {
	it('materializes inbound bytes at ingest and admits the descriptor through the reader', async () => {
		const files = memoryFiles();
		const generations: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		const { sends, binding: communication } = recordingCommunication();
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				generations.push(request);
				// The reader admits the stored image; every later step reads the answer.
				return {
					_tag: 'Success',
					value:
						generations.length === 1
							? generated(
									request,
									assistantToolCall('read-image', 'read_attachment', {
										key: [...files.objects.keys()][0],
										name: 'whatsapp-message-1.png',
										mimeType: 'image/png',
										size: 3
									})
								)
							: generated(request, assistantText('Recorded.'))
				};
			}
		};
		harness = await makeBoltTestRuntime(definition, {
			ai,
			communication,
			files: files.binding
		});
		await seedSender(harness);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		await harness.runtime.runPromise(receiveChat('whatsapp', delivery()));
		const materialized = [...files.objects.keys()];
		expect(materialized).toEqual([expect.stringMatching(/^agent-tasks\/.+\/.+\.png$/)]);
		expect(Array.from(files.objects.get(materialized[0]!) ?? [])).toEqual([137, 80, 78]);
		expect(
			await harness.database.query(
				`select attachments from channel_messages where direction = 'inbound'`
			)
		).toEqual([
			{
				attachments: [
					{
						provider: 'whatsapp',
						attachmentId: 'message-1:image:0',
						kind: 'image',
						mimeType: 'image/png',
						fileName: 'whatsapp-message-1.png',
						size: 3,
						key: materialized[0]
					}
				]
			}
		]);

		const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
		expect(
			await harness.runtime.runPromise(
				envoys.drain(harness.effectId('drain'), 'field_ops_whatsapp', conversationId)
			)
		).toMatchObject({ drained: 1, status: 'answered' });
		const request = generations[0];
		if (request === undefined) throw new Error('Envoy Task did not generate');
		// A message attaches nothing by itself: its descriptor is text the model reads, and the
		// reader is the one tool that turns a stored object into media for the next step.
		expect(request.imageAssets ?? []).toEqual([]);
		expect(JSON.stringify(request.messages)).toContain(materialized[0]!);
		expect(JSON.stringify(request.messages)).toContain('whatsapp-message-1.png');
		expect(JSON.stringify(request.messages)).not.toContain('iVBO');
		expect(generations[1]?.imageAssets).toEqual([
			expect.objectContaining({
				key: materialized[0],
				name: 'whatsapp-message-1.png',
				mimeType: 'image/png',
				size: 3
			})
		]);
		expect([...files.objects.keys()]).toEqual(materialized);
		expect(sends).toEqual([
			expect.objectContaining({ _tag: 'Send', message: { to: '6591234567@s.whatsapp.net', text: 'Recorded.' } })
		]);
	});

	it('records media the provider could not hand over without failing the turn', async () => {
		const files = memoryFiles();
		const generations: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				generations.push(request);
				return { _tag: 'Success', value: generated(request, assistantText('Recorded.')) };
			}
		};
		const { binding: communication } = recordingCommunication();
		harness = await makeBoltTestRuntime(definition, { ai, communication, files: files.binding });
		await seedSender(harness);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		await harness.runtime.runPromise(
			receiveChat('whatsapp', {
				...delivery(),
				attachments: [
					{
						provider: 'whatsapp',
						attachmentId: 'message-1:image:0',
						kind: 'image',
						mimeType: 'image/png',
						fileName: 'whatsapp-message-1.png',
						byteLength: 3,
						bytesBase64: 'iVBO'
					},
					{
						provider: 'whatsapp',
						attachmentId: 'message-1:video:1',
						kind: 'video',
						mimeType: 'video/mp4',
						fileName: 'clip.mp4',
						byteLength: 4096
					}
				]
			})
		);
		const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
		expect(
			await harness.runtime.runPromise(
				envoys.drain(harness.effectId('drain'), 'field_ops_whatsapp', conversationId)
			)
		).toMatchObject({ drained: 1, status: 'answered' });
		expect(generations[0]?.imageAssets ?? []).toEqual([]);
		// The model hears about the clip it never received, so it can ask for it again.
		expect(JSON.stringify(generations[0]?.messages)).toContain(
			'[attachment clip.mp4 · video/mp4 · not received; ask the sender to send it again]'
		);
		const replicated = await harness.database.query(
			`select attachments from channel_messages where direction = 'inbound'`
		);
		const serialized = JSON.stringify(replicated);
		expect(serialized).toContain('"kind":"video"');
		expect(serialized).toContain('clip.mp4');
		expect(serialized).not.toContain('"key":null');
	});
});
