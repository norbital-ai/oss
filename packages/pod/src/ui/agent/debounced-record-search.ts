import type { ParsedCommandQuery } from './mention-sources.js';

export type DebouncedRecordSearchParsed = Pick<ParsedCommandQuery, 'text' | 'collection'>;

/** Debounces record search so caret moves that keep the same query do not refetch. */
export function createDebouncedRecordSearch<T>(options: {
	readonly delayMs?: number;
	readonly search: (text: string, collection: string | null) => Promise<readonly T[]>;
	readonly onLoading: (loading: boolean) => void;
	readonly onResults: (hits: readonly T[]) => void;
}): {
	readonly schedule: (
		identity: string,
		parsed: DebouncedRecordSearchParsed | null,
		shouldSearch: boolean
	) => void;
	readonly cancel: () => void;
	readonly invalidate: () => void;
} {
	const delayMs = options.delayMs ?? 150;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let version = 0;
	let lastIdentity = '';

	/** Drops the pending timer without invalidating in-flight results. */
	// stupidity:allow Q4 -- named helper
	function cancel(): void {
		clearTimeout(timer);
		timer = undefined;
	}

	/** Forgets the last query so the next schedule can search the same identity again. */
	// stupidity:allow Q3 -- factory method; stupidity:allow Q4 -- named helper
	function invalidate(): void {
		version++;
		cancel();
		lastIdentity = '';
	}

	/** Starts a delayed search, or clears results when the trigger is gone. */
	// stupidity:allow Q3 -- factory method
	function schedule(
		identity: string,
		parsed: DebouncedRecordSearchParsed | null,
		shouldSearch: boolean
	): void {
		cancel();
		if (identity === lastIdentity) return;
		lastIdentity = identity;
		if (!shouldSearch || !parsed) {
			version++;
			options.onResults([]);
			options.onLoading(false);
			return;
		}
		const searchVersion = ++version;
		options.onLoading(true);
		const searchText = parsed.text.trim();
		const collection = parsed.collection;
		timer = setTimeout(() => {
			void options
				.search(searchText, collection)
				.then((hits) => {
					if (searchVersion !== version) return;
					options.onResults(hits);
					options.onLoading(false);
				})
				.catch(() => {
					if (searchVersion !== version) return;
					options.onResults([]);
					options.onLoading(false);
				});
		}, delayMs);
	}

	return { schedule, cancel, invalidate };
}
