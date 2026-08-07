import type { AnyCollectionBehavior } from '$lib/authoring/schema/collection-behavior.js';
import type {
	CollectionQuery,
	CollectionFindFirstQuery,
	DbApi,
	ReadonlyDbApi,
	DirectDbTransport,
	RemoteDbTransport
} from '$lib/authoring/workspace/db-api-types.js';
import type { AnySchema } from '$lib/authoring/schema/types.js';
import type {
	FindManyWireSchema,
	FindFirstWireSchema,
	CountWireSchema,
	CreateWireSchema,
	CreateManyWireSchema,
	UpdateManyWireSchema,
	UpdateWireSchema,
	DeleteWireSchema
} from '@norbital-ai/platform-utils/remote/collection_wire_schemas';
import type { z } from 'zod';
import { collectionPageRows } from '@norbital-ai/platform-utils/collection/client';

export type {
	CollectionFindFirstQuery,
	CollectionQuery,
	CollectionGroupedQuery,
	DbApi,
	ReadonlyDbApi,
	DbApiResult,
	DirectDbTransport,
	RemoteDbTransport
} from '$lib/authoring/workspace/db-api-types.js';

/** Policy grant `$sql` template key (compiled to Drizzle `RAW`). */
export const POLICY_SQL_WHERE_KEY = '$sql' as const;

type BehaviorMap = Readonly<Record<string, AnyCollectionBehavior>>;

function toRemoteFindManyInput(
	collectionName: string,
	query: CollectionQuery & { bypass_secret?: string }
): z.infer<typeof FindManyWireSchema> {
	// Safe: client CollectionQuery fields are a superset of wire transport inputs at runtime.
	return { collection: collectionName, ...query } as z.infer<typeof FindManyWireSchema>;
}

function toRemoteFindFirstInput(
	collectionName: string,
	query: CollectionFindFirstQuery & { bypass_secret?: string }
): z.infer<typeof FindFirstWireSchema> {
	return { collection: collectionName, ...query } as z.infer<typeof FindFirstWireSchema>;
}

function toRemoteCountInput(
	collectionName: string,
	query: CollectionQuery & { bypass_secret?: string }
): z.infer<typeof CountWireSchema> {
	return { collection: collectionName, ...query } as z.infer<typeof CountWireSchema>;
}

function toRemoteCreateManyInput(
	collectionName: string,
	inputs: readonly Record<string, unknown>[]
): z.infer<typeof CreateManyWireSchema> {
	return { collection: collectionName, inputs: [...inputs] };
}

function toRemoteUpdateManyInput(
	collectionName: string,
	updates: readonly { recordId: string; input: Record<string, unknown> }[]
): z.infer<typeof UpdateManyWireSchema> {
	return {
		collection: collectionName,
		updates: updates.map(({ recordId, input }) => ({ record_id: recordId, input }))
	};
}

export type DbTransport =
	| { readonly mode: 'direct'; readonly transport: DirectDbTransport }
	| { readonly mode: 'remote'; readonly transport: RemoteDbTransport };

function buildCollectionQueryOps(
	collectionName: string,
	dbTransport: DbTransport
): Record<string, unknown> {
	return {
		findMany: (query: CollectionQuery = {}) => {
			if (dbTransport.mode === 'direct') {
				return dbTransport.transport.findMany(collectionName, query);
			}
			return collectionPageRows(
				dbTransport.transport.findMany(toRemoteFindManyInput(collectionName, query))
			);
		},
		findFirst: (query: CollectionFindFirstQuery = {}) => {
			if (dbTransport.mode === 'direct') {
				return dbTransport.transport.findFirst(collectionName, query);
			}
			return dbTransport.transport.findFirst(toRemoteFindFirstInput(collectionName, query));
		},
		findNearest: (query: {
			readonly column: string;
			readonly probe: readonly number[];
			readonly metric: 'cosine' | 'l2' | 'ip';
			readonly maxDistance?: number;
			readonly limit: number;
			readonly excludeIds?: readonly string[];
			readonly bypass_secret?: string;
		}) => {
			if (dbTransport.mode !== 'direct') {
				throw new Error(
					'findNearest is server-only (pgvector). Use a hook, remote handler, or automation.'
				);
			}
			return dbTransport.transport.findNearest(collectionName, query);
		}
	};
}

function buildCollectionCommandOps(
	collectionName: string,
	dbTransport: DbTransport,
	behavior?: AnyCollectionBehavior
): Record<string, unknown> {
	const ops: Record<string, unknown> = {
		count: (query: CollectionQuery = {}) => {
			if (dbTransport.mode === 'direct') {
				return dbTransport.transport.count(collectionName, query);
			}
			return dbTransport.transport.count(toRemoteCountInput(collectionName, query));
		}
	};

	if (behavior?.create) {
		ops.create = (input: Record<string, unknown>) => {
			if (dbTransport.mode === 'direct') {
				return dbTransport.transport.create(collectionName, input);
			}
			return dbTransport.transport.create({ collection: collectionName, input });
		};
		ops.createMany = (inputs: readonly Record<string, unknown>[]) => {
			if (dbTransport.mode === 'direct') {
				return dbTransport.transport.createMany(collectionName, inputs);
			}
			return dbTransport.transport.createMany(toRemoteCreateManyInput(collectionName, inputs));
		};
	}
	if (behavior?.update) {
		ops.update = (recordId: string, input: Record<string, unknown>) => {
			if (dbTransport.mode === 'direct') {
				return dbTransport.transport.update(collectionName, recordId, input);
			}
			return dbTransport.transport.update({
				collection: collectionName,
				record_id: recordId,
				input
			});
		};
		ops.updateMany = (updates: readonly { recordId: string; input: Record<string, unknown> }[]) => {
			if (dbTransport.mode === 'direct') {
				return dbTransport.transport.updateMany(collectionName, updates);
			}
			return dbTransport.transport.updateMany(toRemoteUpdateManyInput(collectionName, updates));
		};
	}
	if (behavior?.delete) {
		ops.delete = (recordId: string) => {
			if (dbTransport.mode === 'direct') {
				return dbTransport.transport.delete(collectionName, recordId);
			}
			return dbTransport.transport.delete({
				collection: collectionName,
				record_id: recordId
			});
		};
	}

	return ops;
}

export function createDbApi<S extends AnySchema, M extends DbTransport['mode']>(
	schema: S,
	dbTransport: DbTransport & { mode: M },
	behaviors: BehaviorMap = {}
): DbApi<S, M> {
	const tableNames = Object.keys(schema.tables);
	const query: Record<string, unknown> = {};
	const db: Record<string, unknown> = { query };
	for (const name of tableNames) {
		query[name] = buildCollectionQueryOps(name, dbTransport);
		db[name] = buildCollectionCommandOps(name, dbTransport, behaviors[name]);
	}
	// Safe: per-table ops are built uniformly; schema table keys drive the DbApi surface.
	return { ...db } as DbApi<S, M>;
}

export function createReadonlyDbApi<S extends AnySchema, M extends DbTransport['mode']>(
	schema: S,
	dbTransport: DbTransport & { mode: M }
): ReadonlyDbApi<S, M> {
	// Omitting collection behaviors leaves only count on each collection command surface.
	return createDbApi<S, M>(schema, dbTransport) as ReadonlyDbApi<S, M>;
}

export function createElevatedReadonlyDbApi<
	S extends AnySchema,
	M extends DbTransport['mode'],
	E extends object
>(readDb: ReadonlyDbApi<S, M>, elevatedOperations: E): ReadonlyDbApi<S, M> & E {
	return { ...readDb, ...elevatedOperations };
}
