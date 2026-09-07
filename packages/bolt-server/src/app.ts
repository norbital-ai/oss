import {
	Activation,
	ActivationResult,
	PROTOCOL_VERSION,
	type FacilityBindings
} from '@norbital-ai/bolt-protocol';
import { getErrorMessage, toError } from '@norbital-ai/std';
import { writeSync } from 'node:fs';
import { attributeEscapedFailure, guardBindings } from './facilities/boundary.js';
import { Clock, Deferred, Effect, Layer, ManagedRuntime, Result, Schema } from 'effect';
import { BundleLoader, makeLayer as makeBundleLoaderLayer } from './bundle-loader.js';
import type { ServerConfiguration } from './config.js';
import { ServerHealth, layer as serverHealthLayer } from './health.js';
import {
	makeTaskBinding,
	makeTaskInvocationControl,
	ScheduleTickError,
	runScheduleOccurrence,
	runScheduleTick,
	type ScheduleTickOptions
} from './schedules.js';
import { makeTimekeeper } from './timekeeper.js';

/**
 * What one task occurrence (an agent turn, a scheduled automation slice) may take.
 *
 * It is not the HTTP invocation timeout: a browser request is answered in seconds, while an agent
 * turn calling tools against a slow model runs for minutes and settles only at its end. Colony
 * grants the same five minutes (`schedule-tick.ts` `TICK_DEADLINE`); the lease the guest wrote on
 * the claimed row is the same number, so a host that dies mid-turn hands the row to the next tick.
 */
const TASK_DEADLINE_MILLIS = 5 * 60_000;
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
	/** Flips `/readyz` to 503 and refuses new bundle work, without closing anything yet. */
	// repository-health:allow EFF2 -- Same host-side lifecycle edge as `stop`: the process policy calls it from a Node event handler.
	readonly stopAdmission: () => Promise<void>;
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

/** How long a crashing host may spend on its graceful stop before it is killed outright. */
export const CRASH_STOP_MILLIS = 5_000;

/**
 * Ends the process without Node's exit path.
 *
 * `exit()` runs native teardown, and with worker threads and native thread pools alive that
 * teardown has hung for hours with the listening socket still open: Docker saw a live PID 1, the
 * proxy saw a dead backend. `SIGKILL` skips all of it. Inside a container this process is PID 1,
 * where the kernel ignores a SIGKILL it sends itself, so `abort()` follows: a synchronous fault
 * that even init cannot ignore.
 */
const terminateProcess = (): never => {
	process.kill(process.pid, 'SIGKILL');
	process.abort();
};

const describeEscaped = (cause: unknown): string =>
	cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);

/**
 * Installs the process policy: signals stop the application; a failure that escapes every boundary
 * is logged, readiness flips to 503 at once, the graceful stop gets `CRASH_STOP_MILLIS`, and then
 * the process is killed so the restart policy acts instead of a listening corpse. A failure raised
 * inside a facility call's async scope is that call's failure and is contained. Returns a disposer.
 */
export const installProcessShutdown = (application: RunningApplication): (() => void) => {
	/** Removes every process hook without stopping an already running application. */
	const dispose = () => {
		process.off('SIGINT', shutdown);
		process.off('SIGTERM', shutdown);
		process.off('uncaughtException', escaped);
		process.off('unhandledRejection', escaped);
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
	let crashing = false;
	const escaped = (cause: unknown) => {
		const scope = attributeEscapedFailure(cause);
		if (scope !== undefined) {
			writeSync(
				2,
				`bolt-server: failure escaped facility ${scope.facility} (effect ${scope.effectId}) and was contained: ${describeEscaped(cause)}\n`
			);
			return;
		}
		writeSync(
			2,
			`bolt-server: failure escaped every boundary; stopping within ${CRASH_STOP_MILLIS}ms then killing the process: ${describeEscaped(cause)}\n`
		);
		if (crashing) return;
		crashing = true;
		process.exitCode = 1;
		process.off('SIGINT', shutdown);
		process.off('SIGTERM', shutdown);
		setTimeout(terminateProcess, CRASH_STOP_MILLIS);
		void application
			.stopAdmission()
			.then(() => application.stop())
			.then(terminateProcess, terminateProcess);
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
	process.on('uncaughtException', escaped);
	process.on('unhandledRejection', escaped);
	return dispose;
};

/** Validates configuration, activates one immutable bundle, and owns all server finalizers. */
export const startApplication = async (
	options: ApplicationOptions
): Promise<RunningApplication> => {
	const { configuration, facilities } = options;
	const taskInvocations = makeTaskInvocationControl();
	const dispatchReady = Deferred.makeUnsafe<void>();
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
	const tickOptions = Effect.gen(function* () {
		const loader = yield* BundleLoader;
		const bundle = yield* loader.load();
		return {
			scope: configuration.scope,
			deadlineMillis: TASK_DEADLINE_MILLIS,
			gatewaySecret: configuration.gatewaySecret,
			invocations: taskInvocations,
			dispatch: (invocation, signal) => bundle.dispatch(invocation, bound, signal)
		} satisfies ScheduleTickOptions;
	});
	const tickFailure = (message: string) => (cause: unknown) =>
		cause instanceof ApplicationStartError
			? cause
			: new ApplicationStartError({
					operation: 'BoltServer.Application.tick',
					message: cause instanceof ScheduleTickError ? cause.message : message,
					cause
				});
	const tickOnce = () =>
		tickOptions.pipe(
			Effect.flatMap(runScheduleTick),
			Effect.mapError(tickFailure('Bolt scheduler tick failed'))
		);
	/** The immediate half of a `Wake` that carries a claimed occurrence: the same bundle, one run. */
	const runOccurrenceOnce = (occurrence: Parameters<typeof runScheduleOccurrence>[1]) =>
		tickOptions.pipe(
			Effect.flatMap((options) => runScheduleOccurrence(options, occurrence)),
			Effect.mapError(tickFailure('Bolt scheduled occurrence failed'))
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
	// Every binding the guest can reach answers with a facility result and nothing else; a failure
	// that escapes one later is attributable to the call that started it.
	let bound: FacilityBindings = guardBindings({
		...facilities,
		tasks: makeTaskBinding(
			timekeeper,
			() => {},
			taskInvocations,
			(occurrence) => {
				// Started, never awaited: the guest's submit is inside a facility call right now. The
				// timekeeper already holds the lease expiry as the fallback, so a failure here is logged
				// and otherwise left to the ordinary tick.
				void runScheduledTick(runOccurrenceOnce(occurrence)).catch((cause) => {
					Effect.runFork(
						Effect.logError(`tasks.wake: ${occurrence.taskId}: ${getErrorMessage(cause)}`)
					);
				});
			}
		)
	});

	const applicationLayer = Layer.mergeAll(
		uuidGenerationLayer,
		serverHealthLayer,
		makeBundleLoaderLayer({ bundlePath: configuration.bundlePath, facilities: bound })
	);
	const runtime = ManagedRuntime.make(applicationLayer);
	// Activation can announce immediate work before HTTP sync is wired. Hold that work so every
	// background mutation publishes through the same commit lane as an HTTP invocation.
	runScheduledTick = (effect) =>
		runtime.runPromise(Deferred.await(dispatchReady).pipe(Effect.andThen(effect)));

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
				startServer(configuration, bound, runtime, taskInvocations, (liveFacilities) => {
					bound = liveFacilities;
					Effect.runSync(Deferred.succeed(dispatchReady, undefined));
				})
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
				Effect.sync(() => timekeeper.stop()).pipe(
					Effect.andThen(finalizeFacilities),
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

	const stopAdmission = () =>
		runtime.runPromise(
			Effect.gen(function* () {
				const health = yield* ServerHealth;
				yield* health.stopAdmission();
			})
		);

	return {
		address: server.address,
		close: stop,
		stop,
		stopAdmission
	};
};
