import type {
	CollectionClient,
	CollectionBaseQuery,
	CollectionDefinition,
	CollectionOperations,
	CollectionPage,
	CollectionPageQuery,
	CollectionQuery,
	CollectionRecord,
	CollectionRegistry,
	CollectionTransport,
	CollectionType
} from './types.js';

export function collectionPageRows<TRow extends object>(
	query: import('./types.js').RemoteQuery<CollectionPage<TRow>>
): CollectionPageQuery<TRow> {
	return {
		get current() {
			return query.current?.rows;
		},
		get nextCursor() {
			return query.current?.nextCursor;
		},
		get loading() {
			return query.loading;
		},
		get error() {
			return query.error;
		},
		refresh: () => query.refresh()
	};
}

function wireQuery(
	query: CollectionBaseQuery<CollectionRecord> | CollectionQuery<CollectionRecord> | undefined
) {
	if (!query) return {};
	const { orderBy, ...rest } = query;
	return {
		...rest,
		orderBy: orderBy
			? Object.fromEntries(
					Object.entries(orderBy).filter(
						(entry): entry is [string, 'asc' | 'desc'] => entry[1] !== undefined
					)
				)
			: undefined
	};
}

export function createCollectionClient<TCollections extends CollectionRegistry>(
	collections: {
		readonly [TName in keyof TCollections]: CollectionDefinition<TCollections[TName]>;
	},
	transport: CollectionTransport,
	extensions?: Pick<CollectionClient<TCollections>, 'approvals'>
): CollectionClient<TCollections> {
	const db: Record<string, CollectionOperations<CollectionType>> = {};
	const records = {
		findMany: (collection: string, query?: CollectionQuery<CollectionRecord>) =>
			collectionPageRows(transport.findMany({ collection, ...wireQuery(query) }))
	};
	const findHistory = transport.findHistory;
	const history = findHistory
		? {
				findMany: (collection: string, record_id: string, limit = 250) =>
					findHistory({ collection, record_id, limit })
			}
		: undefined;

	for (const collection of Object.keys(collections)) {
		db[collection] = {
			findMany: (query, options) =>
				collectionPageRows(
					transport.findMany({
						collection,
						...wireQuery(query),
						filters: options?.filters ? [...options.filters] : undefined
					})
				),
			findFirst: (query) => transport.findFirst({ collection, ...wireQuery(query) }),
			findGrouped: ({ group, ...query }, options) =>
				transport.findGrouped({
					collection,
					group,
					limit: query.limit ?? 100,
					...wireQuery(query),
					filters: options?.filters ? [...options.filters] : undefined
				}),
			count: (query, options) =>
				transport.count({
					collection,
					...wireQuery(query),
					filters: options?.filters ? [...options.filters] : undefined
				}),
			create: (input) => transport.create({ collection, input }),
			createMany: (inputs) => transport.createMany({ collection, inputs: [...inputs] }),
			update: (recordId, input) => transport.update({ collection, record_id: recordId, input }),
			...(transport.updateMany
				? {
						updateMany: (updates: readonly { recordId: string; input: CollectionRecord }[]) =>
							transport.updateMany!({
								collection,
								updates: updates.map(({ recordId, input }) => ({ record_id: recordId, input }))
							})
					}
				: {}),
			delete: (recordId) => transport.delete({ collection, record_id: recordId })
		};
	}

	// The definition keys build the matching operations above; this is the wire-to-schema boundary.
	return {
		db,
		collections,
		records,
		...(history ? { history } : {}),
		...extensions
	} as CollectionClient<TCollections>; // stupidity: boundary-cast — collection definition keys and generated operations share the same erased registry keys.
}
