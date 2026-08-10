import type { NumericRendererVariant } from '@norbital-ai/platform-utils/collection';
import { NumericRendererVariantSchema } from '@norbital-ai/platform-utils/collection/schemas';
import {
	date as pgDate,
	numeric as pgNumeric,
	text,
	timestamp as pgTimestamp,
	uuid,
	vector as pgVector,
	type AnyPgColumnBuilder
} from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { attachColumnCustom, setColumnSearchable } from '../schema/columns.js';
import {
	dateRangeJsonbColumn,
	jsonbColumn,
	namedJsonbColumn,
	textEnumColumn
} from '../schema/table.js';
import { geolocationZodSchema } from './custom_types.js';

export type FileColumnOptions = {
	readonly mimeTypes?: readonly string[];
};

export type NumericColumnOptions = {
	readonly variant?: NumericRendererVariant;
};

export type EmbeddingColumnOptions = {
	readonly dimensions: number;
};

const customFactoryOptionsSchema = z.record(z.string(), z.unknown());

/** Numeric column read as a JS number (drizzle defaults numeric to string mode). */
export function numeric(options: NumericColumnOptions = {}) {
	const column = pgNumeric({ mode: 'number' });
	if (options.variant) {
		attachColumnCustom(column, {
			kind: 'numeric',
			variant: NumericRendererVariantSchema.parse(options.variant)
		});
	}
	return column;
}

/** Calendar date (`YYYY-MM-DD`) with no timezone or time-of-day semantics. */
export function date() {
	return pgDate();
}

/** Absolute instant stored as PostgreSQL `timestamptz`. */
export function timestamp() {
	return pgTimestamp({ withTimezone: true });
}

/** Calendar date range `{ start, end }` stored as UTC ISO JSONB. Use `.array()` for list columns. */
export function dateRange() {
	return dateRangeJsonbColumn({ kind: 'date-range' });
}

/** GeoJSON-style point with formatted address, stored as JSONB. Use `.array()` for list columns. */
export function geolocation() {
	return jsonbColumn(geolocationZodSchema, { kind: 'geolocation' });
}

/** Telephone number stored as text with telephone-specific editing semantics. */
export function phone() {
	const column = text();
	attachColumnCustom(column, { kind: 'phone' });
	return column;
}

/** Validated local clock time (`HH:mm`) with no date or timezone semantics. */
export function clockTime() {
	const column = text();
	attachColumnCustom(column, { kind: 'clock_time' });
	return column;
}

/**
 * Mark a text-ish column searchable (the default), or opt it out with `searchable(false)`.
 *
 * Search — the collection search box, the omni finder, @ mentions, relation pickers — runs only
 * over fields with a trigram search index, and that set is exactly this: non-array
 * text/phone/enum fields not opted out. `false` drops the field from the search index and from
 * every search path at once; the flag travels into the manifest field, so the runtime's search
 * predicate (`isSearchableCollectionField`) and the index creator make the same decision.
 *
 * On a non text-ish column (numbers, dates, JSON, relations) the flag is inert: there is no
 * trigram index to remove and no search path that ever matched it.
 */
export function searchable<T extends AnyPgColumnBuilder>(column: T, value = true): T {
	setColumnSearchable(column, value);
	return column;
}

/** Workspace-specific values supplied by generated filesystem type augmentation. */
export interface CustomTypeValueMap {}
export interface CustomTypeOptionsMap {}

type CustomTypeValue<K extends string> = K extends keyof CustomTypeValueMap
	? CustomTypeValueMap[K]
	: unknown;

type CustomArguments<K extends string> = K extends keyof CustomTypeOptionsMap
	? [CustomTypeOptionsMap[K]] extends [never]
		? readonly []
		: undefined extends CustomTypeOptionsMap[K]
			? readonly [options?: Exclude<CustomTypeOptionsMap[K], undefined>]
			: CustomTypeOptionsMap[K] extends Readonly<Record<string, unknown>>
				? readonly [options: CustomTypeOptionsMap[K]]
				: readonly []
	: readonly [];

type CustomColumn<K extends string> = ReturnType<typeof namedJsonbColumn<CustomTypeValue<K>>>;

/** Reference to a platform `document_asset` record (UUID column). Use `.array()` for list columns. */
export function file(options: FileColumnOptions = {}) {
	const column = uuid();
	attachColumnCustom(column, { kind: 'file', mimeTypes: options.mimeTypes });
	return column;
}

/** Text column restricted to a fixed set of values. Use `.array()` for list columns. */
export function enums(values: readonly [string, ...string[]]) {
	return textEnumColumn(z.enum(values), {
		kind: 'enum',
		values
	});
}

/** Named custom value; factory-backed definitions accept their inferred options as argument two. */
export function custom<const K extends string>(
	kind: K,
	...arguments_: CustomArguments<K>
): CustomColumn<K>;
export function custom(kind: string, ...arguments_: readonly unknown[]) {
	const candidate = arguments_[0];
	const options = candidate === undefined ? undefined : customFactoryOptionsSchema.parse(candidate);
	return namedJsonbColumn<CustomTypeValue<typeof kind>>(kind, options);
}

/**
 * Float embedding (`vector(n)` via pgvector). Store as a `number[]` of length `n`.
 *
 * One path for every ANN use case: Meta PDQ as a 256-dim 0/1 embedding (L2 ≈ Hamming),
 * Gemini multimodal / omni embeddings (cosine), etc. Index with HNSW + the matching
 * opclass (`vector_l2_ops` / `vector_cosine_ops` / `vector_ip_ops`) and query via
 * `findNearest`.
 */
export function vector(options: EmbeddingColumnOptions) {
	const dimensions = z.number().int().positive().max(16_000).parse(options.dimensions);
	const column = pgVector({ dimensions });
	attachColumnCustom(column, { kind: 'vector', dimensions });
	return column;
}

/**
 * Expand even-length hex (e.g. 64-char Meta PDQ) to a 0/1 float embedding for `vector(n)`.
 * For binary embeddings, L2 distance equals √Hamming — use `findNearest({ metric: 'l2' })`
 * with `maxDistance: Math.sqrt(hammingThreshold)`.
 */
export function hexToBinaryEmbedding(hex: string): number[] {
	if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
		throw new Error('hexToBinaryEmbedding expects an even-length hexadecimal string.');
	}
	const embedding: number[] = [];
	for (const char of hex.toLowerCase()) {
		const nibble = Number.parseInt(char, 16);
		embedding.push((nibble >> 3) & 1, (nibble >> 2) & 1, (nibble >> 1) & 1, nibble & 1);
	}
	return embedding;
}

export type BuiltinColumnBuilder = AnyPgColumnBuilder;
