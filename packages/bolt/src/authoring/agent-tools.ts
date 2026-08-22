import { Effect, Schema } from 'effect';
import type { BeforeApi } from './contracts-schema.js';

/**
 * One workspace-agent tool, with the Effect schema the author declares for its input.
 *
 * The compiler decodes it directly with Effect Schema at the invocation boundary.
 */
type AgentToolDefinition<
	S extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>
> = {
	readonly description: string;
	readonly input: S;
	run(
		api: BeforeApi,
		input: Schema.Schema.Type<S>
	): Effect.Effect<unknown, unknown, never> | unknown;
};

type DefinedAgentTool<S extends Schema.Codec<unknown, unknown>> = AgentToolDefinition<S>;

/** Declare one compiler-discovered workspace-agent tool in a `+<name>.tool.ts` file. */
export const defineAgentTool = <const S extends Schema.Codec<unknown, unknown>>(
	definition: AgentToolDefinition<S>
): DefinedAgentTool<S> => {
	if (definition.description.trim() === '') {
		throw new TypeError('Agent tool description cannot be empty.');
	}
	return Object.freeze({
		...definition,
		description: definition.description.trim()
	});
};
