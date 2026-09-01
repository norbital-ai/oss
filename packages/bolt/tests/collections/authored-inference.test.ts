import {
	AIGenerationResult,
	AIResponse,
	EffectId,
	ProviderObservation,
	type AIRequest
} from '@norbital-ai/bolt-protocol';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { inferOp } from '../../src/runtime/collections/authored.js';

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
