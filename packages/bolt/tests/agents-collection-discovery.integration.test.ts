import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest } from '@norbital-ai/bolt-protocol';
import { AgentId, DirectiveMode, DirectivePriority, ConversationId } from '@norbital-ai/bolt-protocol';
import { collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';
import { fileURLToPath } from 'node:url';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';
import { lastToolResult } from './agents-canonical-ai-fixture.js';

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

const hiddenCollection = 'suspicious_activity_logs';
const definition = workspace({
	name: 'least-authority-discovery',
	version: '1',
	collections: [
		collection({ name: 'job_assignments', fields: { title: field.string({ required: true }) } }),
		collection({ name: hiddenCollection, fields: { reason: field.string({ required: true }) } })
	],
	apps: [],
	policies: [
		policy({
			name: 'field-envoy',
			effect: 'allow',
			actions: ['agent'],
			capabilities: { apps: ['*'] },
			grants: [
				{ collection: 'job_assignments', action: 'read' },
				{ collection: 'job_assignments', action: 'update', fields: ['title'] }
			]
		})
	],
	teams: { 'field-envoy': ['field-envoy'] },
	automations: [],
	envoys: [
		{
			name: 'whatsapp-field',
			transport: 'whatsapp',
			audience: 'public',
			policies: ['field-envoy'],
			task: 'Update only the assignment supplied by the sender.',
			delegation: 'disabled'
		}
	],
	integrations: [],
	prompt: 'You are a narrowly scoped field operations assistant.',
	tools: [],
	skills: [],
	requiredFacilities: []
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('Task collection discovery', () => {
	it('returns only collection names inside the Task subject authority', async () => {
		const subject = {
			userId: 'envoy-like-user',
			tenantId: 'test-tenant',
			teamPath: ['field-envoy'],
			policies: []
		};
		const twin = cassetteTranscript(cassette('agents-discovery'));
		const generated = twin.requests;
		harness = await makeBoltTestRuntime(definition, { ai: twin.ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make('00000000-0000-4000-8000-000000000301');
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('collection-discovery:submit'), subject, {
				conversationId,
				agentId: AgentId.make('whatsapp-field'),
				message: Agents.userAgentInput('Describe reachable collections'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		const executed = await harness.runtime.runPromise(
			agents.execute(harness.effectId('collection-discovery:execute'), subject, conversationId)
		);

		expect(executed.status).toBe('done');
		expect(generated).toHaveLength(2);
		const result = lastToolResult(generated[1]!);
		expect(result).toMatchObject({ collections: expect.arrayContaining(['job_assignments']) });
		expect(JSON.stringify(result)).not.toContain(hiddenCollection);
	});
});
