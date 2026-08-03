import type { z } from 'zod';
import type { BeforeApi } from '../workspace/hook-api.js';

export type AgentToolDefinition<TInput extends z.ZodType = z.ZodType> = {
	readonly description: string;
	readonly input: TInput;
	run(api: BeforeApi, input: z.infer<TInput>): unknown | Promise<unknown>;
};

/** Declare one compiler-discovered workspace-agent tool in a `+<name>.tool.ts` file. */
export function defineAgentTool<const TInput extends z.ZodType>(
	definition: AgentToolDefinition<TInput>
): AgentToolDefinition<TInput> {
	if (!definition.description.trim()) throw new Error('Agent tool description cannot be empty');
	return definition;
}
