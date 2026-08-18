import { Effect, Schema } from 'effect';
import type { AnySchema, BeforeApi, DefaultWorkspaceSchema } from './contracts-schema.js';

export interface DynamicCollectionApi {
	readonly count: (input?: unknown) => Promise<number>;
	readonly findFirst: (input?: unknown) => Promise<Readonly<Record<string, unknown>> | null>;
	readonly findMany: (input?: unknown) => Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;
	readonly create: (input: unknown) => Promise<Readonly<Record<string, unknown>>>;
	readonly update: (input: unknown) => Promise<Readonly<Record<string, unknown>>>;
}

/**
 * The form a declared handler's schema takes after authoring: the Effect schema adapted to the
 * Standard Schema the compiled SvelteKit dispatcher validates through `~standard`, while staying a
 * schema so it remains nestable in further Effect `Schema.Struct`s.
 *
 * Derived from `Schema.toStandardSchemaV1`'s own return type rather than restated: the standard
 * schema interface is effect's to name, and a hand-written copy of it would be a second interface
 * that has to stay in step with the library's.
 */
export type AdaptedAuthoringSchema<S extends Schema.Codec<unknown, unknown>> = ReturnType<
	typeof Schema.toStandardSchemaV1<S>
>;

export interface HandlerDefinition<
	S extends Schema.Codec<unknown, unknown>,
	Output,
	Workspace extends AnySchema = DefaultWorkspaceSchema,
	Kind extends 'query' | 'command' = 'query'
> {
	readonly kind: Kind;
	readonly description: string;
	readonly schema: AdaptedAuthoringSchema<S>;
	readonly handler: (
		payload: Schema.Schema.Type<S>,
		api: BeforeApi<Workspace>
	) => Effect.Effect<Output, unknown, never> | Promise<Output> | Output;
}

type AuthoredHandler<
	S extends Schema.Codec<unknown, unknown>,
	Workspace extends AnySchema,
	Output
> = {
	readonly description: string;
	readonly schema: S;
	readonly handler: (
		payload: Schema.Schema.Type<S>,
		api: BeforeApi<Workspace>
	) => Effect.Effect<Output, unknown, never> | Promise<Output> | Output;
};

/** Public read-remote contract that retains the augmented workspace schema in generated types. */
interface DefineQueryHandler {
	<
		const S extends Schema.Codec<unknown, unknown>,
		Workspace extends AnySchema = DefaultWorkspaceSchema,
		Output = unknown
	>(
		definition: AuthoredHandler<S, Workspace, Output>
	): HandlerDefinition<S, Output, Workspace>;
}

/**
 * Public mutating-remote contract. The literal command discriminant is part of compiler discovery
 * and runtime authorization, while the symbolic default lets each workspace augment its tables.
 */
interface DefineCommandHandler {
	<
		const S extends Schema.Codec<unknown, unknown>,
		Workspace extends AnySchema = DefaultWorkspaceSchema,
		Output = unknown
	>(
		definition: AuthoredHandler<S, Workspace, Output>
	): HandlerDefinition<S, Output, Workspace, 'command'>;
}

/**
 * Owns handler validation while preserving the query and command call contracts.
 *
 * The declared Effect schema is adapted to a Standard Schema here, at the authoring boundary, so
 * the generated dispatcher keeps validating through `~standard` without the author ever handling
 * the adapter.
 */
const HandlerAuthoring: {
	readonly query: DefineQueryHandler;
	readonly command: DefineCommandHandler;
} = {
	query: (definition) => {
		if (definition.description.trim() === '')
			throw new Error('Query handler description cannot be empty');
		return { kind: 'query', ...definition, schema: Schema.toStandardSchemaV1(definition.schema) };
	},
	command: (definition) => {
		if (definition.description.trim() === '')
			throw new Error('Command handler description cannot be empty');
		return { kind: 'command', ...definition, schema: Schema.toStandardSchemaV1(definition.schema) };
	}
};

export const defineQueryHandler = HandlerAuthoring.query;
export const defineCommandHandler = HandlerAuthoring.command;

export interface TFileAttachment {
	name: string;
	contentType: 'HTML' | 'PDF' | 'CSV' | 'XLSX' | 'JSON' | 'TEXT' | 'BINARY';
	content: unknown;
}
export interface TExportAction {
	label: string;
	attachments: Array<TFileAttachment>;
	metadata?: Record<string, unknown>;
}
export type TExportManifest = Array<TExportAction>;
