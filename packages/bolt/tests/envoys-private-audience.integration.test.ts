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
import { collection, envoy, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Envoys from '../src/runtime/envoys/envoys.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';
import { fixtureUserId, seedSession } from './support/fixture-identity.js';

const languageModelId = ModelId.make('test:language');
const encodeMessage = Schema.encodeSync(Prompt.Message);

/**
 * A `private` envoy: a direct message runs under the member's own team policies, a group under the
 * envoy's. The member's team deliberately does not hold the envoy's policy, so a direct message that
 * still spoke as the envoy — or a member refused the envoy's agent — would both show here.
 */
const definition = workspace({
	name: 'envoy-private-audience',
	version: '1',
	collections: [
		collection({ name: 'projects', fields: { title: field.string({ required: true }) } })
	],
	apps: [],
	policies: [
		policy({
			name: 'desk',
			effect: 'allow',
			capabilities: { apps: [] },
			grants: [{ collection: 'projects', action: 'read' }]
		}),
		policy({
			name: 'sales',
			effect: 'allow',
			capabilities: { apps: [] },
			grants: [{ collection: 'projects', action: 'update', fields: ['title'] }]
		})
	],
	teams: { sales: ['sales'] },
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	automations: [],
	envoys: [
		envoy({
			name: 'sales_desk',
			transport: 'whatsapp',
			audience: 'private',
			policies: ['desk'],
			groupMessages: 'all',
			delegation: 'disabled',
			task: 'Answer the sender.'
		})
	],
	integrations: [],
	requiredFacilities: []
});

const ai: FacilityBinding<AIRequest, AIResponse> = {
	call: async (_metadata, request) => {
		if (request._tag === 'Catalog')
			return {
				_tag: 'Success',
				value: {
					_tag: 'Catalog',
					languageModels: [{ id: languageModelId, contextWindowTokens: 1_000_000 }],
					defaultLanguageModelId: languageModelId,
					embeddingModels: [],
					defaultEmbeddingModelId: languageModelId
				}
			};
		if (request._tag !== 'Generate') throw new Error('expected a generation');
		return {
			_tag: 'Success',
			value: {
				_tag: 'Generated',
				result: {
					_tag: 'Message',
					message: encodeMessage(
						Prompt.assistantMessage({ content: [Prompt.textPart({ text: 'Done.' })] })
					)
				},
				observation: {
					callId: request.callId,
					provider: 'test',
					model: request.modelId,
					operation: 'language'
				}
			}
		};
	}
};
const communication: FacilityBinding<CommunicationRequest, CommunicationResponse> = {
	call: async () => ({ _tag: 'Success', value: { receipt: { id: 'wire' } } })
};

const message = (conversationKind: 'dm' | 'group', conversationId: string, messageId: string) => ({
	conversationId,
	conversationKind,
	messageId,
	sentAt: '2026-09-23T04:00:00.000Z',
	invocation: 'direct' as const,
	text: 'Where is my project?',
	sender: { id: '6591234567@s.whatsapp.net', displayName: 'Sam' },
	attachments: []
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('A private envoy', () => {
	it('runs a direct message as the member and a group as the envoy', async () => {
		harness = await makeBoltTestRuntime(definition, { ai, communication });
		await seedSession(harness, { token: 'sam-token', user: 'sam', team: 'sales' });
		await harness.database.query(`update "user" set "channels" = $1::jsonb where "id" = $2`, [
			JSON.stringify([{ type: 'whatsapp', address: '+65 9123 4567', verified: true }]),
			fixtureUserId('sam')
		]);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		const receive = (kind: 'dm' | 'group', conversationId: string, id: string) =>
			harness!.runtime.runPromise(
				envoys.receive(harness!.effectId(id), 'sales_desk', message(kind, conversationId, id))
			);

		expect((await receive('dm', '6591234567@s.whatsapp.net', 'dm-1')).status).toBe('buffered');
		expect((await receive('group', '120363@g.us', 'group-1')).status).toBe('buffered');

		const subjects = await harness.database.query(
			`select external_message_id, subject from bolt_envoy_messages where direction = 'inbound'`
		);
		const byMessage = Object.fromEntries(
			subjects.map((row) => [
				String(row.external_message_id),
				typeof row.subject === 'string' ? JSON.parse(row.subject) : row.subject
			])
		);
		// Direct: the member's own team authority, never the envoy's, never admin.
		expect(byMessage['dm-1']).toMatchObject({
			userId: fixtureUserId('sam'),
			teamPath: ['sales'],
			policies: [],
			admin: false
		});
		// Group: the envoy's policies, with the member's identity only narrowing.
		expect(byMessage['group-1']).toMatchObject({
			userId: fixtureUserId('sam'),
			teamPath: [],
			policies: ['desk'],
			admin: false
		});

		// The member holds no `desk`, and still runs the envoy's agent in their own direct message.
		expect(
			await harness.runtime.runPromise(
				envoys.drain(
					harness.effectId('drain'),
					'sales_desk',
					'sales_desk:dm:6591234567@s.whatsapp.net'
				)
			)
		).toMatchObject({ drained: 1, status: 'answered' });
	});

	it('refuses an audience the union does not name', () => {
		expect(() =>
			envoy({
				name: 'loose',
				transport: 'whatsapp',
				// @ts-expect-error `members` is not an audience.
				audience: 'members',
				policies: ['desk'],
				delegation: 'disabled',
				task: 'Answer.'
			})
		).toThrow(/unsupported audience/);
	});
});
