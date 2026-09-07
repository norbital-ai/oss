import { afterEach, describe, expect, it } from 'vitest';
import { AgentId, DirectiveMode, DirectivePriority, TaskId } from '@norbital-ai/bolt-protocol';
import { envoy } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import {
	assistantText,
	assistantToolCall,
	lastToolFailure,
	scriptedTranscript
} from './agents-canonical-ai-fixture.js';

/**
 * RFC bolt.md B7 through the real loop: the schema the provider is sent enumerates this
 * workspace's spawnable agents, an invented id comes back to the model as a field error on
 * `agentId`, a malformed call as a field error on the missing key, and neither is
 * `ToolNotAllowed` nor an access refusal. No child Task is created by either.
 */
const definition = testWorkspace({
	envoys: [
		envoy({
			name: 'worker',
			transport: 'whatsapp',
			audience: 'authenticated',
			policies: ['admin'],
			task: 'Report field status.',
			delegation: 'disabled'
		})
	]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const advertisedAgentIds = (
	tools: ReadonlyArray<{ readonly name: string; readonly inputSchema: unknown }> | undefined
): ReadonlyArray<string> | undefined => {
	const schema = tools?.find(({ name }) => name === 'subagent')?.inputSchema as
		| { readonly properties?: { readonly agentId?: { readonly enum?: ReadonlyArray<string> } } }
		| undefined;
	return schema?.properties?.agentId?.enum;
};

describe('subagent spawn errors through the agent loop (RFC bolt.md B7)', () => {
	it('advertises the spawnable ids and answers a bad spawn or a malformed call with a field error', async () => {
		const taskId = TaskId.make('00000000-0000-4000-8000-000000000911');
		const { ai, requests } = scriptedTranscript([
			(request) => {
				expect(
					advertisedAgentIds(request.output._tag === 'Message' ? request.output.tools : undefined)
				).toEqual(['web', 'worker']);
				return assistantToolCall(
					'subagent',
					{
						action: 'spawn',
						agentId: 'sg-statutory-law-query',
						instruction: 'Look up the statute.'
					},
					'spawn-1'
				);
			},
			(request) => {
				const failed = lastToolFailure(request);
				expect(failed?.name).toBe('subagent');
				expect(failed?.failure.code).toBe('Bolt.CapabilityCatalog.InvalidToolInput');
				expect(String(failed?.failure.message)).toContain('at "agentId"');
				expect(String(failed?.failure.message)).toContain('"worker"');
				return assistantToolCall('subagent', { action: 'read' }, 'read-1');
			},
			(request) => {
				const failed = lastToolFailure(request);
				expect(failed?.name).toBe('subagent');
				expect(failed?.failure.code).toBe('Bolt.CapabilityCatalog.InvalidToolInput');
				expect(String(failed?.failure.message)).toContain('at "taskId"');
				return assistantText('Nothing to delegate.');
			}
		]);
		harness = await makeBoltTestRuntime(definition, { ai });
		const agents = await harness.runtime.runPromise(Agents.Service);
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit:911'), adminSubject, {
				taskId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Delegate the statute lookup.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		const settled = await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute:911'), adminSubject, taskId)
		);
		expect(settled.status).toBe('done');
		expect(requests).toHaveLength(3);

		const transcript = JSON.stringify(
			await harness.database.query(
				'select message from agent_message where task_id = $1 order by sequence',
				[taskId]
			)
		);
		expect(transcript).toContain('Bolt.CapabilityCatalog.InvalidToolInput');
		expect(transcript).not.toContain('ToolNotAllowed');
		expect(transcript).not.toContain('AccessDenied');
		expect(transcript).not.toContain('invalid-input');
		expect(
			await harness.database.query(
				'select count(*)::int as count from agent_task where parent_id = $1',
				[taskId]
			)
		).toEqual([{ count: 0 }]);
	});
});
