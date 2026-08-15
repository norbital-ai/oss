/**
 * Request-scoped store that does not import `node:async_hooks`.
 *
 * One isolate step is one call, so a module slot is enough there. Standalone may install
 * `globalThis.AsyncLocalStorage` (Node's) before loading the guest bundle so concurrent HTTP
 * requests stay isolated.
 */
type AsyncStore<T> = {
	run<R>(store: T, fn: () => R): R;
	getStore(): T | undefined;
};

class SlotStore<T> implements AsyncStore<T> {
	#store: T | undefined;

	run<R>(store: T, fn: () => R): R {
		const previous = this.#store;
		this.#store = store;
		try {
			const result = fn();
			if (result && typeof Reflect.get(Object(result), 'then') === 'function') {
				return (Promise.resolve(result) as Promise<R>).finally(() => {
					this.#store = previous;
				}) as R;
			}
			this.#store = previous;
			return result;
		} catch (error) {
			this.#store = previous;
			throw error;
		}
	}

	getStore(): T | undefined {
		return this.#store;
	}
}

type AsyncStoreCtor = new <T>() => AsyncStore<T>;

/** Create a store that uses host ALS when present, otherwise a one-call slot. */
export function createAsyncStore<T>(): AsyncStore<T> {
	const impl = (globalThis as { AsyncLocalStorage?: AsyncStoreCtor }).AsyncLocalStorage;
	return impl ? new impl<T>() : new SlotStore<T>();
}
