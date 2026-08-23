import { Schema } from 'effect';
import type { AnyPgColumnBuilder } from 'drizzle-orm/pg-core/columns/common';
import { date as pgDate } from 'drizzle-orm/pg-core/columns/date';
import { jsonb } from 'drizzle-orm/pg-core/columns/jsonb';
import { numeric as pgNumeric } from 'drizzle-orm/pg-core/columns/numeric';
import { text as pgText } from 'drizzle-orm/pg-core/columns/text';
import { timestamp as pgTimestamp } from 'drizzle-orm/pg-core/columns/timestamp';
import { uuid as pgUuid } from 'drizzle-orm/pg-core/columns/uuid';
import { vector as pgVector } from 'drizzle-orm/pg-core/columns/vector_extension/vector';
import type { WorkspaceAuthoringTypes } from './index.js';

/**
 * One authored index on a collection's table.
 *
 * Declared rather than left as `unknown`: the migration generator has to hand these to Drizzle to
 * decide whether an index changed, and an `unknown` it must re-narrow at the boundary is the same
 * declaration written twice — once loosely here and once defensively there.
 */
export interface ModelIndex {
	/** REQUIRED when any member is an expression — Drizzle cannot derive a name from raw SQL. */
	readonly name?: string;
	readonly columns: ReadonlyArray<string | { readonly expr: string }>;
	readonly unique?: boolean;
	/** Raw SQL predicate for a partial index. */
	readonly where?: string;
	readonly method?: 'btree' | 'hash' | 'gist' | 'gin' | 'brin' | 'spgist' | 'hnsw' | 'ivfflat';
	/** Column name to operator class, e.g. `{ title: 'gin_trgm_ops' }`. */
	readonly opclass?: Readonly<Record<string, string>>;
}

/**
 * One authored EXCLUDE constraint on a collection's table.
 *
 * Declared for the same reason `ModelIndex` is, and with more at stake: these are the effective-dating
 * guards — "no two rows overlap on this key" — and while `exclusions` stayed `unknown` nothing could
 * render them, so no EXCLUDE reached any database and the tables happily held the overlapping temporal
 * rows every payroll calculation assumes cannot exist.
 *
 * Deliberately narrower than the shape Pod carried: no `using` (an element mixing `=` with range `&&`
 * can only be served by gist, so the choice is not the author's) and no `where` (nothing declares one).
 * Both are additions the day a workspace needs them, not options carried empty.
 */
export interface ModelExclusion {
	/** Stable; becomes the Postgres constraint name, so it must be a lower_snake_case identifier. */
	readonly name: string;
	/** `<expr> WITH <operator>` members, rendered in the order declared. */
	readonly elements: ReadonlyArray<{ readonly expr: string; readonly with: string }>;
}

/**
 * What a `defineModel` declaration may say about the collection as a whole.
 *
 * Every key here is read by something; an option nothing reads is a lie in the authoring surface, so
 * `opsGuard`, `replica` and `insertOnly` were removed rather than left accepted. They had no
 * reference anywhere in this package and no declaration in any template — accepting them only bought
 * an author the belief that a flag had an effect.
 *
 * `tests/authoring/metadata-witness.test.ts` holds this interface against the function that reads
 * each key, so a key added here has to name its reader or be listed as knowingly unread.
 */
export interface ModelMetadata {
	readonly description?: string;
	/**
	 * The column, or columns, that name a record on screen.
	 *
	 * The array form compiles to the ` + ' · ' + ` concatenation `resolveRecordLabel` splits on, so a
	 * label survives term by term when one field is empty rather than collapsing to a uuid.
	 */
	readonly recordLabel?: string | ReadonlyArray<string>;
	readonly icon?: string;
	readonly history?: boolean;
	readonly approvalLock?: boolean;
	/** Whether readable rows belong in the browser replica. Defaults to true. */
	readonly sync?: boolean;
	readonly indexes?: ReadonlyArray<ModelIndex>;
	readonly exclusions?: ReadonlyArray<ModelExclusion>;
}

export interface ModelDeclaration<
	TColumns extends Readonly<Record<string, AnyModelFieldBuilder>> = Readonly<
		Record<string, AnyModelFieldBuilder>
	>
> {
	readonly __kind: 'model';
	readonly columns: TColumns;
	readonly metadata?: ModelMetadata;
}

type ReferenceDeleteAction = 'restrict' | 'cascade' | 'set null';
export type ReferenceTargets = Readonly<Record<string, string>>;

/** The one logical value exposed for a polymorphic reference, discriminated by its authored tag. */
export type ReferenceHandle<TTargets extends ReferenceTargets> = {
	readonly [Kind in keyof TTargets & string]: Readonly<{
		readonly kind: Kind;
		readonly id: string;
	}>;
}[keyof TTargets & string];

export interface ReferenceBuilder<
	TTargets extends ReferenceTargets = ReferenceTargets,
	TNotNull extends boolean = boolean,
	TUnique extends boolean = boolean
> {
	readonly __kind: 'reference';
	readonly targets: TTargets;
	readonly config: Readonly<{
		readonly notNull: TNotNull;
		readonly isUnique: TUnique;
		readonly onDelete: ReferenceDeleteAction;
	}>;
	/** Mirrors the part of a Drizzle builder's type witness consumed by the model contracts. */
	readonly _: Readonly<{
		readonly data: ReferenceHandle<TTargets>;
		readonly notNull: TNotNull;
		readonly hasDefault: false;
	}>;
	readonly notNull: () => ReferenceBuilder<TTargets, true, TUnique>;
	readonly unique: () => ReferenceBuilder<TTargets, TNotNull, true>;
	readonly onDelete: (
		action: ReferenceDeleteAction
	) => ReferenceBuilder<TTargets, TNotNull, TUnique>;
}

export type AnyModelFieldBuilder = AnyPgColumnBuilder | ReferenceBuilder;

const REFERENCE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const REFERENCE_TAG = /^[A-Z][A-Z0-9_]*$/;

const makeReferenceBuilder = <
	const TTargets extends ReferenceTargets,
	const TNotNull extends boolean,
	const TUnique extends boolean
>(
	targets: TTargets,
	notNull: TNotNull,
	isUnique: TUnique,
	onDelete: ReferenceDeleteAction
): ReferenceBuilder<TTargets, TNotNull, TUnique> =>
	Object.freeze({
		__kind: 'reference' as const,
		targets,
		config: Object.freeze({ notNull, isUnique, onDelete }),
		_: Object.freeze({
			data: undefined as never as ReferenceHandle<TTargets>,
			notNull,
			hasDefault: false as const
		}),
		notNull: () => makeReferenceBuilder(targets, true, isUnique, onDelete),
		unique: () => makeReferenceBuilder(targets, notNull, true, onDelete),
		onDelete: (action: ReferenceDeleteAction) =>
			makeReferenceBuilder(targets, notNull, isUnique, action)
	});

/**
 * Declares one logical field that may point at exactly one of the named collections.
 *
 * Tags are the stable application discriminator; collection names are the physical FK targets.
 * The database representation is generated later and never leaks into authored row types.
 */
export const reference = <const TTargets extends ReferenceTargets>(
	targets: TTargets
): ReferenceBuilder<TTargets, false, false> => {
	const entries = Object.entries(targets);
	if (entries.length < 2) throw new TypeError('reference() requires at least two targets.');
	for (const [tag, collection] of entries) {
		if (!REFERENCE_TAG.test(tag))
			throw new TypeError(`Reference tag ${JSON.stringify(tag)} must be UPPER_SNAKE_CASE.`);
		if (!REFERENCE_IDENTIFIER.test(collection))
			throw new TypeError(
				`Reference target ${JSON.stringify(collection)} must be a lower_snake_case collection name.`
			);
	}
	const collections = entries.map(([, collection]) => collection);
	if (new Set(collections).size !== collections.length)
		throw new TypeError('reference() cannot map multiple tags to the same target collection.');
	return makeReferenceBuilder<TTargets, false, false>(
		Object.freeze({ ...targets }),
		false,
		false,
		'restrict'
	);
};

const isReferenceBuilderValue = Schema.is(Schema.Struct({ __kind: Schema.Literal('reference') }));
export const isReferenceBuilder = (builder: AnyModelFieldBuilder): builder is ReferenceBuilder =>
	isReferenceBuilderValue(builder);

/** Small deterministic hash used to keep generated identifiers inside PostgreSQL's 63-byte limit. */
const identifierHash = (value: string): string => {
	let hash = 0x81_1c_9d_c5;
	for (const byte of new TextEncoder().encode(value)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01_00_01_93);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
};

/** Keeps generated reference columns, constraints, and indexes inside PostgreSQL's identifier cap. */
export const referenceDatabaseIdentifier = (...segments: ReadonlyArray<string>): string => {
	const identifier = segments.join('_');
	if (new TextEncoder().encode(identifier).length <= 63) return identifier;
	let prefix = '';
	for (const character of identifier) {
		if (new TextEncoder().encode(prefix + character).length > 54) break;
		prefix += character;
	}
	return `${prefix}_${identifierHash(identifier)}`;
};

/** Stable hidden UUID column used by the exclusive-arc storage representation. */
export const referenceStorageColumn = (field: string, tag: string): string => {
	if (!REFERENCE_IDENTIFIER.test(field))
		throw new TypeError(`Reference field ${JSON.stringify(field)} must be lower_snake_case.`);
	return referenceDatabaseIdentifier(`${field}__${tag.toLowerCase()}_id`);
};

/**
 * A `vector()` column's declared width, rejected at declaration time rather than at `CREATE TABLE`.
 *
 * The bound is pgvector's own: it refuses a dimension above 16 000, and a fraction or a zero is not
 * a width at all. Throwing here names the column's own declaration; letting it through surfaces as a
 * Postgres syntax error during a migration, with only the generated DDL to trace it back from.
 * `exclusiveMinimum` is what keeps `0` out — `Schema.Natural` admits it.
 */
const decodeVectorDimensions = Schema.decodeUnknownSync(
	Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_000, exclusiveMinimum: true }))
);

/** Keeps the Drizzle-backed column factories together so consumers retain native fluent builder identity. */
const ColumnAuthoring = {
	defineModel: <const TColumns extends Readonly<Record<string, AnyModelFieldBuilder>>>(
		columns: TColumns,
		metadata?: ModelMetadata
	): ModelDeclaration<TColumns> => ({
		__kind: 'model',
		columns,
		...(metadata === undefined ? {} : { metadata })
	}),
	/**
	 * Records the opt-in on the builder rather than dropping it.
	 *
	 * `text({ search: true })` was accepted and discarded, so nothing downstream knew which columns a
	 * free-text query may reach — and search matched nothing at all.
	 */
	searchable: <T>(builder: T, options: { readonly search?: boolean }): T => {
		if (options.search !== true) return builder;
		const config = Reflect.get(builder as object, 'config');
		if (config !== null && typeof config === 'object') Reflect.set(config, 'boltSearch', true);
		return builder;
	},
	text: (options: { readonly search?: boolean } = {}) =>
		ColumnAuthoring.searchable(pgText(), options),
	// No `variant`. It was accepted and discarded, and no workspace in any template repository ever
	// declared one — so there is nothing to preserve and nothing to implement against.
	numeric: () => pgNumeric({ mode: 'number' }),
	timestamp: () => pgTimestamp({ withTimezone: true }),
	dateRange: () => jsonb().$type<{ readonly start?: string; readonly end?: string }>(),
	geolocation: () =>
		jsonb().$type<{
			readonly geometry: { readonly lon: number; readonly lat: number } | null;
			readonly formatted_address: string;
			readonly type: 'Point';
			readonly srid: number;
		}>(),
	phone: (options: { readonly search?: boolean } = {}) =>
		ColumnAuthoring.searchable(pgText(), options),
	/**
	 * An uploaded file, stored as the file rather than as a pointer to one.
	 *
	 * The column held a `uuid` naming a `document_asset` row. Two things were wrong with that, and
	 * the second is why the collection is gone.
	 *
	 * **It never worked.** `WorkspaceUploadClient.beginUpload` mints a uuid, writes the bytes under
	 * it, and returns it — no row was ever inserted. The only writer of `document_asset` in the whole
	 * tree was the dev seeder, by raw SQL. So every file uploaded at runtime resolved against nothing
	 * and rendered empty, and had done since the table was introduced.
	 *
	 * **A pointer with no owner cannot be authorized.** `file()` emitted a bare `uuid` with no foreign
	 * key and nothing validated it on write, so any record could name any asset — and the asset row
	 * carried nothing saying which record it belonged to, so "may this person read this file" had no
	 * answer except a blanket grant to every authenticated subject, which is what existed. Inline, the
	 * metadata is a field of the record and inherits its row predicate and field mask: there is no id
	 * to forge and no second grant to widen.
	 *
	 * **`.array()` is deliberately unavailable.** `describeModelColumns` records only `dimensions` for
	 * a dimensioned builder and drops the scalar type, so `isJsonColumn` would answer false and every
	 * multi-file write would bind a JSON array as a Postgres array — the `worked_intervals` defect,
	 * reintroduced. `multiple: true` is one `jsonb` column holding a JSON array, which takes the
	 * binding path that already works.
	 */
	file: fileColumn,
	vector: (options: { readonly dimensions: number }) =>
		pgVector({ dimensions: decodeVectorDimensions(options.dimensions) }),
	hexToBinaryEmbedding: (hex: string): Array<number> => {
		if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0)
			throw new Error('hexToBinaryEmbedding expects an even-length hexadecimal string.');
		const embedding: Array<number> = [];
		for (const character of hex.toLowerCase()) {
			const nibble = Number.parseInt(character, 16);
			embedding.push((nibble >> 3) & 1, (nibble >> 2) & 1, (nibble >> 1) & 1, nibble & 1);
		}
		return embedding;
	},
	/**
	 * A `text` column that carries its declared members on the builder.
	 *
	 * The members used to be dropped — the argument was `_values` and the builder a bare `pgText()` —
	 * so `config.enumValues` was empty and the declaration-read path never saw them. Only the regex
	 * catalog recovered them from source, which is the exact split the introspection rewrite existed
	 * to end: the client offered a select of members that `describeModelColumns` could not confirm.
	 *
	 * The column stays `text`. `enum` on Drizzle's text builder is a value constraint the migration
	 * generator renders as `text` all the same, so this changes no DDL; a real Postgres enum type
	 * would be a separate, far larger change, and the members are a validation and rendering concern
	 * rather than a storage one. The parameter is deliberately not `const`: widening the members to
	 * `string` keeps the authored row types exactly as they are today, so recovering them costs no
	 * template a type error.
	 */
	enums: (values: readonly [string, ...string[]], options: { readonly search?: boolean } = {}) =>
		ColumnAuthoring.searchable(pgText({ enum: values }), options)
};

/**
 * What a `file()` column holds.
 *
 * `storage_key` is the identity and there is deliberately no `id` beside it: the upload
 * client writes bytes under `<uuid>.<ext>` and the uuid *is* the key's stem, so a second identifier
 * would be one more thing that can disagree with the first — which is the defect this shape exists
 * to remove.
 */
/**
 * The jsonb builder narrowed to what a `file()` column holds, named by construction.
 *
 * Written as `ReturnType` over a thunk because Drizzle's `$type` is a generic *method* — there is no
 * way to apply a type argument through an indexed access, so the builder has to be built to be
 * named.
 */
const oneFileColumn = () => jsonb().$type<FileRef>();
const manyFilesColumn = () => jsonb().$type<ReadonlyArray<FileRef>>();

/**
 * `file()`, declared apart from the object so it can carry overloads.
 *
 * Inside the object literal it was a single arrow whose body branched on `options.multiple`, and
 * TypeScript widened its return to the *union* of both builders. Every authored row then typed
 * `photo` as `FileRef | readonly FileRef[]`, so a template that read `photo.storage_key` did not
 * compile and one that passed it to `readFileAsset` did not either — a declaration-site detail
 * surfacing as a type error in somebody else's collection. The overloads make the literal
 * `multiple: true` decide, which is what an author writes and what the column actually is.
 */
function fileColumn(options?: {
	readonly mimeTypes?: ReadonlyArray<string>;
	readonly multiple?: false;
}): ReturnType<typeof oneFileColumn>;
function fileColumn(options: {
	readonly mimeTypes?: ReadonlyArray<string>;
	readonly multiple: true;
}): ReturnType<typeof manyFilesColumn>;
function fileColumn(
	options: {
		readonly mimeTypes?: ReadonlyArray<string>;
		readonly multiple?: boolean;
	} = {}
) {
	const builder = options.multiple === true ? manyFilesColumn() : oneFileColumn();
	const config = Reflect.get(builder, 'config');
	if (config !== null && typeof config === 'object') {
		if (options.mimeTypes !== undefined)
			Reflect.set(config, 'boltMimeTypes', [...options.mimeTypes]);
		Reflect.set(config, 'boltFile', true);
		if (options.multiple === true) Reflect.set(config, 'boltFileMultiple', true);
	}
	// The refusal the `file` comment describes, made real. Left to the prose alone it is a rule
	// nobody reads until the write has already bound a JSON array as a Postgres array, and that
	// failure surfaces at insert time in a template, nowhere near this declaration.
	Reflect.set(builder, 'array', () => {
		throw new Error(
			'file().array() is not supported: a dimensioned builder loses its scalar type, so the write would bind a JSON array as a Postgres array. Use file({ multiple: true }), which is one jsonb column holding a JSON array.'
		);
	});
	return builder as never;
}

export type FileRef = Readonly<{
	readonly storage_key: string;
	readonly file_name: string;
	readonly file_size: number;
	readonly mime_type: string;
}>;

export const defineModel = ColumnAuthoring.defineModel;
export const text = ColumnAuthoring.text;
export const numeric = ColumnAuthoring.numeric;
/** Uses Drizzle's native date builder directly so its fluent column type remains nominally identical for consumers. */
export { pgDate as date };
/** Owns timestamp behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const timestamp = ColumnAuthoring.timestamp;
/** Local wall-clock value (`HH:mm`) intentionally uses the native text builder and carries no timezone conversion. */
export { pgText as clockTime };
/** Owns date range behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const dateRange = ColumnAuthoring.dateRange;
/** Owns geolocation behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const geolocation = ColumnAuthoring.geolocation;
/** Owns phone behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const phone = ColumnAuthoring.phone;
/** Owns file behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const file = ColumnAuthoring.file;
/** Owns vector behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const vector = ColumnAuthoring.vector;
/** Owns hex to binary embedding behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const hexToBinaryEmbedding = ColumnAuthoring.hexToBinaryEmbedding;
/** Owns enums behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const enums = ColumnAuthoring.enums;
type CustomTypeValueMap = WorkspaceAuthoringTypes extends {
	readonly customTypeValues: infer Values;
}
	? Values
	: Readonly<Record<never, never>>;
type CustomTypeOptionsMap = WorkspaceAuthoringTypes extends {
	readonly customTypeOptions: infer Options;
}
	? Options
	: Readonly<Record<never, never>>;
type CustomTypeValue<Name extends string> = Name extends keyof CustomTypeValueMap
	? CustomTypeValueMap[Name]
	: unknown;
type CustomArguments<Name extends string> = Name extends keyof CustomTypeOptionsMap
	? [CustomTypeOptionsMap[Name]] extends [never]
		? readonly []
		: undefined extends CustomTypeOptionsMap[Name]
			? readonly [options?: Exclude<CustomTypeOptionsMap[Name], undefined>]
			: CustomTypeOptionsMap[Name] extends Readonly<Record<string, unknown>>
				? readonly [options: CustomTypeOptionsMap[Name]]
				: readonly []
	: readonly [];
/** Binds augmented custom-type names to JSONB without weakening their consumer-provided value and option maps. */
const customTypeColumn = {
	/**
	 * The declared name is recorded on the builder, not just carried in the type parameter.
	 *
	 * It used to be dropped entirely — the builder was an anonymous `jsonb()` — so at runtime nothing
	 * knew that a column was a `leave_event` rather than arbitrary JSON, and the closed union the
	 * author declared could not be enforced on write. Malformed values were stored rather than
	 * refused, and the damage only showed up much later as columns generated from them reading null.
	 */
	create: <const Name extends string>(name: Name, ..._arguments: CustomArguments<Name>) => {
		const builder = jsonb().$type<CustomTypeValue<Name>>();
		const config = Reflect.get(builder, 'config');
		if (config !== null && typeof config === 'object') Reflect.set(config, 'boltCustomType', name);
		return builder;
	}
};
export const custom = customTypeColumn.create;

/**
 * A UTC instant as authors store one: `2026-04-02T00:00:00.000Z`.
 *
 * The pattern fixes the grammar and the filter fixes the calendar, because the two reject different
 * things and only the pair rejects everything the zod `z.iso.datetime({ offset: false })` this
 * replaced did. The pattern alone admits `2024-02-30`, which `Date` silently rolls forward to March
 * — an effective-dated layer would then start on a day that does not exist and price a run from it.
 * A zoned spelling (`+08:00`) is refused rather than converted: these bounds are compared as strings
 * in places, so two spellings of one instant would order inconsistently.
 */
const UTC_INSTANT =
	/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/;
const isRealCalendarDay = Schema.makeFilter(
	(value: string) => {
		const parsed = new Date(value);
		return (
			(!Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value.slice(0, 10))) ||
			'must name a day that exists'
		);
	},
	{ title: 'realCalendarDay' }
);
const utcInstant = Schema.String.check(Schema.isPattern(UTC_INSTANT), isRealCalendarDay);

const dateRangeValueSchema = Schema.Struct({ start: utcInstant, end: utcInstant });
/**
 * The period a rule nested inside a custom type is in force for.
 *
 * Both bounds are required. The zod value this replaced declared both *optional* and was then used
 * five times in `hr-payroll` — twice through `.required()` and three times bare — but nothing on
 * either side of those three ever meant a half-open range: every renderer builds the pair, every
 * seeded row carries the pair, and an open-ended layer is written as a far-future `end`
 * (`9999-12-31T23:59:59.999Z`), never as an absent one. So the optional form was not a second shape
 * the domain has; it was a hole that let a range no reader can price reach the write boundary.
 * Restating it as an optional Effect schema plus a required one would preserve that hole and give
 * `.required()` a second life under another name.
 *
 * It carries `~standard` so it is both nestable in an author's `Schema.Struct` and directly usable
 * as a `defineCustomType` schema. `onExcessProperty: 'error'` is what makes a stray key a rejection
 * rather than a silent strip — a misspelled bound would otherwise validate as an absent one.
 *
 * Annotated rather than inferred: `Schema.toStandardSchemaV1` names its result through effect's own
 * `StandardSchemaV1` import of `@standard-schema/spec`, and a public export whose inferred type
 * reaches a dependency this package does not declare cannot be named in its declaration file — the
 * emitted `.d.ts` for the whole module silently disappeared over exactly that. The annotation is
 * `ReturnType` of the adapter's own instantiation, so the type is effect's and never restated.
 */
export const dateRangeSchema: ReturnType<
	typeof Schema.toStandardSchemaV1<typeof dateRangeValueSchema>
> = Schema.toStandardSchemaV1(dateRangeValueSchema, {
	parseOptions: { onExcessProperty: 'error' }
});

interface CustomTypeDefinition<
	Name extends string,
	S extends Schema.Top | ((options: never) => Schema.Top)
> {
	readonly name: Name;
	readonly description: string;
	readonly schema: S;
}
type CustomTypeResolvedSchema<
	D extends CustomTypeDefinition<string, Schema.Top | ((options: never) => Schema.Top)>
> = D['schema'] extends (...arguments_: never[]) => infer S
	? S extends Schema.Top
		? S
		: never
	: D['schema'];
/**
 * Resolved through the schema's own `Type` alone. It used to read `_zod.output` first, because a
 * zod object does not surface its output type any other way; with no zod left in the realm that
 * branch could only ever have matched a library nothing here uses.
 */
export type CustomTypeOutput<
	D extends CustomTypeDefinition<string, Schema.Top | ((options: never) => Schema.Top)>
> = Schema.Schema.Type<CustomTypeResolvedSchema<D>>;
export type CustomTypeFactoryOptions<
	D extends CustomTypeDefinition<string, Schema.Top | ((options: never) => Schema.Top)>
> = D['schema'] extends (options: infer O) => Schema.Top ? O : never;

const relationshipDelete = Symbol.for('@norbital-ai/bolt/relationship-on-delete');
/**
 * Owns custom declaration validation and non-enumerable relationship metadata.
 *
 * A non-factory schema is adapted to a Standard Schema here, with `onExcessProperty: 'error'`, so
 * the runtime's `~standard` validator keeps refusing keys the author's `z.strictObject` refused —
 * the strictness is the platform's default for custom-type values, not an option each author
 * re-declares. A factory is left untouched: it takes options the runtime does not have, so it is
 * never validated there anyway.
 */
const CustomTypeAuthoring = {
	define: <
		const Name extends string,
		const S extends Schema.Top | ((options: never) => Schema.Top)
	>(
		definition: CustomTypeDefinition<Name, S>
	): CustomTypeDefinition<Name, S> => {
		if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(definition.name))
			throw new Error(`Custom type name "${definition.name}" must be lower_snake_case.`);
		if (definition.description.trim() === '')
			throw new Error(`Custom type "${definition.name}" requires a non-empty description.`);
		const schema =
			typeof definition.schema === 'function'
				? definition.schema
				: Schema.toStandardSchemaV1(definition.schema, {
						parseOptions: { onExcessProperty: 'error' }
					});
		return Object.freeze({ ...definition, schema });
	},
	cascade: <T extends object>(relationship: T): T => {
		Reflect.defineProperty(relationship, relationshipDelete, {
			value: 'cascade',
			enumerable: false
		});
		return relationship;
	}
};
export const defineCustomType = CustomTypeAuthoring.define;
export const cascade = CustomTypeAuthoring.cascade;

/**
 * What a `group()` declaration may say about a group of apps.
 *
 * Stated as an interface rather than inferred from a schema: `group()` only constrains its argument
 * at compile time, and nothing in this package, in colony or in any template ever parsed the schema
 * that used to stand here. A validator no caller runs is not validation — it is a second, silently
 * divergent copy of this shape.
 */
export interface BoltGroupDefinition {
	readonly label: string;
	readonly description: string;
	readonly icon: string;
	readonly defaultChild?: string;
}
/** Owns small declarative control-flow helpers that do not alter their inferred consumer types. */
const DeclarationControls = {
	group: <const T extends BoltGroupDefinition>(definition: T): T => definition
};
export const group = DeclarationControls.group;
/**
 * Re-exported rather than declared here, because a refusal is now a typed error with a runtime
 * counterpart and this module is the shape of a table. It lives in `./refusal.js` beside the class
 * the runtime catches, so the throw and the catch are one file apart instead of one package apart.
 */
export { refuse } from './refusal.js';
