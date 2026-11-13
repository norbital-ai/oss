import type { Value } from '@norbital-ai/store/kind';
import type { Json } from '@norbital-ai/store';
import type { OrderBy } from '../filter/order.js';
import type { Query } from '../client/contract.js';
export type Values = { readonly [field: string]: Value };
export type Row = Values & { readonly id: string };
/** A page of rows and its cursor; a read request root's page also counts every row it matches (`total`). */
export type Page<T = Row> = { rows: readonly T[]; next: string | null; total?: number };
/** A native table page or a supplied row array. */
export type SourceData<R extends Values> = Page<R> | readonly R[];
/**
 * The workspace's names as its views see them. Empty here, so ui stays workspace-agnostic: `@norbital-ai/bolt` fills
 * `names` from the workspace's generated index, and `of`, `columns`, `values`, `record` and ids are then checked per
 * model. Unfilled (a host, ui's own tests), any name and any row goes.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target
export interface Workspace {}
type Loose = {
	models: {
		[c: string]: {
			row: Row;
			record: Row;
			insert: { readonly [field: string]: Json };
			where: { readonly [key: string]: Json };
			order_by: OrderBy;
		};
	};
	actions: { [a: string]: Values };
	automations: { [a: string]: Values };
};
type Shape = {
	models: {
		[c: string]: { row: Values; record: Values; insert: Values; where: unknown; order_by: unknown };
	};
	actions: { [a: string]: unknown };
	automations: { [a: string]: Values };
};
type Unusable = { models: {}; actions: {}; automations: {} };
type Names = Workspace extends { names: infer N }
	? [N] extends [never]
		? Loose
		: unknown extends N
			? Unusable
			: N extends Shape
				? N
				: Unusable
	: Loose;
type Models = Names['models'];
export type ModelKey = keyof Models & string;
/** A model, a request with its own decoded answer, or caller-owned rows. */
export type ViewSource<R extends Values = Values> = ModelKey | Query<Readonly<Record<string, SourceData<R>>>> | readonly R[];
type SourcePageRow<T> = T extends { readonly rows: readonly (infer R extends Values)[] } ? R
	: T extends readonly (infer R extends Values)[] ? R : Values;
/** The row proved by the actual source supplied to a view. */
export type SourceRow<S> = S extends string ? RowOf<S> & Values
	: S extends Query<infer T> ? SourcePageRow<T[keyof T]>
	: S extends readonly (infer R extends Values)[] ? R : Values;
/** A model's declared cells, including many layers; other sources retain their own row fields. */
export type SourceColumns<S> = S extends string
	? RecordOf<S> & { readonly [M in ManyOf<S>]: readonly Row[] }
	: SourceRow<S>;
/**
 * A model's row as a view's read returns it (json, custom and file fields only when selected), its whole row as a
 * record view reads it, its create input, its filter and its sort.
 */
export type RowOf<C> = C extends keyof Models ? Models[C]['row'] : Row;
/** A model's whole row as a record view reads it. */
export type RecordOf<C> = C extends keyof Models ? Models[C]['record'] : Row;
/** A model's many-relations a view may name as a column (read with their labels, one statement). */
export type ManyOf<C> = C extends keyof Models
	? Models[C] extends { many: infer M extends string }
		? M
		: never
	: never;
/** A model's create input. */
export type InsertOf<C> = C extends keyof Models ? Models[C]['insert'] : Values;
export type WhereOf<C> = C extends keyof Models
	? Models[C]['where']
	: Loose['models'][string]['where'];
export type OrderByOf<C> = C extends keyof Models
	? Models[C]['order_by']
	: Loose['models'][string]['order_by'];
export type FieldOf<C> = C extends unknown ? keyof RowOf<C> & string : never;
export type RecordFieldOf<C> = C extends unknown ? keyof RecordOf<C> & string : never;
export type IdOf<C> = C extends unknown
	? RowOf<C> extends { readonly id: infer I extends string }
		? I
		: string
	: never;
/** A declared automation and its input as a native start form sees them. */
export type AutomationKey = keyof Names['automations'] & string;
/** A declared automation's input, as a native start form sees it. */
export type AutomationInputOf<N> = N extends keyof Names['automations']
	? Names['automations'][N]
	: Values;
