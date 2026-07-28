import {
	norbitalTable,
	type InferTableSelect,
	type NorbitalColumns,
	type NorbitalTable,
	type TableMeta
} from './table.js';

export type TableDeclaration<
	TName extends string = string,
	TInferSelect extends Record<string, unknown> = Record<never, never>
> = {
	readonly __kind: 'table';
	readonly name: TName;
	readonly table: NorbitalTable<TName, TInferSelect>;
};

export function defineTable<const TName extends string, const TColumns extends NorbitalColumns>(
	name: TName,
	columns: TColumns,
	meta?: TableMeta
): TableDeclaration<TName, InferTableSelect<TColumns>>;
export function defineTable<const TName extends string, const TColumns extends NorbitalColumns>(
	name: TName,
	columns: TColumns,
	extraConfig: Parameters<typeof norbitalTable<TName, TColumns>>[2],
	meta?: TableMeta
): TableDeclaration<TName, InferTableSelect<TColumns>>;
export function defineTable<const TName extends string, const TColumns extends NorbitalColumns>(
	name: TName,
	columns: TColumns,
	extraConfigOrMeta?: Parameters<typeof norbitalTable<TName, TColumns>>[2] | TableMeta,
	metaOrNothing?: TableMeta
): TableDeclaration<TName, InferTableSelect<TColumns>> {
	const extraConfig = typeof extraConfigOrMeta === 'function' ? extraConfigOrMeta : undefined;
	const meta = typeof extraConfigOrMeta === 'function' ? metaOrNothing : extraConfigOrMeta;
	const table =
		extraConfig !== undefined
			? norbitalTable(name, columns, extraConfig, meta)
			: meta !== undefined
				? norbitalTable(name, columns, meta)
				: norbitalTable(name, columns, {});
	return {
		__kind: 'table' as const,
		name,
		table
	};
}

// stupidity:allow R5b -- canonical discriminant guard for defineTable declarations.
export function isTableDeclaration(value: unknown): value is TableDeclaration {
	return (
		typeof value === 'object' &&
		value !== null &&
		'__kind' in value &&
		Reflect.get(value, '__kind') === 'table'
	);
}
