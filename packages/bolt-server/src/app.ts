import {
	Activation,
	ActivationResult,
	PROTOCOL_VERSION,
	type FacilityBindings
} from '@norbital-ai/bolt-protocol';
import { getErrorMessage, toError } from '@norbital-ai/std';
import { Clock, Effect, Layer, ManagedRuntime, Result, Schema } from 'effect';
import { BundleLoader, makeLayer as makeBundleLoaderLayer } from './bundle-loader.js';
import type { ServerConfiguration } from './config.js';
import { ServerHealth, layer as serverHealthLayer } from './health.js';
import {
	makeTaskBinding,
	makeTaskInvocationControl,
	ScheduleTickError,
	runScheduleTick
} from './schedules.js';
import { makeTimekeeper } from './timekeeper.js';
import { waitUntilReady } from './ready.js';
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

export interface RunningLocalApplication extends RunningApplication {
	readonly baseUrl: string;
}

/**
 * `startApplication` plus `/readyz`. The caller still forms `FacilityBindings` — this does not
 * invent database, AI, or files.
 */
export const startLocalApplication = (
	options: ApplicationOptions
): Promise<RunningLocalApplication> =>
	Effect.gen(function* () {
		const application = yield* Effect.tryPromise(() => startApplication(options));
		const baseUrl = `http://${application.address.host}:${application.address.port}`;
		return yield* Effect.tryPromise(() => waitUntilReady(baseUrl)).pipe(
			Effect.map(() => ({ ...application, baseUrl })),
			Effect.catch((cause) =>
				Effect.tryPromise(() => application.stop()).pipe(Effect.andThen(() => Effect.fail(cause)))
			)
		);
	}).pipe(Effect.runPromise);

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
export const startApplication = async (
	options: ApplicationOptions
): Promise<RunningApplication> => {
	const { configuration, facilities } = options;
	const taskInvocations = makeTaskInvocationControl();
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
		await Effect.runPromise(finalizeFacilities.pipe(Effect.catch(() => Effect.void)));
		throw new ApplicationStartError({
			operation: 'BoltServer.Application.validateScope',
			message: 'Facility bindings do not match the configured invocation scope'
		});
	}

	/**
	 * One tick, held against the bundle this process already loaded.
	 *
	 * The queue is driven through `host.schedules.discover` / `host.schedules.settle` with the
	 * occurrences invoked between them — `schedules.ts` owns that conversation, because it is the
	 * guest's protocol rather than this file's lifecycle. What is left here is which bundle it
	 * talks to, which scope it talks about, and the deadline this host grants an invocation.
	 */
	const tickOnce = () =>
		Effect.gen(function* () {
			const loader = yield* BundleLoader;
			const bundle = yield* loader.load();
			return yield* runScheduleTick({
				scope: configuration.scope,
				deadlineMillis: configuration.invocationTimeoutMillis,
				gatewaySecret: configuration.gatewaySecret,
				invocations: taskInvocations,
				dispatch: (invocation, signal) => bundle.dispatch(invocation, bound, signal)
			});
		}).pipe(
			Effect.mapError((cause) =>
				cause instanceof ApplicationStartError
					? cause
					: new ApplicationStartError({
							operation: 'BoltServer.Application.tick',
							message:
								cause instanceof ScheduleTickError ? cause.message : 'Bolt scheduler tick failed',
							cause
						})
			)
		);

	/**
	 * The host's timer, and the task facility that feeds it.
	 *
	 * The binding is built here rather than accepted from the embedder because there is nothing left
	 * to configure: routing and timer requests are answered by this process, while lifecycle
	 * signals point at the exact in-process dispatch and never form a second queue. Whatever `tasks` binding the caller
	 * supplied is replaced, deliberately — a host that let one be injected would be letting somebody
	 * else own its clock.
	 */
	let runScheduledTick = <A, E>(_effect: Effect.Effect<A, E, BundleLoader>): Promise<A> =>
		Promise.reject(
			new ApplicationStartError({
				operation: 'BoltServer.Application.tick',
				message: 'Bolt scheduler runtime is not ready'
			})
		);
	const timekeeper = makeTimekeeper({
		tick: tickOnce,
		run: (effect) => runScheduledTick(effect),
		onFailure: (cause) => {
			// The timekeeper backs off; this boundary keeps an unwatched failure visible.
			Effect.runFork(Effect.logError(`timekeeper.tick: ${getErrorMessage(cause)}`));
		}
	});
	const bound: FacilityBindings = {
		...facilities,
		tasks: makeTaskBinding(timekeeper, () => {}, taskInvocations)
	};

	const applicationLayer = Layer.mergeAll(
		uuidGenerationLayer,
		serverHealthLayer,
		makeBundleLoaderLayer({ bundlePath: configuration.bundlePath, facilities: bound })
	);
	const runtime = ManagedRuntime.make(applicationLayer);
	runScheduledTick = (effect) => runtime.runPromise(effect);

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
				try: (signal) => bundle.activate(activation, bound, signal),
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
			timekeeper.settle(result.nextDueAtEpochMs);
		});
		const server = yield* Effect.gen(function* () {
			yield* activated;
			return yield* Effect.tryPromise(() =>
				startServer(configuration, bound, runtime, taskInvocations)
			);
		});
		yield* Effect.gen(function* () {
			const health = yield* ServerHealth;
			yield* health.markReady();
		});
		return server;
	});
	// Finalization must run outside the runtime it disposes, or it interrupts the failure itself.
	const server = await Effect.runPromise(
		// repository-health:allow SANDWICH1 -- Startup uses its managed runtime, but cleanup must survive disposal of that runtime and report its failure outside it.
		Effect.tryPromise({ try: () => runtime.runPromise(startup), catch: toError }).pipe(
			Effect.catch((cause) =>
				finalizeFacilities.pipe(
					Effect.catch(() => Effect.void),
					Effect.andThen(Effect.tryPromise({ try: () => runtime.dispose(), catch: toError })),
					Effect.andThen(
						Effect.fail(
							cause instanceof ApplicationStartError
								? cause
								: new ApplicationStartError({
										operation: 'BoltServer.Application.start',
										message: 'Bolt server application failed to start',
										cause
									})
						)
					)
				)
			)
		)
	);

	/**
	 * Runs the ordered transport, drain, timekeeper, bundle, and facility finalizers once.
	 *
	 * A transport failure is the one failure reported to the caller of `stop`; every other
	 * step's failures are observed but do not hide that one.
	 */
	const stopEffect = Effect.gen(function* () {
		const transportFailure = yield* Effect.result(Effect.tryPromise(() => server.close()));
		yield* runtime.contextEffect.pipe(
			Effect.flatMap((context) =>
				Effect.gen(function* () {
					const health = yield* ServerHealth;
					const loader = yield* BundleLoader;
					yield* health.stopAdmission();
					yield* health
						.drain(configuration.drainTimeoutMillis)
						.pipe(
							Effect.ensuring(Effect.sync(() => timekeeper.stop())),
							Effect.ensuring(loader.dispose()),
							Effect.ensuring(health.markFinalized())
						);
				}).pipe(Effect.provide(context))
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
	let stopping: Promise<void> | undefined;
	/** Stops the application once, converging concurrent callers on the same run. */
	const stop = () => (stopping ??= Effect.runPromise(stopEffect));

	return {
		address: server.address,
		close: stop,
		stop
	};
};
