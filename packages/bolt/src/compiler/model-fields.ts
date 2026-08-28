import { compileModel } from '../authoring/model-introspection.js';
import { SYSTEM_COLLECTION_MODELS } from '../authoring/system-models.js';
import {
	collection,
	type FieldDefinition,
	type FieldType,
	type RelationDefinition
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
	instant: 'instant',
	geolocation: 'json',
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

type CustomTypeReference = Readonly<{
	readonly field: string;
	/** Absent when the call is not a string literal, which is itself an invalid declaration. */
	readonly name?: string;
}>;

/**
 * Reads every authored `custom('<name>')` reference from model fields.
 *
 * A dynamic expression is deliberately returned without a name rather than ignored. Datatype
 * identity is part of the compiled schema and renderer registry; if it is not a literal the
 * compiler cannot prove that the schema, catalog, renderer, and generated type all name one thing.
 */
export const extractCustomTypeReferences = (source: string): ReadonlyArray<CustomTypeReference> =>
	fieldWindows(source).flatMap(({ name: field, builder, window }) => {
		if (builder !== 'custom') return [];
		const match = window.match(/custom\(\s*(['"])([^'"]+)\1/);
		return [{ field, ...(match?.[2] === undefined ? {} : { name: match[2] }) }];
	});

/** Reads defineModel column builders from an authored +model.ts without executing it. */
export const extractModelFields = (source: string): Readonly<Record<string, FieldDefinition>> => {
	const fields: Record<string, FieldDefinition> = {};
	for (const { name, builder, window } of fieldWindows(source)) {
		const primaryKey = window.includes('.primaryKey()');
		const unique = window.includes('.unique()');
		fields[name] = {
			type: builderTypes[builder] ?? 'string',
			required: window.includes('.notNull()'),
			indexed: primaryKey || unique,
			...(primaryKey ? { primaryKey: true } : {}),
			...(unique ? { unique: true } : {})
		};
	}
	return fields;
};

/**
 * Authoring builder name → UI field kind.
 *
 * These strings are what `DataRenderer` / filters / icons switch on. Emitting the builder name or
 * the schema `ScalarType` (e.g. `instant`) makes a built-in column fall through to
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
	instant: 'instant',
	uuid: 'uuid',
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
	/** Whether the JSON column holds a list of its kind. */
	readonly array?: boolean;
	readonly nullable: boolean;
	/** A column the database computes; a form must not offer it as editable. */
	readonly readOnly?: boolean;
	readonly search?: boolean;
	readonly values?: ReadonlyArray<string>;
	/** The ISO codes a `money` datatype restricts its picker to, from `allowedCurrencies`. */
	readonly currencies?: ReadonlyArray<string>;
	/** The picker precision an instant or `instant_range` datatype declares. */
	readonly precision?: 'day' | 'minute';
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
		readonly cascade?: true;
	}>;
}>;

const stringListOption = (window: string, pattern: RegExp): ReadonlyArray<string> | undefined => {
	const match = window.match(pattern);
	const body = match?.[1];
	if (body === undefined) return undefined;
	const values = [...body.matchAll(/'([^']+)'/g)].flatMap((entry) =>
		entry[1] === undefined ? [] : [entry[1]]
	);
	return values.length === 0 ? undefined : values;
};

const enumValues = (window: string): ReadonlyArray<string> | undefined =>
	stringListOption(window, /enums\(\[([^\]]*)\]/);

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

/** The `allowedCurrencies` option a `money`-typed column declares, as the list a renderer may offer. */
const moneyCurrencies = (window: string): ReadonlyArray<string> | undefined => {
	return stringListOption(window, /allowedCurrencies:\s*\[([^\]]*)\]/);
};

/** The `precision: 'day' | 'minute'` option an instant or instant range declares, for its picker. */
const instantPrecision = (window: string): 'day' | 'minute' | undefined => {
	const precision = window.match(/precision:\s*'([a-z]+)'/)?.[1];
	return precision === 'day' || precision === 'minute' ? precision : undefined;
};

/** CollectionTable metadata: field kinds, search opt-in, and relations from `+relationship.ts`. */
export const extractCollectionCatalog = (
	name: string,
	source: string,
	relations: ReadonlyArray<RelationDefinition>
): CollectionCatalogEntry => {
	const fields: Array<CollectionCatalogField> = [];
	for (const { name: fieldName, builder, window } of fieldWindows(source)) {
		const customType = builder === 'custom' ? window.match(/custom\(\s*'([^']+)'/)?.[1] : undefined;
		const values = builder === 'enums' ? enumValues(window) : undefined;
		const currencies = customType === 'money' ? moneyCurrencies(window) : undefined;
		const precision =
			builder === 'instant' || customType === 'instant_range'
				? instantPrecision(window)
				: undefined;
		const relationCandidates = relations.filter(
			(candidate) => candidate.from?.collection === name && candidate.from.column === fieldName
		);
		// An inverse `many` edge inherits the child's foreign-key endpoints so ownership and cascade
		// planning can reason about the same physical constraint from either side. That inherited edge
		// is not the field's renderer relation, though: a payslip employment id points to one
		// employment, not to the parent's collection of payslips. Prefer the edge authored on this
		// collection and retain the inherited candidate only as compatibility for incomplete catalogs.
		const relation =
			relationCandidates.find((candidate) => candidate.source === name) ?? relationCandidates[0];
		fields.push({
			name: fieldName,
			// A `custom()` column is keyed by the type it declares, not by the word "custom": the renderer
			// registry resolves by kind, and every custom column sharing one kind would mean every one
			// of them rendering through whichever renderer happened to register last.
			kind: builder === 'custom' ? (customType ?? 'custom') : (catalogKinds[builder] ?? 'text'),
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
			...(currencies === undefined ? {} : { currencies }),
			...(precision === undefined ? {} : { precision }),
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
				cardinality: relation.cardinality,
				...(relation.cascade === true ? { cascade: true } : {})
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
	/**
	 * A parent-side `many` declaration normally omits endpoints because the owning foreign key is
	 * authored on the child's inverse `one`. Carry that one unambiguous fact onto the compiled edge
	 * so every artifact consumer — mutation validation, graph reconciliation, the relational read, and
	 * generated types — receives the same writable orientation. Direction names are deliberately irrelevant:
	 * `account_contacts` and `contact_account` are two UI names for the same reversed collections.
	 * Endpointless through-relations and multiple possible inverse foreign keys remain unresolved.
	 */
	return relations.map((relation) => {
		if (relation.cardinality !== 'many') return relation;
		const inverse = relations.filter((candidate) => {
			if (
				candidate.cardinality !== 'one' ||
				candidate.source !== relation.target ||
				candidate.target !== relation.source ||
				candidate.from === undefined ||
				candidate.to === undefined
			)
				return false;
			const endpoints = new Set([candidate.from.collection, candidate.to.collection]);
			return endpoints.has(relation.target) && endpoints.has(relation.source);
		});
		const resolved = inverse.length === 1 ? inverse[0] : undefined;
		const inheritedCascade = relation.cascade === true || resolved?.cascade === true;
		const needsEndpoints = relation.from === undefined && relation.to === undefined;
		return {
			...relation,
			...(inheritedCascade ? { cascade: true } : {}),
			...(needsEndpoints && resolved?.from !== undefined && resolved.to !== undefined
				? { from: resolved.from, to: resolved.to }
				: {})
		};
	});
};

/**
 * The platform's own collections, in the shape the client catalog speaks.
 *
 * The catalog was built only from authored `+model.ts` files under `src/collections`, so it
 * described exactly the collections a workspace declares and none the platform declares for it.
 * The shell's own Approvals surface renders `CollectionTable collection="approval_request"`, and
 * `WorkspaceApis.create` answers an unknown collection with `{ fields: [] }` rather than failing —
 * so every column that table declared was reported as unknown and the whole workspace client
 * refused to load with `declares unknown column "collection_name"`. The column existed; the
 * collection was never published to the client at all.
 *
 * `ScalarType` is coarser than an authored builder name, which is the point: these entries come
 * from the compiled declaration rather than from scraped source text, so a system model can never
 * drift from the catalog the way a regex over source can.
 */
const systemCatalogKinds: Readonly<Record<FieldType, string>> = {
	string: 'text',
	uuid: 'uuid',
	number: 'number',
	boolean: 'boolean',
	instant: 'instant',
	json: 'json',
	reference: 'reference'
};

export const systemCollectionCatalog = (): ReadonlyArray<CollectionCatalogEntry> =>
	Object.entries(SYSTEM_COLLECTION_MODELS).map(([name, declaration]) => {
		const compiled = compileModel(collection({ name, fields: {} }), declaration);
		return {
			name,
			fields: Object.entries(compiled.fields).map(([fieldName, field]) => ({
				name: fieldName,
				kind: systemCatalogKinds[field.type] ?? 'text',
				nullable: !field.required,
				...(field.generated === undefined ? {} : { readOnly: true as const })
			})),
			relationships: []
		};
	});
