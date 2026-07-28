export interface LruCacheOptions<T> {
	capacity?: number;
	ttl?: number;
	dispose?: (value: T, key: string) => void;
	sizeCalculation?: (value: T, key: string) => number;
	maxSize?: number;
}

export interface LruCache<T> {
	get(key: string): T | undefined;
	set(key: string, value: T): void;
	getOrCreate(key: string, factory: () => T): T;
	has(key: string): boolean;
	delete(key: string): boolean;
	clear(): void;
	readonly size: number;
}

interface Entry<T> {
	value: T;
	expiry: number;
	size: number;
}

export function lru<T>(options: LruCacheOptions<T> = {}): LruCache<T> {
	const {
		capacity = Infinity,
		ttl = Infinity,
		dispose,
		sizeCalculation,
		maxSize = Infinity
	} = options;

	const cache = new Map<string, Entry<T>>();
	let _size = 0;

	function isExpired(entry: Entry<T>): boolean {
		return entry.expiry < Date.now();
	}

	function evict(): void {
		for (const [key, entry] of cache) {
			if (cache.size <= capacity && _size <= maxSize) break;
			cache.delete(key);
			_size -= entry.size;
			dispose?.(entry.value, key);
		}
	}

	function evictExpired(): void {
		for (const [key, entry] of cache) {
			if (!isExpired(entry)) break;
			cache.delete(key);
			_size -= entry.size;
			dispose?.(entry.value, key);
		}
	}

	return {
		get size(): number {
			return cache.size;
		},

		get(key: string): T | undefined {
			evictExpired();

			const entry = cache.get(key);
			if (!entry || isExpired(entry)) {
				if (entry) {
					cache.delete(key);
					_size -= entry.size;
					dispose?.(entry.value, key);
				}
				return undefined;
			}

			cache.delete(key);
			cache.set(key, entry);
			return entry.value;
		},

		set(key: string, value: T): void {
			const existing = cache.get(key);
			if (existing) {
				cache.delete(key);
				_size -= existing.size;
				dispose?.(existing.value, key);
			}

			const computedSize = sizeCalculation ? sizeCalculation(value, key) : 1;
			if (computedSize > maxSize) return;

			const entry: Entry<T> = {
				value,
				expiry: Date.now() + ttl,
				size: computedSize
			};

			cache.set(key, entry);
			_size += computedSize;

			while (cache.size > capacity || _size > maxSize) {
				const oldest = cache.keys().next().value;
				if (oldest === undefined) break;
				const evicted = cache.get(oldest);
				cache.delete(oldest);
				if (evicted) {
					_size -= evicted.size;
					dispose?.(evicted.value, oldest);
				}
			}
		},

		getOrCreate(key: string, factory: () => T): T {
			const existing = this.get(key);
			if (existing !== undefined) return existing;
			const created = factory();
			this.set(key, created);
			return created;
		},

		has(key: string): boolean {
			evictExpired();
			const entry = cache.get(key);
			if (!entry) return false;
			if (isExpired(entry)) {
				cache.delete(key);
				_size -= entry.size;
				dispose?.(entry.value, key);
				return false;
			}
			return true;
		},

		delete(key: string): boolean {
			const entry = cache.get(key);
			if (entry) {
				cache.delete(key);
				_size -= entry.size;
				dispose?.(entry.value, key);
				return true;
			}
			return false;
		},

		clear(): void {
			for (const [key, entry] of cache) {
				dispose?.(entry.value, key);
			}
			cache.clear();
			_size = 0;
		}
	};
}

const _dedupQueues = new Map<string, Promise<void>>();

export function dedup<T>(
	cache: LruCache<T>,
	key: string,
	factory: () => T | Promise<T>
): Promise<T> {
	const previous = _dedupQueues.get(key) ?? Promise.resolve();

	let release!: () => void;
	const next = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => next);
	_dedupQueues.set(key, queued);

	return previous
		.then(() => {
			const cached = cache.get(key);
			if (cached !== undefined) return cached;
			return factory();
		})
		.then((result): T => {
			cache.set(key, result);
			return result;
		})
		.finally(() => {
			release();
			_dedupQueues.delete(key);
		});
}
