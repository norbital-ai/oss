import type { BuildQueryResult, DBQueryConfig, TablesRelationalConfig } from 'drizzle-orm';
import type { NorbitalTable } from './table.js';
import type { WorkspaceAuthoringTypes } from '../index.js';

/** Workspace schema value produced by the compiler-generated registry. */
export type AnySchema = {
	readonly tables: Readonly<Record<string, NorbitalTable<string>>>;
	readonly relations: TablesRelationalConfig;
	readonly inputs: Readonly<
		Record<
			string,
			{
				readonly create: unknown;
				readonly update: unknown;
			}
		>
	>;
};

/**
 * The compiler-merged workspace schema, or `AnySchema` when no generated types are present.
 *
 * Every authoring entry point defaults its schema generic to this. That is what makes an unannotated
 * handler exact: without it the generic falls back to `AnySchema`, whose `TableName` collapses to
 * `string`, so a misspelled collection type-checks and only fails at runtime.
 */
export type DefaultWorkspaceSchema = WorkspaceAuthoringTypes extends {
	readonly schema: infer TSchema extends AnySchema;
}
	? TSchema
	: AnySchema;

/**
 * The workspace's app ids, or `string` when no generated types are present.
 *
 * Same purpose as `DefaultWorkspaceSchema`, for the names that are cross-references rather than
 * schemas. An app id that only ever appears as `string` is compared by exact match at runtime, so a
 * typo neither errors nor grants — it silently revokes the app the author meant to allow.
 */
export type DefaultAppName = WorkspaceAuthoringTypes extends {
	readonly appName: infer TName extends string;
}
	? TName
	: string;

/**
 * The workspace's policy names, or `string` when no generated types are present.
 *
 * Lets one declaration reference another by name and have it checked — a channel naming the policy its
 * agent acts under is the case this exists for.
 */
export type DefaultPolicyName = WorkspaceAuthoringTypes extends {
	readonly policyName: infer TName extends string;
}
	? TName
	: string;

export type TableName<S extends AnySchema> = keyof S['tables'] & string;

export type SchemaRow<S extends AnySchema, N extends TableName<S>> = S['tables'][N]['$inferSelect'];

type QueryScalar = string | number | boolean | bigint | Date | null;

type QueryOperand<T> =
	Exclude<T, undefined> extends QueryScalar
		? Exclude<T, undefined>
		: Exclude<T, null | undefined> extends readonly (infer Item)[]
			? Item
			: unknown;

export type SchemaFieldFilter<T> = {
	readonly eq?: QueryOperand<T>;
	readonly ne?: QueryOperand<T>;
	readonly gt?: QueryOperand<T>;
	readonly gte?: QueryOperand<T>;
	readonly lt?: QueryOperand<T>;
	readonly lte?: QueryOperand<T>;
	readonly in?: readonly QueryOperand<T>[];
	readonly notIn?: readonly QueryOperand<T>[];
	readonly like?: string;
	readonly notLike?: string;
	readonly ilike?: string;
	readonly notIlike?: string;
	readonly contains?: unknown;
	readonly overlaps?: unknown;
	readonly isNull?: boolean;
	readonly isNotNull?: boolean;
};

export type SchemaRawOperators = {
	readonly sql: (strings: TemplateStringsArray, ...values: readonly unknown[]) => unknown;
	readonly eq: (left: unknown, right: unknown) => unknown;
	readonly ne: (left: unknown, right: unknown) => unknown;
	readonly gt: (left: unknown, right: unknown) => unknown;
	readonly gte: (left: unknown, right: unknown) => unknown;
	readonly lt: (left: unknown, right: unknown) => unknown;
	readonly lte: (left: unknown, right: unknown) => unknown;
	readonly and: (...conditions: readonly unknown[]) => unknown;
	readonly or: (...conditions: readonly unknown[]) => unknown;
	readonly isNull: (value: unknown) => unknown;
	readonly isNotNull: (value: unknown) => unknown;
};

export type SchemaWhere<Row extends Record<string, unknown>> = {
	readonly [K in keyof Row]?: SchemaFieldFilter<Row[K]> | QueryOperand<Row[K]>;
} & {
	readonly AND?: readonly SchemaWhere<Row>[];
	readonly OR?: readonly SchemaWhere<Row>[];
	readonly NOT?: SchemaWhere<Row>;
	readonly RAW?: (
		table: Readonly<Record<keyof Row, unknown>>,
		operators: SchemaRawOperators
	) => unknown;
	/**
	 * A raw SQL predicate, as data rather than a callback.
	 *
	 * `RAW` is a function, so it cannot survive a policy: a declared policy is serialised to jsonb and
	 * round-tripped through the manifest, and a function silently becomes nothing — leaving a grant
	 * with empty conditions, which the guard reads as *unconditional*. `$sql` is a string, so it
	 * survives, and it is what a policy condition must use.
	 *
	 * `${path}` placeholders are resolved against the request scope at evaluation time and bound as
	 * positional parameters, so `${requestor.norbital_id}` is the current requestor and an unknown
	 * path throws rather than binding null.
	 */
	readonly $sql?: string;
};

export type SchemaColumnSelection<Row extends Record<string, unknown>> = Partial<
	Readonly<Record<keyof Row, boolean>>
>;

export type SchemaQueryConfig<S extends AnySchema, N extends TableName<S>> = {
	readonly where?: SchemaWhere<SchemaRow<S, N>>;
	readonly columns?: SchemaColumnSelection<SchemaRow<S, N>>;
	readonly orderBy?: Partial<Readonly<Record<keyof SchemaRow<S, N>, 'asc' | 'desc'>>>;
	readonly with?: Readonly<Record<string, boolean | Readonly<Record<string, unknown>>>>;
	readonly limit?: number;
	readonly offset?: number;
	readonly comment?: string | Readonly<Record<string, string | number | boolean | null>>;
};

type SelectedColumnKeys<Row, Columns> = true extends Columns[keyof Columns]
	? {
			[K in keyof Columns & keyof Row]: Columns[K] extends true ? K : never;
		}[keyof Columns & keyof Row]
	: Exclude<
			keyof Row,
			{
				[K in keyof Columns & keyof Row]: Columns[K] extends false ? K : never;
			}[keyof Columns & keyof Row]
		>;

type SelectedSchemaRow<Row, Config> = Config extends {
	readonly columns: infer Columns;
}
	? Pick<Row, SelectedColumnKeys<Row, Columns>>
	: Row;

export type SchemaQueryRow<
	S extends AnySchema,
	N extends TableName<S>,
	Cfg extends SchemaQueryConfig<S, N> | undefined = undefined
> = [Cfg] extends [undefined]
	? SchemaRow<S, N>
	: Cfg extends SchemaQueryConfig<S, N>
		? SelectedSchemaRow<SchemaRow<S, N>, Cfg>
		: never;

export type { BuildQueryResult, DBQueryConfig, TablesRelationalConfig };
