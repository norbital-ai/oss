import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import type {
	AIRequest,
	AIResponse,
	CommunicationRequest,
	CommunicationResponse,
	FacilityBinding,
	FileRequest,
	FileResponse
} from '@norbital-ai/bolt-protocol';
import { envoy, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as Envoys from '../../src/runtime/envoys/envoys.js';
import { makeBoltTestRuntime } from '../support/bolt-test-layer.js';

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
			task: 'Record a contractor update.'
		})
	],
	integrations: [],
	requiredFacilities: []
});

const delivery = (messageId: string, senderId = '6591234567@s.whatsapp.net') => ({
	conversationId: senderId,
	conversationKind: 'dm' as const,
	messageId,
	sentAt: '2026-08-24T00:21:36.000Z',
	invocation: 'direct' as const,
	text: '',
	sender: { id: senderId, displayName: 'Sam' },
	attachments: [
		{
			provider: 'whatsapp',
			attachmentId: `${messageId}:image:0`,
			mimeType: 'image/png' as const,
			fileName: `whatsapp-${messageId}.png`,
			byteLength: 3,
			bytesBase64: 'iVBO'
		}
	]
});

describe('envoy burst admission and chat documents', () => {
	it('buffers a burst, persists attribution, turns once, and caps registration notices', async () => {
		const aiRequests: Array<AIRequest> = [];
		const fileRequests: Array<FileRequest> = [];
		const communicationRequests: Array<CommunicationRequest> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				aiRequests.push(request);
				return { _tag: 'Success', value: { output: { text: 'Recorded.' } } };
			}
		};
		const files: FacilityBinding<FileRequest, FileResponse> = {
			call: async (_metadata, request) => {
				fileRequests.push(request);
				return { _tag: 'Success', value: 'key' in request ? { key: request.key } : {} };
			}
		};
		const communication: FacilityBinding<CommunicationRequest, CommunicationResponse> = {
			call: async (_metadata, request) => {
				communicationRequests.push(request);
				return { _tag: 'Success', value: {} };
			}
		};
		const harness = await makeBoltTestRuntime(definition, { ai, files, communication });
		try {
			await harness.database.query(
				`insert into "user" ("id", "name", "email", "tenantId", "channels")
				 values (md5('sam'::text)::uuid, 'Sam', 'sam@example.test', 'test-tenant', $1::jsonb)`,
				[JSON.stringify([{ type: 'whatsapp', address: '+65 9123 4567', verified: true }])]
			);
			const receive = (effectId: string, input: ReturnType<typeof delivery>) =>
				harness.runtime.runPromise(
					Effect.flatMap(Envoys.Service, (envoys) =>
						envoys.receive(harness.effectId(effectId), 'field_ops_whatsapp', input)
					)
				);
			const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
			const drain = (effectId: string) =>
				harness.runtime.runPromise(
					Effect.flatMap(Envoys.Service, (envoys) =>
						envoys.drain(harness.effectId(effectId), 'field_ops_whatsapp', conversationId)
					)
				);

			expect((await receive('receive:first', delivery('message-1'))).status).toBe('buffered');
			const textOnly = {
				...delivery('message-3'),
				sentAt: '2026-08-24T00:21:37.000Z',
				text: 'The work is complete.',
				attachments: []
			};
			expect((await receive('receive:text', textOnly)).status).toBe('buffered');
			expect(aiRequests).toHaveLength(0);
			expect(communicationRequests).toHaveLength(0);

			expect(fileRequests).toHaveLength(1);
			const write = fileRequests[0];
			expect(write?._tag).toBe('Write');
			if (write?._tag !== 'Write') throw new Error('expected a file write');
			expect(Array.from(write.bytes)).toEqual([137, 80, 78]);
			expect(write.key).toMatch(/^chat-sessions\/.+\/.+\.png$/);

			expect((await drain('drain:burst')).status).toBe('answered');
			expect(aiRequests).toHaveLength(1);
			expect(communicationRequests).toHaveLength(1);
			const request = aiRequests[0];
			if (request?._tag !== 'Turn') throw new Error('expected an AI turn');
			const context = request.messages
				.map((entry) =>
					entry !== null && typeof entry === 'object' ? Reflect.get(entry, 'content') : ''
				)
				.filter((content): content is string => typeof content === 'string')
				.join('\n');
			expect(context).toContain('INBOUND BATCH');
			expect(context).toContain('message-1');
			expect(context).toContain('2026-08-24T00:21:36.000Z');
			expect(context).toContain('message-1:image:0');
			expect(context).toContain('whatsapp-message-1.png');
			expect(context).toContain('The work is complete.');
			expect(context).not.toContain('iVBO');

			const stored = await harness.database.query(
				`select content from chat_message where conversation_id = $1 and role = 'user'`,
				[conversationId]
			);
			expect(stored).toHaveLength(1);
			expect(stored[0]?.content).toMatchObject({
				kind: 'inbound_batch',
				messages: [
					{ messageId: 'message-1', sender: { id: '6591234567@s.whatsapp.net' } },
					{ messageId: 'message-3', text: 'The work is complete.' }
				]
			});
			expect(
				await harness.database.query(
					`select conversation_id, storage_key from chat_document where storage_key = $1`,
					[write.key]
				)
			).toEqual([{ conversation_id: conversationId, storage_key: write.key }]);

			expect((await receive('receive:duplicate', delivery('message-1'))).status).toBe('duplicate');
			expect(fileRequests).toHaveLength(1);
			expect(aiRequests).toHaveLength(1);

			const next = { ...delivery('message-5'), text: 'One more update.', attachments: [] };
			expect((await receive('receive:next', next)).status).toBe('buffered');
			const competing = await Promise.all([drain('drain:race:a'), drain('drain:race:b')]);
			expect(competing.map(({ status }) => status).toSorted()).toEqual(['answered', 'skipped']);
			expect(aiRequests).toHaveLength(2);
			expect(communicationRequests).toHaveLength(2);

			expect(
				(await receive('receive:unknown', delivery('message-2', '6599999999@s.whatsapp.net')))
					.status
			).toBe('registration_required');
			expect(
				(await receive('receive:unknown-again', delivery('message-4', '6599999999@s.whatsapp.net')))
					.status
			).toBe('registration_required');
			// Two model replies, then one capped registration notice for two unknown messages.
			expect(communicationRequests).toHaveLength(3);
			expect(fileRequests).toHaveLength(1);
			expect(aiRequests).toHaveLength(2);
		} finally {
			await harness.dispose();
		}
	});
});
