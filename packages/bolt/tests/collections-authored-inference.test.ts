import {
	AIGenerationResult,
	AIResponse,
	EffectId,
	ProviderObservation,
	type AIRequest
} from '@norbital-ai/bolt-protocol';
import { Effect, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import { describe, expect, it } from 'vitest';
import { inferOp } from '../src/runtime/inference.js';
import type { InferenceTool } from '../src/authoring/index.js';

describe('authored inference image boundary', () => {
	it('sends compact host-resolved asset descriptors instead of isolate-expanded bytes', async () => {
		let captured: AIRequest | undefined;
		const infer = inferOp(EffectId.make('inference-image'), {
			catalog: () => Effect.die('unexpected catalog request'),
			generate: (_effectId, request) => {
				captured = request;
				return Effect.succeed(
					AIResponse.cases.Generated.make({
						result: AIGenerationResult.cases.Object.make({
							value: { suspicious: false }
						}),
						observation: ProviderObservation.make({
							callId: request.callId,
							provider: 'test',
							model: request.modelId,
							operation: 'language'
						})
					})
				);
			},
			embed: () => Effect.die('unexpected embedding request')
		});
		const output = await Effect.runPromise(
			infer({
				model: 'provider/vision',
				schema: Schema.Struct({ suspicious: Schema.Boolean }),
				prompt: 'Inspect this evidence.',
				images: [
					{
						file: {
							storage_key: 'evidence/large.jpg',
							file_name: 'large.jpg',
							file_size: 1_042_884,
							mime_type: 'image/jpeg'
						},
						detail: 'low'
					}
				]
			})
		);
		expect(output).toEqual({ suspicious: false });
		expect(captured?._tag).toBe('Generate');
		if (captured?._tag !== 'Generate') throw new Error('expected a generate request');
		expect(captured.output).toMatchObject({
			_tag: 'Object',
			objectName: expect.any(String),
			jsonSchema: expect.objectContaining({ type: 'object' })
		});
		expect(captured.messages).toEqual([
			{
				role: 'user',
				content: expect.stringContaining('Inspect this evidence.'),
				options: {}
			}
		]);
		expect(captured.imageAssets).toEqual([
			{
				key: 'evidence/large.jpg',
				name: 'large.jpg',
				mimeType: 'image/jpeg',
				size: 1_042_884,
				detail: 'low'
			}
		]);
		expect(JSON.stringify(captured)).not.toContain('base64');
	});
});

describe('authored inference tool loop', () => {
	const observation = (request: Extract<AIRequest, { _tag: 'Generate' }>) =>
		ProviderObservation.make({
			callId: request.callId,
			provider: 'test',
			model: request.modelId,
			operation: 'language'
		});
	const encodeMessage = Schema.encodeSync(Prompt.Message);
	const assistant = (content: Array<Prompt.AssistantMessagePart> | string) =>
		encodeMessage(
			Prompt.assistantMessage({
				content: typeof content === 'string' ? [Prompt.textPart({ text: content })] : content
			})
		);
	const toolCall = (id: string, name: string, params: Record<string, unknown>) =>
		Prompt.toolCallPart({ id, name, params, providerExecuted: false });
	const generateWith = (
		script: (
			request: Extract<AIRequest, { _tag: 'Generate' }>,
			turn: number
		) => typeof AIGenerationResult.Type,
		requests: Array<AIRequest>
	) => ({
		catalog: () => Effect.die('unexpected catalog request'),
		generate: (_effectId: unknown, request: AIRequest) => {
			requests.push(request);
			if (request._tag !== 'Generate') return Effect.die('expected a generate request');
			return Effect.succeed(
				AIResponse.cases.Generated.make({
					result: script(request, requests.length - 1),
					observation: observation(request)
				})
			);
		},
		embed: () => Effect.die('unexpected embedding request')
	});

	it('separates concurrent and repeated inferences while preserving replay identities', async () => {
		const run = async () => {
			const requests: Array<AIRequest> = [];
			const effectIds: Array<string> = [];
			const binding = generateWith(
				(request) =>
					request.output._tag === 'Object'
						? AIGenerationResult.cases.Object.make({ value: { rate: 7.5 } })
						: AIGenerationResult.cases.Message.make({ message: assistant('Evidence ready.') }),
				requests
			);
			const infer = inferOp(EffectId.make('statutory-batch'), {
				...binding,
				generate: (id, request) => {
					effectIds.push(id);
					return binding.generate(id, request);
				}
			});
			const request = (country: string) =>
				infer({
					model: 'provider/research',
					schema: Schema.Struct({ rate: Schema.Number }),
					prompt: `Research ${country}.`,
					tools: [
						{
							name: 'read_page',
							description: 'Read official evidence.',
							input: Schema.Struct({}),
							run: () => Effect.succeed('Official evidence.')
						}
					]
				});
			await Effect.runPromise(Effect.all([request('PH'), request('TW')], { concurrency: 2 }));
			await Effect.runPromise(request('PH'));
			const callIds = requests.map((request) => {
				if (request._tag !== 'Generate') throw new Error('expected generation');
				return request.callId;
			});
			expect(new Set(callIds).size).toBe(6);
			expect(new Set(effectIds).size).toBe(6);
			return { callIds, effectIds };
		};
		expect(await run()).toEqual(await run());
	});

	it('lets the model call authored tools, then closes with the structured turn', async () => {
		const requests: Array<AIRequest> = [];
		const reads: Array<string> = [];
		const infer = inferOp(
			EffectId.make('inference-tools'),
			generateWith((request, turn) => {
				if (request.output._tag === 'Object')
					return AIGenerationResult.cases.Object.make({ value: { rate: 7.5 } });
				return turn === 0
					? AIGenerationResult.cases.Message.make({
							message: assistant([
								toolCall('call-1', 'read_page', { url: 'https://www.bli.gov.tw/en/' }),
								toolCall('call-2', 'nope', {})
							])
						})
					: AIGenerationResult.cases.Message.make({ message: assistant('The rate is 7.5%.') });
			}, requests)
		);
		const output = await Effect.runPromise(
			infer({
				model: 'provider/research',
				schema: Schema.Struct({ rate: Schema.Number }),
				prompt: 'Find the employer rate.',
				tools: [
					{
						name: 'read_page',
						description: 'Read one official page.',
						input: Schema.Struct({ url: Schema.String }),
						run: (input: { url: string }) => {
							reads.push(input.url);
							return Effect.succeed({ text: 'x'.repeat(30_000) });
						}
					}
				]
			})
		);
		expect(output).toEqual({ rate: 7.5 });
		expect(reads).toEqual(['https://www.bli.gov.tw/en/']);
		expect(requests.map((r) => (r._tag === 'Generate' ? r.output._tag : r._tag))).toEqual([
			'Message',
			'Message',
			'Object'
		]);
		const first = requests[0];
		if (first?._tag !== 'Generate' || first.output._tag !== 'Message') throw new Error('turn');
		expect(first.output.tools).toEqual([
			{
				name: 'read_page',
				description: 'Read one official page.',
				inputSchema: expect.objectContaining({ type: 'object' })
			}
		]);
		const closing = requests[2];
		if (closing?._tag !== 'Generate') throw new Error('closing');
		const roles = closing.messages.map((m) => m.role);
		expect(roles).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant', 'user']);
		const toolMessage = closing.messages[2];
		if (typeof toolMessage?.content === 'string') throw new Error('tool content');
		const part = toolMessage?.content[0] as { result: unknown; isFailure: boolean };
		expect(part.isFailure).toBe(false);
		expect(String(part.result)).toContain('[clipped: 30');
		const unknown = closing.messages[3];
		if (typeof unknown?.content === 'string') throw new Error('tool content');
		expect((unknown?.content[0] as { isFailure: boolean; result: unknown }).isFailure).toBe(true);
		expect(String((unknown?.content[0] as { result: unknown }).result)).toContain('Unknown tool "nope"');
		expect(JSON.stringify(closing.messages.at(-1))).toContain('Return the structured result now');
	});

	it('keeps calling tools up to the cap, surfacing failures as results', async () => {
		const requests: Array<AIRequest> = [];
		let runs = 0;
		const infer = inferOp(
			EffectId.make('inference-steps'),
			generateWith((request, turn) =>
				request.output._tag === 'Object'
					? AIGenerationResult.cases.Object.make({ value: { rate: 1 } })
					: turn < 3
						? AIGenerationResult.cases.Message.make({
								message: assistant([toolCall(`c${requests.length}`, 'again', {})])
							})
						: AIGenerationResult.cases.Message.make({ message: assistant('Enough.') }), requests)
		);
		const output = await Effect.runPromise(
			infer({
				model: 'provider/research',
				schema: Schema.Struct({ rate: Schema.Number }),
				prompt: 'Loop.',
				tools: [
					{
						name: 'again',
						description: 'Fails every time.',
						input: Schema.Struct({}),
						run: () => {
							runs += 1;
							return Effect.fail(new Error('page unavailable'));
						}
					}
				]
			})
		);
		expect(output).toEqual({ rate: 1 });
		expect(runs).toBe(3);
		expect(requests).toHaveLength(5);
		const closing = requests[4];
		if (closing?._tag !== 'Generate') throw new Error('closing');
		const failed = closing.messages.find((m) => m.role === 'tool');
		expect(JSON.stringify(failed)).toContain('page unavailable');
	});

	it('refuses after the tool-turn cap instead of looping forever', async () => {
		const requests: Array<AIRequest> = [];
		const infer = inferOp(
			EffectId.make('inference-unbounded'),
			generateWith(
				(_request, turn) =>
					AIGenerationResult.cases.Message.make({
						message: assistant([toolCall(`c${turn}`, 'again', {})])
					}),
				requests
			)
		);
		const exit = await Effect.runPromiseExit(
			infer({
				model: 'provider/research',
				schema: Schema.Struct({ rate: Schema.Number }),
				prompt: 'Loop forever.',
				tools: [
					{
						name: 'again',
						description: 'Always asks for another turn.',
						input: Schema.Struct({}),
						run: () => Effect.succeed(null)
					}
				]
			})
		);
		expect(exit._tag).toBe('Failure');
		expect(JSON.stringify(exit)).toContain('ai.tool_loop_unbounded');
		expect(requests).toHaveLength(12);
	});

	it('refuses an ill-formed tool list before any provider call', async () => {
		const requests: Array<AIRequest> = [];
		const infer = inferOp(
			EffectId.make('inference-bad-tools'),
			generateWith(() => AIGenerationResult.cases.Object.make({ value: {} }), requests)
		);
		const exit = await Effect.runPromiseExit(
			infer({
				model: 'provider/research',
				schema: Schema.Struct({}),
				prompt: 'x',
				tools: [
					{ name: 'Bad Name', description: 'x', input: Schema.Struct({}), run: () => Effect.succeed(null) }
				]
			})
		);
		expect(exit._tag).toBe('Failure');
		expect(requests).toHaveLength(0);
	});
});

describe('authored inference tool contract', () => {
	it('admits a typed tool where the untyped tool list is expected', () => {
		const typed: InferenceTool<{ readonly url: string }> = {
			name: 'read_page',
			description: 'Read one page.',
			input: Schema.Struct({ url: Schema.String }),
			run: ({ url }) => Effect.succeed({ url })
		};
		const tools: ReadonlyArray<InferenceTool> = [typed];
		expect(tools[0]?.name).toBe('read_page');
	});
});

describe('authored inference decode refusal', () => {
	it('names the field that failed to decode', async () => {
		const requests: Array<AIRequest> = [];
		const infer = inferOp(EffectId.make('inference-decode'), {
			catalog: () => Effect.die('unexpected catalog request'),
			generate: (_effectId, request) => {
				requests.push(request);
				return Effect.succeed(
					AIResponse.cases.Generated.make({
						result: AIGenerationResult.cases.Object.make({
							value: { leave: { eligibility: null } }
						}),
						observation: ProviderObservation.make({
							callId: request.callId,
							provider: 'test',
							model: request.modelId,
							operation: 'language'
						})
					})
				);
			},
			embed: () => Effect.die('unexpected embedding request')
		});
		const exit = await Effect.runPromiseExit(
			infer({
				model: 'provider/research',
				schema: Schema.Struct({
					leave: Schema.Struct({ eligibility: Schema.optional(Schema.Array(Schema.String)) })
				}),
				prompt: 'x'
			})
		);
		expect(exit._tag).toBe('Failure');
		expect(JSON.stringify(exit)).toContain('eligibility');
	});
});
