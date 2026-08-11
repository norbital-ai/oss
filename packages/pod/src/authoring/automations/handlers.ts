import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { AnySchema, DefaultWorkspaceSchema } from '../schema/types.js';
import type { BeforeApi } from '../workspace/hook-api.js';

export type HandlerKind = 'query' | 'command';

export type HandlerDefinition<
	TSchema extends StandardSchemaV1 = StandardSchemaV1,
	TKind extends HandlerKind = HandlerKind,
	TOutput = unknown
> = {
	readonly kind: TKind;
	/**
	 * What this endpoint answers or does, carried into `manifest.handlers`.
	 *
	 * A remote is the one part of a workspace with no shape a reader can infer from: the name is
	 * author-chosen and the payload schema describes the request, not the effect.
	 */
	readonly description: string;
	readonly schema: TSchema;
	readonly handler: (payload: unknown, api: BeforeApi) => Promise<TOutput> | TOutput;
};

export type QueryHandlerDefinition<
	TSchema extends StandardSchemaV1 = StandardSchemaV1,
	TOutput = unknown
> = HandlerDefinition<TSchema, 'query', TOutput>;

export type CommandHandlerDefinition<
	TSchema extends StandardSchemaV1 = StandardSchemaV1,
	TOutput = unknown
> = HandlerDefinition<TSchema, 'command', TOutput>;

type TypedHandlerFn<S extends AnySchema, TSchema extends StandardSchemaV1, TOutput> = (
	payload: StandardSchemaV1.InferInput<TSchema>,
	api: BeforeApi<S>
) => Promise<TOutput> | TOutput;

/**
 * Runtime boundary: author-typed invoke handlers lose payload generics here.
 * Registry storage and remote dispatch use the returned erased signature only.
 */
function eraseTypedHandler<S extends AnySchema, TSchema extends StandardSchemaV1, TOutput>(
	handler: TypedHandlerFn<S, TSchema, TOutput>
): (payload: unknown, api: BeforeApi) => Promise<TOutput> | TOutput {
	return (payload, api) =>
		handler(
			payload as StandardSchemaV1.InferInput<TSchema>,
			api as unknown as BeforeApi<S> // stupidity: boundary-cast — dispatch provides the same registry API after generic erasure.
		);
}

export function defineQueryHandler<
	const TSchema extends StandardSchemaV1,
	S extends AnySchema = DefaultWorkspaceSchema,
	TOutput = unknown
>(def: {
	readonly description: string;
	readonly schema: TSchema;
	readonly handler: TypedHandlerFn<S, TSchema, TOutput>;
}): QueryHandlerDefinition<TSchema, TOutput> {
	if (!def.description.trim()) throw new Error('Query handler description cannot be empty');
	return {
		kind: 'query',
		description: def.description,
		schema: def.schema,
		handler: eraseTypedHandler(def.handler)
	};
}

export function defineCommandHandler<
	const TSchema extends StandardSchemaV1,
	S extends AnySchema = DefaultWorkspaceSchema,
	TOutput = unknown
>(def: {
	readonly description: string;
	readonly schema: TSchema;
	readonly handler: TypedHandlerFn<S, TSchema, TOutput>;
}): CommandHandlerDefinition<TSchema, TOutput> {
	if (!def.description.trim()) throw new Error('Command handler description cannot be empty');
	return {
		kind: 'command',
		description: def.description,
		schema: def.schema,
		handler: eraseTypedHandler(def.handler)
	};
}
