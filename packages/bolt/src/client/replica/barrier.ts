import type { ReplicaSchemaBarrier } from '@norbital-ai/bolt-protocol';
export type { ReplicaSchemaBarrier } from '@norbital-ai/bolt-protocol';

/** Durable schema facts read from the replica, never inferred from a broadcast. */
export type DurableReplicaSchema = Readonly<{
	readonly generation: number;
	readonly fingerprint: string;
	readonly protocolVersion: number;
}>;

export type SchemaBarrierPhase =
	| 'idle'
	| 'withdrawing-readers'
	| 'switching-namespace'
	| 'failed';

export type SchemaBarrierState = Readonly<{
	readonly phase: SchemaBarrierPhase;
	readonly generation: number;
	readonly fingerprint?: string;
	readonly affectedCollections: ReadonlyArray<string>;
	readonly failure?: unknown;
}>;

export type SchemaBarrierHooks = Readonly<{
	/** True only for the explicit Web Locks replication owner. */
	readonly leader: () => boolean;
	/** Re-read after every wake/promotion; this durable answer outranks in-memory phase or broadcasts. */
	readonly readDurable: () => Promise<DurableReplicaSchema>;
	/**
	 * Persists a committed generation when this physical namespace already has the barrier's exact
	 * schema fingerprint. A freshly provisioned namespace starts at generation zero; without this
	 * adoption step every reconnect sees the same committed barrier and reloads forever.
	 */
	readonly adoptGeneration?: (barrier: ReplicaSchemaBarrier) => Promise<DurableReplicaSchema>;
	/** Synchronously removes affected local readers before the old namespace is retired. */
	readonly withdrawReaders: (collections: ReadonlyArray<string>) => void;
	/**
	 * Stops the old physical replica and asks the shell to bootstrap the namespace selected by the
	 * server's next partition key. This must not provision, clear, or rebuild the current namespace.
	 */
	readonly switchNamespace: (barrier: ReplicaSchemaBarrier) => Promise<void>;
}>;

export type SchemaBarrierController = Readonly<{
	readonly state: () => SchemaBarrierState;
	readonly onChange: (callback: (state: SchemaBarrierState) => void) => () => void;
	/** Serialized: no later barrier can overtake an earlier namespace switch. */
	readonly accept: (barrier: ReplicaSchemaBarrier) => Promise<void>;
	/** Followers use wake-ups only to call this and mirror whatever the leader committed durably. */
	readonly refreshFromDurable: () => Promise<DurableReplicaSchema>;
}>;

const validBarrier = (barrier: ReplicaSchemaBarrier): void => {
	if (!Number.isSafeInteger(barrier.generation) || barrier.generation < 1)
		throw new Error('Schema barrier generation must be a positive safe integer');
	if (!Number.isSafeInteger(barrier.minimumProtocolVersion) || barrier.minimumProtocolVersion < 1)
		throw new Error('Schema barrier protocol version must be a positive safe integer');
	if (barrier.fingerprint.length === 0 || barrier.migrationDigest.length === 0)
		throw new Error('Schema barrier fingerprint and migration digest are required');
};

/**
 * Coordinates the committed-barrier handoff without knowing PGlite or the sync wire.
 *
 * Schema and authority changes select a new physical replica namespace. The old namespace is only
 * withdrawn here; it is never migrated, cleared, provisioned, or placed back on the read path.
 */
export const createSchemaBarrierController = (
	hooks: SchemaBarrierHooks
): SchemaBarrierController => {
	let current: SchemaBarrierState = {
		phase: 'idle',
		generation: 0,
		affectedCollections: []
	};
	let tail = Promise.resolve();
	const callbacks = new Set<(state: SchemaBarrierState) => void>();
	const publish = (state: SchemaBarrierState): void => {
		current = state;
		for (const callback of callbacks) {
			try {
				callback(state);
			} catch {
				// Observers never participate in the namespace handoff or its failure policy.
			}
		}
	};
	const idleAt = (durable: DurableReplicaSchema): void =>
		publish({
			phase: 'idle',
			generation: durable.generation,
			fingerprint: durable.fingerprint,
			affectedCollections: []
		});

	const run = async (barrier: ReplicaSchemaBarrier): Promise<void> => {
		validBarrier(barrier);
		const durable = await hooks.readDurable();
		// A follower never performs namespace work. The lock successor will re-enter through the same
		// durable check; a broadcast may wake this call but does not grant it handoff authority.
		if (!hooks.leader()) {
			idleAt(durable);
			return;
		}
		if (
			durable.generation > barrier.generation ||
			(durable.generation === barrier.generation && durable.fingerprint === barrier.fingerprint)
		) {
			idleAt(durable);
			return;
		}
		if (durable.fingerprint === barrier.fingerprint && hooks.adoptGeneration !== undefined) {
			const adopted = await hooks.adoptGeneration(barrier);
			idleAt(adopted);
			return;
		}

		const affectedCollections = [...new Set(barrier.affectedCollections)];
		publish({
			phase: 'withdrawing-readers',
			generation: barrier.generation,
			fingerprint: barrier.fingerprint,
			affectedCollections
		});
		try {
			hooks.withdrawReaders(affectedCollections);
		} catch (failure) {
			publish({
				phase: 'failed',
				generation: barrier.generation,
				fingerprint: barrier.fingerprint,
				affectedCollections,
				failure
			});
			throw failure;
		}
		try {
			publish({
				phase: 'switching-namespace',
				generation: barrier.generation,
				fingerprint: barrier.fingerprint,
				affectedCollections
			});
			await hooks.switchNamespace(barrier);
		} catch (failure) {
			publish({
				phase: 'failed',
				generation: barrier.generation,
				fingerprint: barrier.fingerprint,
				affectedCollections,
				failure
			});
			throw failure;
		}
	};

	return {
		state: () => current,
		onChange: (callback) => {
			callbacks.add(callback);
			return () => callbacks.delete(callback);
		},
		accept: (barrier) => {
			const accepted = tail.then(() => run(barrier));
			// A rejected barrier may be reported by its caller, but cannot poison the serialization tail and
			// prevent a later namespace switch from being considered.
			tail = accepted.catch(() => undefined);
			return accepted;
		},
		refreshFromDurable: async () => {
			const refreshed = tail.then(async () => {
				const durable = await hooks.readDurable();
				const catchesBlockedBarrier =
					durable.generation > current.generation ||
					(durable.generation === current.generation &&
						durable.fingerprint === current.fingerprint);
				// A wake carrying no content cannot clear a failed/switching barrier merely because
				// some durable state exists. It unblocks only after another owner has actually committed
				// the blocked generation (or a newer one).
				if (current.phase === 'idle' || catchesBlockedBarrier) idleAt(durable);
				return durable;
			});
			// A broadcast wake cannot report `idle` while a serialized switch still has readers
			// withdrawn. Keep refreshes in the same queue, and keep a failed read from poisoning it.
			tail = refreshed.then(
				() => undefined,
				() => undefined
			);
			return refreshed;
		}
	};
};
