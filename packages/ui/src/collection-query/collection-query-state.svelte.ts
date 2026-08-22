import type {
	CollectionFilter,
	CollectionFilterOptions,
	CollectionRecord
} from '@norbital-ai/std/collection';
import { PersistedState } from 'runed';
import { Number as Number_ } from 'effect';

/**
 * A filter path checked against the row it filters.
 *
 * `CollectionFilter.path` on the wire is `string[]` — nothing stops a surface from filtering on a
 * field the collection does not have, and nothing tells you it happened; the query simply returns
 * everything or nothing. One hop for a column on the row, two for a column on an expanded relation.
 */
export type CollectionFilterPath<TRow extends object> =
	readonly [Extract<keyof TRow, string>] | readonly [Extract<keyof TRow, string>, string];

export interface TypedCollectionFilter<TRow extends object> {
	readonly path: CollectionFilterPath<TRow>;
	readonly operator: CollectionFilter['operator'];
	readonly operand?: unknown;
}

export interface CollectionQueryStateOptions<TRow extends object> {
	readonly search?: string;
	readonly filters?: readonly TypedCollectionFilter<TRow>[];
	readonly pageSize?: number;
	/**
	 * View key the *page size* is remembered against.
	 *
	 * Only the page size. How many rows you want to see at once is a preference about the surface;
	 * the search, the filters and the page you are on are the question you asked on this visit, and
	 * a surface that restores them answers a question nobody has asked yet. Page index in particular
	 * cannot be restored honestly by a cursor-paged surface: the cursors are rebuilt from scratch on
	 * mount, so a remembered "page 4" would label the first page as the fourth.
	 */
	readonly persistenceKey?: string;
}

export const DEFAULT_COLLECTION_PAGE_SIZE = 50;
const MAX_COLLECTION_PAGE_SIZE = 500;

/**
 * The one search + filter + pagination model a collection surface binds.
 *
 * Every surface used to keep its own three pieces of state and its own rule for how they interact,
 * and the rule is the part that kept going wrong. Narrowing a result set invalidates the page you
 * are on: filter a six-page board down to one page while sitting on page four and the query asks
 * for rows past the end, so the surface renders empty and reads as broken. `CollectionTable` knew
 * this and called `resetToFirstPage()`; the roster month board knew it too and assigned
 * `boardPage = 0` by hand in five separate handlers, which is five chances to forget.
 *
 * Here the reset is not something a caller remembers to do — `setSearch` and `setFilters` own it,
 * because it is a property of the model rather than of any one surface.
 */
export class CollectionQueryState<TRow extends object = CollectionRecord> {
	#search = $state('');
	#filters = $state<readonly CollectionFilter[]>([]);
	#pageIndex = $state(0);
	#pageSize = $state(DEFAULT_COLLECTION_PAGE_SIZE);
	#storedPageSize: PersistedState<number> | null = null;

	constructor(options: CollectionQueryStateOptions<TRow> = {}) {
		this.#search = options.search ?? '';
		this.#filters = options.filters ?? [];
		const requestedPageSize = clampPageSize(options.pageSize ?? DEFAULT_COLLECTION_PAGE_SIZE);
		if (options.persistenceKey == null) {
			this.#pageSize = requestedPageSize;
			return;
		}
		this.#storedPageSize = new PersistedState(
			`${options.persistenceKey}.pageSize`,
			requestedPageSize
		);
		this.#pageSize = clampPageSize(this.#storedPageSize.current);
	}

	get search(): string {
		return this.#search;
	}

	get filters(): readonly CollectionFilter[] {
		return this.#filters;
	}

	get pageIndex(): number {
		return this.#pageIndex;
	}

	get pageSize(): number {
		return this.#pageSize;
	}

	/** True while the result set is narrowed, so a surface can offer "clear" without recomputing. */
	get narrowed(): boolean {
		return this.#search.trim().length > 0 || this.#filters.length > 0;
	}

	setSearch(search: string): void {
		const next = search.trim().normalize('NFC');
		if (next === this.#search) return;
		this.#search = next;
		this.#pageIndex = 0;
	}

	setFilters(filters: readonly CollectionFilter[]): void {
		this.#filters = filters;
		this.#pageIndex = 0;
	}

	setPageIndex(pageIndex: number): void {
		this.#pageIndex = Math.max(0, Math.trunc(pageIndex));
	}

	setPageSize(pageSize: number): void {
		const next = clampPageSize(pageSize);
		if (next === this.#pageSize) return;
		this.#pageSize = next;
		if (this.#storedPageSize) this.#storedPageSize.current = next;
		// A different page size means different page boundaries, so the current index means nothing.
		this.#pageIndex = 0;
	}

	clear(): void {
		this.#search = '';
		this.#filters = [];
		this.#pageIndex = 0;
	}

	/**
	 * What the generated client takes.
	 *
	 * The wire path is a mutable `string[]`, so this copies rather than casts: the state's own
	 * tuples stay readonly and a consumer cannot reach through the query options to mutate them.
	 */
	get queryOptions(): CollectionFilterOptions {
		const filters: CollectionFilter[] = this.#filters.map((filter) => ({
			path: [...filter.path],
			operator: filter.operator,
			operand: filter.operand
		}));
		return { filters };
	}
}

function clampPageSize(pageSize: number): number {
	if (!Number.isFinite(pageSize)) return DEFAULT_COLLECTION_PAGE_SIZE;
	return Number_.clamp(Math.trunc(pageSize), { minimum: 1, maximum: MAX_COLLECTION_PAGE_SIZE });
}
