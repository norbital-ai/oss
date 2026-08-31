import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import type {
	AIRequest,
	AIResponse,
	CommunicationRequest,
	CommunicationResponse,
	FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { envoy, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as Envoys from '../../src/runtime/envoys/envoys.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import { assistantText, assistantToolCall } from '../agents/canonical-ai-fixture.js';

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

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

const modelCatalog: AIResponse = {
	output: {
		defaultModel: 'test-model',
		options: [{ id: 'test-model', contextLength: 128_000 }]
	}
};

const seedSender = (runtime: BoltTestRuntime) =>
	runtime.database.query(
		`insert into "user" ("id", "name", "email", "tenantId", "channels")
		 values (md5('sam'::text)::uuid, 'Sam', 'sam@example.test', 'test-tenant', $1::jsonb)`,
		[JSON.stringify([{ type: 'whatsapp', address: '+65 9123 4567', verified: true }])]
	);

describe('envoy incoming queue and interruption', () => {
	it('edits the active WhatsApp bubble with a queue preview and reads the message next round', async () => {
		let releaseFirstRound!: () => void;
		const firstRoundHeld = new Promise<void>((resolve) => {
			releaseFirstRound = resolve;
		});
		let announceFirstRound!: () => void;
		const firstRoundStarted = new Promise<void>((resolve) => {
			announceFirstRound = resolve;
		});
		const turns: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const sends: Array<CommunicationRequest> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return { _tag: 'Success', value: modelCatalog };
				if (request._tag !== 'Turn') throw new Error('expected an AI turn');
				turns.push(request);
				if (turns.length === 1) {
					announceFirstRound();
					await firstRoundHeld;
					return {
						_tag: 'Success',
						value: { output: assistantToolCall('describe_workspace', {}, 'envoy-describe') }
					};
				}
				return {
					_tag: 'Success',
					value: {
						output: assistantText('Both updates recorded.', `envoy-answer-${turns.length}`)
					}
				};
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
		await harness.runtime.runPromise(
			envoys.receive(
				harness.effectId('receive:first'),
				'field_ops_whatsapp',
				delivery('one', 'Start.')
			)
		);
		const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
		const drain = harness.runtime.runPromise(
			envoys.drain(harness.effectId('drain:first'), 'field_ops_whatsapp', conversationId)
		);
		await firstRoundStarted;

		expect(
			(
				await harness.runtime.runPromise(
					envoys.receive(
						harness.effectId('receive:queued'),
						'field_ops_whatsapp',
						delivery('two', 'Also include the pump reading.')
					)
				)
			).status
		).toBe('buffered');
		expect(sends[1]).toMatchObject({
			_tag: 'Send',
			payload: {
				updateOf: 'wire-1',
				text: expect.stringContaining('Queued · Also include the pump reading.')
			}
		});
		releaseFirstRound();
		await drain;

		expect(turns).toHaveLength(3);
		expect(JSON.stringify(turns[1]?.messages)).not.toContain('Also include the pump reading.');
		expect(JSON.stringify(turns[2]?.messages)).toContain('Also include the pump reading.');
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
	});

	it('treats /steer as explicit preemption and never publishes the stale answer', async () => {
		let releaseInterruptedRound!: () => void;
		const interruptedRoundHeld = new Promise<void>((resolve) => {
			releaseInterruptedRound = resolve;
		});
		let announceInterruptedRound!: () => void;
		const interruptedRoundStarted = new Promise<void>((resolve) => {
			announceInterruptedRound = resolve;
		});
		const turns: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const sends: Array<CommunicationRequest> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Models') return { _tag: 'Success', value: modelCatalog };
				if (request._tag !== 'Turn') throw new Error('expected an AI turn');
				turns.push(request);
				if (turns.length === 1) {
					announceInterruptedRound();
					await interruptedRoundHeld;
					return {
						_tag: 'Success',
						value: { output: assistantText('Stale answer.', 'stale-answer') }
					};
				}
				return {
					_tag: 'Success',
					value: { output: assistantText('Priority handled.', 'priority-answer') }
				};
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
		await harness.runtime.runPromise(
			envoys.receive(
				harness.effectId('receive:first'),
				'field_ops_whatsapp',
				delivery('one', 'Start.')
			)
		);
		const conversationId = 'field_ops_whatsapp:dm:6591234567@s.whatsapp.net';
		const drain = harness.runtime.runPromise(
			envoys.drain(harness.effectId('drain:first'), 'field_ops_whatsapp', conversationId)
		);
		await interruptedRoundStarted;

		await harness.runtime.runPromise(
			envoys.receive(
				harness.effectId('receive:steer'),
				'field_ops_whatsapp',
				delivery('two', '/steer Handle the safety alarm first.')
			)
		);
		expect(sends).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					_tag: 'Send',
					payload: expect.objectContaining({
						updateOf: 'wire-1',
						text: expect.stringContaining('Steering · Handle the safety alarm first.')
					})
				})
			])
		);
		releaseInterruptedRound();
		await drain;
		expect(turns).toHaveLength(2);
		expect(JSON.stringify(turns[1]?.messages)).toContain('Handle the safety alarm first.');
		expect(JSON.stringify(turns[1]?.messages)).not.toContain('/steer');
		expect(sends).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					_tag: 'Send',
					payload: { text: 'Priority handled.', updateOf: 'wire-1' }
				})
			])
		);
		expect(JSON.stringify(sends)).not.toContain('Stale answer.');
		expect(
			await harness.database.query(
				`select status, disposition from agent_run
				 where conversation_id = $1 order by generation`,
				[conversationId]
			)
		).toEqual([
			{ status: 'aborted', disposition: 'superseded' },
			{ status: 'completed', disposition: null }
		]);
	});
});
