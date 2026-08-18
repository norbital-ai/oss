import type { Schema } from 'effect';

/**
 * The read cache the sync engine invalidates.
 *
 * The browser replica used to hold rows nothing read: `startBrowserReplica` drained the whole outbox
 * into a `Map` and the API proxy went to the network anyway, so a refresh cost exactly what a cold
 * load cost and the sync engine was pure overhead. This is the other half of that design.
 *
 * What it deliberately does **not** do is answer queries locally. The server owns query semantics —
 * `where` over nested relations, `orderBy`, keyset cursors, `with` joins — and a second, approximate
 * implementation of that in the browser is a machine for returning subtly wrong rows. So the cache is
 * keyed by the *question* rather than by row, the server stays the only thing that answers it, and
 * the outbox's job becomes saying which cached answers stopped being true.
 *
 * That split is what makes staleness bounded rather than open-ended: an entry survives only until a
 * write touches a collection it read, and every read revalidates in the background regardless.
 */

/** A cached answer, with the collections whose changes would falsify it. */
export type CachedAnswer = Readonly<{
	readonly value: Schema.Json;
	readonly collections: ReadonlyArray<string>;
	readonly at: number;
}>;

/**
 * A key that is stable across object key order.
 *
 * `JSON.stringify` follows insertion order, so `{ collection, limit }` and `{ limit, collection }`
 * are the same query and would otherwise be two cache entries — which is not a correctness bug but
 * halves the hit rate on exactly the queries a page re-issues on every mount.
 */
const stableStringify = (value: unknown): string => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => entry !== undefined)
		.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
};

export const cacheKeyFor = (command: string, input: Schema.Json): string =>
	`${command}::${stableStringify(input)}`;

/**
 * Which collections an answer depends on.
 *
 * A collection read names its collection, and `with` names the relations it joined — a change to a
 * joined row changes the answer just as much as a change to the root row does, so the relation keys
 * are included even though they are relation names rather than collection names. Over-naming costs a
 * refetch; under-naming serves a stale answer forever, so the asymmetry decides the default.
 *
 * `invoke.*` is the interesting case. A remote handler is arbitrary code that may read anything —
 * `approval_analytics` counts `leave_requests` without the input mentioning it — so there is nothing
 * honest to derive. `ANY_COLLECTION` says so, and any write at all invalidates it.
 */
export const ANY_COLLECTION = '*';

export const collectionsFor = (command: string, input: Schema.Json): ReadonlyArray<string> => {
	if (!command.startsWith('collections.')) return [ANY_COLLECTION];
	if (input === null || typeof input !== 'object' || Array.isArray(input)) return [ANY_COLLECTION];
	const collection = Reflect.get(input, 'collection');
	if (typeof collection !== 'string' || collection.length === 0) return [ANY_COLLECTION];
	const withClause = Reflect.get(input, 'with');
	const joined =
		withClause !== null && typeof withClause === 'object' && !Array.isArray(withClause)
			? Object.keys(withClause)
			: [];
	return [collection, ...joined];
};

export type QueryCache = Readonly<{
	readonly read: (key: string) => Promise<Schema.Json | undefined>;
	readonly write: (key: string, value: Schema.Json, collections: ReadonlyArray<string>) => void;
	/** Drops every answer that read one of these collections. Returns the keys dropped. */
	readonly invalidate: (collections: ReadonlyArray<string>) => ReadonlyArray<string>;
	readonly clear: () => void;
	/** Resolves once the persisted answers are back in memory. */
	readonly hydrated: Promise<void>;
}>;

const DATABASE_NAME = 'bolt-query-cache';
const STORE_NAME = 'answers';

/**
 * How long a persisted answer may be served before it is treated as absent.
 *
 * Invalidation covers writes this client's replica saw. It cannot cover a workspace that was reseeded,
 * imported into, or edited by a path that bypasses the outbox while this browser was closed — so an
 * age bound is the backstop for the changes no cursor knows about. It is generous because every read
 * revalidates anyway: the only thing the bound decides is how long a *first paint* may be stale.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const openDatabase = (): Promise<IDBDatabase | undefined> =>
	new Promise((resolve) => {
		if (typeof indexedDB === 'undefined') {
			resolve(undefined);
			return;
		}
		try {
			const request = indexedDB.open(DATABASE_NAME, 1);
			request.onupgradeneeded = () => {
				if (!request.result.objectStoreNames.contains(STORE_NAME)) {
					request.result.createObjectStore(STORE_NAME);
				}
			};
			request.onsuccess = () => resolve(request.result);
			// A browser with storage disabled, a private window, or a blocked upgrade all land here. The
			// cache degrades to memory-only rather than failing the page: a missing cache is a slow read,
			// never a broken one.
			request.onerror = () => resolve(undefined);
			request.onblocked = () => resolve(undefined);
		} catch {
			resolve(undefined);
		}
	});

/**
 * Builds the cache for one workspace scope.
 *
 * `namespace` keeps tenants and environments apart in shared browser storage; without it, signing
 * into a second tenant would paint the first tenant's rows before the revalidation landed.
 */
export const createQueryCache = (namespace: string): QueryCache => {
	const memory = new Map<string, CachedAnswer>();
	let database: IDBDatabase | undefined;
	const scoped = (key: string): string => `${namespace}::${key}`;

	const hydrated = openDatabase().then(
		(opened) =>
			new Promise<void>((resolve) => {
				database = opened;
				if (opened === undefined) {
					resolve();
					return;
				}
				try {
					const store = opened.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
					const request = store.getAll();
					request.onsuccess = () => {
						const now = Date.now();
						for (const entry of request.result as ReadonlyArray<CachedAnswer & { readonly key?: string }>) {
							const key = entry.key;
							if (typeof key !== 'string' || !key.startsWith(`${namespace}::`)) continue;
							if (now - entry.at > MAX_AGE_MS) continue;
							memory.set(key.slice(namespace.length + 2), {
								value: entry.value,
								collections: entry.collections,
								at: entry.at
							});
						}
						resolve();
					};
					request.onerror = () => resolve();
				} catch {
					resolve();
				}
			})
	);

	const persist = (key: string, answer: CachedAnswer): void => {
		if (database === undefined) return;
		try {
			const store = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
			store.put({ ...answer, key: scoped(key) }, scoped(key));
		} catch {
			// A quota failure, or a database closed underneath us by a version change in another tab.
			// Memory still holds the answer, so this costs persistence across a reload and nothing else.
		}
	};

	const forget = (keys: ReadonlyArray<string>): void => {
		if (database === undefined || keys.length === 0) return;
		try {
			const store = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
			for (const key of keys) store.delete(scoped(key));
		} catch {
			// Same as `persist`: the in-memory drop already happened, which is the half that decides
			// what this session serves.
		}
	};

	return {
		hydrated,
		read: async (key) => {
			// Awaited rather than read straight out of `memory`, because the queries a page issues on
			// mount race the hydration that would answer them. Awaiting costs a microtask on a warm
			// cache and is the difference between a cache that works on refresh and one that only ever
			// works on in-session navigation.
			await hydrated;
			const answer = memory.get(key);
			if (answer === undefined) return undefined;
			if (Date.now() - answer.at > MAX_AGE_MS) {
				memory.delete(key);
				forget([key]);
				return undefined;
			}
			return answer.value;
		},
		write: (key, value, collections) => {
			const answer: CachedAnswer = { value, collections, at: Date.now() };
			memory.set(key, answer);
			persist(key, answer);
		},
		invalidate: (collections) => {
			if (collections.length === 0) return [];
			const changed = new Set(collections);
			const dropped: Array<string> = [];
			for (const [key, answer] of memory) {
				const affected =
					changed.has(ANY_COLLECTION) ||
					answer.collections.some((name) => name === ANY_COLLECTION || changed.has(name));
				if (!affected) continue;
				memory.delete(key);
				dropped.push(key);
			}
			forget(dropped);
			return dropped;
		},
		clear: () => {
			const keys = [...memory.keys()];
			memory.clear();
			forget(keys);
		}
	};
};
