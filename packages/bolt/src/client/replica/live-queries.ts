import { Effect } from 'effect';

/**
 * The mounted queries a sync advance has to re-ask.
 *
 * Invalidating the cache is enough for the *next* mount, but a page already on screen would keep
 * showing the answer the write just falsified until the user navigated away and back. This is the
 * part that closes that gap: every live query registers itself, and a change to a collection it read
 * re-runs it.
 *
 * Registration is by `WeakRef` because a query's life is a component's life and there is no reliable
 * hook to say when that ended — `createRemoteQuery` is called during render, not inside an effect
 * with teardown. A strong registry would therefore pin every query a long session ever mounted, and
 * with it every row it had loaded. Holding weakly makes the leak impossible instead of unlikely, and
 * the dead entries are swept on the next pass rather than by a finalizer.
 */

type LiveQueryRegistration = Readonly<{
	/** The collections whose changes falsify this query's current answer. */
	readonly collections: ReadonlyArray<string>;
	/** Private sync-owned re-execution. This is deliberately absent from the public query object. */
	readonly reexecute: () => Effect.Effect<void, unknown>;
}>;

export type LiveQueryRegistry = Readonly<{
	readonly register: (query: LiveQueryRegistration) => void;
	/** Re-runs every live query that read one of these collections. Returns how many were re-run. */
	readonly reexecuteAffected: (collections: ReadonlyArray<string>) => number;
	/** Live registrations, dead references already swept. Exposed for tests. */
	readonly size: () => number;
}>;

const ANY_COLLECTION = '*';

export const createLiveQueryRegistry = (): LiveQueryRegistry => {
	const registered = new Set<WeakRef<LiveQueryRegistration>>();

	/** Drops collected entries and hands back what is still alive, in one pass. */
	const sweep = (): ReadonlyArray<LiveQueryRegistration> => {
		const alive: Array<LiveQueryRegistration> = [];
		for (const reference of registered) {
			const query = reference.deref();
			if (query === undefined) {
				registered.delete(reference);
				continue;
			}
			alive.push(query);
		}
		return alive;
	};

	return {
		register: (query) => {
			registered.add(new WeakRef(query));
		},
		reexecuteAffected: (collections) => {
			if (collections.length === 0) return 0;
			const changed = new Set(collections);
			let reexecuted = 0;
			const executions: Array<Effect.Effect<void>> = [];
			for (const query of sweep()) {
				const affected =
					changed.has(ANY_COLLECTION) ||
					query.collections.some((name) => name === ANY_COLLECTION || changed.has(name));
				if (!affected) continue;
				reexecuted += 1;
				// Failures land on the query's own `error` cell, which is where a reader already looks.
				// Rethrowing here would take down the sync advance that triggered re-execution, so one
				// collection the subject cannot read would stop every other query updating.
				executions.push(query.reexecute().pipe(Effect.catch(() => Effect.void)));
			}
			Effect.runFork(Effect.all(executions, { concurrency: 'unbounded', discard: true }));
			return reexecuted;
		},
		size: () => sweep().length
	};
};
