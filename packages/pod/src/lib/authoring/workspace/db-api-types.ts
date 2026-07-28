import type {
	AnyDBQueryConfig,
	DBQueryConfigWithComment,
	Placeholder,
	SQLWrapper,
	SqlCommenterInput
} from 'drizzle-orm';
import type { RemoteQuery } from '$lib/client/remote-query.svelte.js';
import type {
	CollectionPage,
	CollectionRecordHistoryEntry
} from '@norbital-ai/platform-utils/collection';
import type { z } from 'zod';
import type {
	CountWireSchema,
	CreateManyWireSchema,
	CreateWireSchema,
	DeleteWireSchema,
	FindFirstWireSchema,
	FindGroupedWireSchema,
	FindHistoryWireSchema,
	FindManyWireSchema,
	UpdateManyWireSchema,
	UpdateWireSchema
} from '@norbital-ai/platform-utils/remote/collection_wire_schemas';
import type {
	AnySchema,
	SchemaQueryConfig,
	SchemaQueryRow,
	SchemaRow,
	TableName
} from '../schema/types.js';

/** Drizzle RQB options passed to collection ops, plus Pod's automatic all-column search term. */
export type CollectionQuery = AnyDBQueryConfig & { readonly search?: string };
export type CollectionFindFirstQuery = DBQueryConfigWithComment<'one'> & {
	readonly search?: string;
};

type JsonPrimitive = string | number | boolean | null | undefined;
type NonSerializableRqbKey = 'RAW' | 'comment' | 'extras';

/** Remove callback, SQL, placeholder, and non-JSON branches from Drizzle's object config. */
type JsonSafeRqbValue<T, Depth extends readonly unknown[] = []> = Depth['length'] extends 8
	? never
	: T extends (...args: never[]) => unknown
		? never
		: T extends SQLWrapper | Placeholder | Uint8Array
			? never
			: T extends Date
				? string
				: T extends JsonPrimitive
					? T
					: T extends readonly (infer Item)[]
						? readonly JsonSafeRqbValue<Item, readonly [...Depth, unknown]>[]
						: T extends object
							? {
									readonly [
										K in keyof T as K extends NonSerializableRqbKey
											? never
											: JsonSafeRqbValue<T[K], readonly [...Depth, unknown]> extends never
												? never
												: K
									]: JsonSafeRqbValue<T[K], readonly [...Depth, unknown]>;
								}
							: never;

/**
 * Schema-aware, JSON-safe query accepted by the browser transport.
 * Callback syntax, SQL wrappers, placeholders, RAW, extras, and comments are direct-only.
 */
export type SerializableRqbQueryConfig<
	S extends AnySchema,
	N extends TableName<S>,
	_RelationType extends 'many' | 'one'
> = JsonSafeRqbValue<Omit<SchemaQueryConfig<S, N>, 'comment'>> & object;

export type CollectionGroupedQuery = CollectionQuery & {
	readonly group: { readonly by: string; readonly lanes?: readonly unknown[] };
};

type DirectRqbQueryConfig<
	S extends AnySchema,
	N extends TableName<S>,
	_RelationType extends 'many' | 'one'
> = SchemaQueryConfig<S, N>;

type DirectDbRelationalQueryApi<S extends AnySchema, N extends TableName<S>> = {
	readonly findMany: <Cfg extends DirectRqbQueryConfig<S, N, 'many'>>(
		cfg?: Cfg & {
			readonly comment?: SqlCommenterInput;
		}
	) => Promise<SchemaQueryRow<S, N, Cfg>[]>;
	readonly findFirst: <Cfg extends DirectRqbQueryConfig<S, N, 'one'>>(
		cfg?: Cfg & {
			readonly comment?: SqlCommenterInput;
		}
	) => Promise<SchemaQueryRow<S, N, Cfg> | undefined>;
};

type RemoteDbRelationalQueryApi<S extends AnySchema, N extends TableName<S>> = {
	readonly findMany: <Cfg extends SerializableRqbQueryConfig<S, N, 'many'>>(
		cfg?: Cfg
	) => RemoteQuery<SchemaQueryRow<S, N, Cfg>[]>;
	readonly findFirst: <Cfg extends SerializableRqbQueryConfig<S, N, 'one'>>(
		cfg?: Cfg
	) => RemoteQuery<SchemaQueryRow<S, N, Cfg> | undefined>;
};

type DbRelationalQueryApi<
	S extends AnySchema,
	N extends TableName<S>,
	M extends 'remote' | 'direct'
> = M extends 'direct' ? DirectDbRelationalQueryApi<S, N> : RemoteDbRelationalQueryApi<S, N>;

type DbRelationalQueryRoot<S extends AnySchema, M extends 'remote' | 'direct'> = {
	readonly [N in TableName<S>]: DbRelationalQueryApi<S, N, M>;
};

type DbCollectionApiRoot<
	S extends AnySchema,
	M extends 'remote' | 'direct',
	Inputs extends S['inputs']
> = {
	readonly [N in TableName<S>]: DbCollectionApi<S, N, M, Inputs>;
};

export type DbApi<
	S extends AnySchema,
	M extends 'remote' | 'direct' = 'direct',
	Inputs extends S['inputs'] = S['inputs']
> = DbCollectionApiRoot<S, M, Inputs> & {
	// TS6: intersection preserves the literal query key beside schema-derived mapped keys.
	readonly query: DbRelationalQueryRoot<S, M>;
};

type InputValue<T> = T extends z.ZodType<infer Output> ? Output : T;

type DbCollectionApi<
	S extends AnySchema,
	N extends TableName<S>,
	M extends 'remote' | 'direct',
	Inputs extends S['inputs']
> = {
	readonly count: (
		cfg?: Pick<SchemaQueryConfig<S, N>, 'where'> & {
			readonly bypass_secret?: string;
		}
	) => DbApiResult<M, number>;
	readonly create: (input: InputValue<Inputs[N]['create']>) => Promise<SchemaRow<S, N>>;
	readonly update: (id: string, patch: InputValue<Inputs[N]['update']>) => Promise<SchemaRow<S, N>>;
	readonly delete: (id: string) => Promise<void>;
};

type ReadonlyDbCollectionApi<
	S extends AnySchema,
	N extends TableName<S>,
	M extends 'remote' | 'direct'
> = Pick<DbCollectionApi<S, N, M, S['inputs']>, 'count'>;

type ReadonlyDbCollectionApiRoot<S extends AnySchema, M extends 'remote' | 'direct'> = {
	readonly [N in TableName<S>]: ReadonlyDbCollectionApi<S, N, M>;
};

export type ReadonlyDbApi<
	S extends AnySchema,
	M extends 'remote' | 'direct' = 'direct'
> = ReadonlyDbCollectionApiRoot<S, M> & {
	// TS6: intersection preserves the literal query key beside schema-derived mapped keys.
	readonly query: DbRelationalQueryRoot<S, M>;
};

export type DbApiResult<M extends 'remote' | 'direct', T> = M extends 'direct'
	? Promise<T>
	: RemoteQuery<T>;

/** Hook/automation `api.db` — direct transport only. */
export type CollectionHookApi<S extends AnySchema> = {
	readonly db: DbApi<S, 'direct'>;
};

export type DirectDbTransport = {
	readonly findMany: (
		collection: string,
		query: CollectionQuery & { bypass_secret?: string }
	) => Promise<Record<string, unknown>[]>;
	readonly findFirst: (
		collection: string,
		query: CollectionFindFirstQuery & { bypass_secret?: string }
	) => Promise<Record<string, unknown> | undefined>;
	readonly findGrouped: (
		collection: string,
		query: CollectionQuery & {
			group: { by: string; lanes?: readonly unknown[] };
			bypass_secret?: string;
		}
	) => Promise<Record<string, Record<string, unknown>[]>>;
	readonly count: (
		collection: string,
		query: CollectionQuery & { bypass_secret?: string }
	) => Promise<number>;
	readonly create: (
		collection: string,
		input: Record<string, unknown>
	) => Promise<Record<string, unknown>>;
	readonly createMany: (
		collection: string,
		inputs: readonly Record<string, unknown>[]
	) => Promise<Record<string, unknown>[]>;
	readonly update: (
		collection: string,
		recordId: string,
		input: Record<string, unknown>
	) => Promise<Record<string, unknown>>;
	readonly updateMany: (
		collection: string,
		updates: readonly { recordId: string; input: Record<string, unknown> }[]
	) => Promise<Record<string, unknown>[]>;
	readonly delete: (collection: string, recordId: string) => Promise<void>;
};

export type RemoteDbTransport = {
	readonly findMany: (
		input: z.infer<typeof FindManyWireSchema>
	) => RemoteQuery<CollectionPage<Record<string, unknown>>>;
	readonly findFirst: (
		input: z.infer<typeof FindFirstWireSchema>
	) => RemoteQuery<Record<string, unknown> | undefined>;
	readonly findGrouped: (
		input: z.infer<typeof FindGroupedWireSchema>
	) => RemoteQuery<Record<string, Record<string, unknown>[]>>;
	readonly findHistory: (
		input: z.infer<typeof FindHistoryWireSchema>
	) => RemoteQuery<readonly CollectionRecordHistoryEntry[]>;
	readonly count: (input: z.infer<typeof CountWireSchema>) => RemoteQuery<number>;
	readonly create: (input: z.infer<typeof CreateWireSchema>) => Promise<Record<string, unknown>>;
	readonly createMany: (
		input: z.infer<typeof CreateManyWireSchema>
	) => Promise<Record<string, unknown>[]>;
	readonly update: (input: z.infer<typeof UpdateWireSchema>) => Promise<Record<string, unknown>>;
	readonly updateMany: (
		input: z.infer<typeof UpdateManyWireSchema>
	) => Promise<Record<string, unknown>[]>;
	readonly delete: (input: z.infer<typeof DeleteWireSchema>) => Promise<void>;
};
