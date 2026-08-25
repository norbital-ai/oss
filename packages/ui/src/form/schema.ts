/**
 * @file schema.ts
 * @description The standard-schema v1 contract shared by form state and its draft storage,
 * defined here so storage reads the schema shape without importing the state class.
 */

/**
 * Structural constraint satisfied by any Standard Schema v1 schema, read through `~standard`.
 */
export type FormSchema = {
	readonly ['~standard']: {
		readonly validate: (data: unknown) => unknown;
	};
};

/** Extract the output type from a Standard Schema v1-compatible schema. */
export type InferSchema<S extends FormSchema> = S extends {
	readonly _output: infer T extends object;
}
	? T
	: object;
