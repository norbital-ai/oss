import { Cache, Effect, Exit } from 'effect';
import { PlatformError } from './adapter.ts';

/** An app token and how long it stays good, in milliseconds. */
export type Token = { readonly token: string; readonly ttl: number };

/**
 * One connection's app token per credential `key`, refreshed once for concurrent callers. A failed refresh is not kept:
 * the next `get` asks again. `invalidate` drops it after a refusal names a revoked token.
 */
export const tokenCache = <E, K = void>(load: (key: K) => Effect.Effect<Token, E>) =>
	Effect.map(
		Cache.makeWith(load, {
			capacity: 1,
			timeToLive: (exit) =>
				Exit.isSuccess(exit) && Number.isFinite(exit.value.ttl) ? Math.max(0, exit.value.ttl) : 0
		}),
		(cache) => ({
			get: (key: K) => Effect.map(Cache.get(cache, key), (t) => t.token),
			invalidate: Cache.invalidateAll(cache)
		})
	);

/** A chat adapter's Promise token load, its rejection a `PlatformError`. */
export const loadToken = (load: () => Promise<Token>) =>
	Effect.tryPromise({
		try: load,
		catch: (cause) =>
			cause instanceof PlatformError
				? cause
				: new PlatformError(cause instanceof Error ? cause.message : String(cause), 502)
	});
