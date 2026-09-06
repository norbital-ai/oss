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
import * as AccessControl from '../src/runtime/access/access-control.js';
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

/**
 * The authored shape every transport template ships: a grants-only policy that opens no app and
 * an authenticated envoy declared on it. The `agent` action's app test must not apply here — the
 * envoy is the surface — or the pipeline buffers a contractor's message and never answers it.
 */
const definition = workspace({
	name: 'envoy-grants-policy',
	version: '1',
	collections: [
		collection({ name: 'job_assignments', fields: { status: field.string({ required: true }) } })
	],
	apps: [],
	policies: [
		policy({
			name: 'contractor',
			effect: 'allow',
			capabilities: { apps: [] },
			grants: [{ collection: 'job_assignments', action: 'update', fields: ['status'] }]
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
			delegation: 'disabled',
			task: 'Mutate the supplied assignment.'
		})
	],
	integrations: [],
	requiredFacilities: []
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('Envoy on a grants-only policy', () => {
	it('answers a linked sender although its policy opens no app', async () => {
		const sends: Array<CommunicationRequest> = [];
		const ai: FacilityBinding<AIRequest, AIResponse> = {
			call: async (_metadata, request) => {
				if (request._tag === 'Catalog') return { _tag: 'Success', value: catalog };
				if (request._tag !== 'Generate' || request.output._tag !== 'Message')
					throw new Error('expected a message generation');
				return {
					_tag: 'Success',
					value: {
						_tag: 'Generated',
						result: {
							_tag: 'Message',
							message: encodeMessage(
								Prompt.assistantMessage({ content: [Prompt.textPart({ text: 'Recorded.' })] })
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
			call: async (_metadata, request) => {
				sends.push(request);
				return { _tag: 'Success', value: { receipt: { id: `wire-${sends.length}` } } };
			}
		};
		harness = await makeBoltTestRuntime(definition, { ai, communication });
		await harness.database.query(
			`insert into "user" ("id", "name", "email", "tenantId", "channels")
			 values (md5('sam'::text)::uuid, 'Sam', 'sam@example.test', 'test-tenant', $1::jsonb)`,
			[JSON.stringify([{ type: 'whatsapp', address: '+65 9123 4567', verified: true }])]
		);
		const access = await harness.runtime.runPromise(AccessControl.Service);
		const principal = {
			userId: 'envoy:field_ops_whatsapp',
			tenantId: 'test-tenant',
			teamPath: [],
			policies: ['contractor']
		};
		expect(access.explain(principal, 'agent', 'field_ops_whatsapp').allowed).toBe(true);
		expect(access.explain(principal, 'agent', 'web').allowed).toBe(false);
		expect(access.explain({ ...principal, policies: [] }, 'agent', 'field_ops_whatsapp').allowed).toBe(
			false
		);

		const envoys = await harness.runtime.runPromise(Envoys.Service);
		const received = await harness.runtime.runPromise(
			envoys.receive(harness.effectId('receive'), 'field_ops_whatsapp', {
				conversationId: '6591234567@s.whatsapp.net',
				conversationKind: 'dm',
				messageId: 'one',
				sentAt: '2026-09-06T04:00:00.000Z',
				invocation: 'direct',
				text: 'Assignment done.',
				sender: { id: '6591234567@s.whatsapp.net', displayName: 'Sam' },
				attachments: []
			})
		);
		expect(received.status).toBe('buffered');
		const drained = await harness.runtime.runPromise(
			envoys.drain(
				harness.effectId('drain'),
				'field_ops_whatsapp',
				'field_ops_whatsapp:dm:6591234567@s.whatsapp.net'
			)
		);
		expect(drained).toMatchObject({ drained: 1, status: 'answered' });
		expect(sends).toEqual([
			{
				_tag: 'Send',
				channel: 'whatsapp',
				recipient: '6591234567@s.whatsapp.net',
				payload: { text: 'Recorded.' }
			}
		]);
	});
});
