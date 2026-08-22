import type {
	CollectionBaseQuery,
	CollectionClient,
	CollectionDefinition,
	CollectionFilterOptions,
	CollectionOperations,
	CollectionRecord,
	CollectionType,
	ErasedCollectionRegistry,
	RemoteQuery
} from '@norbital-ai/std/collection';
import {
	collectionTableRowMatchesFilters,
	collectionTableRowMatchesSearch,
	collectionTableRowMatchesWhere
} from '@norbital-ai/ui/collection-table';
import { Effect } from 'effect';

/**
 * A settled query: the rows are already in hand, so there is no loading state to model.
 */
export const settled = <T>(current: T): RemoteQuery<T> => ({
	current,
	loading: false,
	error: undefined,
	refresh: () => Effect.runPromise(Effect.void),
	then: (onfulfilled, onrejected) =>
		Effect.runPromise(Effect.succeed(current)).then(onfulfilled, onrejected)
});

/**
 * Applies the table's own row predicates and ordering to rows already in hand.
 *
 * The same predicates the wire-backed collection tables use, so a host surface that renders
 * already-loaded rows behaves exactly like one reading a collection.
 */
export const matchingRows = (
	rows: ReadonlyArray<CollectionRecord>,
	query: CollectionBaseQuery<CollectionRecord> | undefined,
	filters: CollectionFilterOptions['filters']
): CollectionRecord[] => {
	const entries = Object.entries(query?.orderBy ?? {});
	return rows
		.filter(
			(row) =>
				collectionTableRowMatchesWhere(row, query?.where) &&
				(query?.search === undefined || collectionTableRowMatchesSearch(row, query.search)) &&
				collectionTableRowMatchesFilters(row, filters)
		)
		.toSorted((left, right) => {
			for (const [field, direction] of entries) {
				const leftValue: unknown = Reflect.get(left, field);
				const rightValue: unknown = Reflect.get(right, field);
				const result =
					typeof leftValue === 'number' && typeof rightValue === 'number'
						? leftValue - rightValue
						: String(leftValue ?? '').localeCompare(String(rightValue ?? ''));
				if (result !== 0) return direction === 'desc' ? -result : result;
			}
			return 0;
		});
};

/**
 * Read operations only, shared by every tab.
 *
 * `create`, `update` and `delete` are optional on `CollectionOperations`, and leaving them off is
 * how an in-memory client says the data is not editable here — the table then omits the affordance
 * instead of offering one that rejects when it is used.
 */
export const readOnly = (
	rows: ReadonlyArray<CollectionRecord>
): CollectionOperations<CollectionType> => ({
	findMany: (query, options) => {
		const matched = matchingRows(rows, query, options?.filters);
		const limit = query?.limit ?? 25;
		// The cursor is the row offset, because that is all it has to be here — the whole set is
		// loaded and never changes underneath a page. It stays opaque to the table either way.
		const parsed = query?.after === undefined ? 0 : Number.parseInt(query.after, 10);
		const from = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
		return {
			...settled(matched.slice(from, from + limit)),
			nextCursor: from + limit < matched.length ? String(from + limit) : null
		};
	},
	findFirst: (query) => settled(matchingRows(rows, query, undefined)[0]),
	findGrouped: (query, options) => {
		// Built by accumulation rather than `Object.groupBy`, whose `Partial<Record<…>>` result
		// would have to be asserted back into the total record the grouped result declares.
		const lanes: Record<string, CollectionRecord[]> = {};
		for (const row of matchingRows(rows, query, options?.filters)) {
			const lane = String(Reflect.get(row, query.group.by) ?? '');
			(lanes[lane] ??= []).push(row);
		}
		return settled(lanes);
	},
	count: (query, options) => settled(matchingRows(rows, query, options?.filters).length)
});

/**
 * Builds a collection client over rows already in hand, keyed by collection name.
 *
 * The rows are read at call time rather than captured, so a client built once keeps answering with
 * the latest rows however many times a table remounts.
 */
export const inMemoryCollectionClient = (
	definitions: Readonly<Record<string, CollectionDefinition>>,
	rowsByCollection: Readonly<Record<string, ReadonlyArray<CollectionRecord>>>
): CollectionClient<ErasedCollectionRegistry> => {
	const clients: Record<string, CollectionOperations<CollectionType>> = {};
	for (const name of Object.keys(definitions)) {
		clients[name] = readOnly(rowsByCollection[name] ?? []);
	}
	return {
		db: clients,
		collections: definitions,
		// Addressed by name for the surfaces that hold a record rather than a collection.
		records: {
			findMany: (collectionName: string, query?: CollectionBaseQuery<CollectionRecord>) =>
				(clients[collectionName] ?? readOnly([])).findMany(query)
		}
	};
};
