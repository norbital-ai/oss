export type DebouncedRecordSearchParsed = {
	readonly text: string;
	readonly collection: string | null;
};

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

	function cancel(): void {
		clearTimeout(timer);
		timer = undefined;
	}

	function invalidate(): void {
		version++;
		cancel();
		lastIdentity = '';
	}

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
