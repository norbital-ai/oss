import { Effect, Schema } from 'effect';
import type { AnySchema, Api, DefaultWorkspaceSchema } from './contracts-schema.js';

interface HandlerDefinition<
	S extends Schema.Codec<unknown, unknown>,
	Output,
	Workspace extends AnySchema = DefaultWorkspaceSchema,
	Kind extends 'query' | 'command' = 'query',
	E = never
> {
	readonly kind: Kind;
	readonly description: string;
	readonly schema: S;
	readonly handler: (
		payload: Schema.Schema.Type<S>,
		api: Api<Workspace>
	) => Effect.Effect<Output, E, never> | Output;
}

type AuthoredHandler<
	S extends Schema.Codec<unknown, unknown>,
	Workspace extends AnySchema,
	Output,
	E = never
> = {
	readonly description: string;
	readonly schema: S;
	readonly handler: (
		payload: Schema.Schema.Type<S>,
		api: Api<Workspace>
	) => Effect.Effect<Output, E, never> | Output;
};

/** Public read-remote contract that retains the augmented workspace schema in generated types. */
interface DefineQueryHandler {
	<
		const S extends Schema.Codec<unknown, unknown>,
		Workspace extends AnySchema = DefaultWorkspaceSchema,
		Output = unknown,
		E = never
	>(
		definition: AuthoredHandler<S, Workspace, Output, E>
	): HandlerDefinition<S, Output, Workspace, 'query', E>;
}

/**
 * Public mutating-remote contract. The literal command discriminant is part of compiler discovery
 * and runtime authorization, while the symbolic default lets each workspace augment its tables.
 */
interface DefineCommandHandler {
	<
		const S extends Schema.Codec<unknown, unknown>,
		Workspace extends AnySchema = DefaultWorkspaceSchema,
		Output = unknown,
		E = never
	>(
		definition: AuthoredHandler<S, Workspace, Output, E>
	): HandlerDefinition<S, Output, Workspace, 'command', E>;
}

/**
 * Owns handler validation while preserving the query and command call contracts.
 *
 * The declared Effect schema stays intact so the generated artifact has one schema path.
 */
const HandlerAuthoring: {
	readonly query: DefineQueryHandler;
	readonly command: DefineCommandHandler;
} = {
	query: (definition) => {
		if (definition.description.trim() === '')
			throw new Error('Query handler description cannot be empty');
		return { kind: 'query', ...definition };
	},
	command: (definition) => {
		if (definition.description.trim() === '')
			throw new Error('Command handler description cannot be empty');
		return { kind: 'command', ...definition };
	}
};

export const defineQueryHandler = HandlerAuthoring.query;
export const defineCommandHandler = HandlerAuthoring.command;

export type { TExportManifest } from './contracts-schema.js';
