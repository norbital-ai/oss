import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest } from '@norbital-ai/bolt-protocol';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	TaskId
} from '@norbital-ai/bolt-protocol';
import { envoy, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import { subagentToolSpec } from '../src/runtime/agents/capability-catalog.js';
import {
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCall,
	lastToolResult,
	successfulAI
} from './agents-canonical-ai-fixture.js';

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

const submit = (
	agents: Agents.Interface,
	runtime: BoltTestRuntime,
	taskId: TaskId,
	agentId: 'ingress' | 'desk'
) =>
	runtime.runtime.runPromise(
		agents.submit(runtime.effectId(`${agentId}:submit`), subject, {
			taskId,
			agentId: AgentId.make(agentId),
			message: Agents.userAgentInput('Handle this Task.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);

describe('envoy Task delegation boundary', () => {
	it('fails a disabled subagent aperture closed and admits a child only for an enabled envoy', async () => {
		const requests: Array<Extract<AIRequest, { readonly _tag: 'Generate' }>> = [];
		const ai = successfulAI((request, index) => {
			requests.push(request);
			if (index === 0 || index === 2) {
				return assistantToolCall(
					'subagent',
					{
						action: 'spawn',
						agentId: 'ingress',
						instruction: 'Record the bounded child update.'
					},
					index === 0 ? 'disabled-subagent' : 'enabled-subagent'
				);
			}
			return assistantText('Delegation decision handled.');
		});
		harness = await makeBoltTestRuntime(definition, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const disabledTask = TaskId.make('00000000-0000-4000-8000-000000000601');
		await submit(agents, harness, disabledTask, 'ingress');
		const disabled = await harness.runtime.runPromise(
			agents.execute(harness.effectId('ingress:execute'), subject, disabledTask)
		);
		expect(disabled.status).toBe('done');
		expect(subagentToolSpec.name).toBe('subagent');
		expect(JSON.stringify(lastToolResult(requests[1]!))).toContain('subagent');
		expect(
			await harness.database.query(
				'select count(*)::int as count from agent_task where parent_id = $1',
				[disabledTask]
			)
		).toEqual([{ count: 0 }]);

		const enabledTask = TaskId.make('00000000-0000-4000-8000-000000000602');
		await submit(agents, harness, enabledTask, 'desk');
		const enabled = await harness.runtime.runPromise(
			agents.execute(harness.effectId('desk:execute'), subject, enabledTask)
		);
		expect(enabled.status).toBe('waiting');
		expect(
			await harness.database.query(
				`select parent_id, agent_id, status
				 from agent_task where parent_id = $1`,
				[enabledTask]
			)
		).toEqual([{ parent_id: enabledTask, agent_id: 'ingress', status: 'ready' }]);
	});
});
