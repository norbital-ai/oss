import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	ConversationId,
	DirectiveMode,
	DirectivePriority,
	type HostToolCatalog
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import { AGENT_BOUNDS } from '../src/runtime/agents/agents.js';
import {
	assistantText,
	assistantToolCall,
	scriptedTranscript,
	toolResultFor
} from './agents-canonical-ai-fixture.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * Nothing waits forever, and the person is never behind a guest process: a host tool that outlasts
 * its inline bound comes back as a job, `wait` collects it, and a wait ends early when the person
 * writes.
 */
const catalog: HostToolCatalog = {
	tools: [
		{
			name: 'slow_probe',
			description: 'A host call that takes longer than the inline bound.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			readOnly: true
		}
	]
};

let harness: BoltTestRuntime | undefined;
const bounds = { ...AGENT_BOUNDS };
afterEach(async () => {
	Object.assign(AGENT_BOUNDS, bounds);
	await harness?.dispose();
	harness = undefined;
});

const sleep = (millis: number) => new Promise<void>((resolve) => setTimeout(resolve, millis));

describe('bounded tool calls and waits', () => {
	it('turns a slow host call into a job and collects it with wait', async () => {
		Object.assign(AGENT_BOUNDS, { toolInlineMillis: 100, waitTickMillis: 20 });
		const conversationId = ConversationId.make(recordId('bounded-wait-job'));
		const { ai, requests } = scriptedTranscript([
			assistantToolCall('slow_probe', {}, 'probe'),
			assistantToolCall('wait', { timeoutSeconds: 5 }, 'collect'),
			assistantText('Collected.')
		]);
		harness = await makeBoltTestRuntime(undefined, {
			ai,
			hostTools: {
				call: async (_metadata, request) => {
					if (request.tool !== 'capability_catalog') await sleep(400);
					return {
						_tag: 'Success',
						value: {
							output: request.tool === 'capability_catalog' ? catalog : { probed: true }
						}
					};
				}
			}
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Probe the host.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		const result = await harness.runtime.runPromise(
			agents.execute(harness.effectId('execute'), adminSubject, conversationId)
		);
		expect(result.status).toBe('done');
		expect(toolResultFor(requests[1]!, 'slow_probe')).toMatchObject({
			job: 'probe',
			tool: 'slow_probe',
			state: 'running'
		});
		expect(toolResultFor(requests[2]!, 'wait')).toMatchObject({
			reason: 'settled',
			jobs: [{ job: 'probe', tool: 'slow_probe', failed: false, result: { probed: true } }],
			running: { jobs: [], conversations: [] }
		});
	});

	it('ends a wait when the person writes, and at its bound when nothing happens', async () => {
		Object.assign(AGENT_BOUNDS, { toolInlineMillis: 100, waitTickMillis: 20 });
		const conversationId = ConversationId.make(recordId('bounded-wait-steer'));
		const { ai, requests } = scriptedTranscript([
			assistantToolCall('slow_probe', {}, 'probe'),
			assistantToolCall('wait', { timeoutSeconds: 5 }, 'first-wait'),
			assistantText('Heard you.'),
			// Finishing with a job uncollected is refused once; the model collects it, then waits on
			// a job that does not exist and gets the bound.
			assistantToolCall('wait', { timeoutSeconds: 5, jobs: ['probe'] }, 'collect'),
			assistantToolCall('wait', { timeoutSeconds: 1, jobs: ['never'] }, 'second-wait'),
			assistantText('Nothing came.')
		]);
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		harness = await makeBoltTestRuntime(undefined, {
			ai,
			hostTools: {
				call: async (_metadata, request) => {
					if (request.tool !== 'capability_catalog') await held;
					return {
						_tag: 'Success',
						value: { output: request.tool === 'capability_catalog' ? catalog : { probed: true } }
					};
				}
			}
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		const submit = (text: string, priority: 'normal' | 'steer', name: string) =>
			harness!.runtime.runPromise(
				agents.submit(harness!.effectId(name), adminSubject, {
					conversationId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput(text),
					mode: DirectiveMode.make('agent'),
					priority: DirectivePriority.make(priority)
				})
			);
		await submit('Probe the host.', 'normal', 'submit');
		const executing = harness.runtime.runPromise(
			agents.execute(harness.effectId('execute'), adminSubject, conversationId)
		);
		// The person writes while the agent waits on a job that has not finished.
		await sleep(300);
		await submit('Are you there?', 'steer', 'steer');
		await sleep(300);
		release();
		const result = await executing;
		expect(result.status).toBe('done');
		expect(toolResultFor(requests[2]!, 'wait')).toMatchObject({ reason: 'message' });
		expect(toolResultFor(requests[4]!, 'wait')).toMatchObject({
			reason: 'settled',
			jobs: [{ job: 'probe' }]
		});
		expect(toolResultFor(requests[5]!, 'wait')).toMatchObject({ reason: 'timeout' });
	});
});
