import { Effect, Schema } from 'effect';
import type { RelationDefinition, WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';

/**
 * Resolves a query's `with` clause: the related records a surface needs to show a label instead of
 * a key.
 *
 * Without it a table renders `pay_component_id` as a raw uuid, or as the dash its label function
 * falls back to. The app already asks for the relation — the query path simply dropped the clause,
 * so the answer never arrived.
 *
 * Prefetching runs through the caller's own authorized read rather than issuing SQL of its own.
 * That is the whole point of taking `read` as a parameter: a related record is subject to exactly
 * the policy and row visibility that a direct query of that collection would be, so `with` can
 * never become a way to see rows a subject could not otherwise read. It also keeps this a batched
 * read — one query per relation per level, not one per row.
 */

/** What a caller asked to load: `true`, or a nested spec that may narrow columns and recurse. */
type WithSpec = Readonly<Record<string, unknown>>;

type PrefetchRead = (
	collection: string,
	column: string,
	values: ReadonlyArray<Schema.Json>
) => Effect.Effect<ReadonlyArray<Schema.Json>, never>;

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** Decodes a `Json` value as the readonly row arm, in one pass. */
const isRow = Schema.is(Schema.JsonObject);

const asRow = (value: Schema.Json): Readonly<Record<string, Schema.Json>> | undefined =>
	isRow(value) ? value : undefined;

/**
 * Reads which side of a relation holds the foreign key.
 *
 * A declaration names its endpoints as `from`/`to` in the order the author wrote them, which is not
 * necessarily source-then-target — so the orientation is resolved against the collection being
 * queried rather than assumed.
 */
const orientation = (
	relation: RelationDefinition,
	source: string
): Readonly<{ readonly sourceColumn: string; readonly targetColumn: string }> | undefined => {
	const { from, to } = relation;
	if (from === undefined || to === undefined) return undefined;
	if (from.collection === source) return { sourceColumn: from.column, targetColumn: to.column };
	if (to.collection === source) return { sourceColumn: to.column, targetColumn: from.column };
	return undefined;
};

type ColumnSelection = Readonly<Record<string, boolean>>;

/** Narrows a related record with the same inclusive/exclusive rules as a base collection query. */
const project = (
	row: Readonly<Record<string, Schema.Json>>,
	columns: ColumnSelection | undefined
): Readonly<Record<string, Schema.Json>> => {
	if (columns === undefined) return row;
	const entries = Object.entries(columns);
	if (entries.some(([, enabled]) => enabled))
		return Object.fromEntries(Object.entries(row).filter(([name]) => columns[name] === true));
	const excluded = new Set(entries.filter(([, enabled]) => !enabled).map(([name]) => name));
	return Object.fromEntries(Object.entries(row).filter(([name]) => !excluded.has(name)));
};

const requestedColumns = (spec: unknown): ColumnSelection | undefined => {
	if (!isObject(spec)) return undefined;
	const columns = spec['columns'];
	if (!isObject(columns)) return undefined;
	const selected: Record<string, boolean> = {};
	for (const [name, enabled] of Object.entries(columns)) {
		if (typeof enabled === 'boolean') selected[name] = enabled;
	}
	return Object.keys(selected).length === 0 ? undefined : selected;
};

const nestedWith = (spec: unknown): WithSpec | undefined => {
	if (!isObject(spec)) return undefined;
	const nested = spec['with'];
	return isObject(nested) ? nested : undefined;
};

/** Reads a `with` clause into the relation names it names, ignoring entries switched off. */
export const requestedRelations = (spec: unknown): ReadonlyArray<string> =>
	isObject(spec)
		? Object.entries(spec)
				.filter(([, value]) => value !== false && value !== undefined)
				.map(([name]) => name)
		: [];

/**
 * Attaches every relation named in `spec` to `rows`, recursing into nested `with` clauses.
 *
 * A relation that cannot be resolved — unknown name, or endpoints the declaration never gave — is
 * left off rather than guessed at. A surface then renders its own fallback, which is a better
 * outcome than attaching a wrong record.
 */
export const attachRelations = (
	definition: WorkspaceDefinition,
	collection: string,
	rows: ReadonlyArray<Schema.Json>,
	spec: unknown,
	read: PrefetchRead
): Effect.Effect<ReadonlyArray<Schema.Json>, never> =>
	Effect.gen(function* () {
		const names = requestedRelations(spec);
		if (names.length === 0 || rows.length === 0) return rows;

		// Rows are rebuilt as plain records once, then mutated per relation, so N relations cost N
		// batched reads rather than N copies of the whole page.
		const attached: Array<Record<string, Schema.Json>> = [];
		for (const row of rows) {
			const record = asRow(row);
			if (record === undefined) return rows;
			attached.push({ ...record });
		}

		for (const name of names) {
			const reference = definition.collections?.find((entry) => entry.name === collection)?.fields[
				name
			]?.reference;
			if (reference !== undefined) {
				const entry = isObject(spec) ? spec[name] : undefined;
				yield* Effect.forEach(
					reference.targets,
					(target) =>
						Effect.gen(function* () {
							const ids = [
								...new Set(
									attached.flatMap((row) => {
										const handle = row[name];
										return isObject(handle) &&
											handle['kind'] === target.tag &&
											typeof handle['id'] === 'string'
											? [handle['id']]
											: [];
									})
								)
							];
							if (ids.length === 0) return;
							const targetSpec = isObject(entry) ? entry[target.tag] : entry;
							const related = yield* read(target.collection, 'id', ids);
							const deeper = nestedWith(targetSpec);
							const resolved =
								deeper === undefined
									? related
									: yield* attachRelations(definition, target.collection, related, deeper, read);
							const columns = requestedColumns(targetSpec);
							const byId = new Map<string, Readonly<Record<string, Schema.Json>>>();
							for (const value of resolved) {
								const record = asRow(value);
								if (record !== undefined && typeof record['id'] === 'string')
									byId.set(record['id'], project(record, columns));
							}
							for (const row of attached) {
								const handle = row[name];
								if (
									!isObject(handle) ||
									handle['kind'] !== target.tag ||
									typeof handle['id'] !== 'string'
								)
									continue;
								row[name] = {
									kind: target.tag,
									id: handle['id'],
									record: byId.get(handle['id']) ?? null
								};
							}
						}),
					{ concurrency: 'unbounded', discard: true }
				);
				continue;
			}
			const relation = definition.relations.find(
				(candidate) => candidate.source === collection && candidate.name === name
			);
			if (relation === undefined) continue;
			const sides = orientation(relation, collection);
			if (sides === undefined) continue;

			const keys = [
				...new Set(
					attached.flatMap((row) => {
						const value = row[sides.sourceColumn];
						return value == null ? [] : [value];
					})
				)
			];
			if (keys.length === 0) continue;

			const related = yield* read(relation.target, sides.targetColumn, keys);
			const entry = isObject(spec) ? spec[name] : undefined;
			const columns = requestedColumns(entry);
			const deeper = nestedWith(entry);
			const resolved =
				deeper === undefined
					? related
					: yield* attachRelations(definition, relation.target, related, deeper, read);

			// Grouped by the key each related row joins on, so attaching is a lookup per parent row.
			const byKey = new Map<string, Array<Readonly<Record<string, Schema.Json>>>>();
			for (const value of resolved) {
				const record = asRow(value);
				if (record === undefined) continue;
				const key = JSON.stringify(record[sides.targetColumn] ?? null);
				const bucket = byKey.get(key);
				if (bucket === undefined) byKey.set(key, [project(record, columns)]);
				else bucket.push(project(record, columns));
			}

			for (const row of attached) {
				const matches = byKey.get(JSON.stringify(row[sides.sourceColumn] ?? null)) ?? [];
				// A `one` relation that matched nothing is null, not an empty object: a surface tests
				// for absence, and `{}` reads as a record that exists but has lost all its fields.
				row[name] = relation.cardinality === 'many' ? matches : (matches[0] ?? null);
			}
		}

		return attached;
	});
