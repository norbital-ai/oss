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
	then: (onfulfilled, onrejected) =>
		Effect.runPromise(Effect.succeed(current)).then(onfulfilled, onrejected)
});

/**
 * Applies the table's own row predicates and ordering to rows already in hand.
 *
 * The same predicates the wire-backed collection tables use, so a host surface that renders
 * already-loaded rows behaves exactly like one reading a collection.
 */
const matchingRows = (
	rows: ReadonlyArray<CollectionRecord>,
	query: CollectionBaseQuery<CollectionRecord> | undefined,
	filters: CollectionFilterOptions['filters']
): CollectionRecord[] => {
	const entries = Object.entries(query?.orderBy ?? {});
	return rows
		.filter(
			(row) =>
				collectionTableRowMatchesWhere(row, query?.where) &&
				// Lexical search re-filters locally; a semantic filter is the server's decision (the
				// rows arrived already ranked against the corpus), so it constrains nothing here.
				(typeof query?.search !== 'string' ||
					collectionTableRowMatchesSearch(row, query.search)) &&
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
 * In-memory operations shared by every read-only tab.
 *
 * The settings views declare no editing actions, so their mutation capability is unreachable. It
 * still refuses explicitly if a future caller invokes it: these rows are projections of access
 * state and cannot be written back through the collection command surface.
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
	count: (query, options) => settled(matchingRows(rows, query, options?.filters).length),
	mutate: () => Effect.runPromise(Effect.fail(new Error('This in-memory collection is read-only'))),
	delete: () => Effect.runPromise(Effect.fail(new Error('This in-memory collection is read-only'))),
	pending: 0
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
