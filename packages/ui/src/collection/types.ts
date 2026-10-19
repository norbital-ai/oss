import type { Value } from '@norbital-ai/std/kind';
import type { Json } from '@norbital-ai/std/wire';
import type { OrderBy } from '../filter/filter.js';
export type Values = { readonly [field: string]: Value };
export type Row = Values & { readonly id: string };
export type Page<T = Row> = { rows: readonly T[]; next: string | null };
/**
 * The workspace's names as its views see them. Empty here, so ui stays workspace-agnostic: `@norbital-ai/bolt` fills
 * `names` from the workspace's generated index, and `of`, `columns`, `values`, `record` and ids are then checked per
 * collection. Unfilled (a host, ui's own tests), any name and any row goes.
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmentation target
export interface Workspace {}
type Loose = {
	collections: {
		[c: string]: {
			row: Row;
			record: Row;
			insert: { readonly [field: string]: Json };
			where: { readonly [key: string]: Json };
			orderBy: OrderBy;
		};
	};
	queries: { [q: string]: { input: Json; output: unknown } };
	actions: { [a: string]: Values };
	automations: { [a: string]: Values };
};
type Shape = {
	collections: {
		[c: string]: { row: object; record: object; insert: object; where: unknown; orderBy: unknown };
	};
	queries: { [q: string]: { input: unknown; output: unknown } };
	actions: { [a: string]: unknown };
	automations: { [a: string]: unknown };
};
type Names = Workspace extends { names: infer N extends Shape }
	? [N] extends [never]
		? Loose
		: N
	: Loose;
type Collections = Names['collections'];
export type CollectionKey = keyof Collections & string;
/**
 * A collection's row as a view's read returns it (json, custom and file fields only when selected), its whole row as a
 * record view reads it, its create input, its filter and its sort.
 */
export type RowOf<C> = C extends keyof Collections ? Collections[C]['row'] : Row;
/** A collection's whole row as a record view reads it. */
export type RecordOf<C> = C extends keyof Collections ? Collections[C]['record'] : Row;
/** A collection's many-relations a view may name as a column (read with their labels, one statement). */
export type ManyOf<C> = C extends keyof Collections
	? Collections[C] extends { many: infer M extends string }
		? M
		: never
	: never;
/** A collection's create input. */
export type InsertOf<C> = C extends keyof Collections ? Collections[C]['insert'] : Values;
export type WhereOf<C> = C extends keyof Collections
	? Collections[C]['where']
	: Loose['collections'][string]['where'];
export type OrderByOf<C> = C extends keyof Collections
	? Collections[C]['orderBy']
	: Loose['collections'][string]['orderBy'];
export type FieldOf<C> = C extends unknown ? keyof RowOf<C> & string : never;
export type RecordFieldOf<C> = C extends unknown ? keyof RecordOf<C> & string : never;
export type IdOf<C> = C extends unknown
	? RowOf<C> extends { readonly id: infer I extends string }
		? I
		: string
	: never;
/** `'<c>.<q>'` queries and `'<c>.<verb|action>'` callables, with their inputs. */
export type QueryKey = keyof Names['queries'] & string;
export type QueryInputOf<N> = N extends keyof Names['queries']
	? Names['queries'][N]['input']
	: Json;
export type QueryOutputOf<N> = N extends keyof Names['queries']
	? Names['queries'][N]['output']
	: unknown;
export type ActionKey = keyof Names['actions'] & string;
export type ActionInputOf<N> = N extends keyof Names['actions'] ? Names['actions'][N] : Values;
