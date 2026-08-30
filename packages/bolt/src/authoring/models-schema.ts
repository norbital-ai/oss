import { Schema } from 'effect';
import type { AnyPgColumnBuilder } from 'drizzle-orm/pg-core/columns/common';
import { jsonb } from 'drizzle-orm/pg-core/columns/jsonb';
import { numeric as pgNumeric } from 'drizzle-orm/pg-core/columns/numeric';
import { text as pgText } from 'drizzle-orm/pg-core/columns/text';
import { timestamp as pgTimestamp } from 'drizzle-orm/pg-core/columns/timestamp';
import { vector as pgVector } from 'drizzle-orm/pg-core/columns/vector_extension/vector';
import { MoneyValueSchema } from '@norbital-ai/std/finance';
import type { WorkspaceAuthoringTypes } from './authoring-types.js';

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
 * One embedding of the whole record, over the attributes the author chooses.
 *
 * Record-level rather than per-attribute: what makes two job photographs the same scene is the
 * photograph together with what was written about it, and an embedding per column can only ever
 * compare halves. The platform maintains the vector as a system column, so authored code never
 * calls a model — it declares which fields mean something and searches with `findNearest`.
 *
 * `fields` names declared columns. Text-shaped columns contribute their text; `file()` columns
 * contribute their bytes as an image part, so a photograph participates directly rather than
 * through a caption about it.
 */
export interface ModelEmbedding<Field extends string = string> {
	/** Declared columns that feed the vector, in the order they are sent to the model. */
	readonly fields: ReadonlyArray<Field>;
	/** The embeddings model; the host's configured default when absent. */
	readonly model?: string;
	/** Matryoshka truncation, when the model supports it. The model's own width when absent. */
	readonly dimensions?: number;
}

/**
 * What a `defineModel` declaration may say about the collection as a whole.
 *
 * Every key here is read by something; an option nothing reads is a lie in the authoring surface, so
 * The authoring surface accepts no `opsGuard`, `replica` or `insertOnly` field: they have no
 * reference anywhere in this package and no declaration in any template — accepting them only bought
 * an author the belief that a flag had an effect.
 *
 * `tests/authoring/metadata-witness.test.ts` holds this interface against the function that reads
 * each key, so a key added here has to name its reader or be listed as knowingly unread.
 */
export interface ModelMetadata<Field extends string = string> {
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
	/** Whether writes to this collection are captured into the live-query changelog. Defaults to true. */
	readonly sync?: boolean;
	readonly indexes?: ReadonlyArray<ModelIndex>;
	readonly exclusions?: ReadonlyArray<ModelExclusion>;
	/** One platform-maintained vector over the named fields. See `ModelEmbedding`. */
	readonly embedding?: ModelEmbedding<Field>;
}

export interface ModelDeclaration<
	TColumns extends Readonly<Record<string, AnyModelFieldBuilder>> = Readonly<
		Record<string, AnyModelFieldBuilder>
	>
> {
	readonly __kind: 'model';
	readonly columns: TColumns;
	// Covariant on purpose: naming the fields through `keyof TColumns` here would make the
	// declaration invariant in its columns and strand every generic registry that stores one.
	// Authoring-time field checking happens on `defineModel`'s metadata parameter instead.
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

const validateEmbeddingDeclaration = (
	columns: Readonly<Record<string, AnyModelFieldBuilder>>,
	embedding: ModelEmbedding | undefined
): void => {
	if (embedding === undefined) return;
	if (embedding.fields.length === 0)
		throw new TypeError('A model embedding must name at least one source field.');
	const seen = new Set<string>();
	for (const field of embedding.fields) {
		if (seen.has(field)) throw new TypeError(`A model embedding names ${field} more than once.`);
		seen.add(field);
		const builder = columns[field];
		if (builder === undefined)
			throw new TypeError(`A model embedding names undeclared field ${field}.`);
		if (isReferenceBuilder(builder))
			throw new TypeError(`A model embedding field ${field} must be text or file data.`);
		const config = Reflect.get(builder, 'config');
		const embeddable =
			config !== null &&
			typeof config === 'object' &&
			(Reflect.get(config, 'dataType') === 'string' || Reflect.get(config, 'boltFile') === true);
		if (!embeddable)
			throw new TypeError(`A model embedding field ${field} must be text or file data.`);
	}
	if (embedding.dimensions !== undefined) decodeVectorDimensions(embedding.dimensions);
};

/** Keeps the Drizzle-backed column factories together so consumers retain native fluent builder identity. */
const ColumnAuthoring = {
	defineModel: <const TColumns extends Readonly<Record<string, AnyModelFieldBuilder>>>(
		columns: TColumns,
		metadata?: ModelMetadata<keyof TColumns & string>
	): ModelDeclaration<TColumns> => {
		validateEmbeddingDeclaration(columns, metadata?.embedding);
		return {
			__kind: 'model',
			columns,
			...(metadata === undefined ? {} : { metadata })
		};
	},
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
	/**
	 * One absolute point in time, stored as PostgreSQL `timestamptz` at the database's full
	 * precision. `precision` is deliberately application metadata only: it narrows the picker and
	 * formatter without changing what is stored or creating a second temporal column type.
	 */
	instant: (options: { readonly precision?: InstantPrecision } = {}) => {
		// `mode: 'string'` is the E2E contract, not a storage compromise. PostgreSQL still stores a
		// full-precision timestamptz, while hooks, approvals, sync, browser mutations and JSON payloads
		// all see the same serializable instant shape instead of alternating between Date and string.
		const builder = pgTimestamp({ withTimezone: true, mode: 'string' });
		const config = Reflect.get(builder, 'config');
		if (config !== null && typeof config === 'object' && options.precision !== undefined)
			Reflect.set(config, 'boltInstantPrecision', options.precision);
		return builder;
	},
	/**
	 * A contiguous run of wall-clock time with no calendar-day meaning, distinct from
	 * `instantRange` (below) which is anchored to instants. See ISO 8601 'time range'.
	 */
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

/**
 * One span the platform understands natively: a started instant and the instant it closed at, if it
 * has.
 *
 * `end` is `null` for an open span (live attendance), never absent — a range half missing is a
 * different shape that only one workspace in the realm uses, and it can keep its own spelling.
 */
export type InstantRangeValue = Readonly<{
	readonly start: string;
	readonly end: string | null;
}>;

/** What an instant picker exposes; storage remains a full-precision instant in both cases. */
export type InstantPrecision = 'day' | 'minute';

/** What an instant-range renderer offers: calendar days, or date-times. */
export const defineModel = ColumnAuthoring.defineModel;
export const text = ColumnAuthoring.text;
export const numeric = ColumnAuthoring.numeric;
/** Owns the only temporal scalar at the authoring boundary. */
export const instant = ColumnAuthoring.instant;
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
/**
 * The platform-owned field *value* names a `custom()` column may declare, with their platform value
 * types at the front and the workspace's own discovered datatypes merged in behind.
 *
 * `custom('name')` names a tenant datatype; the *value* type it resolves is sealed — a name that is
 * neither a platform-owned value type here nor an augmented tenant `customTypeValues` key falls to
 * `unknown` at the type level and is refused at sync time. This base map is why
 * `custom('money')` / `custom('instant_range')` are typed in any workspace without the tenant
 * restating them, and intersecting it with the augmented map is what makes the union carry both
 * halves.
 */
type CustomTypeValueMap = PlatformCustomTypeValueMap &
	(WorkspaceAuthoringTypes extends {
		readonly customTypeValues: infer Values;
	}
		? Values
		: Readonly<Record<never, never>>);
type PlatformCustomTypeValueMap = Readonly<{
	readonly [Name in keyof typeof platformCustomTypes]: CustomTypeOutput<
		(typeof platformCustomTypes)[Name]
	>;
}>;
type PlatformCustomTypeOptionsMap = Readonly<{
	readonly [Name in keyof typeof platformCustomTypes]: CustomTypeFactoryOptions<
		(typeof platformCustomTypes)[Name]
	>;
}>;
type CustomTypeOptionsMap = PlatformCustomTypeOptionsMap &
	(WorkspaceAuthoringTypes extends {
		readonly customTypeOptions: infer Options;
	}
		? Options
		: Readonly<Record<never, never>>);
type CustomTypeValue<Name extends string> = Name extends keyof CustomTypeValueMap
	? CustomTypeValueMap[Name]
	: unknown;
type CustomTypeName = Extract<keyof CustomTypeValueMap, string>;
type CustomColumnOptions<Name extends string> = Readonly<{ multiple?: boolean }> &
	(Name extends keyof CustomTypeOptionsMap
		? [CustomTypeOptionsMap[Name]] extends [never]
			? Readonly<Record<never, never>>
			: Exclude<CustomTypeOptionsMap[Name], undefined>
		: Readonly<Record<never, never>>);
type CustomArguments<Name extends string> = Name extends keyof CustomTypeOptionsMap
	? [CustomTypeOptionsMap[Name]] extends [never]
		? readonly [options?: CustomColumnOptions<Name>]
		: undefined extends CustomTypeOptionsMap[Name]
			? readonly [options?: CustomColumnOptions<Name>]
			: readonly [options: CustomColumnOptions<Name>]
	: readonly [options?: CustomColumnOptions<Name>];
type CustomColumnValue<Name extends string, Options> = Options extends { readonly multiple: true }
	? ReadonlyArray<CustomTypeValue<Name>>
	: CustomTypeValue<Name>;
/** Binds augmented custom-type names to JSONB without weakening their consumer-provided value and option maps. */
const customTypeColumn = {
	/**
	 * The declared name is recorded on the builder, not just carried in the type parameter.
	 *
	 * It used to be dropped entirely — the builder was an anonymous `jsonb()` — so at runtime nothing
	 * knew that a column was a `leave_event` rather than arbitrary JSON, and the closed union the
	 * author declared could not be enforced on write. Malformed values were stored rather than
	 * refused, and the damage only showed up much later as columns generated from them reading null.
	 *
	 * The name is the generated union of platform types and this workspace's discovered datatypes.
	 * Sync performs the same check over source before it emits that augmentation, so neither a type
	 * cast nor an out-of-date generated file can smuggle an undeclared name into the artifact.
	 */
	create: <const Name extends CustomTypeName, const Arguments extends CustomArguments<Name>>(
		name: Name,
		...arguments_: Arguments
	) => {
		const options = arguments_[0];
		if (
			options !== undefined &&
			(typeof options !== 'object' ||
				options === null ||
				Array.isArray(options) ||
				!Schema.is(Schema.Json)(options))
		)
			throw new TypeError(`custom(${JSON.stringify(name)}) options must be JSON-serializable.`);
		const builder = jsonb().$type<CustomColumnValue<Name, Arguments[0]>>();
		const config = Reflect.get(builder, 'config');
		if (config !== null && typeof config === 'object') {
			Reflect.set(config, 'boltCustomType', name);
			if (options !== undefined) Reflect.set(config, 'boltCustomTypeOptions', options);
			const precision = options === undefined ? undefined : Reflect.get(options, 'precision');
			if (precision === 'day' || precision === 'minute')
				Reflect.set(config, 'boltRangePrecision', precision);
		}
		Reflect.set(builder, 'array', () => {
			throw new Error(
				`custom(${JSON.stringify(name)}).array() is not supported: use custom(${JSON.stringify(name)}, { multiple: true }), which stores one JSON array in one jsonb column.`
			);
		});
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

/**
 * The nestable Effect form of a platform instant range — the same shape a `custom('instant_range')` column
 * stores, as a schema a tenant custom type may embed as a field.
 */
export const instantRangeValueSchema = Schema.Struct({
	start: utcInstant,
	end: Schema.NullOr(utcInstant)
});
export type InstantRangeNested = Schema.Schema.Type<typeof instantRangeValueSchema>;

/** The Standard Schema view used wherever `custom('instant_range')` is validated at a boundary. */
export const instantRangeSchema: ReturnType<
	typeof Schema.toStandardSchemaV1<typeof instantRangeValueSchema>
> = Schema.toStandardSchemaV1(instantRangeValueSchema, {
	parseOptions: { onExcessProperty: 'error' }
});

/**
 * The nestable Effect form of a platform monetary value.
 *
 * This is `MoneyValueSchema` re-exported for the authoring surface: the two-file contract is the
 * one place a tenant states a custom type, and a money field nested inside it should read the same
 * schema the platform column does rather than restate it.
 */
export { MoneyValueSchema as moneyValueSchema };
/** The Standard Schema view of a platform monetary value, for boundary validation. */
export const moneySchema: ReturnType<typeof Schema.toStandardSchemaV1<typeof MoneyValueSchema>> =
	Schema.toStandardSchemaV1(MoneyValueSchema, {
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
 * re-declares. A factory is left untouched and receives the options recorded by
 * `custom(name, options)` at the write boundary. Platform and tenant definitions therefore take the
 * same path.
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

type MoneyOptions = Readonly<{ allowedCurrencies?: ReadonlyArray<string> }>;
type InstantRangeOptions = Readonly<{ precision?: InstantPrecision }>;

const moneySchemaFor = (options: MoneyOptions = {}) => {
	const currencies = (options.allowedCurrencies ?? []).map((currency) => currency.trim());
	const schema =
		currencies.length === 0
			? MoneyValueSchema
			: MoneyValueSchema.check(
					Schema.makeFilter(
						(value) =>
							currencies.includes(value.currency) ||
							`currency must be one of ${currencies.join(', ')}`,
						{ title: 'allowedCurrency' }
					)
				);
	return Schema.toStandardSchemaV1(schema, { parseOptions: { onExcessProperty: 'error' } });
};

/**
 * Platform-owned datatypes use the exact declaration contract a workspace datatype uses.
 *
 * The registry is injected while `src/datatypes/<name>/+definition.ts` files are discovered; that
 * acquisition step is their only difference. Both definitions are created by `defineCustomType`,
 * reached through `custom(name, options)`, merged into one runtime registry, validated through one
 * Standard Schema path, and resolved by one renderer map keyed by the declared name.
 */
export const platformCustomTypes = Object.freeze({
	money: defineCustomType({
		name: 'money',
		description:
			'A monetary amount carried with its ISO 4217 currency code, so totals never silently mix currencies.',
		schema: moneySchemaFor
	}),
	instant_range: defineCustomType({
		name: 'instant_range',
		description:
			'A span of UTC instants: started and, when closed, ended — the platform owns the instant grammar and its open-range spellings.',
		// Precision changes rendering, not the stored shape. Naming the option here makes it available
		// through the same inferred second argument a tenant schema factory receives.
		schema: (_options: InstantRangeOptions = {}) => instantRangeSchema
	})
});

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
