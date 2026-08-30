/**
 * A trusted SQL row predicate that is valid only on a policy read grant.
 *
 * The discriminated object is intentionally plain JSON: authored policies are serialized into the
 * workspace manifest before the runtime compiles them. Collection queries never accept this type.
 */
export type PolicySqlPredicate = Readonly<{
	readonly kind: 'policy-sql';
	readonly statement: string;
}>;

/** Authors one serialized, policy-only trusted SQL predicate. */
export const policySql = (statement: string): PolicySqlPredicate => {
	if (statement.trim() === '') throw new TypeError('policySql requires a non-empty SQL statement.');
	return Object.freeze({ kind: 'policy-sql', statement });
};

/** Narrows decoded policy metadata at the runtime boundary. */
export const isPolicySqlPredicate = (value: unknown): value is PolicySqlPredicate =>
	value !== null &&
	typeof value === 'object' &&
	!Array.isArray(value) &&
	Reflect.get(value, 'kind') === 'policy-sql' &&
	typeof Reflect.get(value, 'statement') === 'string';
