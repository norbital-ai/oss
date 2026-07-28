import { ContextNavStackItemSchema } from '$lib/shared/scope.js';
import { z } from 'zod';

export const FetchStackFrameInputSchema = z.object({
	stack: z.array(ContextNavStackItemSchema)
});

export type TFetchStackFrameInput = z.infer<typeof FetchStackFrameInputSchema>;
