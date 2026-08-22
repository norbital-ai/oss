import { Effect, Fiber } from 'effect';
import type { ParsedCommandQuery } from '#lib/client/ui/agent/mention-sources.js';

type DebouncedRecordSearchParsed = Pick<ParsedCommandQuery, 'text' | 'collection'>;

/** Debounces record search so caret moves that keep the same query do not refetch. */
export function createDebouncedRecordSearch<T>(options: {
	readonly delayMs?: number;
	readonly search: (text: string, collection: string | null) => Effect.Effect<readonly T[]>;
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
	let fiber: Fiber.Fiber<void> | undefined;
	let version = 0;
	let lastIdentity = '';

	/** Drops the pending search without invalidating in-flight results. */
	function cancel(): void {
		fiber?.interruptUnsafe();
		fiber = undefined;
	}

	/** Forgets the last query so the next schedule can search the same identity again. */
	function invalidate(): void {
		version++;
		cancel();
		lastIdentity = '';
	}

	/** Starts a delayed search, or clears results when the trigger is gone. */
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
		const search = Effect.gen(function* () {
			yield* Effect.sleep(delayMs);
			const hits = yield* options.search(searchText, collection);
			if (searchVersion !== version) return;
			options.onResults(hits);
			options.onLoading(false);
		}).pipe(
			Effect.catch(() =>
				Effect.sync(() => {
					if (searchVersion !== version) return;
					options.onResults([]);
					options.onLoading(false);
				})
			)
		);
		fiber = Effect.runFork(search);
	}

	return { schedule, cancel, invalidate };
}
