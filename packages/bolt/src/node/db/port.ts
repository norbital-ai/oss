// A same-graph TenantDb crosses HOST_API as complete SQL batches with owned cancellation.
import { Effect, Exit, Scope } from 'effect';
import type { TenantDbShape } from '../../engine/db/tenant-db.ts';
import type { DbError } from '../../engine/errors.ts';
import type { HostDbSession, HostTenantDb } from '../../protocol/host-api.ts';

export const tenantDbPort = (db: TenantDbShape): HostTenantDb => ({
	read: (statements, signal) => Effect.runPromise(db.read(statements), { signal }),
	write: (statement, lock, signal) => Effect.runPromise(db.write(statement, lock), { signal }),
	transaction: (batch, signal) => Effect.runPromise(db.transaction(batch), { signal }),
	session: (signal) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const scope = yield* Scope.make();
				const session = yield* db.session().pipe(
					Effect.provideService(Scope.Scope, scope),
					Effect.onError(() => Scope.close(scope, Exit.void))
				);
				const settle = (effect: Effect.Effect<void, DbError>, abort?: AbortSignal) =>
					Effect.runPromise(effect.pipe(Effect.ensuring(Scope.close(scope, Exit.void))), {
						signal: abort
					});
				return {
					db: {
						read: (statements, abort) =>
							Effect.runPromise(session.db.read(statements), { signal: abort }),
						write: (statement, lock, abort) =>
							Effect.runPromise(session.db.write(statement, lock), { signal: abort }),
						transaction: (batch, abort) =>
							Effect.runPromise(session.db.transaction(batch), { signal: abort })
					},
					commit: (abort) => settle(session.commit, abort),
					rollback: (abort) => settle(session.rollback, abort)
				} satisfies HostDbSession;
			}),
			{ signal }
		)
});
