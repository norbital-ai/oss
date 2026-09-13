import { Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { cassetteTranscript, readCassetteFile } from '@norbital-ai/test-utilities';

const cassette = (name: string) =>
	readCassetteFile(fileURLToPath(new URL(`./assets/${name}.cassette.json`, import.meta.url)));
import {
	AgentId,
	DirectiveMode,
	DirectivePriority,
	ModelId,
	ConversationId,
	type AIRequest,
	type AIResponse,
	type FacilityBinding,
	type HostToolRequest,
	type HostToolResponse
} from '@norbital-ai/bolt-protocol';
import { tool } from '../src/authoring/workspace-schema.js';
import * as Agents from '../src/runtime/agents/agents.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	testWorkspace,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

const languageModelId = ModelId.make('test:language');
const embeddingModelId = ModelId.make('test:embedding');
const encodeMessage = Schema.encodeSync(Prompt.Message);
const catalog = {
	_tag: 'Catalog',
	languageModels: [{ id: languageModelId, contextWindowTokens: 1_000_000 }],
	defaultLanguageModelId: languageModelId,
	embeddingModels: [{ id: embeddingModelId, contextWindowTokens: 1_000_000 }],
	defaultEmbeddingModelId: embeddingModelId
} satisfies AIResponse;

const assistantText = (text: string) =>
	encodeMessage(Prompt.assistantMessage({ content: [Prompt.textPart({ text })] }));

const assistantToolCall = (id: string, name: string, params: unknown) =>
	encodeMessage(
		Prompt.assistantMessage({
			content: [Prompt.toolCallPart({ id, name, params, providerExecuted: false })]
		})
	);

const generated = (
	request: Extract<AIRequest, { readonly _tag: 'Generate' }>,
	message: Prompt.MessageEncoded
): Extract<AIResponse, { readonly _tag: 'Generated' }> => {
	if (request.output._tag !== 'Message') throw new Error('expected Message generation');
	return {
		_tag: 'Generated',
		result: { _tag: 'Message', message },
		observation: {
			callId: request.callId,
			provider: 'test',
			model: request.modelId,
			operation: 'language'
		}
	};
};

const lastToolResult = (request: Extract<AIRequest, { readonly _tag: 'Generate' }>): unknown => {
	for (const message of request.messages.toReversed()) {
		if (message.role !== 'tool' || typeof message.content === 'string') continue;
		const result = message.content.findLast((part) => part.type === 'tool-result');
		if (result?.type === 'tool-result') return result.result;
	}
	return undefined;
};

const workspace = testWorkspace({
	tools: [
		tool({ name: 'summarize', description: 'Summarize records.', command: 'summarize' }),
		tool({ name: 'sandbox_files', description: 'Inspect files.', command: 'host:sandbox_files' })
	],
	skills: [{ name: 'payroll', body: '# Payroll\n\nUse the approved workflow.' }]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const executeTask = async (
	ai: FacilityBinding<AIRequest, AIResponse>,
	name: string,
	bindings: Parameters<typeof makeBoltTestRuntime>[1] = {}
) => {
	harness = await makeBoltTestRuntime(workspace, { ...bindings, ai });
	const agents = await harness.runtime.runPromise(Agents.Service);
	const conversationId = ConversationId.make(recordId(`task-${name}`));
	await harness.runtime.runPromise(
		agents.submit(harness.effectId(`submit:${name}`), adminSubject, {
			conversationId,
			agentId: AgentId.make('web'),
			message: Agents.userAgentInput('Complete the task.'),
			mode: DirectiveMode.make('agent'),
			priority: DirectivePriority.make('normal')
		})
	);
	const result = await harness.runtime.runPromise(
		agents.execute(harness.effectId(`execute:${name}`), adminSubject, conversationId)
	);
	return { result, conversationId };
};

describe('canonical Effect Prompt tool loop', () => {
	it('persists assistant tool calls and typed tool results as complete Prompt messages', async () => {
		const { ai, requests } = cassetteTranscript(cassette('agents-tools-platform'));
		const { result, conversationId } = await executeTask(ai, 'platform-tool');
		expect(result).toMatchObject({ conversationId, status: 'done' });
		expect(requests).toHaveLength(2);
		const secondRequest = requests[1];
		if (secondRequest === undefined) throw new Error('expected the post-tool generation');
		expect(lastToolResult(secondRequest)).toMatchObject({ name: 'test-workspace' });
		const runtime = harness;
		if (runtime === undefined) throw new Error('test runtime was not created');
		expect(
			await runtime.database.query(
				`select author->>'kind' as author_kind, message->>'role' as role
				 from conversation_message where conversation_id = $1 order by sequence`,
				[conversationId]
			)
		).toEqual([
			{ author_kind: 'human', role: 'user' },
			{ author_kind: 'agent', role: 'assistant' },
			{ author_kind: 'tool', role: 'tool' },
			{ author_kind: 'agent', role: 'assistant' }
		]);
	});

	it('executes an authored tool and exposes its JSON result to the next generation', async () => {
		const { ai, requests } = cassetteTranscript(cassette('agents-tools-authored'));
		const { result } = await executeTask(ai, 'authored-tool', {
			remoteHandlers: { summarize: (() => () => ({ count: 3 }))() }
		});
		expect(result.status).toBe('done');
		expect(lastToolResult(requests[1]!)).toEqual({ count: 3 });
	});

	it('routes host-owned tools through the host facility', async () => {
		const calls: Array<HostToolRequest> = [];
		const hostTools: FacilityBinding<HostToolRequest, HostToolResponse> = {
			call: async (_metadata, request) => {
				if (request.tool === 'capability_catalog')
					return { _tag: 'Success', value: { output: { tools: [] } } };
				calls.push(request);
				return { _tag: 'Success', value: { output: { entries: ['src'] } } };
			}
		};
		const { ai } = cassetteTranscript(cassette('agents-tools-host'));
		const { result, conversationId } = await executeTask(ai, 'host-tool', { hostTools });
		expect(result.status).toBe('done');
		expect(calls).toEqual([{ tool: 'sandbox_files', input: { path: 'src' }, sessionId: conversationId }]);
	});

	it('returns an Effect tool failure for a provider-requested undeclared tool', async () => {
		const { ai, requests } = cassetteTranscript(cassette('agents-tools-undeclared'));
		const { result } = await executeTask(ai, 'undeclared-tool');
		expect(result.status).toBe('done');
		expect(lastToolResult(requests[1]!)).toMatchObject({
			code: 'Bolt.CapabilityCatalog.ToolNotAllowed'
		});
	});
});
