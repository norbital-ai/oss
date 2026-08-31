import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	chat,
	EventType,
	maxIterations,
	modelMessagesToUIMessages,
	toolDefinition,
	type AdapterYieldChunk,
	type AnyTextAdapter,
	type ChatMiddleware,
	type ChatMiddlewareConfig,
	type ContentPart,
	type ModelMessage,
	type TextOptions
} from '@tanstack/ai';
import type { RunStore } from '@tanstack/ai-persistence';
import {
	AgentRunStore,
	contextPolicyMiddleware,
	projectAgentContext
} from '../../src/runtime/agents/agent-runtime.js';

type ModelMessageContentPart = Exclude<ModelMessage['content'], string | null>[number];

const event = (value: AdapterYieldChunk): AdapterYieldChunk => value;

const captureAdapter = (
	capture: Array<{
		readonly messages: ReadonlyArray<ModelMessage>;
		readonly tools: ReadonlyArray<string>;
		readonly prompts: ReadonlyArray<string>;
	}>
): AnyTextAdapter => ({
	kind: 'text',
	name: 'context-capture',
	model: 'fixture-model',
	'~types': undefined as never,
	chatStream: async function* (options: TextOptions<Record<string, unknown>>) {
		capture.push({
			messages: options.messages as ReadonlyArray<ModelMessage>,
			tools: (options.tools ?? []).map(({ name }) => name),
			prompts: (options.systemPrompts ?? []).map((prompt) =>
				typeof prompt === 'string' ? prompt : prompt.content
			)
		});
		const runId = options.runId ?? 'run-context';
		const threadId = options.threadId ?? 'thread-context';
		yield event({ type: EventType.RUN_STARTED, runId, threadId });
		yield event({ type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' });
		yield event({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'Plan.' });
		yield event({ type: EventType.TEXT_MESSAGE_END, messageId: 'answer' });
		yield event({ type: EventType.RUN_FINISHED, runId, threadId, finishReason: 'stop' });
	},
	structuredOutput: async () => ({ data: null, rawText: 'null' })
});

type SpikeRun = {
	id: string;
	generation: number;
	status: 'running' | 'completed' | 'aborted';
	disposition: null | 'superseded';
	claimed: Array<string>;
};

/** Transaction-shaped Phase-0 lane spike. The promise tail is the lane lock. */
class LaneSpike {
	readonly messages: Array<{ id: string; receiptSequence: number }> = [];
	readonly inbox: Array<{
		id: string;
		messageId: string;
		receiptSequence: number;
		mode: 'queue' | 'steer';
		state: 'pending' | 'claimed';
		claimedByRunId: string | null;
	}> = [];
	readonly runs: Array<SpikeRun> = [];
	readonly lane = {
		activeRunId: null as string | null,
		activeGeneration: 0,
		requestedGeneration: 0
	};
	#tail: Promise<void> = Promise.resolve();

	#locked<A>(operation: () => A | Promise<A>): Promise<A> {
		const next = this.#tail.then(operation, operation);
		this.#tail = next.then(
			() => undefined,
			() => undefined
		);
		return next;
	}

	admit(id: string, receiptSequence: number, mode: 'queue' | 'steer') {
		return this.#locked(() => {
			const existing = this.inbox.find(({ id: candidate }) => candidate === id);
			if (existing) return existing;
			this.messages.push({ id: `message-${id}`, receiptSequence });
			const entry = {
				id,
				messageId: `message-${id}`,
				receiptSequence,
				mode,
				state: 'pending' as const,
				claimedByRunId: null
			};
			this.inbox.push(entry);
			if (mode === 'steer' && this.lane.activeRunId !== null) {
				this.lane.requestedGeneration = Math.max(
					this.lane.requestedGeneration,
					this.lane.activeGeneration + 1
				);
			}
			if (this.lane.activeRunId === null) this.#start('queue');
			return entry;
		});
	}

	settle() {
		return this.#locked(() => {
			const active = this.runs.find(({ id }) => id === this.lane.activeRunId);
			if (!active) return;
			if (this.lane.requestedGeneration > this.lane.activeGeneration) {
				active.status = 'aborted';
				active.disposition = 'superseded';
				this.lane.activeRunId = null;
				this.#start('steer');
				return;
			}
			active.status = 'completed';
			this.lane.activeRunId = null;
			this.#start('queue');
		});
	}

	#start(cause: 'queue' | 'steer') {
		const ordered = this.inbox
			.filter(({ state }) => state === 'pending')
			.toSorted((left, right) => left.receiptSequence - right.receiptSequence);
		const candidates =
			cause === 'steer' ? ordered.filter(({ mode }) => mode === 'steer') : ordered.slice(0, 1);
		if (candidates.length === 0) {
			this.lane.requestedGeneration = this.lane.activeGeneration;
			return;
		}
		const generation =
			cause === 'steer'
				? this.lane.requestedGeneration
				: Math.max(this.lane.activeGeneration, this.lane.requestedGeneration) + 1;
		const id = `run-${generation}`;
		const claimed = candidates.map(({ id: entryId }) => entryId);
		this.runs.push({ id, generation, status: 'running', disposition: null, claimed });
		for (const entry of candidates) {
			entry.state = 'claimed';
			entry.claimedByRunId = id;
		}
		this.lane.activeRunId = id;
		this.lane.activeGeneration = generation;
		this.lane.requestedGeneration = generation;
	}
}

/** Two provider iterations with one tool phase between them. */
const twoIterationAdapter = (
	providerCalls: Array<ReadonlyArray<ModelMessage>>
): AnyTextAdapter => ({
	kind: 'text',
	name: 'phase-zero-fixture',
	model: 'fixture-model',
	'~types': undefined as never,
	chatStream: async function* (options: TextOptions<Record<string, unknown>>) {
		providerCalls.push(options.messages as Array<ModelMessage>);
		const iteration = providerCalls.length - 1;
		const runId = options.runId ?? 'run-fixture';
		const threadId = options.threadId ?? 'thread-fixture';
		const messageId = `assistant-${iteration}`;
		yield event({ type: EventType.RUN_STARTED, runId, threadId });
		yield event({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
		if (iteration === 0) {
			yield event({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'Checking.' });
			yield event({
				type: 'TOOL_CALL_START',
				toolCallId: 'call-1',
				toolCallName: 'lookup',
				parentMessageId: messageId,
				metadata: { thoughtSignature: 'encrypted-tool-signature' }
			});
			yield event({
				type: EventType.TOOL_CALL_ARGS,
				toolCallId: 'call-1',
				delta: '{"key":"value"}'
			});
			yield event({ type: 'TOOL_CALL_END', toolCallId: 'call-1', input: { key: 'value' } });
			yield event({
				type: EventType.RUN_FINISHED,
				runId,
				threadId,
				finishReason: 'tool_calls',
				usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 }
			});
			return;
		}
		yield event({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'Finished.' });
		yield event({ type: EventType.TEXT_MESSAGE_END, messageId });
		yield event({
			type: EventType.RUN_FINISHED,
			runId,
			threadId,
			finishReason: 'stop',
			usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 }
		});
	},
	structuredOutput: async () => ({ data: null, rawText: 'null' })
});

describe('pinned TanStack AI 0.52.0 contract', () => {
	it('implements the pinned persistence RunStore contract', () => {
		expectTypeOf<ReturnType<typeof AgentRunStore>>().toEqualTypeOf<RunStore>();
	});

	it('derives the canonical content-part alias from ModelMessage', () => {
		expectTypeOf<ModelMessageContentPart>().toEqualTypeOf<ContentPart>();
	});

	it('projects rich canonical messages without losing stable provider semantics', () => {
		const createdAt = new Date('2026-08-31T00:00:00.000Z');
		const messages: Array<ModelMessage> = [
			{
				id: 'user-1',
				role: 'user',
				createdAt,
				content: [
					{ type: 'text', content: 'Inspect both files.', metadata: { locale: 'en' } },
					{
						type: 'image',
						source: { type: 'url', value: 'https://example.test/image.png', mimeType: 'image/png' },
						metadata: { detail: 'high' }
					},
					{
						type: 'document',
						source: { type: 'data', value: 'cGRm', mimeType: 'application/pdf' }
					}
				],
				metadata: { application: { attachmentIds: ['image-1', 'document-1'] } }
			},
			{
				id: 'assistant-1',
				role: 'assistant',
				content: 'Checking.',
				thinking: [{ content: 'Use the lookup.', signature: 'reasoning-signature' }],
				toolCalls: [
					{
						id: 'call-1',
						type: 'function',
						function: { name: 'lookup', arguments: '{"key":"value"}' },
						metadata: { thoughtSignature: 'tool-signature' }
					}
				]
			},
			{
				id: 'tool-1',
				role: 'tool',
				toolCallId: 'call-1',
				content: '{"ok":true}',
				metadata: { provider: { requestId: 'provider-1' } }
			},
			{
				id: 'assistant-2',
				role: 'assistant',
				content: '{"answer":"done"}',
				structuredOutput: {
					type: 'structured-output',
					status: 'complete',
					raw: '{"answer":"done"}',
					data: { answer: 'done' }
				}
			}
		];

		const projected = modelMessagesToUIMessages(messages);
		expect(projected.map(({ id }) => id)).toEqual(['user-1', 'assistant-1', 'assistant-2']);
		expect(projected[0]?.createdAt).toEqual(createdAt);
		expect(projected[0]?.parts.map(({ type }) => type)).toEqual(['text', 'image', 'document']);
		expect(projected[1]?.parts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'thinking', signature: 'reasoning-signature' }),
				expect.objectContaining({
					type: 'tool-call',
					id: 'call-1',
					metadata: { thoughtSignature: 'tool-signature' }
				})
			])
		);
		expect(projected[1]?.parts).toContainEqual(
			expect.objectContaining({ type: 'tool-result', toolCallId: 'call-1' })
		);
		expect(projected[2]?.parts).toContainEqual(
			expect.objectContaining({ type: 'structured-output', data: { answer: 'done' } })
		);
	});

	it('keeps compaction durable while filtering the provider prefix and plan mutations', async () => {
		const captured: Parameters<typeof captureAdapter>[0] = [];
		const read = toolDefinition({
			name: 'read_collection',
			description: 'Read',
			inputSchema: {}
		}).server(async () => ({ rows: [] }));
		const write = toolDefinition({
			name: 'write_collection',
			description: 'Write',
			inputSchema: {}
		}).server(async () => ({ written: true }));
		const messages: Array<ModelMessage> = [
			{ id: 'old-user', role: 'user', content: 'Old request' },
			{ id: 'old-assistant', role: 'assistant', content: 'Old answer' },
			{ id: 'summary', role: 'assistant', content: 'Complete compacted context' },
			{ id: 'new-user', role: 'user', content: 'Plan the next change' }
		];
		for await (const _chunk of chat({
			adapter: captureAdapter(captured),
			messages,
			tools: [read, write],
			middleware: [
				contextPolicyMiddleware({
					contextTokens: 32_000,
					intent: 'plan',
					metadata: new Map([
						['summary', { version: 1 as const, kind: 'summary' as const, fold: 'compact' as const }]
					])
				})
			],
			threadId: 'context-thread',
			runId: 'context-run'
		})) {
			// Drain the SDK stream.
		}

		expect(messages.map(({ id }) => id)).toEqual([
			'old-user',
			'old-assistant',
			'summary',
			'new-user'
		]);
		expect(captured[0]?.messages.map(({ id }) => id)).toEqual(['summary', 'new-user']);
		expect(captured[0]?.tools).toEqual(['read_collection']);
		expect(captured[0]?.prompts.at(-1)).toContain('Planning mode is active');
	});

	it('makes the newest plan the context checkpoint for a later implementing turn', () => {
		const read = toolDefinition({
			name: 'read_collection',
			description: 'Read',
			inputSchema: {}
		}).server(async () => ({ rows: [] }));
		const messages: Array<ModelMessage> = [
			{ id: 'old-request', role: 'user', content: 'Earlier discussion' },
			{ id: 'old-answer', role: 'assistant', content: 'Earlier answer' },
			{ id: 'latest-plan', role: 'assistant', content: '1. Inspect\n2. Implement\n3. Verify' },
			{ id: 'implement', role: 'user', content: 'Implement the plan.' }
		];
		const projected = projectAgentContext(
			{
				contextTokens: 32_000,
				intent: 'do',
				metadata: new Map([
					['latest-plan', { version: 1 as const, kind: 'summary' as const, fold: 'plan' as const }]
				])
			},
			{
				messages,
				systemPrompts: [],
				tools: [read] as unknown as ChatMiddlewareConfig['tools']
			}
		);

		expect(projected.providerMessages?.map(({ id }) => id)).toEqual(['latest-plan', 'implement']);
		expect(messages.map(({ id }) => id)).toEqual([
			'old-request',
			'old-answer',
			'latest-plan',
			'implement'
		]);
	});

	it('projects compact turns without tools and leaves durable history unchanged', () => {
		const read = toolDefinition({
			name: 'read_collection',
			description: 'Read',
			inputSchema: {}
		}).server(async () => ({ rows: [] }));
		const messages: Array<ModelMessage> = [
			{ id: 'request', role: 'user', content: 'A long-running discussion' },
			{ id: 'compact', role: 'user', content: 'Keep the decisions and open risks.' }
		];
		const projected = projectAgentContext(
			{ contextTokens: 32_000, intent: 'compact', metadata: new Map() },
			{
				messages,
				systemPrompts: [],
				tools: [read] as unknown as ChatMiddlewareConfig['tools']
			}
		);

		expect(projected.tools).toEqual([]);
		expect(projected.systemPrompts?.at(-1)).toMatchObject({
			content: expect.stringContaining('Compaction mode is active')
		});
		expect(messages.map(({ id }) => id)).toEqual(['request', 'compact']);
	});

	it('keeps goal verdicts visible while filtering transcript-only accounting from a pure projection', () => {
		const messages: Array<ModelMessage> = [
			{ id: 'request', role: 'user', content: 'Complete the task.' },
			{ id: 'usage', role: 'user', content: 'internal usage record' },
			{ id: 'verifier', role: 'user', content: 'internal verifier trace' },
			{ id: 'transcript', role: 'assistant', content: 'UI-only detail' },
			{ id: 'goal', role: 'user', content: '{"resultType":"goal_verdict","achieved":false}' },
			{ id: 'answer', role: 'assistant', content: 'Continuing from the durable verdict.' }
		];
		const snapshot = structuredClone(messages);
		const options = {
			contextTokens: 32_000,
			intent: 'do' as const,
			metadata: new Map([
				['usage', { version: 1 as const, kind: 'usage' as const }],
				['verifier', { version: 1 as const, kind: 'verifier' as const }],
				['transcript', { version: 1 as const, visibility: 'transcript-only' as const }],
				['goal', { version: 1 as const, kind: 'goal' as const }]
			])
		};
		const config = { messages, systemPrompts: [], tools: [] };
		const first = projectAgentContext(options, config);
		const second = projectAgentContext(options, config);

		expect(first).toEqual(second);
		expect(messages).toEqual(snapshot);
		expect(first.providerMessages?.map(({ id }) => id)).toEqual(['request', 'goal', 'answer']);
	});

	it('runs tools sequentially after the complete assistant call batch is middleware-visible', async () => {
		const providerCalls: Array<ReadonlyArray<ModelMessage>> = [];
		const iterations: Array<Readonly<{ iteration: number; messageId: string }>> = [];
		const boundaries: Array<ReadonlyArray<ModelMessage>> = [];
		const execution: Array<string> = [];
		let finalMessages: ReadonlyArray<ModelMessage> = [];
		const middleware: ChatMiddleware = {
			name: 'phase-zero-boundaries',
			onIteration: (_ctx, info) => {
				iterations.push(info);
			},
			onInterruptBoundary: (ctx) => {
				if (ctx.phase === 'beforeTools') boundaries.push(structuredClone(ctx.messages));
			},
			onBeforeToolCall: (_ctx, info) => {
				execution.push(`before:${info.toolCallId}`);
			},
			onAfterToolCall: (_ctx, info) => {
				execution.push(`after:${info.toolCallId}`);
			},
			onFinish: (ctx) => {
				finalMessages = structuredClone(ctx.messages);
			}
		};
		const lookup = toolDefinition({
			name: 'lookup',
			description: 'Look up one value.',
			inputSchema: {
				type: 'object',
				properties: { key: { type: 'string' } },
				required: ['key'],
				additionalProperties: false
			}
		}).server(async (input) => {
			execution.push(`execute:${JSON.stringify(input)}`);
			return { ok: true };
		});

		for await (const _chunk of chat({
			adapter: twoIterationAdapter(providerCalls),
			messages: [{ id: 'user-1', role: 'user', content: 'Run the lookup.' }],
			tools: [lookup],
			middleware: [middleware],
			agentLoopStrategy: maxIterations(2),
			threadId: 'thread-1',
			runId: 'run-1'
		})) {
			// Draining is the contract: terminal middleware runs only after the stream settles.
		}

		expect(iterations).toEqual([
			{ iteration: 0, messageId: expect.any(String) },
			{ iteration: 1, messageId: expect.any(String) }
		]);
		expect(new Set(iterations.map(({ messageId }) => messageId)).size).toBe(2);
		expect(boundaries).toHaveLength(1);
		expect(boundaries[0]?.at(-1)).toMatchObject({
			role: 'assistant',
			id: 'assistant-0',
			toolCalls: [{ id: 'call-1', function: { name: 'lookup' } }]
		});
		expect(execution).toEqual(['before:call-1', 'execute:{"key":"value"}', 'after:call-1']);
		expect(providerCalls).toHaveLength(2);
		expect(providerCalls[1]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: 'assistant', id: 'assistant-0' }),
				expect.objectContaining({ role: 'tool', toolCallId: 'call-1' })
			])
		);
		expect(finalMessages.filter(({ role }) => role === 'assistant').map(({ id }) => id)).toEqual([
			'assistant-0',
			'assistant-1'
		]);
	});
});

describe('Phase-0 lane transaction spike', () => {
	it('admits idempotently and gives an idle lane exactly one FIFO run', async () => {
		const lane = new LaneSpike();
		await Promise.all([
			lane.admit('web:1', 1, 'queue'),
			lane.admit('web:2', 2, 'queue'),
			lane.admit('web:1', 1, 'queue')
		]);

		expect(lane.messages).toHaveLength(2);
		expect(lane.runs).toEqual([
			expect.objectContaining({ generation: 1, status: 'running', claimed: ['web:1'] })
		]);
		expect(lane.inbox.find(({ id }) => id === 'web:2')).toMatchObject({ state: 'pending' });
	});

	it('coalesces steer admissions and makes steer beat final settlement under the same lock', async () => {
		const lane = new LaneSpike();
		await lane.admit('web:1', 1, 'queue');
		await Promise.all([
			lane.admit('web:steer-1', 2, 'steer'),
			lane.admit('web:steer-2', 3, 'steer')
		]);
		expect(lane.lane).toMatchObject({ activeGeneration: 1, requestedGeneration: 2 });

		await lane.settle();

		expect(lane.runs).toEqual([
			expect.objectContaining({
				generation: 1,
				status: 'aborted',
				disposition: 'superseded'
			}),
			expect.objectContaining({
				generation: 2,
				status: 'running',
				claimed: ['web:steer-1', 'web:steer-2']
			})
		]);
		expect(lane.inbox.every(({ state }) => state === 'claimed')).toBe(true);
	});
});
