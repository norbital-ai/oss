import { assert, describe, expect, it } from '@effect/vitest';
import {
	EffectId,
	EnvironmentName,
	InvocationId,
	InvocationScope,
	ReleaseId,
	SyncCommitRequest,
	SyncCommitResponse,
	TenantId,
	success
} from '@norbital-ai/bolt-protocol';
import { Deferred, Effect, Fiber } from 'effect';
import { makeSyncCommitFacility } from '../src/server.js';

const metadata = {
	invocationId: InvocationId.make('sync-commit:test'),
	effectId: EffectId.make('sync-commit:test:effect'),
	deadlineEpochMs: 4_000_000_000_000,
	idempotencyKey: 'sync-commit:test:effect'
};

const scope = InvocationScope.make({
	tenantId: TenantId.make('sync-commit-test'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('sync-commit-test')
});

const request = SyncCommitRequest.make({
	changes: [
		{
			collection: 'jobs',
			id: 'job-1',
			operation: 'update',
			before: { id: 'job-1', status: 'queued' },
			after: { id: 'job-1', status: 'running' }
		}
	]
});

describe('bolt-server sync commit facility', () => {
	it.effect('awaits host advancement and delivery before acknowledging the guest', () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const facility = makeSyncCommitFacility(
				{
					committed: (commit) => {
						assert.deepStrictEqual(commit.scope, scope);
						return Effect.runPromise(
							Deferred.succeed(entered, undefined).pipe(
								Effect.andThen(Deferred.await(release))
							)
						);
					}
				},
				scope
			);
			const running = yield* Effect.tryPromise({
				try: (signal) => facility.call(metadata, request, signal),
				catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
			}).pipe(Effect.forkChild);

			yield* Deferred.await(entered);
			yield* Effect.yieldNow;
			assert.strictEqual(running.pollUnsafe(), undefined);

			yield* Deferred.succeed(release, undefined);
			assert.deepStrictEqual(
				yield* Fiber.join(running),
				success(SyncCommitResponse.make({}))
			);
		})
	);

	it('does not acknowledge a rejected host settlement', async () => {
		const rejected = new Error('sync.advance rejected the commit');
		const facility = makeSyncCommitFacility(
			{ committed: () => Promise.reject(rejected) },
			scope
		);
		await expect(
			facility.call(metadata, request, new AbortController().signal)
		).rejects.toBe(rejected);
	});
});
