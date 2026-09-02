import { Effect, Schema } from 'effect';
import type { Api } from './contracts-schema.js';

type AgentToolDefinition<
	S extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
	E = never
> = {
	readonly description: string;
	readonly input: S;
	run(api: Api, input: Schema.Schema.Type<S>): Effect.Effect<unknown, E, never> | unknown;
};

/** Declares one tenant Effect Tool implementation discovered from a `+<name>.tool.ts` file. */
export const defineAgentTool = <const S extends Schema.Codec<unknown, unknown>, E = never>(
	definition: AgentToolDefinition<S, E>
): AgentToolDefinition<S, E> => {
	const description = definition.description.trim();
	if (description === '') throw new TypeError('Agent tool description cannot be empty.');
	return Object.freeze({ ...definition, description });
};
