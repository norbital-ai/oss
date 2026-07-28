import { AiInferInputSchema } from '$lib/remote/ai_infer/schema.js';
import { requireRuntimeFacility } from '$lib/server/run/facilities.js';
import type { z } from 'zod';

export async function runAiInfer(input: z.infer<typeof AiInferInputSchema>): Promise<unknown> {
	const ai = requireRuntimeFacility('ai');
	return ai.infer({
		prompt: input.prompt,
		model: input.model,
		temperature: input.temperature,
		schema: input.schema
	});
}
