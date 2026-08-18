/**
 * What a record detail panel shows, and in what order.
 *
 * Three sources, in descending authority: the collection's declared fields, the client column
 * catalog, and — when a workspace has neither — the record itself. The last case is what keeps a
 * detail panel from rendering blank for a collection the manifest has not caught up with; inferring
 * a kind from a value is a worse answer than a declaration, but it is a far better one than nothing.
 */

export type DetailFieldKind = 'string' | 'number' | 'boolean' | 'json' | 'datetime';

export type DetailField = Readonly<{
	readonly name: string;
	readonly kind: DetailFieldKind;
	readonly nullable: boolean;
	readonly values?: ReadonlyArray<string>;
	readonly relation?: Readonly<{ readonly name: string; readonly target: string }>;
}>;

export type CollectionColumn = Readonly<{
	readonly name: string;
	readonly type: string;
	readonly required?: boolean;
	readonly generated?: boolean;
	readonly values?: ReadonlyArray<string>;
}>;

export type CollectionRelation = Readonly<{
	readonly name: string;
	readonly target: string;
	readonly cardinality?: string;
}>;

/** System columns are row bookkeeping; a detail panel shows the record, not its plumbing. */
const isSystem = (name: string): boolean => name === 'id' || name.startsWith('norbital_');

const KINDS: Readonly<Record<string, DetailFieldKind>> = {
	string: 'string',
	number: 'number',
	boolean: 'boolean',
	datetime: 'datetime',
	json: 'json'
};

const kindOf = (type: string): DetailFieldKind => KINDS[type] ?? 'string';

/** Infers a kind from a value when nothing declared one. */
const inferKind = (value: unknown): DetailFieldKind => {
	if (typeof value === 'boolean') return 'boolean';
	if (typeof value === 'number') return 'number';
	if (value !== null && typeof value === 'object') return 'json';
	return 'string';
};

/**
 * A relation is attached by matching the declared relation whose name is the field's name minus its
 * `_id` suffix, which is the convention the compiler emits foreign keys under.
 */
const relationFor = (
	field: string,
	relations: ReadonlyArray<CollectionRelation>
): DetailField['relation'] => {
	const base = field.endsWith('_id') ? field.slice(0, -'_id'.length) : field;
	const match = relations.find((relation) => relation.name === base || relation.target === `${base}s` || relation.target === base);
	return match === undefined ? undefined : { name: match.name, target: match.target };
};

export const resolveRecordDetailFields = (input: {
	readonly columns?: ReadonlyArray<CollectionColumn>;
	readonly relations?: ReadonlyArray<CollectionRelation>;
	readonly record?: Readonly<Record<string, unknown>>;
}): ReadonlyArray<DetailField> => {
	const relations = input.relations ?? [];
	const declared = (input.columns ?? []).filter((column) => !isSystem(column.name));
	const source: ReadonlyArray<DetailField> =
		declared.length > 0
			? declared.map((column) => ({
					name: column.name,
					kind: kindOf(column.type),
					// A generated column is computed by the database and can never be edited.
					nullable: column.generated === true ? true : column.required !== true,
					...(column.values === undefined ? {} : { values: column.values })
				}))
			: Object.entries(input.record ?? {})
					.filter(([name]) => !isSystem(name))
					.map(([name, value]) => ({ name, kind: inferKind(value), nullable: true }));

	return source.map((field) => {
		const relation = relationFor(field.name, relations);
		return relation === undefined ? field : { ...field, relation };
	});
};
