import type { Schema } from 'effect';
import type { QueryCache } from './replica/query-cache.js';
import type { LiveQueryRegistry } from './replica/live-queries.js';

export interface RemoteQuery<Value> extends PromiseLike<Value> {
	readonly current: Value | undefined;
	readonly error: unknown;
	readonly loading: boolean;
	readonly refresh: () => Promise<void>;
}

export interface CollectionPageQuery<Value> extends RemoteQuery<Value> {
	readonly nextCursor: string | null | undefined;
}

const asError = (cause: unknown): Error =>
	cause instanceof Error
		? cause
		: new Error(cause == null ? 'Remote invocation failed' : String(cause));

/**
 * What a query needs to take part in the sync engine's cache.
 *
 * Optional as a whole: a runtime built without a cache — the test harness, a non-browser caller —
 * gets exactly the previous fetch-every-time behaviour rather than a second code path.
 */
export type RemoteQueryCaching = Readonly<{
	readonly cache: QueryCache;
	readonly key: string;
	readonly collections: ReadonlyArray<string>;
	readonly registry: LiveQueryRegistry;
}>;

/** Holds one in-flight command so `$derived` / CollectionTable see rows after the response lands. */
class ReactiveRemoteQuery implements RemoteQuery<Schema.Json> {
	current = $state.raw<Schema.Json | undefined>(undefined);
	error = $state.raw<unknown>(undefined);
	loading = $state(false);
	readonly #pending: Promise<Schema.Json>;
	readonly #fetch: () => Promise<Schema.Json>;
	readonly #caching: RemoteQueryCaching | undefined;
	/** Read by the live-query registry to decide whether a sync advance falsified this answer. */
	readonly collections: ReadonlyArray<string>;

	constructor(fetchValue: () => Promise<Schema.Json>, caching?: RemoteQueryCaching) {
		this.#fetch = fetchValue;
		this.#caching = caching;
		this.collections = caching?.collections ?? [];
		caching?.registry.register(this);
		this.#pending = this.refresh().then(() => {
			// `refresh` catches so the reactive `error` cell can hold the cause; rethrowing it here is
			// what keeps the awaited half honest. This used to raise a fresh
			// `Remote invocation completed without a value`, which named neither the command nor the
			// reason — a remote failing on `operator does not exist: text = uuid` reached the reader as
			// "could not be loaded" and the console as a sentence about undefined.
			if (this.error !== undefined) throw asError(this.error);
			if (this.current === undefined)
				throw new Error('Remote invocation completed without a value');
			return this.current;
		});
	}

	/**
	 * Revalidates, painting the last known answer first when there is one.
	 *
	 * `loading` stays true across the cached paint on purpose: the answer on screen is real but not
	 * yet confirmed, and a spinner that cleared here would tell the reader the revalidation had
	 * finished. Callers that want "have I got anything to show" already ask `current !== undefined` —
	 * which is exactly the test `companiesUnknown` on the leave page makes.
	 */
	refresh = async (): Promise<void> => {
		this.loading = true;
		this.error = undefined;
		const caching = this.#caching;
		if (caching !== undefined && this.current === undefined) {
			const cached = await caching.cache.read(caching.key);
			// Re-checked after the await: a fetch that resolved while the cache was being read has
			// already written the fresh answer, and overwriting it with the stale one would be a
			// visible flicker backwards.
			if (cached !== undefined && this.current === undefined) this.current = cached;
		}
		try {
			const value = await this.#fetch();
			this.current = value;
			caching?.cache.write(caching.key, value, caching.collections);
		} catch (cause) {
			this.error = asError(cause);
		} finally {
			this.loading = false;
		}
	};

	then = <TResult1 = Schema.Json, TResult2 = never>(
		onfulfilled?: ((value: Schema.Json) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
	) => this.#pending.then(onfulfilled, onrejected);
}

/** Starts a command and exposes its result as Svelte-tracked query state. */
export const createRemoteQuery = (
	fetchValue: () => Promise<Schema.Json>,
	caching?: RemoteQueryCaching
): RemoteQuery<Schema.Json> => new ReactiveRemoteQuery(fetchValue, caching);
