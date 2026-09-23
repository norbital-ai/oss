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
import * as Agents from '../src/runtime/agents/agents.js';
import * as Envoys from '../src/runtime/envoys/envoys.js';
import * as EnvoyInbox from '../src/runtime/envoys/inbox.js';
import * as Channels from '../src/runtime/channels/channels.js';
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
	name: 'envoy-replica',
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
	channels: testChannels('whatsapp'),
	envoys: [
		envoy({
			name: 'field_ops_whatsapp',
			channel: 'whatsapp',
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

const GROUP = '120363000000000000@g.us';
const CONVERSATION = `field_ops_whatsapp:group:${GROUP}`;
/** The replica's key: the agent conversation the chat projects to, which is what a tool reads. */
const REPLICA = Agents.conversationIdFor(`envoy:${CONVERSATION}`);

const groupDelivery = (
	messageId: string,
	sender: string,
	displayName: string,
	text: string,
	overrides: Partial<TestChatDelivery> = {}
): TestChatDelivery => ({
	conversationId: GROUP,
	conversationKind: 'group',
	messageId,
	sentAt: '2026-08-31T04:00:00.000Z',
	invocation: 'ambient',
	text,
	sender: { id: sender, displayName },
	attachments: [],
	...overrides
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const seedSenders = (runtime: BoltTestRuntime) =>
	runtime.database.query(
		`insert into "user" ("id", "name", "email", "tenantId", "channels") values
		 (md5('sam'::text)::uuid, 'Sam', 'sam@example.test', 'test-tenant', $1::jsonb),
		 (md5('alex'::text)::uuid, 'Alex', 'alex@example.test', 'test-tenant', $2::jsonb)`,
		[
			JSON.stringify([{ type: 'whatsapp', address: '+65 9123 4567', verified: true }]),
			JSON.stringify([{ type: 'whatsapp', address: '+65 9876 5432', verified: true }])
		]
	);

describe('Envoy channel replica', () => {
	it('keeps ambient chatter out of the transcript, preempts it, and reads it on demand', async () => {
		const generations: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		const sends: Array<CommunicationRequest> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				generations.push(request);
				return { _tag: 'Success', value: generated(request, 'Noted.') };
			}
		};
		const communication: FacilityBinding<CommunicationRequest, CommunicationResponse> = {
			call: async (_metadata, request) => {
				sends.push(request);
				return {
					_tag: 'Success',
					value: { providerMessageId: `wire-${sends.length}`, body: 'Noted.' }
				};
			}
		};
		harness = await makeBoltTestRuntime(definition, { ai, communication });
		await seedSenders(harness);
		const envoys = await harness.runtime.runPromise(Envoys.Service);

		// Ambient chatter: recorded in the replica, never admitted as a turn.
		expect(
			(
				await harness.runtime.runPromise(
					receiveChat(
						'whatsapp',
						groupDelivery('group-1', '6591234567@s.whatsapp.net', 'Sam', 'Pump is loud.', {
							sentAt: '2026-08-31T03:59:00.000Z'
						})
					, 'ambient')
				)
			).admitted
		).toEqual([]);
		expect(await harness.database.query(`select count(*)::int as count from conversation`)).toEqual(
			[{ count: 0 }]
		);

		const inbox = await harness.runtime.runPromise(EnvoyInbox.Service);
		expect(
			await harness.runtime.runPromise(inbox.unread(harness.effectId('unread'), REPLICA))
		).toBe(1);

		// An addressed message wakes the turn, which carries the unread preempt.
		await harness.runtime.runPromise(
			receiveChat(
						'whatsapp',
				groupDelivery('group-2', '6598765432@s.whatsapp.net', 'Alex', 'Valve is done.', {
					invocation: 'mention'
				})
			)
		);
		expect(
			await harness.runtime.runPromise(
				envoys.drain(harness.effectId('drain'), 'field_ops_whatsapp', CONVERSATION)
			)
		).toMatchObject({ drained: 1, status: 'answered' });
		const prompt = JSON.stringify(generations[0]?.messages);
		expect(prompt).toContain('Valve is done.');
		expect(prompt).not.toContain('Pump is loud.');
		expect(prompt).toContain('1 unread message');
		expect(prompt).toContain('read_messages');

		// The outbound half is written from the receipt, so the replica holds the whole chat.
		expect(sends).toHaveLength(1);
		expect(
			await harness.database.query(
				`select direction, provider_message_id, text from channel_messages order by sent_at, id`
			)
		).toEqual([
			{ direction: 'inbound', provider_message_id: 'group-1', text: 'Pump is loud.' },
			{ direction: 'inbound', provider_message_id: 'group-2', text: 'Valve is done.' },
			{ direction: 'outbound', provider_message_id: 'wire-1', text: 'Noted.' }
		]);

		// Reading marks the batch; a replay of the same call returns the same batch.
		const first = await harness.runtime.runPromise(
			inbox.read(harness.effectId('read:1'), REPLICA, 'call-1', 20)
		);
		expect(first.messages.map(({ text }) => text)).toEqual(['Pump is loud.']);
		expect(first.unreadAfter).toBe(0);
		expect(first.horizon.floorAt).toBe('2026-08-31T03:59:00.000Z');
		const replay = await harness.runtime.runPromise(
			inbox.read(harness.effectId('read:1'), REPLICA, 'call-1', 20)
		);
		expect(replay.messages.map(({ text }) => text)).toEqual(['Pump is loud.']);
		const later = await harness.runtime.runPromise(
			inbox.read(harness.effectId('read:2'), REPLICA, 'call-2', 20)
		);
		expect(later.messages).toEqual([]);
	});

	it('records history as read and edits converging without touching the transcript', async () => {
		const generations: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				generations.push(request);
				return { _tag: 'Success', value: generated(request, 'Noted.') };
			}
		};
		harness = await makeBoltTestRuntime(definition, { ai });
		await seedSenders(harness);
		const envoys = await harness.runtime.runPromise(Envoys.Service);

		expect(
			(
				await harness.runtime.runPromise(
					receiveChat(
						'whatsapp',
						groupDelivery('group-old', '6591234567@s.whatsapp.net', 'Sam', 'Before the link.', {
							historical: true
						})
					, 'history')
				)
			).admitted
		).toEqual([]);
		const inbox = await harness.runtime.runPromise(EnvoyInbox.Service);
		expect(
			await harness.runtime.runPromise(inbox.unread(harness.effectId('unread'), REPLICA))
		).toBe(0);
		expect(
			await harness.database.query(`select count(*)::int as count from conversation_message`)
		).toEqual([{ count: 0 }]);

		await harness.runtime.runPromise(
			receiveChat(
						'whatsapp',
				groupDelivery('group-new', '6598765432@s.whatsapp.net', 'Alex', 'Valve is done.', {
					invocation: 'mention'
				})
			)
		);
		await harness.runtime.runPromise(
			envoys.drain(harness.effectId('drain'), 'field_ops_whatsapp', CONVERSATION)
		);
		const before = await harness.database.query(
			`select id, sequence from conversation_message where state is not null order by sequence`
		);

		expect(
			(
				await harness.runtime.runPromise(
					receiveChat(
						'whatsapp',
						groupDelivery('group-new', '6598765432@s.whatsapp.net', 'Alex', 'Valve is finished.', {
							invocation: 'mention',
							version: '2026-08-31T04:05:00.000Z'
						}),
						'edit'
					)
				)
			).rows.map(({ inserted }) => inserted)
		).toEqual([false]);

		expect(
			await harness.database.query(
				`select text, edited_at is not null as edited from channel_messages where provider_message_id = 'group-new'`
			)
		).toEqual([{ text: 'Valve is finished.', edited: true }]);
		expect(
			await harness.database.query(
				`select id, sequence from conversation_message where state is not null order by sequence`
			)
		).toEqual(before);
		// The edit woke no new turn: the transcript is history, the replica converges.
		expect(generations).toHaveLength(1);
	});

	it('honours a sender delete, even one that arrives before the message it deletes', async () => {
		harness = await makeBoltTestRuntime(definition, {
			communication: recordingCommunication().binding
		});
		await seedSenders(harness);
		const channels = await harness.runtime.runPromise(Channels.Service);
		const inbox = await harness.runtime.runPromise(EnvoyInbox.Service);
		const tombstone = (messageId: string) =>
			harness!.runtime.runPromise(
				channels.ingest(harness!.effectId(`revoke:${messageId}`), 'whatsapp', [{ _tag: 'Tombstone', messageId }], {})
			);

		await harness.runtime.runPromise(
			receiveChat('whatsapp', groupDelivery('said', '6591234567@s.whatsapp.net', 'Sam', 'Wrong valve.'))
		);
		await tombstone('said');
		// Reordered: the revoke is seen first, and the late message lands on a deleted row.
		await tombstone('late');
		await harness.runtime.runPromise(
			receiveChat('whatsapp', groupDelivery('late', '6591234567@s.whatsapp.net', 'Sam', 'Also wrong.'))
		);
		// Duplicated delete: nothing moves twice.
		await tombstone('said');

		expect(
			await harness.database.query(
				`select provider_message_id, text, deleted_at is not null as deleted from channel_messages order by provider_message_id`
			)
		).toEqual([
			{ provider_message_id: 'late', text: '', deleted: true },
			{ provider_message_id: 'said', text: '', deleted: true }
		]);
		const read = await harness.runtime.runPromise(inbox.read(harness.effectId('read'), REPLICA, 'call', 20));
		expect(read.messages).toEqual([]);
	});
});
