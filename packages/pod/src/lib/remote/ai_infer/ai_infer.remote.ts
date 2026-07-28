import { Guard, requireAuthMiddleware } from '$lib/remote/guard.server.js';
import { runAiInfer } from '$lib/server/run/ai_infer.server.js';
import { AiInferInputSchema } from './schema.js';

const authenticated = Guard.init().use(requireAuthMiddleware());

export const aiInfer = authenticated.command(AiInferInputSchema, runAiInfer);
