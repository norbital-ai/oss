import { Schema } from 'effect';
import { createLocalStore, type LocalStore } from './replica/local-sql.js';
import {
	compareCursors,
	createSyncClient,
	decodeChanges,
	decodeCursor,
	type SyncClient
} from './replica/sync-client.js';
import {
	ANY_COLLECTION,
	cacheKeyFor,
	collectionsFor,
	createQueryCache,
	type QueryCache
} from './replica/query-cache.js';
import { createLiveQueryRegistry, type LiveQueryRegistry } from './replica/live-queries.js';
import type { SyncChange, SyncCursor } from '../runtime/sync/sync.js';
import {
	EnvironmentName,
	InvocationScope,
	ReleaseId,
	storedRecordsOf,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { createBoltClient, type BoltClient, type BoltTransport } from '../client.js';
import { createRemoteQuery } from './remote-query.svelte.js';
import { workspaceSession } from './session.js';
import { openLocalDatabase, type BootstrapTransport } from './replica/bootstrap.js';
import { createLocalReader, type LocalReader } from './replica/local-reads.js';
import { subscribeToChanges, type Subscription } from './replica/subscribe.js';
import type { PGliteLike, ProvisioningStep } from './replica/pglite-sql.js';
import { openPGlite } from './replica/pglite-loader.js';
import type { LocalSql } from './replica/replica.js';

export interface RemoteQuery<Value> extends PromiseLike<Value> {
	readonly current: Value | undefined;
	readonly error: unknown;
	readonly loading: boolean;
	readonly refresh: () => Promise<void>;
}

export interface CollectionPageQuery<Value> extends RemoteQuery<Value> {
	readonly nextCursor: string | null | undefined;
}

export type WorkspaceClientRuntime = Readonly<{
	readonly db: Readonly<Record<string, unknown>>;
	readonly bolt: BoltClient;
	/**
	 * The sync engine's read cache and the live queries it invalidates.
	 *
	 * Optional together: a runtime built without them — the test harness, a caller outside a browser —
	 * issues every read over the wire exactly as before, rather than taking a second code path through
	 * a cache that has nowhere to persist to.
	 */
	readonly cache?: QueryCache;
	readonly queries?: LiveQueryRegistry;
	/**
	 * Where the replica installs its reader once it is up.
	 *
	 * A mutable slot rather than a constructor argument because the ordering is fixed the other way:
	 * pages are rendering, and therefore reading, long before several megabytes of WebAssembly have
	 * finished loading. Reads before that go to the server, which is simply how it worked before.
	 */
	readonly local?: { current?: LocalReader };
}>;

export type BrowserWorkspaceRuntimeOptions = Readonly<{
	readonly transport?: BoltTransport;
	readonly tenantId?: string;
	readonly environment?: string;
	readonly releaseId?: string;
}>;

/**
 * `Array.isArray` does not narrow a `readonly` array out of a union, so the true branch stayed
 * `JsonArray | JsonObject`. Testing the array case first and returning early narrows what is left.
 */
/**
 * `Array.isArray` narrows `any[]`, not `readonly Json[]`, so no arrangement of these guards makes
 * TypeScript discard the array member of `Schema.Json`. The checks are exhaustive; the assertion
 * only states what they already established.
 */
const asJsonRecord = (input: Schema.Json): Readonly<Record<string, Schema.Json>> =>
	input !== null && typeof input === 'object' && !Array.isArray(input)
		? (input as Readonly<Record<string, Schema.Json>>)
		: {};

export type CollectionCatalogField = Readonly<{
	readonly name: string;
	readonly kind: string;
	readonly nullable: boolean;
	/** A column the database computes; a form must not offer it as editable. */
	readonly readOnly?: boolean;
	readonly search?: boolean;
	readonly values?: ReadonlyArray<string>;
}>;

export type CollectionCatalogRelation = Readonly<{
	readonly name: string;
	readonly target: string;
	readonly cardinality: 'one' | 'many';
}>;

export type CollectionCatalogEntry = Readonly<{
	readonly name: string;
	readonly recordLabel?: string;
	readonly fields: ReadonlyArray<CollectionCatalogField>;
	readonly relationships?: ReadonlyArray<CollectionCatalogRelation>;
}>;

export type CollectionCatalog = Readonly<Record<string, CollectionCatalogEntry>>;

type QueryFilter = Readonly<{
	readonly path: ReadonlyArray<string>;
	readonly operator: string;
	readonly operand?: Schema.Json;
}>;

type QueryOptions = Readonly<{
	readonly filters?: ReadonlyArray<QueryFilter>;
}>;

/** Nests a CollectionTable filter path into the JSON where compileWhere already understands. */
const filterToWhere = (filter: QueryFilter): Schema.Json => {
	const leaf = filter.path[filter.path.length - 1];
	if (leaf === undefined) return {};
	let node: Record<string, Schema.Json> = {
		[leaf]:
			filter.operand === undefined
				? { [filter.operator]: true }
				: { [filter.operator]: filter.operand }
	};
	for (let index = filter.path.length - 2; index >= 0; index -= 1) {
		const key = filter.path[index];
		if (key === undefined) continue;
		node = { [key]: node };
	}
	return node;
};

const mergeWhere = (
	query: Readonly<Record<string, Schema.Json>>,
	options?: QueryOptions
): Readonly<Record<string, Schema.Json>> => {
	const filters = options?.filters ?? [];
	if (filters.length === 0) return query;
	const clauses = filters.map(filterToWhere);
	const existing = query.where;
	const combined =
		existing === undefined
			? clauses.length === 1
				? clauses[0]
				: { AND: clauses }
			: { AND: [existing, ...clauses] };
	return combined === undefined ? query : { ...query, where: combined };
};

/**
 * Reads the rows out of a collection read, whichever shape it arrived in.
 *
 * Exported because callers that go straight to `transport.command` face the same page object as the
 * query layer does. Every one of them previously guarded with `Array.isArray` and fell back to an
 * empty list, so the page shape turned into "no records" rather than an error — the failure that
 * looks exactly like a collection legitimately having nothing in it.
 */
export const rowsFrom = (value: unknown): ReadonlyArray<Schema.Json> | undefined => {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return value;
	if (typeof value === 'object' && value !== null) {
		const rows = Reflect.get(value, 'rows');
		if (Array.isArray(rows)) return rows;
	}
	return undefined;
};

const countFrom = (value: Schema.Json | undefined): number | undefined => {
	if (typeof value === 'number') return value;
	if (typeof value === 'object' && value !== null) {
		const count = Reflect.get(value, 'count');
		if (typeof count === 'number') return count;
	}
	return undefined;
};

const cursorFrom = (value: Schema.Json | undefined): string | null => {
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const cursor = Reflect.get(value, 'nextCursor');
		return typeof cursor === 'string' && cursor.length > 0 ? cursor : null;
	}
	return null;
};

/** Owns stateful remote-query construction without introducing a module-global runtime singleton. */
const RemoteQueries = {
	make: (
		runtime: WorkspaceClientRuntime,
		command: string,
		input: Schema.Json
	): RemoteQuery<Schema.Json> => {
		const cache = runtime.cache;
		const registry = runtime.queries;
		// Every read goes through here — `db.*`, `invoke.*`, `records`, `history`, `approvals` — which
		// is why the cache is attached at this single point rather than per API surface. A surface added
		// later is cached by construction instead of by remembering to.
		const caching =
			cache === undefined || registry === undefined
				? undefined
				: {
						cache,
						registry,
						key: cacheKeyFor(command, input),
						collections: collectionsFor(command, input)
					};
		/**
		 * The replica answers first when it can, and declines by returning `undefined` — at which point
		 * this is exactly the request it always was. The cache still sits in front of both, so a local
		 * answer is cached on the same terms a remote one is and invalidated by the same collections.
		 */
		return createRemoteQuery(async () => {
			const reader = runtime.local?.current;
			const answered = reader === undefined ? undefined : await reader.answer(command, input);
			return answered ?? (await runtime.bolt.command(command, input, Schema.Json));
		}, caching);
	}
};

const PageQueries = {
	make: (
		runtime: WorkspaceClientRuntime,
		command: string,
		input: Schema.Json
	): CollectionPageQuery<ReadonlyArray<Schema.Json>> => {
		const query = RemoteQueries.make(runtime, command, input);
		const page: CollectionPageQuery<ReadonlyArray<Schema.Json>> = {
			get current() {
				return rowsFrom(query.current);
			},
			get nextCursor() {
				return cursorFrom(query.current);
			},
			get error() {
				return query.error;
			},
			get loading() {
				return query.loading;
			},
			refresh: query.refresh,
			// `PromiseLike.then` defaults `TResult1` to the resolved type, so returning the rows
			// unchanged when no handler is given is exactly that default — TypeScript just cannot
			// prove it for an arbitrary caller-supplied `TResult1`.
			then: <TResult1 = ReadonlyArray<Schema.Json>, TResult2 = never>(
				onfulfilled?:
					((value: ReadonlyArray<Schema.Json>) => TResult1 | PromiseLike<TResult1>) | null,
				onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
			) =>
				query.then((value) => {
					const rows = rowsFrom(value) ?? [];
					return onfulfilled === undefined || onfulfilled === null
						? (rows as unknown as TResult1)
						: onfulfilled(rows);
				}, onrejected)
		};
		return page;
	}
};

const CountQueries = {
	make: (runtime: WorkspaceClientRuntime, input: Schema.Json): RemoteQuery<number> => {
		const query = RemoteQueries.make(runtime, 'collections.count', input);
		return {
			get current() {
				return countFrom(query.current);
			},
			get error() {
				return query.error;
			},
			get loading() {
				return query.loading;
			},
			refresh: query.refresh,
			then: <TResult1 = number, TResult2 = never>(
				onfulfilled?: ((value: number) => TResult1 | PromiseLike<TResult1>) | null,
				onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
			) =>
				query.then((value) => {
					const count = countFrom(value);
					if (count === undefined) throw new Error('Collection count completed without a value');
					return onfulfilled === undefined || onfulfilled === null
						? (count as unknown as TResult1)
						: onfulfilled(count);
				}, onrejected)
		};
	}
};

type InvokeMethod = ReturnType<() => (input: Schema.Json) => RemoteQuery<Schema.Json>>;

/** Groups workspace API construction with the stateful remote-query factory it exposes. */
const WorkspaceApis = {
	create: (runtime: WorkspaceClientRuntime, catalog: CollectionCatalog = {}) => ({
		db: ClientDatabase.database(runtime),
		invoke: new Proxy<Record<string, InvokeMethod>>(
			{},
			{
				get: (_target, property) =>
					typeof property === 'string'
						? (input: Schema.Json) => RemoteQueries.make(runtime, `invoke.${property}`, { input })
						: undefined
			}
		),
		collections: new Proxy<Record<string, CollectionCatalogEntry>>(
			{},
			{
				get: (_target, property) => {
					if (typeof property !== 'string') return undefined;
					return catalog[property] ?? { name: property, fields: [], relationships: [] };
				}
			}
		),
		records: {
			findMany: (collection: string, input: Schema.Json = {}) =>
				PageQueries.make(runtime, 'collections.findMany', { collection, ...asJsonRecord(input) })
		},
		history: {
			findMany: (collection: string, recordId: string) =>
				RemoteQueries.make(runtime, 'collections.history', { collection, id: recordId })
		},
		approvals: {
			findMany: (approvalId: string) =>
				RemoteQueries.make(runtime, 'approvals.timeline', { requestId: approvalId }),
			process: async (input: {
				readonly approvalRequestId: string;
				readonly action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE';
				readonly comments?: string;
			}) => {
				const state = await runtime.bolt.command(
					'approvals.status',
					{ requestId: input.approvalRequestId },
					Schema.Json
				);
				const decision =
					input.action === 'APPROVED'
						? 'approve'
						: input.action === 'REJECTED'
							? 'reject'
							: undefined;
				if (decision === undefined || state === null || typeof state !== 'object') return;
				await runtime.bolt.command(
					'approvals.decide',
					{
						state,
						decision,
						...(input.comments === undefined ? {} : { reason: input.comments })
					},
					Schema.Json
				);
				invalidateApproval(runtime);
			},
			withdraw: async (approvalRequestId: string) => {
				const state = await runtime.bolt.command(
					'approvals.status',
					{ requestId: approvalRequestId },
					Schema.Json
				);
				if (state === null || typeof state !== 'object') return;
				await runtime.bolt.command('approvals.withdraw', { state }, Schema.Json);
				invalidateApproval(runtime);
			}
		}
	})
};

export const createWorkspaceApiProxy = WorkspaceApis.create;

/**
 * The transport the host declared, resolved per call.
 *
 * It used to be a second HTTP client written out here — its own `fetch`, its own endpoint literal,
 * and a credential sniffed from `document.documentElement.dataset`. That made two implementations of
 * "post a Bolt command" that could disagree about where commands go and who is making them, and the
 * one that read the document was wrong on every page that was not itself a served document.
 */
const browserTransport: BoltTransport = {
	command: (command, input, signal) => workspaceSession().transport.command(command, input, signal)
};

/**
 * Drops this collection's cached answers and re-runs the queries reading it.
 *
 * Called on the write path rather than left to the sync engine, because the replica drains on demand
 * and not on a timer: waiting for the outbox to report a write this client just made would leave the
 * table the user is looking at showing the row as it was before their own edit.
 */
const invalidateWrite = (runtime: WorkspaceClientRuntime, collection: string): void => {
	runtime.cache?.invalidate([collection]);
	runtime.queries?.refreshAffected([collection]);
};

/**
 * Drops every cached answer and re-runs every live query, after an approval decision.
 *
 * An approval decision is not a `db.*` write, so it never passed through `invalidateWrite`. The one
 * table that happened to own the open sheet refreshed its own rows by hand, and every other surface
 * showing the same record — a board, a second table, a nested sheet — stayed stale until something
 * else refetched. The decision commits against a record this call cannot name a collection for, so
 * `ANY_COLLECTION` is the honest scope: something changed, and nothing held is provably still true.
 * Approvals are rare and deliberate, which is what makes a full re-read the cheap half of the trade.
 */
const invalidateApproval = (runtime: WorkspaceClientRuntime): void => {
	runtime.cache?.invalidate([ANY_COLLECTION]);
	runtime.queries?.refreshAffected([ANY_COLLECTION]);
};

/** Owns collection proxy behavior at the client boundary so validation and typed semantics stay consistent for every caller. */
const ClientDatabase = {
	collection: (runtime: WorkspaceClientRuntime, collection: string) => ({
		findMany: (input: Schema.Json = {}, options?: QueryOptions) =>
			PageQueries.make(runtime, 'collections.findMany', {
				collection,
				...mergeWhere(asJsonRecord(input), options)
			}),
		findFirst: (input: Schema.Json = {}) =>
			RemoteQueries.make(runtime, 'collections.findFirst', { collection, ...asJsonRecord(input) }),
		count: (input: Schema.Json = {}, options?: QueryOptions) =>
			CountQueries.make(runtime, { collection, ...mergeWhere(asJsonRecord(input), options) }),
		/**
		 * Creates a record, and answers with the record — not with what was handed in.
		 *
		 * Two things used to happen here that could not both stay. The browser minted the primary key
		 * with `crypto.randomUUID()`, which made the client the authority on the identity of a row
		 * that did not exist yet and could still be refused; and the return value was the caller's own
		 * argument with that id stapled to it. The second is the one that did damage: a submitted
		 * value is not what the database holds once a column default, a generated column and a
		 * `create.before` hook have run — a payroll run is posted with four fields and stored with ten
		 * — so every caller that put this straight into a store, or rendered it, was holding a record
		 * that had never existed anywhere.
		 *
		 * `values` now goes up alone and the stored row comes back. `values` may also carry a graph:
		 * a key naming a declared `many` relation carries the records that belong to this one, and
		 * the server writes the parent and its children in one transaction, filling each child's
		 * foreign key from the id it assigns the parent.
		 *
		 * A response with no record throws rather than falling back to the submission. There is no
		 * honest fallback: "the write succeeded and I do not know what it stored" is not a record,
		 * and inventing one is exactly the failure this replaced.
		 */
		create: async (input: Schema.Json) => {
			const response = await runtime.bolt.command(
				'collections.create',
				{ collection, values: asJsonRecord(input) },
				Schema.Json
			);
			invalidateWrite(runtime, collection);
			const stored = storedRecordsOf(response)?.[0];
			if (stored === undefined)
				throw new Error(
					`Creating a ${collection} record answered without the stored row, so there is nothing to return. The command reported: ${JSON.stringify(response)}`
				);
			return stored;
		},
		/** Answers with the stored row for the same reason `create` does — an update runs hooks too. */
		update: async (recordId: string, input: Schema.Json) => {
			const response = await runtime.bolt.command(
				'collections.update',
				{ collection, id: recordId, values: asJsonRecord(input) },
				Schema.Json
			);
			invalidateWrite(runtime, collection);
			const stored = storedRecordsOf(response)?.[0];
			if (stored === undefined)
				throw new Error(
					`Updating ${collection} ${recordId} answered without the stored row, so there is nothing to return. The command reported: ${JSON.stringify(response)}`
				);
			return stored;
		},
		delete: async (recordId: string) => {
			await runtime.bolt.command('collections.delete', { collection, id: recordId }, Schema.Json);
			invalidateWrite(runtime, collection);
		}
	}),
	database: (runtime: WorkspaceClientRuntime): Readonly<Record<string, unknown>> =>
		new Proxy<Record<string, unknown>>(
			{},
			{
				get: (_target, property) =>
					typeof property === 'string' ? ClientDatabase.collection(runtime, property) : undefined
			}
		)
};

/**
 * Where the replica left off, kept next to the cache it explains.
 *
 * `localStorage` rather than the IndexedDB the answers live in, because this is read *before* the
 * first diff and a synchronous read is what lets the resume happen without a round trip's delay. It
 * is one small value per scope; losing it costs a replay from the origin, never correctness.
 */
const readStoredCursor = (key: string): SyncCursor | undefined => {
	if (typeof localStorage === 'undefined') return undefined;
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return undefined;
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object') return undefined;
		const xid = Reflect.get(parsed, 'xid');
		const sequence = Reflect.get(parsed, 'sequence');
		return typeof xid === 'number' && typeof sequence === 'number' ? { xid, sequence } : undefined;
	} catch {
		return undefined;
	}
};

const writeStoredCursor = (key: string, cursor: SyncCursor): void => {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(key, JSON.stringify(cursor));
	} catch {
		// A full or disabled store costs a replay from the origin next boot, which is the behaviour
		// this replaced. Nothing above needs to know.
	}
};

export type BrowserReplica = Readonly<{
	readonly store: LocalStore;
	readonly client: SyncClient;
	/** Pulls everything the server has for this subject and applies it locally. */
	readonly refresh: () => Promise<number>;
	readonly stop: () => void;
}>;

/**
 * Starts the reconstructible browser replica.
 *
 * The replica is a client projection of the sync outbox, never authority: it is rebuilt from the
 * server on demand and dropped whenever the server says the cursor fell off retained history.
 * Callers read from it for immediate answers and still issue writes through commands, which come
 * back through the same outbox.
 */
export const startBrowserReplica = async (
	runtime: WorkspaceClientRuntime,
	options: {
		readonly onAdvance?: (cursor: SyncCursor) => void;
		readonly onError?: (cause: unknown) => void;
	} = {}
): Promise<BrowserReplica> => {
	const store = createLocalStore();
	const cache = runtime.cache;
	const registry = runtime.queries;
	const cursorKey = `bolt-sync-cursor::${runtime.bolt.scope.tenantId}::${runtime.bolt.scope.environment}`;
	const storedCursor = readStoredCursor(cursorKey);

	/**
	 * Turns one applied batch into the invalidation it implies.
	 *
	 * A `reset` means the client fell off retained history, so nothing it holds is reconstructible and
	 * the whole cache goes — the same conclusion the local store reaches for its rows.
	 */
	const invalidateNamed = (collections: ReadonlyArray<string>): void => {
		if (cache === undefined || registry === undefined) return;
		cache.invalidate(collections);
		registry.refreshAffected(collections);
	};

	const collectionsIn = (changes: ReadonlyArray<SyncChange>): ReadonlyArray<string> =>
		changes.some((change) => change.operation === 'reset')
			? [ANY_COLLECTION]
			: [...new Set(changes.map((change) => change.collection))];

	const invalidateFor = (changes: ReadonlyArray<SyncChange>): void =>
		invalidateNamed(collectionsIn(changes));

	const client = createSyncClient({
		transport: {
			head: async () => decodeCursor(await runtime.bolt.command('sync.head', null, Schema.Json)),
			diff: async (cursor, limit) =>
				decodeChanges(await runtime.bolt.command('sync.diff', { cursor, limit }, Schema.Json))
		},
		sink: {
			apply: async (changes) => {
				await store.apply(changes);
				invalidateFor(changes);
			},
			reset: async () => {
				// The sync client calls this *instead of* `apply` for a reset batch, so the wildcard
				// invalidation has to happen here rather than falling out of the change list. Everything
				// cached predates a point the server no longer remembers, so none of it is trustworthy.
				await store.reset();
				cache?.clear();
				registry?.refreshAffected([ANY_COLLECTION]);
			}
		},
		// Resuming rather than replaying: the persisted cache already reflects everything up to this
		// cursor, so a boot only needs what happened since. Replaying from the origin on every load was
		// a full outbox read racing the page's own queries for the same connection.
		...(storedCursor === undefined ? {} : { initialCursor: storedCursor }),
		onAdvance: (cursor) => {
			writeStoredCursor(cursorKey, cursor);
			options.onAdvance?.(cursor);
		},
		...(options.onError === undefined ? {} : { onError: options.onError })
	});
	// A stored cursor can outlive the database it described — an environment reset, a reseed, a fork
	// restored to an earlier point all leave the outbox shorter than the cursor claims. Resuming from
	// it would ask for changes after a position that no longer exists and quietly receive nothing
	// forever, which presents as "sync stopped working" with no error anywhere. Comparing against the
	// server's head is one round trip and turns that into a rebuild.
	if (storedCursor !== undefined) {
		const head = await runtime.bolt
			.command('sync.head', null, Schema.Json)
			.then(decodeCursor)
			.catch(() => undefined);
		if (head !== undefined && compareCursors(storedCursor, head) > 0) {
			cache?.clear();
			await store.reset();
			client.reset();
		}
	}
	await client.drain();
	return { store, client, refresh: client.drain, stop: client.stop };
};

/**
 * Starts the replica as a real local PostgreSQL, provisioned from the tenant's own migrations.
 *
 * The engine is opened through a callback so this module never imports the wasm bundle: it is several
 * megabytes, and loading it before first paint would make every page slower to open in exchange for
 * making it faster to re-open. The caller imports it after the page is interactive, and a workspace
 * whose browser cannot run it keeps working over the wire — degraded to what it had before, never
 * broken.
 *
 * The order — provision, snapshot, then follow — is not arrangeable differently. Streaming before the
 * snapshot would apply updates to rows the replica does not hold; snapshotting before provisioning has
 * nowhere to put them.
 */
/** The Postgres channel the leader announces on, so every tab invalidates off one applied batch. */
const REPLICA_CHANNEL = 'bolt_replica_changed';

/**
 * The replicas already running in this document, keyed by the scope they hold.
 *
 * Starting one is expensive and not idempotent: it opens a PGlite engine, snapshots the workspace
 * and subscribes to the change stream. Two callers for the same scope therefore meant two engines
 * over one storage directory and two streams holding host connections — and two callers is the
 * ordinary case, because a component that remounts asks again for something it cannot see it already
 * has. Handing back the running one makes "start the replica" the idempotent request every caller
 * already assumed it was.
 *
 * Keyed by scope rather than by runtime, because the storage a replica opens is keyed by scope: two
 * runtimes for one workspace would otherwise collide in exactly the place this is protecting.
 */
const runningReplicas = new Map<string, Promise<LocalReplica>>();

export const startLocalReplica = async (
	runtime: WorkspaceClientRuntime,
	open?: (steps: ReadonlyArray<ProvisioningStep>) => Promise<PGliteLike>,
	options: {
		readonly onChange?: (applied: number) => void;
		readonly onError?: (cause: unknown) => void;
	} = {}
): Promise<LocalReplica> => {
	const key = `${runtime.bolt.scope.tenantId}::${runtime.bolt.scope.environment}`;
	const running = runningReplicas.get(key);
	if (running !== undefined) return running;
	// `stop` forgets the entry as well as closing the engine, so a caller that tears one down and
	// mounts again gets a new replica rather than the corpse of the last one.
	const started = startReplica(runtime, open, options).then((replica) => ({
		...replica,
		stop: () => {
			runningReplicas.delete(key);
			replica.stop();
		}
	}));
	runningReplicas.set(key, started);
	// A failed start must not be remembered as a running replica: the usual reason to fail is that
	// nobody had signed in yet, and the next caller is the one that just did.
	void started.catch(() => runningReplicas.delete(key));
	return started;
};

const startReplica = async (
	runtime: WorkspaceClientRuntime,
	open?: (steps: ReadonlyArray<ProvisioningStep>) => Promise<PGliteLike>,
	options: {
		readonly onChange?: (applied: number) => void;
		readonly onError?: (cause: unknown) => void;
	} = {}
): Promise<LocalReplica> => {
	const cache = runtime.cache;
	const registry = runtime.queries;
	// Scoped to the workspace, because browser storage is shared across every workspace this browser
	// has signed into and two built from the same template share a fingerprint.
	const scope = `${runtime.bolt.scope.tenantId}::${runtime.bolt.scope.environment}`;
	const openEngine = open ?? ((steps: ReadonlyArray<ProvisioningStep>) => openPGlite(steps, scope));
	const transport: BootstrapTransport = {
		command: (command, input) => runtime.bolt.command(command, input, Schema.Json)
	};
	const local = await openLocalDatabase(transport, openEngine);
	// The snapshot brought in rows no cursor accounts for, so everything cached predates it.
	cache?.clear();
	registry?.refreshAffected([ANY_COLLECTION]);

	const invalidateNamed = (collections: ReadonlyArray<string>): void => {
		if (cache === undefined || registry === undefined) return;
		cache.invalidate(collections);
		registry.refreshAffected(collections);
	};

	const collectionsIn = (changes: ReadonlyArray<SyncChange>): ReadonlyArray<string> =>
		changes.some((change) => change.operation === 'reset')
			? [ANY_COLLECTION]
			: [...new Set(changes.map((change) => change.collection))];

	const invalidateFor = (changes: ReadonlyArray<SyncChange>): void =>
		invalidateNamed(collectionsIn(changes));

	/**
	 * Tells the other tabs what this one just applied.
	 *
	 * Only the leader streams, so without this a second tab would hold a database moving quietly
	 * underneath it while its own cache and rendered queries stayed on the old rows — stale in exactly
	 * the way the replica exists to prevent, and invisible because nothing errored.
	 *
	 * `pg_notify` rather than a `BroadcastChannel`: the notification travels with the database, so it
	 * cannot outrun the rows it describes, and a tab with no shared engine simply has no listener and
	 * loses nothing.
	 */
	const announceToTabs = async (collections: ReadonlyArray<string>): Promise<void> => {
		if (local.engine.listen === undefined || collections.length === 0) return;
		await local.engine
			.query('select pg_notify($1, $2)', [REPLICA_CHANNEL, JSON.stringify(collections)])
			.catch(() => undefined);
	};

	const client = createSyncClient({
		transport: {
			head: async () => decodeCursor(await runtime.bolt.command('sync.head', null, Schema.Json)),
			diff: async (cursor, limit) =>
				decodeChanges(await runtime.bolt.command('sync.diff', { cursor, limit }, Schema.Json))
		},
		sink: {
			apply: async (changes) => {
				for (const change of changes) await local.sql.applyChange(change as unknown as Schema.Json);
				const collections = collectionsIn(changes);
				invalidateNamed(collections);
				await announceToTabs(collections);
			},
			reset: async () => {
				await local.sql.reset();
				cache?.clear();
				registry?.refreshAffected([ANY_COLLECTION]);
				await announceToTabs([ANY_COLLECTION]);
			}
		},
		initialCursor: local.cursor,
		// Recorded in the replica's own database, in the same place as the rows it explains, so a reload
		// resumes exactly where this session stopped rather than re-reading the whole workspace.
		onAdvance: (cursor) => void local.record(cursor).catch(() => undefined),
		...(options.onError === undefined ? {} : { onError: options.onError })
	});
	/**
	 * One drain in flight at a time, and one more queued behind it.
	 *
	 * A burst of writes produces a burst of frames, and starting a drain per frame would have several
	 * reading the same cursor and applying the same batch. `drain()` already collapses concurrent
	 * callers, so this only has to make sure a frame that arrives mid-drain is not lost: the trailing
	 * pass picks up whatever the in-flight one did not see.
	 */
	let draining: Promise<void> | undefined;
	let pending = false;
	const catchUp = (): void => {
		if (draining !== undefined) {
			pending = true;
			return;
		}
		draining = client
			.drain()
			.then((applied) => {
				if (applied > 0) options.onChange?.(applied);
			})
			.catch((cause: unknown) => options.onError?.(cause))
			.finally(() => {
				draining = undefined;
				if (!pending) return;
				pending = false;
				catchUp();
			});
	};

	/**
	 * Exactly one tab streams.
	 *
	 * The database is shared, so a per-tab sync loop would have every open tab fetching the same
	 * diffs and applying them to the same rows — N times the requests and N times the writes to reach
	 * one outcome, with the cursor being advanced by whichever tab got there first. Leadership is
	 * already decided for us: the tab holding the database is the one that should feed it.
	 *
	 * A tab that is not the leader opens no stream at all, which is the point — one SSE connection
	 * per browser instead of one per tab. Browsers cap concurrent connections per host, so tabs used
	 * to compete for that budget with the very requests the pages were waiting on.
	 */
	// An absent `isLeader` means an unshared engine — the test harness, or a browser without workers —
	// which is the same thing as being the only tab.
	const leads = (): boolean => local.engine.isLeader !== false;

	let subscription: Subscription | undefined;
	const streamIfLeading = (): void => {
		if (!leads() || subscription !== undefined) return;
		// The host tells us when to look; nothing here asks on a timer. A frame names the collections
		// that changed, but the cursor decides what is actually fetched, so the names are not read
		// here — acting on them would be a second, weaker version of the ordering `sync.diff` gives.
		subscription = subscribeToChanges({
			onChange: () => catchUp(),
			// A reconnect can span a gap in which anything might have happened, so every open catches
			// up rather than waiting for the next write to arrive.
			onOpen: () => catchUp(),
			...(options.onError === undefined ? {} : { onError: options.onError })
		});
	};
	streamIfLeading();

	/**
	 * Leadership moves when the leading tab closes, and the sync loop has to move with it.
	 *
	 * Without this, closing the one tab that happened to be elected would leave every remaining tab
	 * holding a live database that nothing was feeding: no stream, no drain, and no error — the
	 * workspace would simply stop updating until someone reloaded. The inherited stream catches up on
	 * open, so the gap between the old leader dying and the new one connecting is closed by the
	 * cursor rather than lost.
	 */
	/**
	 * From here on, reads this replica can answer identically are answered from it.
	 *
	 * Installed after the snapshot rather than before: until the rows are in, a local answer would be
	 * a confident empty result, which is worse than a slow correct one.
	 */
	if (runtime.local !== undefined) {
		runtime.local.current = createLocalReader(local.engine, local.shape, local.readable);
	}

	const stopWatchingLeader = local.engine.onLeaderChange?.(() => {
		if (leads()) {
			streamIfLeading();
			catchUp();
			return;
		}
		// Demotion is possible in principle; drop the stream rather than stream in duplicate.
		subscription?.stop();
		subscription = undefined;
	});

	/**
	 * Every tab listens, including the leader's followers who never fetch anything themselves.
	 *
	 * This is what makes a second tab correct rather than merely cheap: it holds no stream and runs
	 * no drain, so the only way it learns that its rendered queries are stale is the leader saying so
	 * through the database they share.
	 */
	const stopListening = await local.engine
		.listen?.(REPLICA_CHANNEL, (payload) => {
			// The leader already invalidated its own; this is for everybody else.
			if (leads()) return;
			try {
				const named: unknown = JSON.parse(payload);
				invalidateNamed(
					Array.isArray(named)
						? named.filter((entry): entry is string => typeof entry === 'string')
						: [ANY_COLLECTION]
				);
			} catch {
				// An unreadable announcement still means something changed, and refreshing everything is
				// the safe reading of it.
				invalidateNamed([ANY_COLLECTION]);
			}
		})
		.catch(() => undefined);

	return {
		sql: local.sql,
		fingerprint: local.fingerprint,
		rows: local.rows,
		poke: catchUp,
		leader: leads,
		stop: () => {
			// Withdrawn first: a closed database that is still being asked would fail every read that
			// had been succeeding, rather than quietly going back to the wire.
			if (runtime.local !== undefined) runtime.local.current = undefined;
			stopWatchingLeader?.();
			void stopListening?.();
			subscription?.stop();
			client.stop();
			void local.close();
		}
	};
};

export type LocalReplica = Readonly<{
	readonly sql: LocalSql;
	readonly fingerprint: string;
	/** Rows loaded by the initial snapshot, for a host that wants to report the bootstrap. */
	readonly rows: number;
	readonly poke: () => void;
	/** Whether this tab holds the shared database and therefore runs the sync loop. */
	readonly leader: () => boolean;
	readonly stop: () => void;
}>;

/**
 * Creates the browser runtime for the session the host declared.
 *
 * The scope was read from `data-bolt-*` attributes with `local`/`development` defaults behind it.
 * Those defaults are what let a page that carried no routing decision still render — as somebody
 * else's workspace, against a query cache namespaced to a tenant it was not showing. The session is
 * required instead, and stating a scope explicitly is still allowed for a caller that has one.
 */
export const createBrowserWorkspaceRuntime = (
	options: BrowserWorkspaceRuntimeOptions = {}
): WorkspaceClientRuntime => {
	const session = workspaceSession();
	const scope = InvocationScope.make({
		tenantId: TenantId.make(options.tenantId ?? session.tenantId),
		environment: EnvironmentName.make(options.environment ?? session.environment),
		releaseId: ReleaseId.make(options.releaseId ?? session.releaseId)
	});
	const bolt = createBoltClient(scope, options.transport ?? browserTransport);
	// Namespaced by tenant and environment: browser storage is shared across every workspace this
	// browser has signed into, and an unscoped cache would paint one tenant's rows into another's page
	// for as long as the revalidation took.
	const runtime: {
		bolt: BoltClient;
		db: Readonly<Record<string, unknown>>;
		local: { current?: LocalReader };
		cache: QueryCache;
		queries: LiveQueryRegistry;
	} = {
		bolt,
		db: {},
		local: {},
		cache: createQueryCache(`${scope.tenantId}::${scope.environment}`),
		queries: createLiveQueryRegistry()
	};
	runtime.db = ClientDatabase.database(runtime);
	return runtime;
};
