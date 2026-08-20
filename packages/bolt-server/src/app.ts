import {
	Activation,
	ActivationResult,
	BundleResult,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	type FacilityBindings
} from '@norbital-ai/bolt-protocol';
import { Clock, Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { BundleLoader, makeLayer as makeBundleLoaderLayer } from './bundle-loader.js';
import type { ServerConfiguration } from './config.js';
import { ServerHealth, layer as serverHealthLayer } from './health.js';
import { makeScheduler } from './scheduler.js';
import { makeTaskBinding } from './facilities/tasks.js';
import { startServer, type RunningServer } from './server.js';

/** Reports a lifecycle phase that prevented the self-host application from becoming usable; stupidity:allow Q4 -- Effect TaggedError declaration is the canonical rc.109 error boundary. */
export class ApplicationStartError extends Schema.TaggedError<ApplicationStartError>()(
	'BoltServer.ApplicationStartError',
	{
		operation: Schema.String,
		message: Schema.NonEmptyString,
		cause: Schema.optionalKey(Schema.Defect())
	}
) {}

// stupidity:allow AL10 -- public lifecycle options stay beside their sole runtime owner in the required 14-file architecture
export interface ApplicationOptions {
	readonly configuration: ServerConfiguration;
	readonly facilities: FacilityBindings;
	readonly finalizeFacilities?: () => Promise<void>;
}

export interface RunningApplication extends RunningServer {
	readonly stop: () => Promise<void>;
}

/** Installs one-shot Node process shutdown hooks and returns a hook disposer. */
export const installProcessShutdown = (application: RunningApplication): (() => void) => {
	/** Removes both one-shot process hooks without stopping an already running application; stupidity:allow Q4 -- paired Node signal disposer must retain callback identity. */
	const dispose = () => {
		process.off('SIGINT', shutdown);
		process.off('SIGTERM', shutdown);
	};
	/** Converts either supported process signal into the same idempotent application stop; stupidity:allow Q4 -- paired Node signal callback must retain callback identity. */
	const shutdown = () => {
		dispose();
		void application.stop().catch(() => {
			process.exitCode = 1;
		});
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
	return dispose;
};

/** Validates configuration, activates one immutable bundle, and owns all server finalizers. */
export const startApplication = async (
	options: ApplicationOptions
): Promise<RunningApplication> => {
	const { configuration, facilities, finalizeFacilities = () => Promise.resolve() } = options;
	let validationError: ApplicationStartError | undefined;
	if (
		facilities.scope.tenantId !== configuration.scope.tenantId ||
		facilities.scope.environment !== configuration.scope.environment ||
		facilities.scope.releaseId !== configuration.scope.releaseId
	) {
		validationError = new ApplicationStartError({
			operation: 'BoltServer.Application.validateScope',
			message: 'Facility bindings do not match the configured invocation scope'
		});
	}
	if (validationError !== undefined) {
		try {
			await finalizeFacilities();
		} finally {
			throw validationError;
		}
	}
	/**
	 * The host's timer, and the task facility that feeds it.
	 *
	 * The binding is built here rather than accepted from the embedder because there is nothing left
	 * to configure: `TaskRequest` carries `Register` and `Wake`, and both are answered by this
	 * process's own routing table and its own `setTimeout`. Whatever `tasks` binding the caller
	 * supplied is replaced, deliberately — a host that let one be injected would be letting somebody
	 * else own its clock.
	 */
	const scheduler = makeScheduler({
		tick: () => tickOnce(),
		onFailure: (cause) => {
			// A tick is background work with nobody waiting on it, so a swallowed failure is silence
			// rather than an error somebody sees. The scheduler backs off on its own count; this only
			// has to make sure the reason reaches a log.
			void Effect.runPromise(
				Effect.logError(`scheduler.tick: ${cause instanceof Error ? cause.message : String(cause)}`)
			);
		}
	});
	const bound: FacilityBindings = { ...facilities, tasks: makeTaskBinding(scheduler) };

	const applicationLayer = Layer.mergeAll(
		serverHealthLayer,
		makeBundleLoaderLayer({ bundlePath: configuration.bundlePath, facilities: bound })
	);
	const runtime = ManagedRuntime.make(applicationLayer);

	/**
	 * One tick, dispatched into the bundle like any other invocation.
	 *
	 * `Task`, not `Command`: a `Task` carries no credential by construction, which is what the
	 * runtime's provenance gate requires of enqueued work — and a host minting a tenant session to
	 * talk to its own tenant would be a standing key to tenant data. The answer carries the next
	 * instant anything is due, which is the only thing this side needs to know.
	 */
	const tickOnce = (): Promise<number | null> =>
		runtime.runPromise(
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
			})
		);

	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const loader = yield* BundleLoader;
				const bundle = yield* loader.load();
				const now = yield* Clock.currentTimeMillis;
				const activation = Activation.make({
					protocolVersion: PROTOCOL_VERSION,
					id: InvocationId.make(randomUUID()),
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
				// Activation has just written this release's schedules and read back when anything is next
				// due, so the timer is armed from that answer rather than from a first tick that exists
				// only to ask. A release with no schedule and nothing queued arms nothing at all, which is
				// the state an idle workspace spends almost all of its life in.
				scheduler.settle(result.nextDueAtEpochMs);
			})
		);

		const server = await startServer(configuration, facilities, runtime);
		await runtime.runPromise(
			Effect.gen(function* () {
				const health = yield* ServerHealth;
				yield* health.markReady();
			})
		);

		let stopPromise: Promise<void> | undefined;
		/** Runs the ordered transport, drain, scheduler, bundle, and facility finalizers once. */
		const stop = (): Promise<void> => {
			stopPromise ??= (async () => {
				let transportFailure: unknown;
				try {
					try {
						await server.close();
					} catch (cause) {
						transportFailure = cause;
					}
					await runtime.runPromise(ServerHealth.use((health) => health.stopAdmission()));
					await runtime.runPromise(
						Effect.gen(function* () {
							const health = yield* ServerHealth;
							const loader = yield* BundleLoader;
							yield* health
								.drain(configuration.drainTimeoutMillis)
								.pipe(
									Effect.ensuring(Effect.sync(() => scheduler.stop())),
									Effect.ensuring(loader.dispose()),
									Effect.ensuring(health.markFinalized())
								);
						})
					);
					if (transportFailure !== undefined) throw transportFailure;
				} finally {
					try {
						await finalizeFacilities();
					} finally {
						await runtime.dispose();
					}
				}
			})();
			return stopPromise;
		};

		return { address: server.address, close: stop, stop };
	} catch (cause) {
		try {
			await finalizeFacilities();
		} finally {
			await runtime.dispose();
		}
		if (cause instanceof ApplicationStartError) throw cause;
		throw new ApplicationStartError({
			operation: 'BoltServer.Application.start',
			message: 'Bolt server application failed to start',
			cause
		});
	}
};
