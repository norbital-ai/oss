import type { Value } from '@norbital-ai/std/kind';
import type { Json } from '@norbital-ai/std/wire';
import type { OrderBy } from '../filter/filter.js';
export type Values = { readonly [field: string]: Value };
export type Row = Values & { readonly id: string };
/** A page of rows and its cursor; a read request root's page also counts every row it matches (`total`). */
export type Page<T = Row> = { rows: readonly T[]; next: string | null; total?: number };
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
			orderBy: OrderBy;
		};
	};
	actions: { [a: string]: Values };
	automations: { [a: string]: Values };
};
type Shape = {
	models: {
		[c: string]: { row: Values; record: Values; insert: Values; where: unknown; orderBy: unknown };
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
	? Models[C]['orderBy']
	: Loose['models'][string]['orderBy'];
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
