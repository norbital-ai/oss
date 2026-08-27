import { Effect, Result, Schema } from 'effect';
import {
	createPGliteStore,
	markProvisioned,
	provision,
	readReplicaState,
	withTransaction,
	writeDurableReplicaSchema,
	type LocalReplicaStore,
	type PGliteLike,
	ProvisioningStep,
	type ProvisioningStep as ProvisioningStepType
} from '#lib/client/replica/pglite-sql.js';
import { ReplicaShape } from '#lib/client/replica/local-reads.js';
import type { SyncCursor } from '#lib/runtime/sync/sync.js';
import { PROTOCOL_VERSION } from '@norbital-ai/bolt-protocol';

export const ORIGIN_CURSOR: SyncCursor = { xid: 0, sequence: 0 };

/** The authenticated command seam used while opening the reconstructible database. */
export type BootstrapTransport = Readonly<{
	readonly command: (
		command: string,
		input: Schema.Json,
		signal?: AbortSignal
	) => Effect.Effect<Schema.Json, unknown>;
}>;

const ProvisioningResponse = Schema.Struct({
	steps: Schema.Array(ProvisioningStep),
	fingerprint: Schema.String,
	collections: ReplicaShape.fields.collections,
	relations: ReplicaShape.fields.relations
});

const readProvisioning = Effect.fn('ReplicaBootstrap.readProvisioning')(function* (
	transport: BootstrapTransport
): Effect.fn.Return<
	{
		readonly steps: ReadonlyArray<ProvisioningStepType>;
		readonly fingerprint: string;
		readonly shape: ReplicaShape;
	},
	unknown
> {
	const raw = yield* transport.command('sync.provisioning', null);
	const answer = yield* Schema.decodeUnknownEffect(ProvisioningResponse)(raw);
	return {
		steps: answer.steps,
		fingerprint: answer.fingerprint,
		shape: { collections: answer.collections, relations: answer.relations }
	};
});

const readShape = (transport: BootstrapTransport): Effect.Effect<ReadonlyArray<string>, unknown> =>
	transport.command('sync.shape', {}).pipe(
		Effect.map(
			(answer) =>
				Result.getOrElse(
					Schema.decodeUnknownResult(Schema.Array(Schema.String))(answer),
					() => null
				) ?? []
		)
	);

const FOLLOWER_PROVISION_TIMEOUT_MILLIS = 30_000;
const FOLLOWER_PROVISION_POLL_MILLIS = 50;

/** A promoted follower becomes the only document allowed to provision this partition. */
const awaitProvisioned = Effect.fn('ReplicaBootstrap.awaitProvisioned')(function* (
	database: PGliteLike,
	steps: ReadonlyArray<ProvisioningStepType>,
	fingerprint: string
): Effect.fn.Return<boolean, unknown> {
	const deadline = Date.now() + FOLLOWER_PROVISION_TIMEOUT_MILLIS;
	for (;;) {
		const state = yield* readReplicaState(database);
		if (state?.fingerprint === fingerprint) return false;
		if (database.isLeader !== false) return yield* provision(database, steps, fingerprint);
		if (Date.now() >= deadline) {
			return yield* Effect.fail(
				new Error('Local replica timed out waiting for the replication leader to provision it')
			);
		}
		yield* Effect.sleep(FOLLOWER_PROVISION_POLL_MILLIS);
	}
});

export type LocalDatabase = Readonly<{
	readonly store: LocalReplicaStore;
	readonly cursor: SyncCursor;
	readonly fingerprint: string;
	/** Query-first bootstrap never copies the tenant database. */
	readonly rows: 0;
	readonly resumed: boolean;
	readonly close: () => Effect.Effect<void, unknown>;
	readonly engine: PGliteLike;
	readonly shape: ReplicaShape;
	readonly readable: ReadonlySet<string>;
}>;

/** The current namespace could not satisfy the base/window storage contract. */
export class ReplicaStoredStateCorruption extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) this.cause = cause;
    this.name = 'ReplicaStoredStateCorruption';
  }
}

/**
 * Opens only one schema/authority namespace and its base/window/position ledger.
 *
 * No collection is eagerly hydrated here. Ordinary reads hydrate one bounded authoritative window.
 * Every physical namespace has exactly one base/window/position schema path.
 */
export const openLocalDatabase = Effect.fn('ReplicaBootstrap.openLocalDatabase')(function* (
	transport: BootstrapTransport,
	open: (steps: ReadonlyArray<ProvisioningStepType>) => Effect.Effect<PGliteLike, unknown>
): Effect.fn.Return<LocalDatabase, unknown> {
	const provisioning = yield* readProvisioning(transport);
	const database = yield* open(provisioning.steps);
	// The server already enforced integrity. A replica may receive relationally dependent rows in any
	// order, so it applies with PostgreSQL's logical-replication semantics.
	yield* database.exec('set session_replication_role = replica');
	const existing = yield* readReplicaState(database);
	let provisioned: boolean;
	if (database.isLeader === false) {
		provisioned = yield* awaitProvisioned(database, provisioning.steps, provisioning.fingerprint);
	} else if (existing?.fingerprint === provisioning.fingerprint) {
		provisioned = yield* provision(database, provisioning.steps, provisioning.fingerprint);
	} else {
		provisioned = yield* provision(database, provisioning.steps, provisioning.fingerprint);
	}
	const fieldsByCollection = Object.fromEntries(
		provisioning.shape.collections.map((collection) => [collection.name, collection.fields])
	);
	const readableFieldsByCollection = Object.fromEntries(
		provisioning.shape.collections.map((collection) => [
			collection.name,
			collection.readableFields
		])
	);
	const store = yield* createPGliteStore(
		database,
		fieldsByCollection,
		readableFieldsByCollection
	);
	const readable = new Set(yield* readShape(transport));
	if (provisioned) {
		yield* withTransaction(database, store.clearNamespace());
		yield* markProvisioned(database, provisioning.fingerprint, ORIGIN_CURSOR);
		yield* writeDurableReplicaSchema(database, {
			authorityGeneration: 0,
			fingerprint: provisioning.fingerprint,
			protocolVersion: PROTOCOL_VERSION
		});
		return {
			store,
			cursor: ORIGIN_CURSOR,
			fingerprint: provisioning.fingerprint,
			rows: 0,
			resumed: false,
			close: database.close,
			engine: database,
			shape: provisioning.shape,
			readable
		};
	}

	const state = yield* readReplicaState(database);
	return {
		store,
		cursor: state?.cursor ?? ORIGIN_CURSOR,
		fingerprint: provisioning.fingerprint,
		rows: 0,
		resumed: true,
		close: database.close,
		engine: database,
		shape: provisioning.shape,
		readable
	};
});
