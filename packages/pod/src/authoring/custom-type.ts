import type { StandardSchemaV1 } from '@standard-schema/spec';

export type CustomTypeSchema<TOutput = unknown> = StandardSchemaV1<unknown, TOutput> & {
	readonly parse: (value: unknown) => TOutput;
};

export type CustomTypeDefinition<
	TName extends string = string,
	TSchema extends CustomTypeSchema | ((options: never) => CustomTypeSchema) = CustomTypeSchema
> = Readonly<{
	name: TName;
	/**
	 * What this type holds and why it is a type rather than a column, carried into the manifest.
	 *
	 * A custom type is the one thing on a collection whose meaning is not visible from the model: the
	 * column reads `settlement_policy` and the shape behind it lives in another directory entirely.
	 */
	description: string;
	schema: TSchema;
}>;

export type AnyCustomTypeDefinition = CustomTypeDefinition<
	string,
	CustomTypeSchema | ((options: never) => CustomTypeSchema)
>;

export type CustomTypeResolvedSchema<TDefinition extends AnyCustomTypeDefinition> =
	TDefinition['schema'] extends (...arguments_: never[]) => infer TSchema
		? TSchema extends CustomTypeSchema
			? TSchema
			: never
		: TDefinition['schema'];

export type CustomTypeOutput<TDefinition extends AnyCustomTypeDefinition> =
	TDefinition['schema'] extends (...arguments_: never[]) => infer TSchema
		? SchemaOutput<TSchema>
		: SchemaOutput<TDefinition['schema']>;

type SchemaOutput<TSchema> = TSchema extends {
	readonly _zod: { readonly output: infer TOutput };
}
	? TOutput
	: TSchema extends CustomTypeSchema
		? StandardSchemaV1.InferOutput<TSchema>
		: never;

export type CustomTypeFactoryOptions<TDefinition extends AnyCustomTypeDefinition> =
	TDefinition['schema'] extends (options: infer TOptions) => CustomTypeSchema ? TOptions : never;

/** Define the single schema authority for a filesystem-backed custom type. */
export function defineCustomType<
	const TName extends string,
	const TSchema extends CustomTypeSchema | ((options: never) => CustomTypeSchema)
>(definition: CustomTypeDefinition<TName, TSchema>): CustomTypeDefinition<TName, TSchema> {
	if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(definition.name)) {
		throw new Error(`Custom type name "${definition.name}" must be lower_snake_case.`);
	}
	if (!definition.description.trim()) {
		throw new Error(`Custom type "${definition.name}" requires a non-empty description.`);
	}
	return Object.freeze({
		name: definition.name,
		description: definition.description,
		schema: definition.schema
	});
}

export function resolveCustomTypeSchema(
	definition: AnyCustomTypeDefinition,
	options: Readonly<Record<string, unknown>> | undefined
): CustomTypeSchema {
	if (typeof definition.schema === 'function') return definition.schema(options as never);
	if (options && Object.keys(options).length > 0) {
		throw new Error(`Custom type "${definition.name}" does not accept factory options.`);
	}
	return definition.schema;
}
