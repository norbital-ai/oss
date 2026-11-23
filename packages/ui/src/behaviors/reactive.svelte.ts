// Reactive Svelte-5 helpers replacing external utility packages (`watch`, `watch.pre`, `Debounced`,
// `use_debounce`, `PersistedState`). Zero external dependencies, strict types.
import { untrack } from 'svelte';

/** Options controlling whether `watch` skips its initial run (`lazy`) or only runs once (`once`). */
export type WatchOptions = {
	/** Skip the initial effect run and only invoke on subsequent changes (default `false`). */
	readonly lazy?: boolean;
	/** Stop reacting after the first invocation (default `false`). */
	readonly once?: boolean;
};

type Getter<T> = () => T;
type GetterValues<S extends readonly Getter<unknown>[]> = {
	[K in keyof S]: S[K] extends Getter<infer T> ? T : never;
};
type WatchCallback<V> = (
	current: V,
	previous: V | undefined
) => void | (() => void);

function runWatch<V>(
	pre: boolean,
	read: () => V,
	callback: WatchCallback<V>,
	options?: WatchOptions
): void {
	let active = true;
	let ran = false;
	let previous: V | undefined = undefined;
	const lazy = options?.lazy === true;
	const once = options?.once === true;

	const runner = () => {
		if (!active) return;
		const current = read();
		const prev = previous;
		previous = current;
		if (!ran && lazy) {
			ran = true;
			return;
		}
		ran = true;
		if (once) active = false;
		return untrack(() => callback(current, prev));
	};

	if (pre) {
		$effect.pre(runner);
	} else {
		$effect(runner);
	}
}

function makeReader<T>(
	source: Getter<T> | readonly Getter<unknown>[]
): () => T {
	if (typeof source === 'function') return source;
	return () => {
		const values = source.map((fn) => fn());
		// Tuple return from multi-getter array matches the overload signature.
		return Object.assign(values);
	};
}

/**
 * Reactively watches one or more getter sources and invokes `callback(current, previous)` without
 * tracking reads inside `callback`. Supports `{ lazy: true }` and `watch.pre(...)`.
 */
export function watch<T>(
	source: Getter<T>,
	callback: WatchCallback<T>,
	options?: WatchOptions
): void;
export function watch<const S extends readonly Getter<unknown>[]>(
	source: S,
	callback: WatchCallback<GetterValues<S>>,
	options?: WatchOptions
): void;
export function watch<T>(
	source: Getter<T> | readonly Getter<unknown>[],
	callback: WatchCallback<T>,
	options?: WatchOptions
): void {
	runWatch(false, makeReader(source), callback, options);
}

/** Pre-DOM variant of `watch` backed by `$effect.pre`. */
export function watch_pre<T>(
	source: Getter<T>,
	callback: WatchCallback<T>,
	options?: WatchOptions
): void;
export function watch_pre<const S extends readonly Getter<unknown>[]>(
	source: S,
	callback: WatchCallback<GetterValues<S>>,
	options?: WatchOptions
): void;
export function watch_pre<T>(
	source: Getter<T> | readonly Getter<unknown>[],
	callback: WatchCallback<T>,
	options?: WatchOptions
): void {
	runWatch(true, makeReader(source), callback, options);
}

watch.pre = watch_pre;

/**
 * Reactive debounced value mirroring `getter()` after `wait` ms of inactivity.
 */
export class Debounced<T> {
	#box: { value: T };
	#timer: ReturnType<typeof setTimeout> | undefined;
	#wait: () => number;

	constructor(getter: () => T, wait: number | (() => number) = 250) {
		this.#wait = typeof wait === 'function' ? wait : () => wait;
		const box = $state({ value: untrack(getter) });
		this.#box = box;
		let initialized = false;
		$effect(() => {
			const next = getter();
			if (!initialized) {
				initialized = true;
				return;
			}
			const delay = this.#wait();
			if (this.#timer !== undefined) clearTimeout(this.#timer);
			this.#timer = setTimeout(() => {
				this.#box.value = next;
				this.#timer = undefined;
			}, delay);
			return () => {
				if (this.#timer !== undefined) {
					clearTimeout(this.#timer);
					this.#timer = undefined;
				}
			};
		});
	}

	/** The latest settled value. */
	get current(): T {
		return this.#box.value;
	}

	/** Immediately sets the value and cancels any pending debounce timer. */
	updateImmediately = (value: T): void => {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
		this.#box.value = value;
	};

	/** Cancels any pending scheduled update. */
	cancel = (): void => {
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	};
}

/**
 * Debounced callback wrapper with `.cancel()` support for input-driven queries.
 */
export function use_debounce<A extends readonly unknown[]>(
	callback: (...args: A) => void,
	wait: number | (() => number) = 250
): ((...args: A) => void) & { readonly cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const delayOf = typeof wait === 'function' ? wait : () => wait;

	const cancel = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const invoke = (...args: A) => {
		cancel();
		timer = setTimeout(() => {
			timer = undefined;
			callback(...args);
		}, delayOf());
	};

	return Object.assign(invoke, { cancel });
}

/** Storage options for `PersistedState`. */
export type PersistedStateOptions<T> = {
	/** Browser storage backend (`'local'` default, or `'session'`). */
	readonly storage?: 'local' | 'session';
	/** Custom serializer; defaults to JSON. */
	readonly serializer?: {
		readonly serialize: (value: T) => string;
		readonly deserialize: (raw: string) => T;
	};
};

function defaultDeserialize<T>(raw: string): T {
	return JSON.parse(raw);
}

/**
 * Reactive state synchronized with `localStorage` or `sessionStorage` with safe fallback when
 * storage is unavailable or contains malformed JSON.
 */
export class PersistedState<T> {
	#key: string;
	#storage: 'local' | 'session';
	#serialize: (value: T) => string;
	#deserialize: (raw: string) => T;
	#box: { value: T };

	constructor(key: string, initialValue: T, options: PersistedStateOptions<T> = {}) {
		this.#key = key;
		this.#storage = options.storage ?? 'local';
		this.#serialize = options.serializer?.serialize ?? JSON.stringify;
		this.#deserialize = options.serializer?.deserialize ?? defaultDeserialize;
		const box = $state({ value: this.#read(initialValue) });
		this.#box = box;
	}

	#store(): Storage | null {
		try {
			if (typeof window === 'undefined') return null;
			return this.#storage === 'session' ? window.sessionStorage : window.localStorage;
		} catch {
			return null;
		}
	}

	#read(fallback: T): T {
		const store = this.#store();
		if (store === null) return fallback;
		try {
			const raw = store.getItem(this.#key);
			return raw === null ? fallback : this.#deserialize(raw);
		} catch {
			return fallback;
		}
	}

	/** Current persisted value. */
	get current(): T {
		return this.#box.value;
	}

	set current(value: T) {
		this.#box.value = value;
		const store = this.#store();
		if (store === null) return;
		try {
			store.setItem(this.#key, this.#serialize(value));
		} catch {
			// Quota exceeded or blocked storage keeps the in-memory state working.
		}
	}
}
