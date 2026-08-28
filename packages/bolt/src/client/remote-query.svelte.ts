import { Effect, Fiber, Schema } from 'effect';
import type { QueryCache } from '#lib/client/replica/query-cache.js';
import type { LiveQueryRegistry } from '#lib/client/replica/live-queries.js';
import type { RemoteQuery } from '@norbital-ai/std/collection';

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
	/** A server-only response may remain live without being retained in browser storage. */
	readonly retain?: (value: Schema.Json) => boolean;
}>;

/**
 * One reload attempt's publication fence.
 *
 * Transport cancellation is an optimisation, not a correctness boundary: a response may win the
 * network race after a newer search/filter request has already started. Callers use this fence
 * before installing any durable proof, while this module uses the same fence before changing the
 * reactive value. That makes "request 10 cannot publish over request 11" one invariant rather than
 * two best-effort checks.
 */
export type RemoteQueryAttempt = Readonly<{
	readonly generation: number;
	readonly isCurrent: () => boolean;
}>;

/** Holds one in-flight command so `$derived` / CollectionTable see rows after the response lands. */
class ReactiveRemoteQuery<Value extends Schema.Json> implements RemoteQuery<Value> {
	current = $state.raw<Value | undefined>(undefined);
	error = $state.raw<Error | undefined>(undefined);
	loading = $state(false);
	readonly #pending: Fiber.Fiber<Value, unknown>;
	readonly #fetch: (attempt: RemoteQueryAttempt) => Effect.Effect<Value, unknown>;
	readonly #caching: RemoteQueryCaching | undefined;
	#requestGeneration = 0;
	/** Keeps the registry's weak registration alive for exactly as long as this query is alive. */
	readonly #liveRegistration:
		| Readonly<{
				readonly collections: ReadonlyArray<string>;
				readonly reexecute: () => Effect.Effect<void, unknown>;
		  }>
		| undefined;

	constructor(
		fetchValue: (attempt: RemoteQueryAttempt) => Effect.Effect<Value, unknown>,
		caching: RemoteQueryCaching | undefined
	) {
		this.#fetch = fetchValue;
		this.#caching = caching;
		if (caching === undefined) {
			this.#liveRegistration = undefined;
		} else {
			this.#liveRegistration = {
				collections: caching.collections,
				reexecute: () => this.#reload()
			};
			caching.registry.register(this.#liveRegistration);
		}
		this.#pending = Effect.runFork(
			this.#reload().pipe(
				Effect.flatMap(() => {
					// Re-execution records failures in the reactive `error` cell; failing here is
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
	 * The whole flow is one Effect. `loading` is reset in the effect's own continuation rather than in
	 * a `finally`, because a cache read failing above the fetch is left to propagate with the flag still
	 * true — the pending fiber surfaces that failure to its awaiter.
	 */
	readonly #reload = (): Effect.Effect<void, unknown> => {
		// Captured because `Effect.gen` bodies are plain generators, and `this` inside one is
		// whatever it was called with — not the query instance.
		const self = this;
		const generation = (this.#requestGeneration += 1);
		const attempt: RemoteQueryAttempt = {
			generation,
			isCurrent: () => self.#requestGeneration === generation
		};
		return Effect.gen(function* () {
			yield* Effect.sync(() => {
				self.loading = true;
				self.error = undefined;
			});
			const caching = self.#caching;
			// Persisted query values carry no coverage cursor. They remain useful as post-fetch
			// bookkeeping/dedup metadata, but never paint: a page is local only through a PGlite proof,
			// and every other command revalidates with its authority before becoming visible.
			yield* self.#fetch(attempt).pipe(
				Effect.match({
					onFailure: (cause) => {
						if (!attempt.isCurrent()) return;
						self.error = asError(cause);
					},
					onSuccess: (value) => {
						if (!attempt.isCurrent()) return;
						self.current = value;
						if (caching !== undefined && (caching.retain?.(value) ?? true)) {
							caching.cache.write(caching.key, value, caching.collections);
						} else if (caching !== undefined) {
							// A prior release may already have persisted this server-only query. Dropping
							// its dependency set removes that legacy copy as well as refusing the new one.
							caching.cache.invalidate(caching.collections);
						}
					}
				})
			);
			yield* Effect.sync(() => {
				if (attempt.isCurrent()) self.loading = false;
			});
		});
	};

	then: RemoteQuery<Value>['then'] = (onfulfilled, onrejected) =>
		Effect.runPromise(Fiber.join(this.#pending)).then(onfulfilled, onrejected);
}

/** Starts a command and exposes its result as Svelte-tracked query state. */
export const createRemoteQuery = <Output extends Schema.ConstraintDecoder<Schema.Json>>(
	fetchValue: (attempt: RemoteQueryAttempt) => Effect.Effect<Output['Type'], unknown>,
	caching: RemoteQueryCaching | undefined,
	_schema: Output
): RemoteQuery<Output['Type']> =>
	new ReactiveRemoteQuery(fetchValue, caching);
