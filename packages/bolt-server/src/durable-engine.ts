import { Context, Effect, Layer, Ref, Schema } from 'effect';

export const DurableEngineSnapshot = Schema.Struct({
	durable: Schema.Boolean,
	recovered: Schema.Boolean,
	recoveredWorkItems: Schema.Int,
	stopped: Schema.Boolean
});

export interface DurableEngineSnapshot extends Schema.Schema.Type<typeof DurableEngineSnapshot> {}

/** Reports durable recovery attempts that cannot safely proceed; stupidity:allow Q4 -- Effect TaggedError declaration is the canonical rc.109 error boundary. */
export class DurableEngineError extends Schema.TaggedError<DurableEngineError>()(
	'BoltServer.DurableEngineError',
	{
		operation: Schema.String,
		cause: Schema.Defect()
	}
) {}

// stupidity:allow AL10 -- durable adapter SPI stays beside its sole service owner in the required 14-file architecture
export interface Adapter {
	readonly durable: boolean;
	readonly recover: Effect.Effect<number, DurableEngineError>;
	readonly close: Effect.Effect<void, never>;
}

// stupidity:allow AL10 -- service shape stays beside its Context.Service owner in the required 14-file architecture
export interface Interface {
	readonly recover: () => Effect.Effect<number, DurableEngineError>;
	readonly snapshot: () => Effect.Effect<DurableEngineSnapshot>;
	readonly stop: () => Effect.Effect<void>;
}

/** Coordinates exactly-once recovery and close for the configured durable adapter; stupidity:allow Q4 -- Effect Context.Service declaration is the canonical rc.109 service tag. */
export class DurableEngine extends Context.Service<DurableEngine, Interface>()(
	'@norbital-ai/bolt-server/DurableEngine'
) {}

/**
 * Owns durable-engine recovery/finalization. Protocol Task methods are intentionally adapted in
 * facilities/tasks.ts, so this service never creates a second task DTO surface.
 */
export const makeLayer = (adapter: Adapter) =>
	Layer.effect(
		DurableEngine,
		Effect.gen(function* () {
			const state = yield* Ref.make<DurableEngineSnapshot>({
				durable: adapter.durable,
				recovered: false,
				recoveredWorkItems: 0,
				stopped: false
			});
			const recoverOnce = yield* Effect.cached(adapter.recover);

			const recover = Effect.fn('BoltServer.DurableEngine.recover')(function* () {
				const current = yield* Ref.get(state);
				if (current.stopped) {
					return yield* new DurableEngineError({
						operation: 'BoltServer.DurableEngine.recover',
						cause: new Error('durable engine is stopped')
					});
				}
				if (current.recovered) return current.recoveredWorkItems;

				const recoveredWorkItems = yield* recoverOnce;
				yield* Ref.set(state, {
					...current,
					recovered: true,
					recoveredWorkItems
				});
				return recoveredWorkItems;
			});

			const snapshot = Effect.fn('BoltServer.DurableEngine.snapshot')(() => Ref.get(state));

			const stop = Effect.fn('BoltServer.DurableEngine.stop')(function* () {
				const wasStopped = yield* Ref.modify(state, (current) => [
					current.stopped,
					{ ...current, stopped: true }
				]);
				if (!wasStopped) yield* adapter.close;
			});

			return DurableEngine.of({ recover, snapshot, stop });
		})
	);

/** Explicitly non-durable and only valid for local development. */
export const developmentLayer = makeLayer({
	durable: false,
	recover: Effect.succeed(0),
	close: Effect.void
});

/** Names both durable-engine Layer constructors without hiding durability semantics. */
export const DurableEngineLayers = { make: makeLayer, development: developmentLayer };
