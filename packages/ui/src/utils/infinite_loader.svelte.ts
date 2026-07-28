export type InfiniteLoader<T> = {
	items: T[];
	total: number;
	isLoading: boolean;
	isFetchingNextPage: boolean;
	hasNextPage: boolean;
	loadedCount: number;
	error: Error | null;
	fetchNextPage: () => Promise<void>;
	refresh: () => Promise<void>;
	/** Replace a loaded row in place (e.g. after inline edit) without refetching the list. */
	replaceRecord: (matcher: (item: T) => boolean, next: T) => void;
	/** Remove a row; returns the removed record when found. */
	removeRecord: (matcher: (item: T) => boolean) => T | undefined;
	/** Insert a row at index (clamped); bumps total when the list is not full. */
	insertRecord: (record: T, index?: number) => void;
};

export function createInfiniteLoader<T>(
	fetcher: (opts: { offset: number; limit: number }) => Promise<{ records: T[]; total: number }>,
	limit: number
): InfiniteLoader<T> {
	let items = $state<T[]>([]);
	let total = $state(0);
	let isLoading = $state(false);
	let isFetchingNextPage = $state(false);
	let error = $state<Error | null>(null);
	let requestId = 0;

	const loadedCount = $derived(items.length);
	const hasNextPage = $derived(total > 0 && items.length < total);

	async function loadPage(offset: number, mode: 'replace' | 'append'): Promise<void> {
		const currentRequestId = ++requestId;
		const replacing = mode === 'replace';
		if (replacing) {
			isLoading = true;
			isFetchingNextPage = false;
			items = [];
			total = 0;
		} else {
			isFetchingNextPage = true;
		}
		error = null;

		try {
			const res = await fetcher({ offset, limit });
			if (currentRequestId !== requestId) return;
			items = replacing ? (res.records ?? []) : [...items, ...(res.records ?? [])];
			const rawTotal = res.total ?? 0;
			total = rawTotal < 0 ? items.length : rawTotal;
		} catch (e) {
			if (currentRequestId !== requestId) return;
			error = e as Error;
		} finally {
			if (currentRequestId === requestId) {
				isLoading = false;
				isFetchingNextPage = false;
			}
		}
	}

	async function refresh(): Promise<void> {
		await loadPage(0, 'replace');
	}

	async function fetchNextPage(): Promise<void> {
		if (isLoading || isFetchingNextPage || !hasNextPage) return;
		await loadPage(items.length, 'append');
	}

	function replaceRecord(matcher: (item: T) => boolean, next: T): void {
		const index = items.findIndex(matcher);
		if (index < 0) return;
		if (items[index] === next) return;
		items = [...items.slice(0, index), next, ...items.slice(index + 1)];
	}

	function removeRecord(matcher: (item: T) => boolean): T | undefined {
		const index = items.findIndex(matcher);
		if (index < 0) return undefined;
		const removed = items[index];
		items = [...items.slice(0, index), ...items.slice(index + 1)];
		if (total > 0) total -= 1;
		return removed;
	}

	function insertRecord(record: T, index = items.length): void {
		const at = Math.max(0, Math.min(index, items.length));
		items = [...items.slice(0, at), record, ...items.slice(at)];
		total += 1;
	}

	return {
		get items() {
			return items;
		},
		get total() {
			return total;
		},
		get isLoading() {
			return isLoading;
		},
		get isFetchingNextPage() {
			return isFetchingNextPage;
		},
		get hasNextPage() {
			return hasNextPage;
		},
		get loadedCount() {
			return loadedCount;
		},
		get error() {
			return error;
		},
		fetchNextPage,
		refresh,
		replaceRecord,
		removeRecord,
		insertRecord
	};
}
