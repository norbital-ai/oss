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
import * as Identity from '../../src/runtime/identity/identity.js';
import { fixtureUserId } from '../support/fixture-identity.js';
import { makeBoltTestRuntime } from '../support/bolt-test-layer.js';
import { assistantText } from '../agents/canonical-ai-fixture.js';

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

const delivery = (
	messageId: string,
	senderId = '6591234567@s.whatsapp.net'
): Envoys.EnvoyDelivery => ({
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
				// The catalog is asked for before a turn and is not one. Answered separately, and left
				// out of the record, because every count below is a count of turns the envoy took.
				if (request._tag === 'Models') {
					return {
						_tag: 'Success',
						value: {
							output: {
								defaultModel: 'test-model',
								options: [{ id: 'test-model', contextLength: 128_000 }]
							}
						}
					};
				}
				aiRequests.push(request);
				return {
					_tag: 'Success',
					value: { output: assistantText('Recorded.', `recorded-${aiRequests.length}`) }
				};
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
				return {
					_tag: 'Success',
					value: { receipt: { id: `provider-message-${communicationRequests.length}` } }
				};
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

			expect((await drain('drain:burst')).status).toBe('queued');
			expect(aiRequests).toHaveLength(1);
			expect(communicationRequests).toHaveLength(2);
			expect(communicationRequests[1]).toMatchObject({
				_tag: 'Send',
				payload: { text: 'Recorded.', updateOf: 'provider-message-1' }
			});
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
				`select app_metadata->'inbound' as inbound
				 from chat_message where conversation_id = $1 and role = 'user'`,
				[conversationId]
			);
			expect(stored).toHaveLength(1);
			expect(stored[0]?.inbound).toMatchObject([
					{ messageId: 'message-1', sender: { id: '6591234567@s.whatsapp.net' } },
					{ messageId: 'message-3', text: 'The work is complete.' }
				]);
			expect(
				await harness.database.query(
					`select conversation_id, files from chat_session where conversation_id = $1`,
					[conversationId]
				)
			).toEqual([
				{
					conversation_id: conversationId,
					files: [
						{
							storage_key: write.key,
							file_name: 'whatsapp-message-1.png',
							file_size: 3,
							mime_type: 'image/png'
						}
					]
				}
			]);

			expect((await receive('receive:duplicate', delivery('message-1'))).status).toBe('duplicate');
			expect(fileRequests).toHaveLength(1);
			expect(aiRequests).toHaveLength(1);

			const next = { ...delivery('message-5'), text: 'One more update.', attachments: [] };
			expect((await receive('receive:next', next)).status).toBe('buffered');
			const competing = await Promise.all([drain('drain:race:a'), drain('drain:race:b')]);
			expect(competing.map(({ status }) => status).toSorted()).toEqual(['queued', 'skipped']);
			expect(aiRequests).toHaveLength(2);
			expect(communicationRequests).toHaveLength(4);

			const unknownSender = '6599999999@s.whatsapp.net';
			const unknownGroupMessage = {
				...delivery('message-2', unknownSender),
				conversationId: '120363000000000000@g.us',
				conversationKind: 'group' as const,
				invocation: 'mention' as const,
				text: '@field_ops_whatsapp can you help?',
				attachments: []
			};
			expect((await receive('receive:unknown', unknownGroupMessage)).status).toBe(
				'registration_required'
			);
			expect(
				(await receive('receive:unknown-again', delivery('message-4', unknownSender))).status
			).toBe('registration_required');
			// Each model turn creates then edits one bubble; one capped registration notice follows.
			expect(communicationRequests).toHaveLength(5);
			const registrationNotice = communicationRequests[4];
			expect(registrationNotice).toMatchObject({
				_tag: 'Send',
				channel: 'whatsapp',
				recipient: unknownSender,
				payload: {
					text: 'Register this whatsapp account with test-tenant to continue.',
					registration: { expiresInMinutes: 15 }
				}
			});
			if (registrationNotice?._tag !== 'Send') throw new Error('expected a registration send');
			const registration = Reflect.get(registrationNotice.payload as object, 'registration');
			if (registration === null || typeof registration !== 'object') {
				throw new Error('expected a registration claim');
			}
			const claimId = Reflect.get(registration, 'claimId');
			expect(claimId).toEqual(expect.any(String));
			expect(
				await harness.runtime.runPromise(
					Effect.flatMap(Envoys.Service, (envoys) =>
						envoys.inspectRegistration(harness.effectId('registration:inspect:first'), claimId)
					)
				)
			).toEqual({ state: 'ready', envoy: 'field_ops_whatsapp', transport: 'whatsapp' });
			expect(
				await harness.runtime.runPromise(
					Effect.flatMap(Envoys.Service, (envoys) =>
						envoys.inspectRegistration(harness.effectId('registration:inspect:scanner'), claimId)
					)
				)
			).toEqual({ state: 'ready', envoy: 'field_ops_whatsapp', transport: 'whatsapp' });
			expect(
				await harness.database.query(
					`select sender_id, status,
						(expires_at between now() + interval '14 minutes' and now() + interval '16 minutes') as expires_in_fifteen
					 from bolt_channel_links where link_id = $1`,
					[claimId]
				)
			).toEqual([{ sender_id: '6599999999', status: 'pending', expires_in_fifteen: true }]);
			expect(
				await harness.runtime.runPromise(
					Effect.flatMap(Envoys.Service, (envoys) =>
						envoys.status(harness.effectId('envoy:status'), 'field_ops_whatsapp')
					)
				)
			).toMatchObject({ received: 5, replied: 3 });
			expect(fileRequests).toHaveLength(1);
			expect(aiRequests).toHaveLength(2);
		} finally {
			await harness.dispose();
		}
	});

	it('binds a pending WhatsApp claim to the authenticated tenant identity exactly once', async () => {
		const communicationRequests: Array<CommunicationRequest> = [];
		const communication: FacilityBinding<CommunicationRequest, CommunicationResponse> = {
			call: async (_metadata, request) => {
				communicationRequests.push(request);
				return { _tag: 'Success', value: {} };
			}
		};
		const harness = await makeBoltTestRuntime(definition, { communication });
		try {
			await harness.database.query(
				`insert into "user" ("id", "name", "email", "tenantId")
				 values (md5('ada'::text)::uuid, 'Ada', 'ada@example.test', 'test-tenant')`
			);
			const unknownSender = '6598887777@s.whatsapp.net';
			const received = await harness.runtime.runPromise(
				Effect.flatMap(Envoys.Service, (envoys) =>
					envoys.receive(harness.effectId('registration:receive'), 'field_ops_whatsapp', {
						...delivery('claim-message', unknownSender),
						attachments: [],
						text: 'Hello'
					})
				)
			);
			expect(received.status).toBe('registration_required');
			const notice = communicationRequests[0];
			if (notice?._tag !== 'Send') throw new Error('expected a registration send');
			const registration = Reflect.get(notice.payload as object, 'registration');
			if (registration === null || typeof registration !== 'object') {
				throw new Error('expected a registration claim');
			}
			const claimId = Reflect.get(registration, 'claimId');
			if (typeof claimId !== 'string') throw new Error('expected a registration claim id');
			const subject: Identity.Subject = {
				userId: fixtureUserId('ada'),
				tenantId: 'test-tenant',
				teamPath: [],
				policies: [],
				admin: false,
				email: 'ada@example.test'
			};

			const registered = await harness.runtime.runPromise(
				Effect.flatMap(Envoys.Service, (envoys) =>
					envoys.redeemRegistration(harness.effectId('registration:redeem'), claimId, subject)
				)
			);
			expect(registered).toEqual({
				state: 'registered',
				envoy: 'field_ops_whatsapp',
				transport: 'whatsapp'
			});
			expect(
				await harness.database.query(
					`select channels from "user" where "id" = md5('ada'::text)::uuid`
				)
			).toEqual([
				{
					channels: [{ type: 'whatsapp', address: '6598887777', verified: true }]
				}
			]);
			expect(
				await harness.runtime.runPromise(
					Effect.flatMap(Identity.Service, (identity) =>
						identity.accountByTransportIdentity(
							harness.effectId('registration:identity'),
							'whatsapp',
							unknownSender
						)
					)
				)
			).toEqual({ userId: fixtureUserId('ada'), email: 'ada@example.test' });
			expect(
				await harness.runtime.runPromise(
					Effect.flatMap(Envoys.Service, (envoys) =>
						envoys.inspectRegistration(harness.effectId('registration:after'), claimId)
					)
				)
			).toEqual({ state: 'registered' });
			expect(
				await harness.runtime.runPromise(
					Effect.flatMap(Envoys.Service, (envoys) =>
						envoys.redeemRegistration(harness.effectId('registration:replay'), claimId, subject)
					)
				)
			).toEqual({ state: 'used' });
		} finally {
			await harness.dispose();
		}
	});

	it('refuses expired or already-owned WhatsApp claims without changing either account', async () => {
		const harness = await makeBoltTestRuntime(definition);
		try {
			await harness.database.query(
				`insert into "user" ("id", "name", "email", "tenantId", "channels") values
				 (md5('owner'::text)::uuid, 'Owner', 'owner@example.test', 'test-tenant',
				  '[{"type":"whatsapp","address":"6591112222","verified":true}]'::jsonb),
				 (md5('claimant'::text)::uuid, 'Claimant', 'claimant@example.test', 'test-tenant', '[]'::jsonb)`
			);
			await harness.database.query(
				`insert into bolt_channel_links
					(link_id, tenant_id, envoy, transport, sender_id, status, expires_at) values
				 ('claim-expired', 'test-tenant', 'field_ops_whatsapp', 'whatsapp', '6593334444', 'pending', now() - interval '1 second'),
				 ('claim-conflict', 'test-tenant', 'field_ops_whatsapp', 'whatsapp', '6591112222', 'pending', now() + interval '15 minutes')`
			);
			const claimant: Identity.Subject = {
				userId: fixtureUserId('claimant'),
				tenantId: 'test-tenant',
				teamPath: [],
				policies: [],
				admin: false,
				email: 'claimant@example.test'
			};
			const redeem = (effectId: string, claimId: string) =>
				harness.runtime.runPromise(
					Effect.flatMap(Envoys.Service, (envoys) =>
						envoys.redeemRegistration(harness.effectId(effectId), claimId, claimant)
					)
				);

			expect(await redeem('registration:expired', 'claim-expired')).toEqual({ state: 'expired' });
			expect(await redeem('registration:conflict', 'claim-conflict')).toEqual({
				state: 'conflict'
			});
			expect(
				await harness.database.query(
					`select channels from "user" where "id" = md5('claimant'::text)::uuid`
				)
			).toEqual([{ channels: [] }]);
			expect(
				await harness.database.query(
					`select link_id, status, claimed_by from bolt_channel_links order by link_id`
				)
			).toEqual([
				{ link_id: 'claim-conflict', status: 'pending', claimed_by: null },
				{ link_id: 'claim-expired', status: 'pending', claimed_by: null }
			]);
		} finally {
			await harness.dispose();
		}
	});
});
