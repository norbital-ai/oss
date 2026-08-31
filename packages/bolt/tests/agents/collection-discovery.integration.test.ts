import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest } from '@norbital-ai/bolt-protocol';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as Agents from '../../src/runtime/agents/agents.js';
import {
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCall,
	lastToolResult,
	successfulAI
} from './canonical-ai-fixture.js';

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

describe('agent collection discovery', () => {
	it('does not reveal collection names outside the subject authority', async () => {
		const subject = {
			userId: 'envoy-like-user',
			tenantId: 'test-tenant',
			teamPath: ['field-envoy'],
			policies: []
		};
		const offered: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		let result: Readonly<Record<string, unknown>> | undefined;
		const ai = successfulAI((request, index) => {
			offered.push(request);
			if (index > 0) result = lastToolResult(request);
			return {
				output:
					index === 0
						? assistantToolCall('describe_workspace', {}, 'describe-authority')
						: assistantText('I can work with job assignments.', 'authority-answer')
			};
		});
		harness = await makeBoltTestRuntime(definition, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const admitted = await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('collection-discovery'),
				subject,
				'whatsapp-field',
				'conversation-discovery',
				'collection-discovery-input',
				Agents.userAgentInput('Describe reachable collections')
			)
		);

		expect(admitted.status).toBe('completed');
		expect(offered).toHaveLength(2);
		const offeredSurface = JSON.stringify(offered[0]);
		expect(offeredSurface).toContain('Allowed collections: job_assignments');
		expect(offeredSurface).not.toContain(hiddenCollection);
		expect(result).toMatchObject({ collections: expect.arrayContaining(['job_assignments']) });
		expect(JSON.stringify(result)).not.toContain(hiddenCollection);
	});
});
