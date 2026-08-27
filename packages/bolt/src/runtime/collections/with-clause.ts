import { Schema } from 'effect';

/**
 * How a `with` clause is read: which relations it names, which columns each of them keeps, and how
 * it recurses.
 *
 * The reading has two consumers that must agree exactly. `relation-query.ts` turns a clause into a
 * Drizzle relational query, and `authoring/schema.ts` turns the same clause into the `Schema` of the
 * row that query returns. A shape that selected columns by a different rule than a read does would
 * be a second grammar for one clause, and the type would stop describing the value.
 *
 * Nothing here knows about SQL, Effect or the collections service, so both consumers can depend on
 * it without either depending on the other.
 */

/** What a caller asked to load: `true`, or a nested spec that may narrow columns and recurse. */
export type WithSpec = Readonly<Record<string, unknown>>;

/** A `columns` clause, normalized to its boolean members. */
export type ColumnSelection = Readonly<Record<string, boolean>>;

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/**
 * Which of the available names a `columns` clause keeps.
 *
 * Naming any column `true` makes the clause a list of what to keep; naming only `false` members
 * makes it a list of what to drop. Stated over names rather than over a row because the rule has a
 * second caller that has no row to narrow: `authoring/schema.ts` decides which fields a struct is
 * assembled from, and a shape that selected columns by a different rule than a read does would be a
 * second grammar for one clause.
 */
export const selectedColumnNames = (
	names: ReadonlyArray<string>,
	columns: ColumnSelection | undefined
): ReadonlyArray<string> => {
	if (columns === undefined) return names;
	const entries = Object.entries(columns);
	if (entries.some(([, enabled]) => enabled)) return names.filter((name) => columns[name] === true);
	const excluded = new Set(entries.filter(([, enabled]) => !enabled).map(([name]) => name));
	return names.filter((name) => !excluded.has(name));
};

/** Reads the `columns` clause off a spec: boolean members only, and nothing when none were given. */
export const requestedColumns = (spec: unknown): ColumnSelection | undefined => {
	if (!isObject(spec)) return undefined;
	const columns = spec['columns'];
	if (!isObject(columns)) return undefined;
	const selected: Record<string, boolean> = {};
	for (const [name, enabled] of Object.entries(columns)) {
		if (typeof enabled === 'boolean') selected[name] = enabled;
	}
	return Object.keys(selected).length === 0 ? undefined : selected;
};

/** Reads the nested `with` clause off a spec, so a shape and a read recurse by the same reading. */
export const nestedWith = (spec: unknown): WithSpec | undefined => {
	if (!isObject(spec)) return undefined;
	const nested = spec['with'];
	return isObject(nested) ? nested : undefined;
};

/**
 * Reads a `with` clause into the relation names it names, ignoring entries switched off.
 *
 * Shared with `authoring/schema.ts`, which reads the same clause to decide which nested structs a
 * declared shape carries.
 */
export const requestedRelations = (spec: unknown): ReadonlyArray<string> =>
	isObject(spec)
		? Object.entries(spec)
				.filter(([, value]) => value !== false && value !== undefined)
				.map(([name]) => name)
		: [];

/** The entry a `with` clause carries for one relation, or `undefined` when it named it as `true`. */
export const relationSpec = (spec: unknown, name: string): unknown =>
	isObject(spec) ? spec[name] : undefined;

/**
 * The spec that applies to one arm of a polymorphic reference.
 *
 * A caller may narrow each target separately — `{ source: { TIME_ENTRY: { columns: … } } }` — or
 * state one narrowing that applies to every arm. The per-tag entry wins when it is there.
 */
export const referenceArmSpec = (spec: unknown, tag: string): unknown =>
	isObject(spec) ? (spec[tag] ?? spec) : spec;

/** A bounded whole number a caller may put on a relation's `limit` or `offset`. */
export const boundedCount = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
