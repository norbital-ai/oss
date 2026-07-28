import { getTableColumns } from 'drizzle-orm';
import { createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import {
	isSystemColumnName,
	MUTATION_EXCLUDED_SYSTEM_COLUMNS
} from '@norbital-ai/platform-utils/system/column_names';
import { z } from 'zod';
import { parseUtcInstant } from '@norbital-ai/std/date';
import {
	readColumnCustomFromHost,
	type ColumnCustomMeta,
	type ColumnMetadataHost
} from './columns.js';
import type { NorbitalTable } from './table.js';
import type { MutationInsert, MutationUpdate } from './mutation-types.js';
export type {
	InputValuesForTables,
	MutationInsert,
	MutationInsertFor,
	MutationUpdate,
	MutationUpdateFor
} from './mutation-types.js';
import {
	clockTimeZodSchema,
	dateRangeZodSchema,
	fileZodSchema,
	geolocationZodSchema,
	moneyZodSchema
} from '../builtin/custom_types.js';
import type { CustomTypeSchema } from '../custom-type.js';

function buildMutationOmit(): Record<string, true> {
	const omit: Record<string, true> = {};
	for (const name of MUTATION_EXCLUDED_SYSTEM_COLUMNS) {
		omit[name] = true;
	}
	return omit;
}

type AnyNorbitalTable = NorbitalTable<string>;

/** Zod object helpers with Drizzle-backed insert/update row inference for collection input pickers. */
export type PickableZodSchema<T extends Record<string, unknown>> = z.ZodType<T> & {
	pick<M extends Partial<Record<keyof T, true>>>(
		mask: M
	): z.ZodType<{ [K in keyof M & keyof T]: T[K] }>;
	omit<M extends Partial<Record<keyof T, true>>>(
		mask: M
	): z.ZodType<{ [K in Exclude<keyof T, keyof M & keyof T>]: T[K] }>;
};

function zodSchemaForColumn(column: ColumnMetadataHost): z.ZodType | undefined {
	const meta = readColumnCustomFromHost(column);
	if (!meta) return undefined;
	if ('definitionBacked' in meta) {
		return meta.zodSchema ? classicSchema(meta.zodSchema) : undefined;
	}

	switch (meta.kind) {
		case 'money':
			return moneyZodSchema;
		case 'date-range':
			return dateRangeZodSchema;
		case 'clock_time':
			return clockTimeZodSchema;
		case 'geolocation':
			return geolocationZodSchema;
		case 'file':
			return fileZodSchema;
		case 'enum':
			return undefined;
		case 'json': {
			const jsonMeta = meta as Extract<ColumnCustomMeta, { readonly kind: 'json' }>;
			return jsonMeta.zodSchema;
		}
		default:
			return undefined;
	}
}

function classicSchema<T>(schema: CustomTypeSchema<T>): z.ZodType<T> {
	return z.custom<T>((value) => {
		try {
			schema.parse(value);
			return true;
		} catch {
			return false;
		}
	});
}

/** Accept ISO UTC strings for Date-mode columns — JSON wire payloads carry dates as strings. */
function coerceDateStrings(schema: z.ZodType): z.ZodType {
	return z.preprocess(
		(value: unknown) => (typeof value === 'string' ? parseUtcInstant(value) : value),
		schema
	);
}

type ColumnRefine = z.ZodType | ((schema: z.ZodType) => z.ZodType);

function buildInsertRefine<TTable extends AnyNorbitalTable>(
	table: TTable
): Record<string, ColumnRefine> | undefined {
	const refine: Record<string, ColumnRefine> = {};
	for (const [name, column] of Object.entries(getTableColumns(table))) {
		if (isSystemColumnName(name)) continue;
		const schema = zodSchemaForColumn(column as ColumnMetadataHost);
		if (schema) {
			// Function form, not the ZodType directly: drizzle-zod uses a direct
			// ZodType as-is, skipping its nullable/optional conditions — update
			// schemas then demand every custom column (no partial updates) and
			// nullable custom columns reject null/omission on create.
			refine[name] = () => schema;
		} else if ((column as { dataType?: string }).dataType === 'object date') {
			refine[name] = coerceDateStrings;
		}
	}
	return Object.keys(refine).length > 0 ? refine : undefined;
}

export type InputSchemasFor<TTables extends Record<string, AnyNorbitalTable>> = {
	readonly [K in keyof TTables & string]: {
		readonly create: PickableZodSchema<MutationInsert<TTables[K]>>;
		readonly update: PickableZodSchema<MutationUpdate<TTables[K]>>;
	};
};

type MutationSchemaKind = 'insert' | 'update';

type DrizzleMutationFactory = (
	table: AnyNorbitalTable,
	refine?: Record<string, ColumnRefine>
) => { omit: (mask: Record<string, true>) => z.ZodType };

/**
 * Drizzle-zod's BuildRefine and omit() masks are keyed by per-table column maps that we
 * assemble at runtime. Compile-time mutation shapes come from NorbitalTable inference
 * (MutationInsert / MutationUpdate), not from drizzle-zod's generic output.
 */
function buildPickableMutationSchema<T extends Record<string, unknown>>(
	table: AnyNorbitalTable,
	kind: MutationSchemaKind,
	refine: Record<string, ColumnRefine> | undefined,
	omit: Record<string, true>
): PickableZodSchema<T> {
	const factory = (
		kind === 'insert' ? createInsertSchema : createUpdateSchema
	) as DrizzleMutationFactory;
	return (refine ? factory(table, refine) : factory(table)).omit(omit) as PickableZodSchema<T>;
}

export function buildInputSchemas<TTables extends Record<string, AnyNorbitalTable>>(
	tables: TTables
): InputSchemasFor<TTables> {
	const omit = buildMutationOmit();
	type BuiltInputs = {
		[K in keyof TTables & string]: {
			create: PickableZodSchema<MutationInsert<TTables[K]>>;
			update: PickableZodSchema<MutationUpdate<TTables[K]>>;
		};
	};
	const inputs = {} as BuiltInputs;

	for (const name of Object.keys(tables) as (keyof TTables & string)[]) {
		const table = tables[name];
		const refine = buildInsertRefine(table);
		inputs[name] = {
			create: buildPickableMutationSchema<MutationInsert<TTables[typeof name]>>(
				table,
				'insert',
				refine,
				omit
			),
			update: buildPickableMutationSchema<MutationUpdate<TTables[typeof name]>>(
				table,
				'update',
				refine,
				omit
			)
		};
	}

	return inputs;
}
