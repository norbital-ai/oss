export interface RemoteQuery<T> {
	readonly current: T | undefined;
	readonly loading: boolean;
	readonly error: Error | undefined;
	refresh(): Promise<void>;
}

type RemoteQueryLoader<T> = (signal: AbortSignal | undefined) => Promise<T>;

export function remoteQueryKey(keyPrefix: string, path: string, body: unknown): string {
	const canonicalBody = JSON.stringify(body, (_key, entry: unknown) => {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
		return Object.fromEntries(
			Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))
		);
	});
	return `${keyPrefix}${path}:${canonicalBody}`;
}

class RemoteQueryResource<T> {
	current = $state<T>();
	loading = $state(false);
	error = $state<Error>();
	pending: Promise<T>;
	controller: AbortController | null = null;
	generation = 0;
	/** Bumped on every read of `current`. A rendered query re-reads it each render pass, so
	 *  anything on screen is by construction among the most recently accessed. */
	lastAccess = Date.now();
	/** True once a value has ever been produced — `current` is then real data, not a placeholder. */
	settled = false;

	constructor(
		readonly key: string,
		readonly load: RemoteQueryLoader<T>,
		placeholder?: T
	) {
		// Seed with the previous result for this query family. Changing a filter, sort, page or
		// search term mints a new key; without a seed the UI would render `undefined` for a frame
		// and the table would blank out and refill. See sync/README.md §3.2.
		if (placeholder !== undefined) this.current = placeholder;
		this.pending = this.start();
	}

	start(): Promise<T> {
		const generation = ++this.generation;
		this.error = undefined;
		const pending = this.load(this.controller?.signal ?? undefined);
		this.pending = pending;

		// `loading` means "nothing to show", not "a request is in flight". A re-evaluation over
		// warm local data resolves in well under a frame, and a query that already has data — its
		// own or its family's — must never swap it for a spinner.
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (this.current === undefined) {
			timer = setTimeout(() => {
				timer = undefined;
				if (this.current === undefined) this.loading = true;
			}, 100);
		}

		void pending.then(
			(value) => {
				if (timer) clearTimeout(timer);
				if (generation !== this.generation) return;
				this.current = value;
				this.settled = true;
				this.loading = false;
			},
			(error) => {
				if (timer) clearTimeout(timer);
				if (generation !== this.generation) return;
				if (error instanceof DOMException && error.name === 'AbortError') return;
				this.error = error instanceof Error ? error : new Error(String(error));
				this.loading = false;
			}
		);
		return pending;
	}
}

export class ReactiveRemoteQuery<T> implements RemoteQuery<T>, PromiseLike<T> {
	private readonly resource: RemoteQueryResource<T>;

	constructor(resource: RemoteQueryResource<T>) {
		this.resource = resource;
	}

	get current(): T | undefined {
		// Touch on read: this is what keeps a mounted query out of the eviction set.
		this.resource.lastAccess = Date.now();
		return this.resource.current;
	}

	get loading(): boolean {
		return this.resource.loading;
	}

	get error(): Error | undefined {
		return this.resource.error;
	}

	async refresh(): Promise<void> {
		if (!this.resource.loading) this.resource.start();
		await this.resource.pending.catch(() => undefined);
	}

	then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
	): PromiseLike<TResult1 | TResult2> {
		return this.resource.pending.then(onfulfilled, onrejected);
	}
}

/**
 * Cap on cached resources, evicted least-recently-read first.
 *
 * Evicting a resource that is still mounted guarantees a recreate-with-`undefined` on its next
 * read — a blink caused entirely by the cache. Reading `current` touches `lastAccess`, so
 * on-screen queries sort to the hot end and are never the ones dropped. The cap is generous
 * because a single page of relationship columns can hold well over a hundred resources at once,
 * which is exactly what made the previous cap of 100 thrash.
 */
const MAX_QUERY_RESOURCES = 500;

export class RemoteQueryResourceManager<T> {
	private readonly resources = new Map<string, RemoteQueryResource<T>>();
	/** Most recent settled value per family prefix, used to seed a new key in the same family. */
	private readonly families = new Map<string, T>();

	query(key: string, load: RemoteQueryLoader<T>, familyKey?: string): ReactiveRemoteQuery<T> {
		let resource = this.resources.get(key);
		if (!resource) {
			resource = new RemoteQueryResource(
				key,
				load,
				familyKey ? this.families.get(familyKey) : undefined
			);
			this.resources.set(key, resource);
			if (familyKey) this.trackFamily(resource, familyKey);
			this.prune();
		} else {
			resource.lastAccess = Date.now();
		}
		return new ReactiveRemoteQuery(resource);
	}

	private trackFamily(resource: RemoteQueryResource<T>, familyKey: string): void {
		void resource.pending.then(
			(value) => this.families.set(familyKey, value),
			() => undefined
		);
	}

	invalidate(keyPrefix: string): void {
		for (const [key, resource] of this.resources) {
			if (key.startsWith(keyPrefix)) resource.start();
		}
	}

	private prune(): void {
		if (this.resources.size <= MAX_QUERY_RESOURCES) return;
		const evictable = [...this.resources.values()]
			.filter((resource) => !resource.loading)
			.sort((left, right) => left.lastAccess - right.lastAccess);
		const excess = this.resources.size - MAX_QUERY_RESOURCES;
		for (const resource of evictable.slice(0, excess)) this.resources.delete(resource.key);
	}
}
