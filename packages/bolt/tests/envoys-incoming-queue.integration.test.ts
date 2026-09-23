import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ModelId,
	type AIRequest,
	type AIResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { envoy, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import * as Envoys from '../src/runtime/envoys/envoys.js';
import { envoySubject, workspaceSubject } from '../src/runtime/identity/static-identity.js';
import * as Collections from '../src/runtime/collections/collections.js';
import {
	adminSubject,
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

const delivery = (messageId: string, text: string): TestChatDelivery => ({
	conversationId: '6591234567@s.whatsapp.net',
	conversationKind: 'dm',
	messageId,
	sentAt: '2026-08-31T04:00:00.000Z',
	invocation: 'direct',
	text,
	sender: { id: '6591234567@s.whatsapp.net', displayName: 'Sam' },
	attachments: []
});

/** What the host mints for a verified sender of this envoy: the declaration's policies, their id. */
const envoySubjectForTest = envoySubject(
	{ name: 'field_ops_whatsapp', policies: ['operator'] },
	'test-tenant',
	{ userId: 'contractor-7' }
);

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

describe('Envoy inbound queue', () => {
	it('queues each message as a steer on the chat conversation and answers the turn once', async () => {
		const generations: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		const { sends, binding: communication } = recordingCommunication();
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				generations.push(request);
				return { _tag: 'Success', value: generated(request, 'Both updates recorded.') };
			}
		};
		harness = await makeBoltTestRuntime(definition, { ai, communication });
		await seedSender(harness);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		expect(
			(
				await harness.runtime.runPromise(
					receiveChat('whatsapp', delivery('one', 'Start.'), 'receive:one')
				)
			).admitted.length
		).toBe(1);
		expect(
			(
				await harness.runtime.runPromise(
					receiveChat('whatsapp', delivery('two', 'Also include the pump reading.'), 'receive:two')
				)
			).admitted.length
		).toBe(1);

		const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
		expect(
			await harness.runtime.runPromise(
				envoys.drain(harness.effectId('drain'), 'field_ops_whatsapp', conversationId)
			)
		).toMatchObject({ drained: 2, status: 'answered' });
		// Both messages are already waiting when the turn starts, so both steer it — no batch window,
		// no second turn, and one answer written from the full picture.
		expect(generations).toHaveLength(1);
		const prompt = JSON.stringify(generations[0]?.messages);
		expect(prompt).toContain('Start.');
		expect(prompt).toContain('Also include the pump reading.');
		expect(sends).toEqual([
			expect.objectContaining({
				_tag: 'Send',
				channel: 'whatsapp',
				message: { to: '6591234567@s.whatsapp.net', text: 'Both updates recorded.' }
			})
		]);
		expect(
			await harness.database.query(
				`select provider_message_id, answered_at is not null as answered from channel_messages
				 where conversation_id = $1 and direction = 'inbound' order by provider_message_id`,
				['6591234567@s.whatsapp.net']
			)
		).toEqual([
			{ provider_message_id: 'one', answered: true },
			{ provider_message_id: 'two', answered: true }
		]);
		// One chat, one conversation — the second message continues the first, it does not open a
		// second one.
		expect(
			await harness.database.query(`select status, agent_id, audience from conversation`)
		).toEqual([{ status: 'done', agent_id: 'field_ops_whatsapp', audience: 'workbench' }]);
		expect(
			await harness.database.query(
				`select priority from conversation_message where state is not null`
			)
		).toEqual([{ priority: 'steer' }, { priority: 'steer' }]);
	});

	it('runs one turn when two drains for the same chat overlap, and answers the next message', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const generations: Array<string> = [];
		const { sends, binding: communication } = recordingCommunication();
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request, _signal, onProgress) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				generations.push(request.callId);
				// Streamed like a real provider: a partial answer lands before the call finishes, and
				// the call is still open when the next message's drain arrives.
				const partial = encodeMessage(
					Prompt.assistantMessage({ content: [Prompt.textPart({ text: 'Hello, how can I help?' })] })
				);
				await onProgress?.(
					Schema.decodeUnknownSync(Schema.Json)({
						callId: request.callId,
						sequence: 0,
						message: partial,
						activeParts: []
					})
				);
				await gate;
				return { _tag: 'Success', value: generated(request, 'Hello, how can I help?') };
			}
		};
		harness = await makeBoltTestRuntime(definition, { ai, communication });
		await seedSender(harness);
		const runtime = harness.runtime;
		const envoys = await runtime.runPromise(Envoys.Service);
		const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
		const drain = (name: string) =>
			runtime.runPromise(
				envoys.drain(harness!.effectId(`drain:${name}`), 'field_ops_whatsapp', conversationId, {
					id: `envoys.drain:${name}`,
					attempt: 1
				})
			);
		const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
		// The host enqueues one drain per message, each under its own task claim; the second
		// message arrives while the first drain's turn is still generating.
		await runtime.runPromise(receiveChat('whatsapp', delivery('one', 'Hello'), 'receive:one'));
		const first = drain('one');
		await settle(300);
		await runtime.runPromise(receiveChat('whatsapp', delivery('two', 'Hello'), 'receive:two'));
		const second = drain('two');
		await settle(300);
		release();
		const settled = await Promise.allSettled([first, second]);
		expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
		// One turn: the drain that did not start it left it to the one that did, and its message
		// steered that turn at the next boundary instead of starting a second executor on it.
		expect(await harness.database.query(`select status from turn`)).toEqual([{ status: 'succeeded' }]);
		expect(await harness.database.query(`select status, active_turn_id from conversation`)).toEqual([
			{ status: 'done', active_turn_id: null }
		]);
		expect(new Set(generations).size).toBe(generations.length);
		expect(
			await harness.database.query(
				`select count(*)::int as failed from conversation_message where message::text like '%Task failed%'`
			)
		).toEqual([{ failed: 0 }]);

		await runtime.runPromise(receiveChat('whatsapp', delivery('three', 'Still there?'), 'receive:three'));
		expect(await drain('three')).toMatchObject({ status: 'answered' });
		expect(sends.length).toBeGreaterThanOrEqual(2);
	});

	it('answers the next message when a failed turn left its id on the conversation', async () => {
		const { sends, binding: communication } = recordingCommunication();
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				return { _tag: 'Success', value: generated(request, 'Back again.') };
			}
		};
		harness = await makeBoltTestRuntime(definition, { ai, communication });
		await seedSender(harness);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
		await harness.runtime.runPromise(receiveChat('whatsapp', delivery('one', 'Hello'), 'receive:one'));
		await harness.runtime.runPromise(
			envoys.drain(harness.effectId('drain:one'), 'field_ops_whatsapp', conversationId)
		);
		// What a failure could leave behind: the conversation settled, still naming its dead turn.
		await harness.database.query(`update turn set status = 'failed'`);
		await harness.database.query(
			`update conversation set status = 'failed', active_turn_id = (select id from turn limit 1)`
		);
		await harness.runtime.runPromise(
			receiveChat('whatsapp', delivery('two', 'Still there?'), 'receive:two')
		);
		expect(
			await harness.runtime.runPromise(
				envoys.drain(harness.effectId('drain:two'), 'field_ops_whatsapp', conversationId)
			)
		).toMatchObject({ status: 'answered' });
		expect(sends.at(-1)).toMatchObject({ message: { text: 'Back again.' } });
	});

	it('refuses a write that restates a turn the conversation no longer holds', async () => {
		harness = await makeBoltTestRuntime(definition, {});
		const conversation = Agents.conversationIdFor('envoy:field_ops_whatsapp:dm:zombie');
		await harness.database.query(
			`insert into conversation (id, workbench_id, subject_id, agent_id, audience, title, status)
			 values ($1, $2, 'contractor-7', 'field_ops_whatsapp', 'workbench', 'z', 'failed')`,
			[conversation, conversation]
		);
		const collections = await harness.runtime.runPromise(Collections.Service);
		// A streamed frame from an executor whose turn was failed under it names that turn and no status.
		await expect(
			harness.runtime.runPromise(
				collections.write(harness.effectId('zombie'), workspaceSubject(adminSubject), [
					{
						collection: 'conversation',
						action: 'update',
						inputs: [{ id: conversation, active_turn_id: '00000000-0000-4000-8000-000000000001' }]
					}
				])
			)
		).rejects.toThrow(/no longer holds the conversation/);
		expect(await harness.database.query(`select active_turn_id from conversation`)).toEqual([
			{ active_turn_id: null }
		]);
	});

	it('keeps one conversation per group channel and lets every linked member steer it', async () => {
		const generations: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		const { sends, binding: communication } = recordingCommunication();
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				generations.push(request);
				return { _tag: 'Success', value: generated(request, 'Group update recorded.') };
			}
		};
		harness = await makeBoltTestRuntime(definition, { ai, communication });
		await harness.database.query(
			`insert into "team" ("id", "name") values (md5('Contractor'::text)::uuid, 'Contractor')`
		);
		// Sam administers the workspace and belongs to no team; Alex is an ordinary contractor.
		await harness.database.query(
			`insert into "user" ("id", "name", "email", "tenantId", "channels", "status", "team_id") values
			 (md5('sam'::text)::uuid, 'Sam', 'sam@example.test', 'test-tenant', $1::jsonb, 'admin', null),
			 (md5('alex'::text)::uuid, 'Alex', 'alex@example.test', 'test-tenant', $2::jsonb, 'normal', md5('Contractor'::text)::uuid)`,
			[
				JSON.stringify([{ type: 'whatsapp', address: '+65 9123 4567', verified: true }]),
				JSON.stringify([{ type: 'whatsapp', address: '+65 9876 5432', verified: true }])
			]
		);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		const groupDelivery = (
			messageId: string,
			sender: string,
			displayName: string,
			text: string
		): TestChatDelivery => ({
			conversationId: '120363000000000000@g.us',
			conversationKind: 'group',
			messageId,
			sentAt: '2026-08-31T04:00:00.000Z',
			invocation: 'mention',
			text,
			sender: { id: sender, displayName },
			attachments: []
		});
		expect(
			(
				await harness.runtime.runPromise(
					receiveChat('whatsapp', groupDelivery('group-1', '6591234567@s.whatsapp.net', 'Sam W.', 'Pump done.'), 'receive:sam')
				)
			).admitted.length
		).toBe(1);
		expect(
			(
				await harness.runtime.runPromise(
					receiveChat('whatsapp', groupDelivery('group-2', '6598765432@s.whatsapp.net', 'Alex T.', 'Valve done.'), 'receive:alex')
				)
			).admitted.length
		).toBe(1);
		const conversationId = 'field_ops_whatsapp:group:120363000000000000@g.us';
		expect(
			await harness.runtime.runPromise(
				envoys.drain(harness.effectId('drain'), 'field_ops_whatsapp', conversationId)
			)
		).toMatchObject({ drained: 2, status: 'answered' });
		// Two linked members, one channel, one conversation, one answer that covers both.
		expect(
			await harness.database.query(`select status, agent_id, audience from conversation`)
		).toEqual([{ status: 'done', agent_id: 'field_ops_whatsapp', audience: 'workbench' }]);
		expect(generations).toHaveLength(1);
		const prompt = JSON.stringify(generations[0]?.messages);
		expect(prompt).toContain('Pump done.');
		expect(prompt).toContain('Valve done.');
		// Each envelope names the workspace account behind the sender's transport address, so the
		// turn reads who it serves instead of resolving a chat nickname against staff.
		// The envelope also states each member's real standing and what their message runs under,
		// so the turn never infers one: an administrator with no team is not a contractor.
		expect(prompt).toContain(
			'registered account: Sam · workspace administrator · no team · policies none'
		);
		expect(prompt).toContain(
			'registered account: Alex · not an administrator · team Contractor · policies none'
		);
		// The channel's own brief rides on an envoy turn, not on the shared one.
		expect(prompt).toContain('Registration is the platform');
		expect(sends).toHaveLength(1);
	});

	it('refuses a subject that does not hold the envoy policy', async () => {
		// The first admission starts the chat's turn, which selects its model from the catalog.
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) =>
				request._tag === 'Catalog'
					? { _tag: 'Success', value: catalog }
					: {
							_tag: 'Failure',
							error: {
								code: 'unsupported',
								message: 'no generation here',
								retryable: false,
								outcome: 'known'
							}
						}
		};
		harness = await makeBoltTestRuntime(definition, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const envoyConversation = Agents.conversationIdFor(
			'envoy:field_ops_whatsapp:dm:6591234567@s.whatsapp.net'
		);
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('envoy-submit'), envoySubjectForTest, {
				conversationId: envoyConversation,
				agentId: AgentId.make('field_ops_whatsapp'),
				message: Agents.userAgentInput('Start.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('steer')
			})
		);
		await expect(
			harness.runtime.runPromise(
				agents.submit(harness.effectId('outsider-submit'), adminSubject, {
					conversationId: envoyConversation,
					agentId: AgentId.make('field_ops_whatsapp'),
					message: Agents.userAgentInput('Another.'),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make('steer')
				})
			)
		).rejects.toMatchObject({ _tag: 'Bolt.AccessControl.AccessDenied' });
	});

	it('deduplicates provider receipts and admits the message text verbatim', async () => {
		const generations: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate') throw new Error('expected language generation');
				generations.push(request);
				return { _tag: 'Success', value: generated(request, 'Safety alarm handled.') };
			}
		};
		const { binding: communication } = recordingCommunication();
		harness = await makeBoltTestRuntime(definition, { ai, communication });
		await seedSender(harness);
		const envoys = await harness.runtime.runPromise(Envoys.Service);
		const text = 'Handle the safety alarm first.';
		expect(
			(
				await harness.runtime.runPromise(
					receiveChat('whatsapp', delivery('priority', text), 'receive:first')
				)
			).admitted.length
		).toBe(1);
		expect(
			(
				await harness.runtime.runPromise(
					receiveChat('whatsapp', delivery('priority', text), 'receive:duplicate')
				)
			).rows.length
		).toBe(0); // a redelivery is the same history row: nothing changes, nothing is admitted
		const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
		await harness.runtime.runPromise(
			envoys.drain(harness.effectId('drain'), 'field_ops_whatsapp', conversationId)
		);
		expect(generations).toHaveLength(1);
		expect(JSON.stringify(generations[0]?.messages)).toContain(text);
		expect(
			await harness.database.query(
				`select priority from conversation_message where state is not null`
			)
		).toEqual([{ priority: 'steer' }]);
	});
});
