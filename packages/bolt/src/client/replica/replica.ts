import { Context, Effect, Layer, Ref, Schema } from 'effect';
import type { SyncChange, SyncCursor } from '../../runtime/sync/sync.js';

export type LocalSql = Readonly<{
	readonly query: (sql: string, parameters: ReadonlyArray<Schema.Json>) => Promise<ReadonlyArray<Schema.Json>>;
	readonly applyChange: (change: Schema.Json) => Promise<void>;
	readonly reset: () => Promise<void>;
}>;

export type OptimisticMutation = Readonly<{ readonly id: string; readonly change: SyncChange; readonly status: 'pending' | 'confirmed' | 'rejected' }>;

/** Owns settle optimistic behavior at the replica boundary so validation and typed semantics stay consistent for every caller. */
const ReplicaValues = {
	settleOptimistic: (mutation: OptimisticMutation, accepted: boolean): OptimisticMutation => ({ ...mutation, status: accepted ? 'confirmed' : 'rejected' })
};
export const settleOptimistic = ReplicaValues.settleOptimistic;

export type ReplicaStatus = Readonly<{ readonly cursor: SyncCursor; readonly state: 'idle' | 'syncing' | 'error' }>;
/** Carries replica error through the typed replica failure channel without losing diagnostic context. */
export class ReplicaError extends Schema.TaggedError<ReplicaError>()(
	'Bolt.Replica.Error',
	{
		operation: Schema.Literals(['apply-diff', 'query', 'reset']),
		message: Schema.NonEmptyString,
		cause: Schema.optionalKey(
			Schema.Defect()
		)
	}
) {}
export type Interface = Readonly<{
	readonly status: () => Effect.Effect<ReplicaStatus>;
	readonly applyDiff: (changes: ReadonlyArray<SyncChange>) => Effect.Effect<void, ReplicaError>;
	readonly query: (sql: string, parameters: ReadonlyArray<Schema.Json>) => Effect.Effect<ReadonlyArray<Schema.Json>, ReplicaError>;
	readonly reset: () => Effect.Effect<void, ReplicaError>;
}>;
/** Identifies the replica service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/Replica');
/** Owns layer behavior at the replica boundary so validation and typed semantics stay consistent for every caller. */
export const layer = (sql: LocalSql) => Layer.effect(Service, Effect.gen(function* () {
	const status = yield* Ref.make<ReplicaStatus>({ cursor: { xid: 0, sequence: 0 }, state: 'idle' });
	return Service.of({
		status: Effect.fn('Replica.status')(() => Ref.get(status)),
		applyDiff: Effect.fn('Replica.applyDiff')(function* (changes) {
			for (const change of changes) {
			yield* Effect.tryPromise({
				try: () => sql.applyChange(change),
				catch: (cause) => new ReplicaError({ operation: 'apply-diff', message: 'Failed to apply a replica diff', cause })
			});
				const nextStatus: ReplicaStatus = { cursor: change.cursor, state: 'idle' };
				yield* Ref.set(status, nextStatus);
			}
		}),
		query: Effect.fn('Replica.query')((query, parameters) => Effect.tryPromise({
			try: () => sql.query(query, parameters),
			catch: (cause) => new ReplicaError({ operation: 'query', message: 'Failed to query the local replica', cause })
		})),
		reset: Effect.fn('Replica.reset')(function* () {
			yield* Effect.tryPromise({
				try: () => sql.reset(),
				catch: (cause) => new ReplicaError({ operation: 'reset', message: 'Failed to reset the local replica', cause })
			});
			const resetStatus: ReplicaStatus = { cursor: { xid: 0, sequence: 0 }, state: 'idle' };
			yield* Ref.set(status, resetStatus);
		})
	});
}));
export * as Replica from './replica.js';
