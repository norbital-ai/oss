import type {
	FieldDefinition,
	FieldType,
	RelationDefinition
} from '../authoring/workspace-schema.js';

const builderTypes: Readonly<Record<string, FieldType>> = {
	// No `uuid` entry, deliberately. A builder name is all this can see, and `uuid()` and
	// `uuid().array()` share it — `statutory_contributions.relief_for` is the second — so claiming
	// `uuid` here would plan a `uuid` column for an array. `describeModelColumns` reads the built
	// column and answers that question properly; this fallback stays conservative.
	integer: 'number',
	numeric: 'number',
	number: 'number',
	boolean: 'boolean',
	timestamp: 'datetime',
	datetime: 'datetime',
	geolocation: 'json',
	dateRange: 'json',
	jsonb: 'json',
	json: 'json',
	vector: 'json',
	reference: 'reference',
	// `custom()` is a jsonb column. Missing it planned `text`, so every custom value round-tripped
	// as a JSON *string* and every consumer reading `value.by` saw a character instead of a field.
	custom: 'json'
};

const fieldPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
const collectionBlockPattern =
	/^(?:\t|  )([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{([\s\S]*?)^(?:\t|  )\}/gm;
const relationCallPattern =
	/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(cascade\(\s*)?r\.(one|many)\.([A-Za-z_][A-Za-z0-9_]*)\(((?:\{[\s\S]*?\})?)\)/g;
const relationEndpointsPattern =
	/from:\s*r\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*,\s*to:\s*r\.([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * The source belonging to each declared field.
 *
 * A field's window used to run to the next `,\n<letter>`, which a JSDoc block between two fields
 * defeats: the boundary skipped the comment *and* the field after it, so flags were read from a
 * later declaration. `pay_components.nature` declares no `.notNull()` and was published to the
 * client as required, because its window reached `sequence: integer().notNull()`.
 *
 * The boundary is now the next match of the very pattern that defines a field, so a window cannot
 * disagree with what this module counts as a field.
 */
const fieldWindows = (
	source: string
): ReadonlyArray<{ readonly name: string; readonly builder: string; readonly window: string }> => {
	const matches = [...source.matchAll(fieldPattern)].filter((match) => {
		const name = match[1];
		return (
			name !== undefined &&
			match[2] !== undefined &&
			name !== 'import' &&
			name !== 'export' &&
			name !== 'from'
		);
	});
	return matches.map((match, index) => ({
		name: match[1] as string,
		builder: match[2] as string,
		window: source.slice(match.index ?? 0, matches[index + 1]?.index ?? source.length)
	}));
};

/** Reads defineModel column builders from an authored +model.ts without executing it. */
export const extractModelFields = (source: string): Readonly<Record<string, FieldDefinition>> => {
	const fields: Record<string, FieldDefinition> = {};
	for (const { name, builder, window } of fieldWindows(source)) {
		fields[name] = {
			type: builderTypes[builder] ?? 'string',
			required: window.includes('.notNull()'),
			indexed: window.includes('.primaryKey()')
		};
	}
	return fields;
};

/**
 * Authoring builder name → UI field kind.
 *
 * These strings are what `DataRenderer` / filters / icons switch on. Emitting the builder name or
 * the schema `ScalarType` (e.g. `dateRange`, `datetime`) makes a built-in column fall through to
 * the JSON textarea even though a dedicated renderer already exists.
 */
const catalogKinds: Readonly<Record<string, string>> = {
	text: 'text',
	phone: 'phone',
	enums: 'enum',
	integer: 'integer',
	numeric: 'numeric',
	number: 'number',
	boolean: 'boolean',
	date: 'date',
	timestamp: 'timestamp',
	datetime: 'timestamp',
	uuid: 'uuid',
	clockTime: 'clock_time',
	dateRange: 'date-range',
	geolocation: 'geolocation',
	file: 'file',
	vector: 'json',
	reference: 'reference',
	custom: 'custom',
	jsonb: 'json',
	json: 'json'
};

type CollectionCatalogField = Readonly<{
	readonly name: string;
	readonly kind: string;
	/** Whether the column holds a list of its kind — today only `file({ multiple: true })`. */
	readonly array?: boolean;
	readonly nullable: boolean;
	/** A column the database computes; a form must not offer it as editable. */
	readonly readOnly?: boolean;
	readonly search?: boolean;
	readonly values?: ReadonlyArray<string>;
	/**
	 * The relationship this column is the foreign key of.
	 *
	 * Without it a table renders `employment_id` as an unresolvable dash: the catalog listed the
	 * collection's relationships but nothing said which column each one travels over, so no renderer
	 * could turn the key into the related record's label.
	 */
	readonly relation?: Readonly<{
		readonly name: string;
		readonly target: string;
		readonly cardinality: 'one' | 'many';
	}>;
}>;

export type CollectionCatalogEntry = Readonly<{
	readonly name: string;
	readonly recordLabel?: string;
	readonly fields: ReadonlyArray<CollectionCatalogField>;
	readonly relationships: ReadonlyArray<{
		readonly name: string;
		readonly target: string;
		readonly cardinality: 'one' | 'many';
	}>;
}>;

const enumValues = (window: string): ReadonlyArray<string> | undefined => {
	const match = window.match(/enums\(\[([^\]]*)\]/);
	const body = match?.[1];
	if (body === undefined) return undefined;
	const values = [...body.matchAll(/'([^']+)'/g)].flatMap((entry) =>
		entry[1] === undefined ? [] : [entry[1]]
	);
	return values.length === 0 ? undefined : values;
};

/**
 * How the label terms are joined for the resolver that reads them.
 *
 * `resolveRecordLabel` splits a compiled label on exactly this separator and evaluates each term on
 * its own, so a single empty field costs its own term rather than the whole title. The catalog
 * therefore has to emit that form; emitting a bare list would be a label the resolver reads as one
 * unparseable expression.
 */
const LABEL_TERM_JOIN = " + ' · ' + ";

/**
 * The `recordLabel` a `defineModel` declares, in either form its type permits.
 *
 * The pattern used to require a quote straight after the colon, which only the single-column form
 * `recordLabel: 'summary'` satisfies. `ModelMetadata` has always also permitted
 * `recordLabel: ['code', 'name']` — the form ten of the payroll models use — and every one of those
 * labels was dropped entirely, leaving those tables titling their rows from the first non-uuid
 * column they happened to find.
 */
const recordLabel = (source: string): string | undefined => {
	const declaration = source.match(/recordLabel:\s*(\[[^\]]*\]|['"][^'"]+['"])/)?.[1];
	if (declaration === undefined) return undefined;
	if (!declaration.startsWith('[')) return declaration.slice(1, -1);
	const columns = [...declaration.matchAll(/['"]([^'"]+)['"]/g)].flatMap((match) =>
		match[1] === undefined ? [] : [match[1]]
	);
	return columns.length === 0 ? undefined : columns.join(LABEL_TERM_JOIN);
};

/** CollectionTable metadata: field kinds, search opt-in, and relations from `+relationship.ts`. */
export const extractCollectionCatalog = (
	name: string,
	source: string,
	relations: ReadonlyArray<RelationDefinition>
): CollectionCatalogEntry => {
	const fields: Array<CollectionCatalogField> = [];
	for (const { name: fieldName, builder, window } of fieldWindows(source)) {
		const values = builder === 'enums' ? enumValues(window) : undefined;
		const relation = relations.find(
			(candidate) => candidate.from?.collection === name && candidate.from.column === fieldName
		);
		fields.push({
			name: fieldName,
			// A `custom()` column is keyed by the type it declares, not by the word "custom": the renderer
			// registry resolves by kind, and every custom column sharing one kind would mean every one
			// of them rendering through whichever renderer happened to register last.
			kind:
				builder === 'custom'
					? (window.match(/custom\(\s*'([^']+)'/)?.[1] ?? 'custom')
					: (catalogKinds[builder] ?? 'text'),
			nullable: !window.includes('.notNull()'),
			// Safe only because a field's window now ends at the next field: while the boundary ran
			// past comments, this read `.generatedAlwaysAs(` from a later declaration and marked
			// ordinary columns read-only, which is a worse fault than the one it fixes.
			...(window.includes('.generatedAlwaysAs(') ? { readOnly: true } : {}),
			...(window.includes('search: true') ? { search: true } : {}),
			// A multi-file column, so a renderer offers one picker for many files rather than one.
			// Read from the declaration's own text, as every other flag here is.
			...(window.includes('multiple: true') ? { array: true } : {}),
			...(values === undefined ? {} : { values }),
			...(relation === undefined
				? {}
				: {
						relation: {
							name: relation.name,
							target: relation.target,
							cardinality: relation.cardinality
						}
					})
		});
	}
	const label = recordLabel(source);
	return {
		name,
		...(label === undefined ? {} : { recordLabel: label }),
		fields,
		relationships: relations
			.filter((relation) => relation.source === name)
			.map((relation) => ({
				name: relation.name,
				target: relation.target,
				cardinality: relation.cardinality
			}))
	};
};

/** Reads `+relationship.ts` `r.one` / `r.many` declarations without executing the authored module. */
export const extractRelationships = (source: string): ReadonlyArray<RelationDefinition> => {
	const relations: Array<RelationDefinition> = [];
	for (const block of source.matchAll(collectionBlockPattern)) {
		const sourceCollection = block[1];
		const body = block[2];
		if (sourceCollection === undefined || body === undefined) continue;
		for (const call of body.matchAll(relationCallPattern)) {
			const name = call[1];
			// Group 2 is the `cascade(` wrapper itself. It used to be a non-capturing group, so the
			// call was recognised, stripped and forgotten.
			const cascaded = call[2] !== undefined;
			const cardinality = call[3];
			const target = call[4];
			const endpoints =
				call[5] === undefined || call[5] === ''
					? undefined
					: call[5].match(relationEndpointsPattern);
			if (
				name === undefined ||
				(cardinality !== 'one' && cardinality !== 'many') ||
				target === undefined
			)
				continue;
			const fromCollection = endpoints?.[1];
			const fromColumn = endpoints?.[2];
			const toCollection = endpoints?.[3];
			const toColumn = endpoints?.[4];
			relations.push({
				name,
				source: sourceCollection,
				target,
				cardinality,
				...(cascaded ? { cascade: true } : {}),
				...(fromCollection === undefined || fromColumn === undefined
					? {}
					: { from: { collection: fromCollection, column: fromColumn } }),
				...(toCollection === undefined || toColumn === undefined
					? {}
					: { to: { collection: toCollection, column: toColumn } })
			});
		}
	}
	return relations;
};
