import { afterEach, describe, expect, it } from 'vitest';
import {
	AgentId,
	ConversationId,
	DirectiveMode,
	DirectivePriority,
	type AIRequest,
	type FacilityCall,
	type HostToolCatalog,
	type HostToolRequest,
	type HostToolResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	scriptedTranscript,
	assistantText,
	assistantToolCall
} from './agents-canonical-ai-fixture.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { fileURLToPath } from 'node:url';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));

const catalog: HostToolCatalog = {
	tools: [
		...[
			['sandbox_bash', false],
			['web_fetch', true],
			['list_personal_skills', true],
			['read_personal_skill', true],
			['save_personal_skill', false]
		].map(([name, readOnly]) => ({
			name: String(name),
			description: 'Scoped capability fixture.',
			inputSchema: { type: 'object', properties: {} },
			readOnly: readOnly === true
		})),
		{
			name: 'workspace_validate',
			description: 'Read-only validation still executes a build.',
			inputSchema: { type: 'object', properties: {} },
			readOnly: true
		},
		{
			name: 'workspace_read',
			description: 'Read private source.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			readOnly: true
		},
		{
			name: 'workspace_apply',
			description: 'Edit private source.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			readOnly: false
		}
	]
};
let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('host capability discovery and execution', () => {
	it('estimates bounded host receipts without compacting their full temporary-file contents', async () => {
		const conversationId = ConversationId.make(recordId('bounded-tool-output'));
		const { ai, feed } = scriptedTranscript([
			assistantToolCall('workspace_read', {}, 'bounded-read'),
			assistantText('Read the bounded receipt.')
		]);
		harness = await makeBoltTestRuntime(undefined, {
			ai,
			hostTools: {
				call: async (_metadata, request) => ({
					_tag: 'Success',
					value: {
						output:
							request.tool === 'capability_catalog'
								? {
										tools: [
											...catalog.tools,
											{
												name: 'agent_output_read',
												description: 'Read bounded receipts.',
												inputSchema: { type: 'object', properties: {} },
												readOnly: true
											}
										]
									}
								: { contents: 'evidence'.repeat(50_000) }
					}
				})
			}
		});
		const agents = await harness.runtime.runPromise(Agents.Service);
		await harness.runtime.runPromise(
			agents.submit(harness.effectId('submit'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Inspect my workspace.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		expect(
			(
				await harness.runtime.runPromise(
					agents.execute(harness.effectId('execute'), adminSubject, conversationId)
				)
			).status
		).toBe('done');
		expect(feed.map(({ automaticCompact }) => automaticCompact)).toEqual([false, false]);
	});

	it.each(['agent', 'plan'] as const)(
		'discovers authorized source tools and enforces %s mode',
		async (mode) => {
			const calls: Array<{ metadata: FacilityCall; request: HostToolRequest }> = [];
			const { ai: twinAi, requests } = cassetteTranscript(cassette('agents-host-agent'));
			const hostTools: FacilityBinding<HostToolRequest, HostToolResponse> = {
				call: async (metadata, request) => {
					calls.push({ metadata, request });
					return {
						_tag: 'Success',
						value: {
							output:
								request.tool === 'capability_catalog'
									? catalog
									: { contents: 'source evidence', commit: 'current' }
						}
					};
				}
			};
			harness = await makeBoltTestRuntime(undefined, {
				hostTools,
				ai: twinAi
			});
			const runtime = harness;
			const agents = await runtime.runtime.runPromise(Agents.Service);
			const conversationId = ConversationId.make(recordId(`host-mode-${mode}`));
			await runtime.runtime.runPromise(
				agents.submit(runtime.effectId('submit'), adminSubject, {
					conversationId,
					agentId: AgentId.make('web'),
					message: Agents.userAgentInput('Inspect my workspace.'),
					mode: DirectiveMode.make(mode),
					priority: DirectivePriority.make('normal')
				})
			);
			await runtime.runtime.runPromise(
				agents.execute(runtime.effectId('execute'), adminSubject, conversationId)
			);
			expect(
				calls
					.filter(({ request }) => request.tool !== 'capability_catalog')
					.map(({ request }) => request.tool)
			).toEqual(mode === 'agent' ? ['workspace_read', 'workspace_apply'] : ['workspace_read']);
			expect(calls.every(({ metadata }) => metadata.subject?.userId === adminSubject.userId)).toBe(
				true
			);
			expect(JSON.stringify(requests[1]?.messages)).toContain('source evidence');
			const first = requests[0];
			expect(first?.output._tag).toBe('Message');
			if (first?.output._tag !== 'Message') throw new Error('Expected tool-capable generation');
			expect(first.output.tools?.some(({ name }) => name === 'workspace_read')).toBe(true);
			for (const tool of ['web_fetch', 'list_personal_skills', 'read_personal_skill'])
				expect(first.output.tools?.some(({ name }) => name === tool)).toBe(true);
			for (const tool of ['sandbox_bash', 'save_personal_skill'])
				expect(first.output.tools?.some(({ name }) => name === tool)).toBe(mode === 'agent');
			expect(first.output.tools?.some(({ name }) => name === 'workspace_validate')).toBe(
				mode === 'agent'
			);
			expect(first.output.tools?.some(({ name }) => name === 'workspace_apply')).toBe(
				mode === 'agent'
			);
			if (mode === 'plan')
				expect(JSON.stringify(requests[2]?.messages)).toContain('workspace_apply');
			const rows = await runtime.database.query(
				'select capability_snapshot from turn where conversation_id = $1',
				[conversationId]
			);
			expect(JSON.stringify(rows)).toContain('host/workspace_read');
			expect(JSON.stringify(rows)).toContain('host/workspace_apply');
		}
	);

	it('rejects a malformed bound catalogue before the provider runs', async () => {
		const twin = cassetteTranscript(cassette('agents-host-agent'));
		harness = await makeBoltTestRuntime(undefined, {
			hostTools: {
				call: async () => ({ _tag: 'Success', value: { output: { unexpected: true } } })
			},
			ai: twin.ai
		});
		const runtime = harness;
		const agents = await runtime.runtime.runPromise(Agents.Service);
		const conversationId = ConversationId.make(recordId('invalid-host-catalog'));
		await runtime.runtime.runPromise(
			agents.submit(runtime.effectId('submit'), adminSubject, {
				conversationId,
				agentId: AgentId.make('web'),
				message: Agents.userAgentInput('Inspect source.'),
				mode: DirectiveMode.make('agent'),
				priority: DirectivePriority.make('normal')
			})
		);
		await expect(
			runtime.runtime.runPromise(
				agents.execute(runtime.effectId('execute'), adminSubject, conversationId)
			)
		).rejects.toThrow();
		expect(twin.requests).toEqual([]);
		expect(
			await runtime.database.query('select id from turn where conversation_id = $1', [
				conversationId
			])
		).toEqual([]);
	});
});
