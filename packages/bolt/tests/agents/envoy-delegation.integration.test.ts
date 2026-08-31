import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest } from '@norbital-ai/bolt-protocol';
import { envoy, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as Agents from '../../src/runtime/agents/agents.js';
import { sandboxToolSpecs } from '../../src/runtime/agents/sandbox-tools.js';
import {
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCall,
	successfulAI
} from './canonical-ai-fixture.js';

const definition = workspace({
	name: 'field-operations',
	version: '1.0.0',
	collections: [],
	apps: [],
	policies: [
		policy({
			name: 'operator',
			effect: 'allow',
			actions: ['agent'],
			capabilities: { apps: ['*'] }
		})
	],
	teams: { operator: ['operator'] },
	automations: [],
	envoys: [
		envoy({
			name: 'ingress',
			transport: 'whatsapp',
			audience: 'authenticated',
			policies: ['operator'],
			task: 'Record field updates.',
			delegation: 'disabled'
		}),
		envoy({
			name: 'desk',
			transport: 'whatsapp',
			audience: 'authenticated',
			policies: ['operator'],
			task: 'Coordinate field support.',
			delegation: 'enabled'
		})
	],
	integrations: [],
	prompt: 'You are the field operations agent.',
	tools: [],
	skills: [],
	requiredFacilities: []
});

const subject = {
	userId: 'operator-1',
	tenantId: 'test-tenant',
	teamPath: ['operator'],
	policies: []
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('envoy delegation boundary', () => {
	it('omits every sandbox tool and terminalizes a disabled envoy requesting one', async () => {
		const requests: Array<Extract<AIRequest, { readonly _tag: 'Turn' }>> = [];
		const ai = successfulAI((request, index) => {
			requests.push(request);
			return {
				output:
					index === 0
						? assistantToolCall(
								'spawn_agent',
								{ task: 'Do work outside this ingress boundary.' },
								'disabled-spawn'
							)
						: assistantText('Handled without delegation.', `answer-${index}`)
			};
		});
		harness = await makeBoltTestRuntime(definition, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const disabled = await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('disabled-envoy-turn'),
				subject,
				'ingress',
				'ingress-conversation',
				'disabled-input',
				Agents.userAgentInput('Handle this envoy turn')
			)
		);
		expect(disabled.status).toBe('completed');

		const sandboxNames = sandboxToolSpecs.map(({ name }) => name);
		const disabledOffer = requests[0]?.tools.map(
			(entry) => (entry as { readonly name: string }).name
		);
		expect(disabledOffer?.filter((name) => sandboxNames.includes(name))).toEqual([]);
		const toolAnswer = requests[1]?.messages.find(
			(message) =>
				typeof message === 'object' &&
				message !== null &&
				(message as { readonly role?: string }).role === 'tool'
		) as { readonly content?: string } | undefined;
		expect(toolAnswer?.content).toContain('spawn_agent');
		expect(toolAnswer?.content?.toLowerCase()).toMatch(/unknown|not (found|allowed)/);
		expect(
			await harness.database.query('select count(*)::int as count from chat_session where parent_id is not null')
		).toEqual([{ count: 0 }]);

		await harness.runtime.runPromise(
			agents.enqueue(
				harness.effectId('enabled-envoy-turn'),
				subject,
				'desk',
				'desk-conversation',
				'enabled-input',
				Agents.userAgentInput('Handle this envoy turn')
			)
		);
		const enabledOffer = requests.at(-1)?.tools.map(
			(entry) => (entry as { readonly name: string }).name
		);
		expect(enabledOffer).toEqual(expect.arrayContaining(sandboxNames));
	});
});
