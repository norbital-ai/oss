import { Context, Deferred, Effect, Layer, Schema, SynchronizedRef } from 'effect';

export const HealthSnapshot = Schema.Struct({
	ready: Schema.Boolean,
	accepting: Schema.Boolean,
	inFlight: Schema.Int,
	finalized: Schema.Boolean
});

export interface HealthSnapshot extends Schema.Schema.Type<typeof HealthSnapshot> {}

/** Rejects new bundle work after the server begins draining. */
export class AdmissionStopped extends Schema.TaggedError<AdmissionStopped>()(
	'BoltServer.AdmissionStopped',
	{ operation: Schema.String }
) {}

/** Reports that in-flight work outlived the configured shutdown bound. */
export class DrainTimedOut extends Schema.TaggedError<DrainTimedOut>()('BoltServer.DrainTimedOut', {
	operation: Schema.String,
	inFlight: Schema.Int,
	timeoutMillis: Schema.Int
}) {}

interface State extends HealthSnapshot {
	readonly idle: Deferred.Deferred<void>;
}

/** The service shape: admission and drain are one machine, so one interface owns all four operations. */
interface Interface {
	readonly snapshot: () => Effect.Effect<HealthSnapshot>;
	readonly markReady: () => Effect.Effect<void>;
	readonly stopAdmission: () => Effect.Effect<void>;
	readonly admit: <A, E, R>(
		effect: Effect.Effect<A, E, R>
	) => Effect.Effect<A, E | AdmissionStopped, R>;
	readonly drain: (timeoutMillis: number) => Effect.Effect<HealthSnapshot, DrainTimedOut>;
	readonly markFinalized: () => Effect.Effect<void>;
}

/** Owns readiness, admission, in-flight accounting, drain, and finalization state. */
export class ServerHealth extends Context.Service<ServerHealth, Interface>()(
	'@norbital-ai/bolt-server/ServerHealth'
) {}

export const layer = Layer.effect(
	ServerHealth,
	Effect.gen(function* () {
		const initiallyIdle = yield* Deferred.make<void>();
		yield* Deferred.succeed(initiallyIdle, undefined);
		const state = yield* SynchronizedRef.make<State>({
			ready: false,
			accepting: true,
			inFlight: 0,
			finalized: false,
			idle: initiallyIdle
		});

		const snapshot = Effect.fn('BoltServer.ServerHealth.snapshot')(function* () {
			const { idle: _idle, ...publicState } = yield* SynchronizedRef.get(state);
			return publicState;
		});

		const markReady = Effect.fn('BoltServer.ServerHealth.markReady')(function* () {
			yield* SynchronizedRef.update(state, (current) => ({ ...current, ready: true }));
		});

		const stopAdmission = Effect.fn('BoltServer.ServerHealth.stopAdmission')(function* () {
			yield* SynchronizedRef.update(state, (current) => ({
				...current,
				ready: false,
				accepting: false
			}));
		});

		const acquireAdmission = Effect.fn('BoltServer.ServerHealth.acquireAdmission')(function* () {
			yield* SynchronizedRef.modifyEffect(state, (current) => {
				if (!current.accepting) {
					return Effect.fail(new AdmissionStopped({ operation: 'BoltServer.ServerHealth.admit' }));
				}

				return Effect.gen(function* () {
					const idle = current.inFlight === 0 ? yield* Deferred.make<void>() : current.idle;
					return [undefined, { ...current, inFlight: current.inFlight + 1, idle }] as const;
				});
			});
		});

		const releaseAdmission = Effect.fn('BoltServer.ServerHealth.releaseAdmission')(function* () {
			const completedIdle = yield* SynchronizedRef.modify(state, (current) => {
				const inFlight = Math.max(0, current.inFlight - 1);
				return [inFlight === 0 ? current.idle : undefined, { ...current, inFlight }] as const;
			});
			if (completedIdle !== undefined) yield* Deferred.succeed(completedIdle, undefined);
		});

		const admit: Interface['admit'] = Effect.fn('BoltServer.ServerHealth.admit')((effect) =>
			Effect.acquireUseRelease(acquireAdmission(), () => effect, releaseAdmission)
		);

		const drain = Effect.fn('BoltServer.ServerHealth.drain')(function* (timeoutMillis: number) {
			yield* stopAdmission();
			const current = yield* SynchronizedRef.get(state);
			if (current.inFlight > 0) {
				yield* Deferred.await(current.idle).pipe(
					Effect.timeout(timeoutMillis),
					Effect.mapError(
						() =>
							new DrainTimedOut({
								operation: 'BoltServer.ServerHealth.drain',
								inFlight: current.inFlight,
								timeoutMillis
							})
					)
				);
			}
			return yield* snapshot();
		});

		const markFinalized = Effect.fn('BoltServer.ServerHealth.markFinalized')(function* () {
			yield* SynchronizedRef.update(state, (current) => ({
				...current,
				ready: false,
				accepting: false,
				finalized: true
			}));
		});

		return ServerHealth.of({
			snapshot,
			markReady,
			stopAdmission,
			admit,
			drain,
			markFinalized
		});
	})
);
