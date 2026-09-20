import { afterEach, describe, expect, it } from 'vitest';
import type { AIRequest } from '@norbital-ai/bolt-protocol';
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ConversationId
} from '@norbital-ai/bolt-protocol';
import { envoy, policy, workspace } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import { SUBAGENT_TOOL_NAME } from '../src/runtime/agents/capability-catalog.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';
import { fixtureUserId, seedSession } from './support/fixture-identity.js';
import { bindTaskRunner } from './support/task-runner.js';
import * as Identity from '../src/runtime/identity/identity.js';
import {
	assistantText,
	assistantToolCall,
	lastToolResult,
	scriptedTranscript
} from './agents-canonical-ai-fixture.js';
import { fileURLToPath } from 'node:url';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

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
	conversationId: ConversationId,
	agentId: 'ingress' | 'desk'
) =>
	runtime.runtime.runPromise(
		agents.submit(runtime.effectId(`${agentId}:submit`), subject, {
			conversationId,
			agentId: AgentId.make(agentId),
			message: Agents.userAgentInput('Handle this Task.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);

describe('envoy Task delegation boundary', () => {
	it('fails a disabled subagent aperture closed and admits a child only for an enabled envoy', async () => {
		const twin = cassetteTranscript(cassette('agents-envoy-delegation'));
		const requests = twin.requests;
		harness = await makeBoltTestRuntime(definition, { ai: twin.ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		const disabledTask = ConversationId.make('00000000-0000-4000-8000-000000000601');
		await submit(agents, harness, disabledTask, 'ingress');
		const disabled = await harness.runtime.runPromise(
			agents.execute(harness.effectId('ingress:execute'), subject, disabledTask)
		);
		expect(disabled.status).toBe('done');
		expect(SUBAGENT_TOOL_NAME).toBe('subagent');
		expect(JSON.stringify(lastToolResult(requests[1]!))).toContain('subagent');
		expect(
			await harness.database.query(
				'select count(*)::int as count from conversation where parent_id = $1',
				[disabledTask]
			)
		).toEqual([{ count: 0 }]);
	});

	/**
	 * The open half of the aperture, on an authored transcript rather than the recording.
	 *
	 * The recorded turns are still a truthful account of what the model said, but they are no longer
	 * enough turns: a child is a task of its own and reports back when it settles, so the loop asks
	 * the provider for the child's answer and then for the parent's turn the report wakes. Adding
	 * those to the cassette would be inventing model responses. What this row asserts is ours — that
	 * `desk` may spawn `ingress` at all, and that the child it spawns is a real conversation that runs.
	 */
	it('lets an enabled envoy spawn a child, which runs as its own task and reports back', async () => {
		const { ai } = scriptedTranscript(
			[
				assistantToolCall(
					'subagent',
					{ action: 'spawn', agentId: 'ingress', instruction: 'Record the field update.' },
					'spawn-1'
				),
				assistantText('Child dispatched.'),
				// The parent's next turn, woken by the child's report.
				assistantText('Child result noted.')
			],
			{ children: [assistantText('Field update recorded.')] }
		);
		harness = await makeBoltTestRuntime(definition, { ai });
		// A task resolves its person from the user row, so the operator is a seeded one here.
		await seedSession(harness, { token: 'operator-token', user: 'operator', team: 'operator' });
		const identity = await harness.runtime.runPromise(Identity.Service);
		const operator = await harness.runtime.runPromise(
			identity.resolveUser(harness.effectId('resolve-operator'), fixtureUserId('operator'))
		);
		const runner = bindTaskRunner(harness);
		const agents = await harness.runtime.runPromise(Agents.Service);
		const enabledTask = ConversationId.make('00000000-0000-4000-8000-000000000602');
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('desk:submit'), operator, {
				conversationId: enabledTask,
				agentId: AgentId.make('desk'),
				message: Agents.userAgentInput('Handle this Task.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		const enabled = await harness.runtime.runPromise(
			agents.execute(harness.effectId('desk:execute'), operator, enabledTask)
		);
		expect(enabled.status).toBe('done');
		await runner.settled();
		expect(
			await harness.database.query(
				`select parent_id, agent_id, status from conversation where parent_id = $1`,
				[enabledTask]
			)
		).toEqual([{ parent_id: enabledTask, agent_id: 'ingress', status: 'done' }]);
	});
});
