/** Schema for identity/authZ collections that survive public-schema rebuilds. */
export const PROTECTED_AUTH_SCHEMA = 'norbital_auth';

/** Collections stored in {@link PROTECTED_AUTH_SCHEMA} instead of `public`. */
export const PROTECTED_AUTH_COLLECTIONS = new Set(['user', 'team', 'policy']);

const ei = (id: string) => `"${id.replace(/"/g, '""')}"`;

export function collectionSchema(_collectionName: string): string {
	return 'public';
}

export function relationshipSchema(from: string, to: string): string {
	if (PROTECTED_AUTH_COLLECTIONS.has(from) && PROTECTED_AUTH_COLLECTIONS.has(to)) {
		return collectionSchema(from);
	}
	return 'public';
}

/** Unqualified table id: `c_<collection>`. */
export function tableName(collectionName: string): string {
	return collectionName;
}

/** Escaped qualified table ref for SQL: `"schema"."c_<collection>"`. */
export function qualifiedTableName(collectionName: string): string {
	return `${ei(collectionSchema(collectionName))}.${ei(tableName(collectionName))}`;
}

/** Escaped qualified relationship (junction) table ref. */
export function qualifiedRelationshipTable(
	relationshipName: string,
	from: string,
	to: string
): string {
	return `${ei(relationshipSchema(from, to))}.${ei(relationshipName)}`;
}

/** Escaped qualified temporal history table ref. */
export function qualifiedHistoryTableName(collectionName: string): string {
	return `${ei(collectionSchema(collectionName))}.${ei(`${tableName(collectionName)}_history`)}`;
}

/** Idempotent bootstrap for the protected auth schema. */
export function protectedSchemaBootstrapSql(): string {
	return `CREATE SCHEMA IF NOT EXISTS ${ei(PROTECTED_AUTH_SCHEMA)};`;
}

/** Infer collection name from a relationship join column (`user_id`, `task_from_id`, …). */
export function joinColumnCollectionName(columnName: string): string {
	if (columnName.endsWith('_from_id')) {
		return columnName.slice(0, -'_from_id'.length);
	}
	if (columnName.endsWith('_to_id')) {
		return columnName.slice(0, -'_to_id'.length);
	}
	if (columnName.endsWith('_id')) {
		return columnName.slice(0, -3);
	}
	throw new Error(`Invalid relationship join column: ${columnName}`);
}
