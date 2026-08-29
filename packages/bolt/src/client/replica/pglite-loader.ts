// repository-health:allow SEM_PARALLEL -- pglite-loader adapts the engine to the replica store's
// PGliteLike port over the #lib alias, so the pair is linked, not parallel.
import type { PGliteLike, ProvisioningStep } from '#lib/client/replica/pglite-sql.js';
import {
	type ReplicaPartitionIdentity,
	type ReplicationLeadership
} from '#lib/client/replica/leader.js';
import { selectReplicaStorage, type ReplicaStorageDecision } from '#lib/client/replica/budget.js';
import { Effect } from 'effect';
import type { PGliteInterface } from '@electric-sql/pglite';
import { replicaLocation } from '#lib/client/replica/physical-storage.js';

export { replicaLocation } from '#lib/client/replica/physical-storage.js';

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
 * same diffs — and three writers to a single persisted database, which risks corrupting it rather
 * than merely wasting the work. PGlite's election chooses the worker that executes SQL; Bolt's
 * explicit partition Web Lock separately chooses the one document allowed to bootstrap, replicate
 * and migrate. Followers proxy SQL to the shared worker and never perform network sync.
 */

type SharedPGlite = PGliteInterface & {
	readonly isLeader?: boolean;
	onLeaderChange?: (callback: () => void) => () => void;
};

/** The one adapter from PGlite's Promise API into the replica's Effect-native database port. */
export const adaptPGlite = (database: SharedPGlite, afterClose?: () => void): PGliteLike => ({
	query: <T>(sql: string, parameters?: ReadonlyArray<unknown>) =>
		Effect.tryPromise(() =>
			database.query<T>(sql, parameters === undefined ? undefined : [...parameters])
		).pipe(Effect.map((result) => ({ rows: result.rows }))),
	exec: (sql) => Effect.tryPromise(() => database.exec(sql)),
	close: () =>
		Effect.tryPromise(async () => {
			try {
				await database.close();
			} finally {
				afterClose?.();
			}
		}),
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
 * Makes Bolt's explicit replication lock, rather than PGlite's engine-owner election, visible to the
 * bootstrap and sync layers. Queries still proxy through PGlite's actual worker owner; this adapter
 * decides only which document is allowed to perform replication network work and schema migration.
 */
export const withReplicationLeadership = (
	database: PGliteLike,
	leadership: ReplicationLeadership
): PGliteLike => ({
	query: <T>(sql: string, parameters?: ReadonlyArray<unknown>) =>
		database.query<T>(sql, parameters),
	exec: (sql) => database.exec(sql),
	close: () => database.close(),
	get isLeader() {
		return leadership.leader();
	},
	listen: (channel, callback) => database.listen(channel, callback),
	onLeaderChange: (callback) => leadership.onChange(() => callback())
});

export class ReplicaServerOnly extends Error {
	readonly tier = 'server-only' as const;
	readonly reason: string;

	constructor(reason: string) {
		super(`Local replica unavailable: ${reason}`);
		this.reason = reason;
		this.name = 'ReplicaServerOnly';
	}
}

export type OpenPGliteOptions = Readonly<{
	readonly storage?: ReplicaStorageDecision;
	readonly leadership?: ReplicationLeadership;
}>;

export const openPGlite = Effect.fn('Replica.openPGlite')(function* (
	_steps: ReadonlyArray<ProvisioningStep>,
	scope: string | ReplicaPartitionIdentity = 'local',
	options: OpenPGliteOptions = {}
): Effect.fn.Return<PGliteLike, unknown> {
	const storage = options.storage ?? (yield* Effect.tryPromise(() => selectReplicaStorage()));
	if (storage.tier === 'server-only')
		return yield* Effect.fail(new ReplicaServerOnly(storage.reason));
	const dataDir = replicaLocation(scope, storage.tier);
	/**
	 * `new URL(..., import.meta.url)` rather than a bare specifier, because this has to survive being
	 * a dependency: the bundler rewrites this form into an emitted worker chunk, while a plain string
	 * path would be resolved against the *host* application's root, where this file does not live.
	 */
	const engine = yield* Effect.sync(
		() => new Worker(new URL('./pglite-worker.js', import.meta.url), { type: 'module' })
	);
	// The worker client is the large browser dependency this module exists to defer. A value import at
	// module scope pulled it into the generated client's initial graph even though replica startup was
	// called later; importing it here makes startup, not module evaluation, the first point that can
	// fetch or evaluate PGlite.
	const { PGliteWorker } = yield* Effect.tryPromise(() => import('@electric-sql/pglite/worker'));
	// PGlite's internal worker-owner election shares the same physical partition key. It is intentionally
	// separate from Bolt's replication lock, but neither may ever cross a partition boundary.
	const database = yield* Effect.tryPromise(async () => {
		try {
			return await PGliteWorker.create(engine, { dataDir, id: dataDir });
		} catch (cause) {
			engine.terminate();
			throw cause;
		}
	});
	const adapted = adaptPGlite(database, () => engine.terminate());
	return options.leadership === undefined
		? adapted
		: withReplicationLeadership(adapted, options.leadership);
});
