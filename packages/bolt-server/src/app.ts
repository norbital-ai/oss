import {
	Activation,
	ActivationResult,
	BundleResult,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	type FacilityBindings
} from '@norbital-ai/bolt-protocol';
import { Clock, Effect, Layer, ManagedRuntime, Result, Schema } from 'effect';
import { BundleLoader, makeLayer as makeBundleLoaderLayer } from './bundle-loader.js';
import type { ServerConfiguration } from './config.js';
import { ServerHealth, layer as serverHealthLayer } from './health.js';
import { makeScheduler, makeTaskBinding } from './scheduler.js';
import { startServer, type RunningServer, UuidGeneration, uuidGenerationLayer } from './server.js';

/** Reports a lifecycle phase that prevented the self-host application from becoming usable. */
export class ApplicationStartError extends Schema.TaggedError<ApplicationStartError>()(
	'BoltServer.ApplicationStartError',
	{
		operation: Schema.String,
		message: Schema.NonEmptyString,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

/** The embedder's options: a lifecycle promise (`finalizeFacilities`) stays a host-side edge. */
export interface ApplicationOptions {
	readonly configuration: ServerConfiguration;
	readonly facilities: FacilityBindings;
	// repository-health:allow EFF2 -- Embedders own facilities outside this runtime and expose their established Promise finalizer here.
	readonly finalizeFacilities?: () => Promise<void>;
}

export interface RunningApplication extends RunningServer {
	readonly stop: RunningServer['close'];
}

/** Installs one-shot Node process shutdown hooks and returns a hook disposer. */
export const installProcessShutdown = (application: RunningApplication): (() => void) => {
	/** Removes both one-shot process hooks without stopping an already running application. */
	const dispose = () => {
		process.off('SIGINT', shutdown);
		process.off('SIGTERM', shutdown);
	};
	/** Converts either supported process signal into the same idempotent application stop. */
	const shutdown = () => {
		dispose();
		Effect.runFork(
			Effect.tryPromise(() => application.stop()).pipe(
				Effect.catch(() => Effect.sync(() => (process.exitCode = 1)))
			)
		);
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
	return dispose;
};

/** Validates configuration, activates one immutable bundle, and owns all server finalizers. */
export const startApplication = (options: ApplicationOptions) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const { configuration, facilities } = options;
			const finalizeFacilities =
				options.finalizeFacilities === undefined
					? Effect.void
					: Effect.tryPromise(options.finalizeFacilities);
			if (
				facilities.scope.tenantId !== configuration.scope.tenantId ||
				facilities.scope.environment !== configuration.scope.environment ||
				facilities.scope.releaseId !== configuration.scope.releaseId
			) {
				// The bindings the embedder may have opened are finalized before the mismatch is
				// reported; a failure in finalization must not hide the validation error that
				// caused the halt.
				yield* finalizeFacilities.pipe(Effect.catch(() => Effect.void));
				return yield* new ApplicationStartError({
					operation: 'BoltServer.Application.validateScope',
					message: 'Facility bindings do not match the configured invocation scope'
				});
			}

			/**
			 * One tick, dispatched and decoded as a plain Effect.
			 *
			 * `Task`, not `Command`: a `Task` carries no credential by construction, which is what the
			 * runtime's provenance gate requires of enqueued work — and a host minting a tenant session to
			 * talk to its own tenant would be a standing key to tenant data. The answer carries the next
			 * instant anything is due, which is the only thing this side needs to know.
			 */
			const tickOnce = () =>
				Effect.gen(function* () {
					const loader = yield* BundleLoader;
					const bundle = yield* loader.load();
					const now = yield* Clock.currentTimeMillis;
					const unsafeResult = yield* Effect.tryPromise({
						try: (signal) =>
							bundle.dispatch(
								Invocation.cases.Task.make({
									protocolVersion: PROTOCOL_VERSION,
									id: InvocationId.make(`tasks.tick:${now}`),
									scope: configuration.scope,
									deadlineEpochMs: now + configuration.invocationTimeoutMillis,
									command: 'tasks.tick',
									input: {},
									attempt: 1
								}),
								bound,
								signal
							),
						catch: (cause) =>
							new ApplicationStartError({
								operation: 'BoltServer.Application.tick',
								message: 'Bolt bundle dispatch failed',
								cause
							})
					}).pipe(Effect.timeout(configuration.invocationTimeoutMillis));
					const result = yield* Schema.decodeUnknownEffect(BundleResult)(unsafeResult);
					if (result._tag !== 'Success') {
						return yield* new ApplicationStartError({
							operation: 'BoltServer.Application.tick',
							message: 'Bolt bundle refused a scheduler tick'
						});
					}
					const value = result.response.value;
					if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
					const due = Reflect.get(value, 'nextDueAtEpochMs');
					return typeof due === 'number' && Number.isFinite(due) ? due : null;
				}).pipe(
					Effect.mapError((cause) =>
						cause instanceof ApplicationStartError
							? cause
							: new ApplicationStartError({
									operation: 'BoltServer.Application.tick',
									message: 'Bolt scheduler tick failed',
									cause
								})
					)
				);

			/**
			 * The host's timer, and the task facility that feeds it.
			 *
			 * The binding is built here rather than accepted from the embedder because there is nothing left
			 * to configure: `TaskRequest` carries `Register` and `Wake`, and both are answered by this
			 * process's own routing table and its own `setTimeout`. Whatever `tasks` binding the caller
			 * supplied is replaced, deliberately — a host that let one be injected would be letting somebody
			 * else own its clock.
			 */
			let runTick: Effect.Effect<number | null, unknown> = Effect.fail(
				new ApplicationStartError({
					operation: 'BoltServer.Application.tick',
					message: 'Bolt scheduler runtime is not ready'
				})
			);
			const scheduler = makeScheduler({
				tick: () => runTick,
				onFailure: (cause) => {
					// The scheduler backs off; this boundary keeps an unwatched failure visible.
					void Effect.runPromise(
						Effect.logError(
							`scheduler.tick: ${cause instanceof Error ? cause.message : String(cause)}`
						)
					);
				}
			});
			const bound: FacilityBindings = { ...facilities, tasks: makeTaskBinding(scheduler) };

			const applicationLayer = Layer.mergeAll(
				uuidGenerationLayer,
				serverHealthLayer,
				makeBundleLoaderLayer({ bundlePath: configuration.bundlePath, facilities: bound })
			);
			const runtime = ManagedRuntime.make(applicationLayer);
			runTick = Effect.tryPromise(() => runtime.runPromise(tickOnce()));

			const startup = Effect.gen(function* () {
				const activated = Effect.gen(function* () {
					const loader = yield* BundleLoader;
					const bundle = yield* loader.load();
					const now = yield* Clock.currentTimeMillis;
					const uuid = yield* UuidGeneration;
					const activation = Activation.make({
						protocolVersion: PROTOCOL_VERSION,
						id: uuid.next(),
						scope: configuration.scope,
						deadlineEpochMs: now + configuration.invocationTimeoutMillis,
						reason: 'restart'
					});
					const unsafeResult = yield* Effect.tryPromise({
						try: (signal) => bundle.activate(activation, facilities, signal),
						catch: (cause) =>
							new ApplicationStartError({
								operation: 'BoltServer.Application.activate',
								message: 'Bolt bundle activation failed',
								cause
							})
					}).pipe(Effect.timeout(configuration.invocationTimeoutMillis));
					const result = yield* Schema.decodeUnknownEffect(ActivationResult)(unsafeResult).pipe(
						Effect.mapError(
							(cause) =>
								new ApplicationStartError({
									operation: 'BoltServer.Application.decodeActivation',
									message: 'Bolt bundle returned an invalid activation result',
									cause
								})
						)
					);
					if (result._tag === 'Failure') {
						return yield* new ApplicationStartError({
							operation: 'BoltServer.Application.activate',
							message: result.error.message
						});
					}
					// Activation already knows the next due instant, so no discovery tick is needed.
					scheduler.settle(result.nextDueAtEpochMs);
				});
				const server = yield* Effect.gen(function* () {
					yield* activated;
					return yield* Effect.tryPromise(() => startServer(configuration, facilities, runtime));
				});
				yield* Effect.gen(function* () {
					const health = yield* ServerHealth;
					yield* health.markReady();
				});
				return server;
			});
			const started = yield* Effect.result(
				Effect.tryPromise({
					try: () => runtime.runPromise(startup),
					catch: (cause) => cause
				})
			);
			if (Result.isFailure(started)) {
				const cause = started.failure;
				// Same order as the imperative path: the host's finalizer runs before the runtime is
				// disposed, and the original failure is rethrown afterwards.
				yield* finalizeFacilities.pipe(Effect.catch(() => Effect.void));
				yield* runtime.disposeEffect;
				if (cause instanceof ApplicationStartError) return yield* cause;
				return yield* new ApplicationStartError({
					operation: 'BoltServer.Application.start',
					message: 'Bolt server application failed to start',
					cause
				});
			}
			const server: RunningServer = started.success;

			/**
			 * Runs the ordered transport, drain, scheduler, bundle, and facility finalizers once.
			 *
			 * A transport failure is the one failure reported to the caller of `stop`; every other
			 * step's failures are observed but do not hide that one.
			 */
			const stopEffect = Effect.gen(function* () {
				const transportFailure = yield* Effect.result(Effect.tryPromise(() => server.close()));
				yield* Effect.tryPromise(() =>
					runtime.runPromise(ServerHealth.use((health) => health.stopAdmission()))
				);
				yield* Effect.tryPromise(() =>
					runtime.runPromise(
						Effect.gen(function* () {
							const health = yield* ServerHealth;
							const loader = yield* BundleLoader;
							return yield* health
								.drain(configuration.drainTimeoutMillis)
								.pipe(
									Effect.ensuring(Effect.sync(() => scheduler.stop())),
									Effect.ensuring(loader.dispose()),
									Effect.ensuring(health.markFinalized())
								);
						})
					)
				);
				if (Result.isFailure(transportFailure)) {
					return yield* Effect.fail(transportFailure.failure);
				}
			}).pipe(
				Effect.ensuring(
					Effect.gen(function* () {
						yield* finalizeFacilities.pipe(Effect.catch(() => Effect.void));
						yield* runtime.disposeEffect;
					})
				)
			);
			let stopped = false;
			/** Stops the application once, converging concurrent callers on the same run. */
			const stop = () =>
				Effect.runPromise(
					Effect.gen(function* () {
						if (stopped) return;
						stopped = true;
						yield* stopEffect;
					})
				);

			return {
				address: server.address,
				close: stop,
				stop
			};
		})
	);
