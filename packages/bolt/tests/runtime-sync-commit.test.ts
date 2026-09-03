import { assert, describe, it } from '@effect/vitest';
import {
	EffectId,
	InvocationId,
	SyncCommitResponse,
	failure,
	makeWireError,
	success,
	type FacilityBinding,
	type SyncCommitRequest
} from '@norbital-ai/bolt-protocol';
import { Deferred, Effect, Fiber } from 'effect';
import { FacilityError, type CallContext } from '../src/runtime/facilities/database.js';
import { SyncCommit } from '../src/runtime/facilities/services.js';

const context: CallContext = {
	invocationId: InvocationId.make('sync-commit:test'),
	deadlineEpochMs: 4_000_000_000_000,
	environment: 'test',
	tenantId: 'tenant-test'
};

const request: SyncCommitRequest = {
	changes: [{ collection: 'jobs', id: 'job-1', operation: 'insert', after: {} }]
};

describe('Bolt SyncCommit service', () => {
	it.effect('awaits the bound host acknowledgement', () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const binding: FacilityBinding<SyncCommitRequest, SyncCommitResponse> = {
				call: (_metadata, _request, signal) =>
					Effect.runPromise(
						Deferred.succeed(entered, undefined).pipe(
							Effect.andThen(Deferred.await(release)),
							Effect.as(success(SyncCommitResponse.make({})))
						),
						{ signal }
					)
			};
			const running = yield* Effect.gen(function* () {
				const syncCommit = yield* SyncCommit.Service;
				yield* syncCommit.publish(EffectId.make('sync-commit:test:publish'), request);
			}).pipe(Effect.provide(SyncCommit.layer(binding, context)), Effect.forkChild);

			yield* Deferred.await(entered);
			yield* Effect.yieldNow;
				assert.strictEqual(running.pollUnsafe(), undefined);

			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(running);
		})
	);

	it.effect('propagates a typed facility failure instead of acknowledging it', () =>
		Effect.gen(function* () {
			const binding: FacilityBinding<SyncCommitRequest, SyncCommitResponse> = {
				call: () =>
					Promise.resolve(
						failure(
							makeWireError('sync_settlement_failed', 'sync.advance rejected the commit', {
								retryable: true,
									outcome: 'unknown'
								})
							)
						)
				};
			const error = yield* Effect.gen(function* () {
				const syncCommit = yield* SyncCommit.Service;
				return yield* syncCommit
					.publish(EffectId.make('sync-commit:test:failure'), request)
					.pipe(Effect.flip);
			}).pipe(Effect.provide(SyncCommit.layer(binding, context)));

			assert.instanceOf(error, FacilityError);
			assert.strictEqual(error.code, 'sync_settlement_failed');
			assert.strictEqual(error.message, 'sync.advance rejected the commit');
			assert.strictEqual(error.retryable, true);
			assert.strictEqual(error.outcome, 'unknown');
		})
	);
});
