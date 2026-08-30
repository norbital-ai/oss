import { AIResponse, EffectId, type AIRequest } from '@norbital-ai/bolt-protocol';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { inferOp } from '../../src/runtime/collections/authored.js';

describe('authored inference image boundary', () => {
	it('sends compact host-resolved asset descriptors instead of isolate-expanded bytes', async () => {
		let captured: AIRequest | undefined;
		const infer = inferOp(EffectId.make('inference-image'), {
			execute: (_effectId, request) => {
				captured = request;
				return Effect.succeed(AIResponse.make({ output: { suspicious: false } }));
			}
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
		expect(captured?._tag).toBe('Turn');
		if (captured?._tag !== 'Turn') throw new Error('expected a turn request');
		expect(captured.messages).toEqual([
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'Inspect this evidence.' },
					{
						type: 'image_asset',
						image_asset: {
							key: 'evidence/large.jpg',
							name: 'large.jpg',
							mimeType: 'image/jpeg',
							size: 1_042_884,
							detail: 'low'
						}
					}
				]
			}
		]);
		expect(JSON.stringify(captured)).not.toContain('base64');
	});
});
