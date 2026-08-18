import { Effect, Schema } from 'effect';
import type { BeforeApi } from './contracts-schema.js';
import type { AdaptedAuthoringSchema } from './handlers-schema.js';

/**
 * One workspace-agent tool, with the Effect schema the author declares for its input.
 *
 * The authoring boundary adapts the schema to a Standard Schema (`Schema.toStandardSchemaV1`) so
 * the generated dispatcher keeps validating through `~standard`, exactly as it already reads an
 * authored remote's schema — the adapter is the platform's, not the author's.
 */
export type AgentToolDefinition<
	S extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>
> = {
	readonly description: string;
	readonly input: S;
	run(
		api: BeforeApi,
		input: Schema.Schema.Type<S>
	): Effect.Effect<unknown, unknown, never> | unknown | Promise<unknown>;
};

/**
 * A declared tool after authoring: the input schema has been adapted to the Standard Schema the
 * compiled dispatcher validates through `~standard`, while remaining the author's schema.
 */
export type DefinedAgentTool<S extends Schema.Codec<unknown, unknown>> = Omit<
	AgentToolDefinition<S>,
	'input'
> & { readonly input: AdaptedAuthoringSchema<S> };

/** Declare one compiler-discovered workspace-agent tool in a `+<name>.tool.ts` file. */
export const defineAgentTool = <const S extends Schema.Codec<unknown, unknown>>(
	definition: AgentToolDefinition<S>
): DefinedAgentTool<S> => {
	if (definition.description.trim() === '') {
		throw new TypeError('Agent tool description cannot be empty.');
	}
	return Object.freeze({
		...definition,
		description: definition.description.trim(),
		input: Schema.toStandardSchemaV1(definition.input)
	});
};
