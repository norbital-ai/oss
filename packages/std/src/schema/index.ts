import type { StandardSchemaV1 } from '@standard-schema/spec';

export type { StandardSchemaV1 } from '@standard-schema/spec';
export type StandardSchemaIssue = StandardSchemaV1.Issue;

type SyncResult = { readonly issues?: readonly StandardSchemaV1.Issue[]; readonly value?: unknown };
type ValidationResult = SyncResult | PromiseLike<SyncResult>;

/**
 * Schema-backed type guard. Returns `true` + narrows to the schema's inferred type.
 * Every `isX(value: unknown): value is X` guard that checks multiple fields
 * should use this instead of hand-rolled duck typing.
 */
export function typeGuard<S extends StandardSchemaV1>(
	schema: S,
	value: unknown // stupidity:allow R5b -- canonical schema-backed predicate
): value is StandardSchemaV1.InferOutput<S> {
	const result = schema['~standard'].validate(value) as ValidationResult;
	if (result && typeof (result as PromiseLike<SyncResult>).then === 'function') return false;
	const sync = result as SyncResult;
	return !sync.issues;
}
