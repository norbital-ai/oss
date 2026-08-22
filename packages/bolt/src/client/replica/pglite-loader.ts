import type { PGliteLike, ProvisioningStep } from '#lib/client/replica/pglite-sql.js';
import { Effect } from 'effect';
import type { PGliteInterface } from '@electric-sql/pglite';

/**
 * Loading the local database engine, on Bolt's side of the boundary.
 *
 * The generated tenant client used to import `@electric-sql/pglite` itself, which made the engine a
 * dependency every workspace had to resolve: the client is generated *into* the tenant, and the host
 * that serves it resolves imports from its own root, so the specifier failed there even though the
 * package was installed. Which engine backs the replica is Bolt's decision anyway — a workspace
 * author never chose it and should not have to carry it.
 *
 * Dynamic so the several megabytes of WebAssembly load after the page is interactive rather than in
 * front of first paint, and in a module of its own so the static import graph never reaches it.
 *
 * ## One engine per browser, not per tab
 *
 * The database lives in a worker that every tab shares, rather than in the page. Three tabs on one
 * workspace used to mean three engines, three copies of the rows, and three sync loops fetching the
 * same diffs — and three writers to a single persisted IndexedDB database, which risks corrupting it
 * rather than merely wasting the work. PGlite elects a leader across tabs through the Web Locks API;
 * only the leader holds the database and the rest proxy to it, so they all read the same rows.
 */

import { PGliteWorker } from '@electric-sql/pglite/worker';

type SharedPGlite = PGliteInterface & {
	readonly isLeader?: boolean;
	onLeaderChange?: (callback: () => void) => () => void;
};

/** The one adapter from PGlite's Promise API into the replica's Effect-native database port. */
export const adaptPGlite = (database: SharedPGlite): PGliteLike => ({
	query: <T>(sql: string, parameters?: ReadonlyArray<unknown>) =>
		Effect.tryPromise(() =>
			database.query<T>(sql, parameters === undefined ? undefined : [...parameters])
		).pipe(Effect.map((result) => ({ rows: result.rows }))),
	exec: (sql) => Effect.tryPromise(() => database.exec(sql)),
	close: () => Effect.tryPromise(() => database.close()),
	get isLeader() {
		return database.isLeader ?? true;
	},
	listen: (channel, callback) =>
		Effect.tryPromise(() => database.listen(channel, callback)).pipe(
			Effect.map((stop) => () => Effect.tryPromise(() => stop()).pipe(Effect.asVoid))
		),
	onLeaderChange: (callback) => database.onLeaderChange?.(callback) ?? (() => undefined)
});

/**
 * Where the replica persists, scoped to the workspace it mirrors.
 *
 * Unscoped, one browser signed into two workspaces pointed both at `idb://bolt-replica`. The rebuild
 * check would usually paper over it — a different schema means a different fingerprint means a
 * rebuild — but two workspaces built from the *same template* have the same fingerprint, and there
 * the second one would silently inherit the first one's rows and believe them.
 */
export const replicaLocation = (scope: string): string =>
	`idb://bolt-replica::${scope.replaceAll(/[^a-zA-Z0-9:_-]/g, '_')}`;

export const openPGlite = Effect.fn('Replica.openPGlite')(function* (
	_steps: ReadonlyArray<ProvisioningStep>,
	scope: string = 'local'
): Effect.fn.Return<PGliteLike, unknown> {
	const dataDir = replicaLocation(scope);
	/**
	 * `new URL(..., import.meta.url)` rather than a bare specifier, because this has to survive being
	 * a dependency: the bundler rewrites this form into an emitted worker chunk, while a plain string
	 * path would be resolved against the *host* application's root, where this file does not live.
	 */
	const engine = yield* Effect.sync(
		() => new Worker(new URL('./pglite-worker.js', import.meta.url), { type: 'module' })
	);
	// `id` is the leader-election key. Scoping it to the workspace keeps two open workspaces from
	// electing one leader between them and proxying one's queries into the other's database.
	const database = yield* Effect.tryPromise(() =>
		PGliteWorker.create(engine, { dataDir, id: dataDir })
	);
	return adaptPGlite(database);
});
