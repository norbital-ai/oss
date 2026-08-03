import type { z } from 'zod';
import type { AnySchema, TableName } from './types.js';

/** Collection mutation Zod schema — omit `input` to use the full schema; `.pick()` / `.omit()` to narrow. */
export function extract<S extends AnySchema, N extends TableName<S>>(
	schema: S,
	collection: N
): S['inputs'][N]['create'] {
	return schema.inputs[collection].create;
}

export type ExtractInput<S extends AnySchema, N extends TableName<S>> = S['inputs'][N]['create'];

export type InferZodInput<T> = T extends z.ZodType<infer U> ? U : never;
