import { z } from 'zod';

export const AiInferInputSchema = z.object({
	prompt: z.string(),
	schema: z.unknown().optional(),
	model: z.string().optional(),
	temperature: z.number().optional()
});
