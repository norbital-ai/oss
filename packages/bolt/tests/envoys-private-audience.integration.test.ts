import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
	ModelId,
	type AIRequest,
	type AIResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { collection, envoy, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Envoys from '../src/runtime/envoys/envoys.js';
import {
	makeBoltTestRuntime,
	receiveChat,
	recordingCommunication,
	testChannels,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { fixtureUserId, seedSession } from './support/fixture-identity.js';
import { assistantToolCall } from './agents-canonical-ai-fixture.js';

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
	channels: testChannels('whatsapp'),
	envoys: [
		envoy({
			name: 'sales_desk',
			channel: 'whatsapp',
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

/**
 * Every tool result the model was handed. The scripted model asks `describe_workspace` first — its
 * answer names the turn's teams and policies — and answers once it has read it, so the recorded
 * result is exactly whose authority the turn carried.
 */
const described: Array<string> = [];
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
		const results = request.messages.filter((message) => message.role === 'tool');
		for (const result of results) described.push(JSON.stringify(result));
		const message =
			results.length === 0
				? assistantToolCall('describe_workspace', {}, `describe-${request.callId}`)
				: encodeMessage(Prompt.assistantMessage({ content: [Prompt.textPart({ text: 'Done.' })] }));
		return {
			_tag: 'Success',
			value: {
				_tag: 'Generated',
				result: { _tag: 'Message', message },
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
		harness = await makeBoltTestRuntime(definition, {
			ai,
			communication: recordingCommunication().binding
		});
		await seedSession(harness, { token: 'sam-token', user: 'sam', team: 'sales' });
		await harness.database.query(`update "user" set "channels" = $1::jsonb where "id" = $2`, [
			JSON.stringify([{ type: 'whatsapp', address: '+65 9123 4567', verified: true }]),
			fixtureUserId('sam')
		]);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		const receive = (kind: 'dm' | 'group', conversationId: string, id: string) =>
			harness!.runtime.runPromise(receiveChat('whatsapp', message(kind, conversationId, id)));
		const drain = (label: string, conversation: string) =>
			harness!.runtime.runPromise(envoys.drain(harness!.effectId(label), 'sales_desk', conversation));

		expect((await receive('dm', '6591234567@s.whatsapp.net', 'dm-1')).admitted).toEqual(['dm-1']);
		expect((await receive('group', '120363@g.us', 'group-1')).admitted).toEqual(['group-1']);

		// Direct: the member's own team authority (`sales` may update projects), never the envoy's —
		// and the member holds no `desk`, yet still runs the envoy's agent in their own direct message.
		described.length = 0;
		expect(await drain('drain-dm', 'sales_desk:dm:6591234567@s.whatsapp.net')).toMatchObject({
			drained: 1,
			status: 'answered'
		});
		// The member's session holds no declared policy of its own: the envoy's `desk` is absent.
		expect(described.join('\n')).toContain('describe_workspace');
		expect(described.join('\n')).not.toContain('policies desk');
		// Group: the envoy's policies (`desk` only reads), with the member's identity only narrowing.
		described.length = 0;
		expect(await drain('drain-group', 'sales_desk:group:120363@g.us')).toMatchObject({
			drained: 1,
			status: 'answered'
		});
		expect(described.join('\n')).toContain('policies desk');
	});

	it('refuses an audience the union does not name', () => {
		expect(() =>
			envoy({
				name: 'loose',
				channel: 'whatsapp',
				// @ts-expect-error `members` is not an audience.
				audience: 'members',
				policies: ['desk'],
				delegation: 'disabled',
				task: 'Answer.'
			})
		).toThrow(/unsupported audience/);
	});
});
