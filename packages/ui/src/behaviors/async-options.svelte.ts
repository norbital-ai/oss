// Async option loader for remote Combobox, CommandMenu, Picker and Finder searches:
// debounces input, aborts superseded requests so only the latest query commits, keeps previous
// items visible while loading (stale-while-revalidating) and supports paginated `load_more()`.
import { untrack } from 'svelte';

/** Load lifecycle state of `create_async_options`. */
export type AsyncOptionsStatus = 'idle' | 'loading' | 'error';

/** Page payload returned by `AsyncOptionsOptions.load`. */
export type AsyncOptionsPage<T> =
	| readonly T[]
	| {
			readonly items: readonly T[];
			readonly has_more?: boolean;
	  };

/** Context passed to `AsyncOptionsOptions.load`. */
export type AsyncOptionsContext = {
	/** Aborted automatically when a newer query or reset supersedes this request. */
	readonly signal: AbortSignal;
	/** Zero-based page index (`0` for fresh query, incremented by `load_more()`). */
	readonly page: number;
};

/** Options for `create_async_options`. */
export type AsyncOptionsOptions<T> = {
	/** Fetches matching items for `query` and `ctx.page`, honoring `ctx.signal`. */
	readonly load: (query: string, ctx: AsyncOptionsContext) => Promise<AsyncOptionsPage<T>>;
	/** Initial query (default `''`). */
	readonly initial_query?: string;
	/** Typing debounce window in ms (default `200`). */
	readonly debounce_ms?: number;
	/** Fetch immediately for `initial_query` on mount (default `false`). */
	readonly immediate?: boolean;
};

/** Return value of `create_async_options`. */
export type AsyncOptions<T> = ReturnType<typeof create_async_options<T>>;

function normalizePage<T>(page: AsyncOptionsPage<T>): { items: readonly T[]; has_more: boolean } {
	if ('items' in page) return { items: page.items, has_more: page.has_more === true };
	return { items: page, has_more: false };
}

/**
 * Headless debounced, abortable, paginated async option loader.
 */
export function create_async_options<T>(options: AsyncOptionsOptions<T>) {
	let query = $state(options.initial_query ?? '');
	let items = $state.raw<readonly T[]>([]);
	let status = $state<AsyncOptionsStatus>('idle');
	let error = $state<unknown>(undefined);
	let hasMore = $state(false);

	let page = 0;
	let requestSeq = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let controller: AbortController | null = null;
	const debounceMs = options.debounce_ms ?? 200;

	function cancelInFlight(): void {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		if (controller !== null) {
			controller.abort();
			controller = null;
		}
	}

	async function execute(nextQuery: string, nextPage: number, append: boolean): Promise<void> {
		cancelInFlight();
		const seq = ++requestSeq;
		const ac = new AbortController();
		controller = ac;
		status = 'loading';
		error = undefined;

		try {
			const result = normalizePage(await options.load(nextQuery, { signal: ac.signal, page: nextPage }));
			if (ac.signal.aborted || seq !== requestSeq) return;
			items = append ? [...items, ...result.items] : [...result.items];
			hasMore = result.has_more;
			page = nextPage;
			status = 'idle';
		} catch (err) {
			if (ac.signal.aborted || seq !== requestSeq) return;
			error = err;
			status = 'error';
		} finally {
			if (controller === ac) controller = null;
		}
	}

	function schedule(nextQuery: string, immediate = false): void {
		cancelInFlight();
		if (immediate || debounceMs <= 0) {
			void execute(nextQuery, 0, false);
			return;
		}
		status = 'loading';
		timer = setTimeout(() => {
			timer = undefined;
			void execute(nextQuery, 0, false);
		}, debounceMs);
	}

	function set_query(next: string, opts: { immediate?: boolean } = {}): void {
		query = next;
		schedule(next, opts.immediate === true);
	}

	function load_more(): void {
		if (!hasMore || status === 'loading') return;
		void execute(query, page + 1, true);
	}

	function reload(): void {
		void execute(query, 0, false);
	}

	function reset(): void {
		cancelInFlight();
		requestSeq++;
		query = options.initial_query ?? '';
		items = [];
		status = 'idle';
		error = undefined;
		hasMore = false;
		page = 0;
	}

	$effect(() => {
		if (options.immediate) {
			untrack(() => void execute(query, 0, false));
		}
		return () => cancelInFlight();
	});

	return {
		get query() {
			return query;
		},
		set query(value: string) {
			set_query(value);
		},
		get items() {
			return items;
		},
		get status() {
			return status;
		},
		get loading() {
			return status === 'loading';
		},
		get error() {
			return error;
		},
		get has_more() {
			return hasMore;
		},
		set_query,
		load_more,
		reload,
		reset,
		cancel: cancelInFlight
	};
}
