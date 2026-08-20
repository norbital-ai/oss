import {
	FacilityCall,
	TaskRequest,
	TaskResponse,
	failure,
	makeWireError,
	success,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { Effect, Schema } from 'effect';
import type { Scheduler } from '../scheduler.js';

/**
 * The task facility, which is now a timer and not a queue.
 *
 * It used to select a configured durable-engine provider and hand it four queue operations —
 * `Enqueue`, `Schedule`, `Cancel`, `Signal` — and the only shipped adapter recorded them and ran
 * none. That was not a gap in the adapter: enqueueing belongs in the tenant's own database, in the
 * same transaction as the state change that asked for it, and a queue on this side of the seam
 * cannot be in that transaction. So the wire lost those four tags and this lost its provider.
 *
 * What is left is the two things a host genuinely owes a bolt: remember where to route work
 * addressed to this release, and come back when it says to.
 */

/** Adapts the two remaining task messages onto the server's own routing table and timer. */
export const makeTaskBinding = (
	scheduler: Scheduler,
	/**
	 * Records a routing registration.
	 *
	 * Single-tenant, single-release: a bolt-server holds one bundle and every registration names it,
	 * so there is nothing to look up later and this exists to be observable rather than consulted.
	 */
	register: (command: string) => void = () => {}
): FacilityBinding<TaskRequest, TaskResponse> => ({
	call: (unsafeMetadata, unsafeInput, signal) =>
		Effect.runPromise(
			Effect.gen(function* () {
				yield* Schema.decodeUnknownEffect(FacilityCall)(unsafeMetadata);
				const input = yield* Schema.decodeUnknownEffect(TaskRequest)(unsafeInput);
				if (signal.aborted)
					return failure(makeWireError('tasks.cancelled', 'Task call was cancelled'));
				if (input._tag === 'Register') {
					register(input.command);
					return success(TaskResponse.make({}));
				}
				// Announced synchronously, and answered before the guest commits. That ordering is the
				// guest's to keep and this side's to not get in the way of: a wake that arrives before a
				// commit costs at most a tick that finds nothing, while one that arrives after costs a
				// committed job nobody comes back for.
				scheduler.announce(input.notLaterThanEpochMs);
				return success(TaskResponse.make({}));
			}).pipe(
				Effect.catch(() =>
					Effect.succeed(
						failure(
							makeWireError('tasks.failed', 'Task facility call failed', {
								retryable: !signal.aborted,
								outcome: signal.aborted ? 'unknown' : 'known'
							})
						)
					)
				)
			)
		)
});

/** Exposes task binding construction. There is nothing left to configure — the host owns the timer. */
export const TaskFacilities = { make: makeTaskBinding };
