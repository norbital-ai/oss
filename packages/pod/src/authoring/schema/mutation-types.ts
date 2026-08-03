import type { SystemColumnName } from '@norbital-ai/platform-utils/system/column_names';
import type { NorbitalTable } from './table.js';

type AnyNorbitalTable = NorbitalTable<string>;

type InferNorbitalSelect<TTable extends AnyNorbitalTable> =
	TTable extends NorbitalTable<string, infer Row extends Record<string, unknown>>
		? Row
		: Record<string, unknown>;

type NullableKeys<Row extends Record<string, unknown>> = {
	[K in keyof Row]-?: null extends Row[K] ? K : never;
}[keyof Row];

type OptionalNullableFields<Row extends Record<string, unknown>> = Omit<Row, NullableKeys<Row>> &
	Partial<Pick<Row, NullableKeys<Row>>>;

/** Insert payload for a table (user columns only, no system columns). */
export type MutationInsert<TTable extends AnyNorbitalTable> = OptionalNullableFields<
	Omit<InferNorbitalSelect<TTable>, SystemColumnName>
>;
export type MutationUpdate<TTable extends AnyNorbitalTable> = Partial<MutationInsert<TTable>>;

export type MutationInsertFor<
	S extends { readonly tables: Record<string, AnyNorbitalTable> },
	N extends keyof S['tables'] & string
> = MutationInsert<S['tables'][N]>;

export type MutationUpdateFor<
	S extends { readonly tables: Record<string, AnyNorbitalTable> },
	N extends keyof S['tables'] & string
> = MutationUpdate<S['tables'][N]>;

/** Lightweight create/update values used by generated tenant type schemas. */
export type InputValuesForTables<TTables extends Record<string, AnyNorbitalTable>> = {
	readonly [K in keyof TTables & string]: {
		readonly create: MutationInsert<TTables[K]>;
		readonly update: MutationUpdate<TTables[K]>;
	};
};
