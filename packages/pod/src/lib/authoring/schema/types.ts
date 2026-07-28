import type { BuildQueryResult, DBQueryConfig, TablesRelationalConfig } from 'drizzle-orm';
import type { NorbitalTable } from './table.js';

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
