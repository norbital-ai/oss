import { Effect } from 'effect';
/** Wait for finalizers inside the grace; interrupt unfinished work after the grace expires. */
export const within = <A, E, R>(ms: number, work: Effect.Effect<A, E, R>) =>
	work.pipe(Effect.timeoutOption(ms));
