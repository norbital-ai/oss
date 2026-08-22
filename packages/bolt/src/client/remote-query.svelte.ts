import { Effect, Fiber, Schema } from 'effect';
import type { QueryCache } from '#lib/client/replica/query-cache.js';
import type { LiveQueryRegistry } from '#lib/client/replica/live-queries.js';

interface RemoteQuery<Value> extends PromiseLike<Value> {
	readonly current: Value | undefined;
	readonly error: unknown;
	readonly loading: boolean;
	readonly refresh: () => Promise<void>;
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
type RemoteQueryCaching = Readonly<{
	readonly cache: QueryCache;
	readonly key: string;
	readonly collections: ReadonlyArray<string>;
	readonly registry: LiveQueryRegistry;
}>;

/** Holds one in-flight command so `$derived` / CollectionTable see rows after the response lands. */
class ReactiveRemoteQuery<Value extends Schema.Json> implements RemoteQuery<Value> {
	current = $state.raw<Value | undefined>(undefined);
	error = $state.raw<unknown>(undefined);
	loading = $state(false);
	readonly #pending: Fiber.Fiber<Value, unknown>;
	readonly #fetch: () => Effect.Effect<Value, unknown>;
	readonly #caching: RemoteQueryCaching | undefined;
	readonly #decodeCached: (value: unknown) => Effect.Effect<Value, unknown>;
	/** Read by the live-query registry to decide whether a sync advance falsified this answer. */
	readonly collections: ReadonlyArray<string>;

	constructor(
		fetchValue: () => Effect.Effect<Value, unknown>,
		caching: RemoteQueryCaching | undefined,
		decodeCached: (value: unknown) => Effect.Effect<Value, unknown>
	) {
		this.#fetch = fetchValue;
		this.#caching = caching;
		this.#decodeCached = decodeCached;
		this.collections = caching?.collections ?? [];
		caching?.registry.register(this);
		this.#pending = Effect.runFork(
			this.#reload().pipe(
				Effect.flatMap(() => {
					// `refresh` catches so the reactive `error` cell can hold the cause; failing here is
					// what keeps the awaited half honest.
					if (this.error !== undefined) return Effect.fail(asError(this.error));
					if (this.current === undefined)
						return Effect.fail(new Error('Remote invocation completed without a value'));
					return Effect.succeed(this.current);
				})
			)
		);
	}

	/**
	 * Revalidates, painting the last known answer first when there is one.
	 *
	 * `loading` stays true across the cached paint on purpose: the answer on screen is real but not
	 * yet confirmed, and a spinner that cleared here would tell the reader the revalidation had
	 * finished. Callers that want "have I got anything to show" already ask `current !== undefined` —
	 * which is exactly the test `companiesUnknown` on the leave page makes.
	 *
	 * The whole flow is one Effect; `runPromise` is the single browser edge, at the signature the
	 * Query API promises its callers. `loading` is reset in the effect's own continuation rather than
	 * in a `finally`, because a cache read failing above the fetch is left to propagate with the flag
	 * still true — the pre-Effect behaviour, which the pending fiber surfaces to its awaiter.
	 */
	refresh = (): Promise<void> => Effect.runPromise(this.#reload());

	readonly #reload = (): Effect.Effect<void, unknown> => {
		// Captured because `Effect.gen` bodies are plain generators, and `this` inside one is
		// whatever it was called with — not the query instance.
		const self = this;
		return Effect.gen(function* () {
			yield* Effect.sync(() => {
				self.loading = true;
				self.error = undefined;
			});
			const caching = self.#caching;
			if (caching !== undefined && self.current === undefined) {
				const cached = yield* caching.cache.read(caching.key);
				// Re-checked after the await: a fetch that resolved while the cache was being read has
				// already written the fresh answer, and overwriting it with the stale one would be a
				// visible flicker backwards.
				if (cached !== undefined && self.current === undefined) {
					// A package upgrade may make a persisted answer older than the operation's schema.
					// Such an entry is a cache miss: it must never paint an invalid value, and the wire
					// revalidation below is still the authority that can replace it.
					const decoded = yield* self
						.#decodeCached(cached)
						.pipe(Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }));
					if (self.current === undefined) self.current = decoded;
				}
			}
			yield* self.#fetch().pipe(
				Effect.match({
					onFailure: (cause) => {
						self.error = asError(cause);
					},
					onSuccess: (value) => {
						self.current = value;
						caching?.cache.write(caching.key, value, caching.collections);
					}
				})
			);
			yield* Effect.sync(() => {
				self.loading = false;
			});
		});
	};

	then = <TResult1 = Value, TResult2 = never>(
		onfulfilled?: ((value: Value) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
	) => Effect.runPromise(Fiber.join(this.#pending)).then(onfulfilled, onrejected);
}

/** Starts a command and exposes its result as Svelte-tracked query state. */
export const createRemoteQuery = <Output extends Schema.ConstraintDecoder<Schema.Json>>(
	fetchValue: () => Effect.Effect<Output['Type'], unknown>,
	caching: RemoteQueryCaching | undefined,
	schema: Output
): RemoteQuery<Output['Type']> =>
	new ReactiveRemoteQuery(fetchValue, caching, Schema.decodeUnknownEffect(schema));
