import type { NumericRendererVariant } from '@norbital-ai/platform-utils/collection';
import type { Column } from 'drizzle-orm';
import type { AnyPgColumnBuilder } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type { CustomTypeSchema } from '../custom-type.js';

import { PLATFORM_ZOD_BUILTIN_KINDS } from '../builtin/custom_types.js';

/** Built-in custom column kinds — aligned with datatype renderers. */
export const BUILTIN_COLUMN_CUSTOM_KINDS = [
	...PLATFORM_ZOD_BUILTIN_KINDS,
	'enum',
	'numeric',
	'json',
	'vector'
] as const;

export type BuiltinColumnCustomKind = (typeof BUILTIN_COLUMN_CUSTOM_KINDS)[number];

/** Custom column kind — builtins plus workspace-defined names from `custom()`. */
export type ColumnCustomKind = BuiltinColumnCustomKind | (string & {});

/** Runtime metadata attached at authoring time — not part of Drizzle's column model except `custom`. */
export type ColumnCustomMeta =
	| {
			readonly kind: 'numeric';
			readonly variant: NumericRendererVariant;
	  }
	| {
			readonly kind: 'money';
			readonly currencies?: readonly string[];
	  }
	| {
			readonly kind: 'date-range';
	  }
	| {
			readonly kind: 'geolocation';
	  }
	| {
			readonly kind: 'file';
			readonly mimeTypes?: readonly string[];
	  }
	| {
			readonly kind: 'phone';
	  }
	| {
			readonly kind: 'clock_time';
	  }
	| {
			readonly kind: 'enum';
			readonly values: readonly string[];
	  }
	| {
			readonly kind: 'json';
			readonly zodSchema?: z.ZodType;
	  }
	| {
			readonly kind: 'vector';
			readonly dimensions: number;
	  }
	| {
			readonly kind: Exclude<ColumnCustomKind, BuiltinColumnCustomKind>;
			readonly definitionBacked: true;
			readonly options?: Readonly<Record<string, unknown>>;
			readonly zodSchema?: CustomTypeSchema;
	  };

export type ColumnMetadataHost = Column | AnyPgColumnBuilder;

const COLUMN_CUSTOM = Symbol('column-custom');
/** Explicit search opt-in, set by `text({ search: true })`; absent means "not searchable". */
const COLUMN_SEARCHABLE = Symbol('column-searchable');

/**
 * Whether a text-ish column carries the explicit search opt-in.
 *
 * Search is opt-in: only `true` grants a trigram search index and search participation. Absent or
 * `false` means the column is never indexed and never searched, however text-like its kind. Stored
 * on the builder so the index creator (`isSearchableTextBuilder`) reads it at authoring time, and
 * copied onto the built column so `portableCollectionField` carries it into the manifest for the
 * runtime's search paths.
 */
export function setColumnSearchable(host: ColumnMetadataHost, searchable: boolean): void {
	Reflect.set(host, COLUMN_SEARCHABLE, searchable);
}

export function readColumnSearchable(host: ColumnMetadataHost): boolean | undefined {
	const value = Reflect.get(host, COLUMN_SEARCHABLE);
	return typeof value === 'boolean' ? value : undefined;
}

/** Resolve the searchable flag from a column builder, including `.array()` wrappers. */
export function readBuilderSearchable(builder: AnyPgColumnBuilder): boolean | undefined {
	const direct = readColumnSearchable(builder);
	if (direct !== undefined) return direct;

	const config = Reflect.get(builder, 'config');
	const inner = config && typeof config === 'object' ? Reflect.get(config, 'base') : undefined;
	if (inner) return readColumnSearchable(inner);

	return undefined;
}

declare module 'drizzle-orm' {
	interface Column {
		readonly custom?: ColumnCustomKind;
	}
}

export function attachColumnCustom(host: ColumnMetadataHost, meta: ColumnCustomMeta): void {
	Reflect.set(host, COLUMN_CUSTOM, meta);
	Object.defineProperty(host, 'custom', {
		value: meta.kind,
		enumerable: false,
		configurable: true
	});
}

export function readColumnCustomFromHost(host: ColumnMetadataHost): ColumnCustomMeta | undefined {
	const meta = Reflect.get(host, COLUMN_CUSTOM);
	if (!meta || typeof meta !== 'object') return undefined;
	const kind = Reflect.get(meta, 'kind');
	return typeof kind === 'string' ? meta : undefined;
}

/** Bind a filesystem custom-type definition without replacing closure-owned metadata. */
export function bindColumnCustomSchema(host: ColumnMetadataHost, schema: CustomTypeSchema): void {
	const metadata = readColumnCustomFromHost(host);
	if (!metadata) throw new Error('Cannot bind a custom-type schema to an untyped column.');
	Reflect.set(metadata, 'zodSchema', schema);
}

export function readColumnCustom(column: Column): ColumnCustomMeta | undefined {
	return readColumnCustomFromHost(column);
}

export type ColumnCustomMetaForKind<K extends ColumnCustomMeta['kind']> = Extract<
	ColumnCustomMeta,
	{ readonly kind: K }
>;

export function columnCustomIsKind<K extends ColumnCustomMeta['kind']>(
	meta: ColumnCustomMeta | undefined,
	kind: K
): meta is ColumnCustomMetaForKind<K> /* stupidity:allow R5b -- canonical union guard */ {
	return meta?.kind === kind;
}

/** Resolve custom metadata from a column builder, including `.array()` wrappers. */
export function readBuilderCustom(builder: AnyPgColumnBuilder): ColumnCustomMeta | undefined {
	const direct = readColumnCustomFromHost(builder);
	if (direct) return direct;

	const config = Reflect.get(builder, 'config');
	const inner = config && typeof config === 'object' ? Reflect.get(config, 'base') : undefined;
	if (inner) return readColumnCustomFromHost(inner);

	return undefined;
}
