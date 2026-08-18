import {
	Activation,
	ActivationResult,
	InvocationId,
	PROTOCOL_VERSION,
	type FacilityBindings
} from '@norbital-ai/bolt-protocol';
import { Clock, Effect, Layer, ManagedRuntime, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { BundleLoader, makeLayer as makeBundleLoaderLayer } from './bundle-loader.js';
import type { ServerConfiguration } from './config.js';
import {
	DurableEngine,
	developmentLayer as durableEngineDevelopmentLayer
} from './durable-engine.js';
import { ServerHealth, layer as serverHealthLayer } from './health.js';
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
	readonly durableEngineLayer?: Layer.Layer<DurableEngine>;
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
	if (configuration.mode === 'production' && configuration.durableEngine !== 'external') {
		validationError = new ApplicationStartError({
			operation: 'BoltServer.Application.validateDurability',
			message: 'Production mode must select the external durable engine'
		});
	} else if (
		configuration.durableEngine === 'external' &&
		options.durableEngineLayer === undefined
	) {
		validationError = new ApplicationStartError({
			operation: 'BoltServer.Application.validateDurability',
			message: 'The external durable engine requires an explicit adapter layer'
		});
	}
	if (
		validationError === undefined &&
		(facilities.scope.tenantId !== configuration.scope.tenantId ||
			facilities.scope.environment !== configuration.scope.environment ||
			facilities.scope.releaseId !== configuration.scope.releaseId)
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
	const durableEngineLayer = options.durableEngineLayer ?? durableEngineDevelopmentLayer;

	const applicationLayer = Layer.mergeAll(
		serverHealthLayer,
		makeBundleLoaderLayer({ bundlePath: configuration.bundlePath, facilities }),
		durableEngineLayer
	);
	const runtime = ManagedRuntime.make(applicationLayer);

	try {
		await runtime.runPromise(
			Effect.gen(function* () {
				const loader = yield* BundleLoader;
				const durableEngine = yield* DurableEngine;
				const bundle = yield* loader.load();
				yield* durableEngine.recover();
				const durableSnapshot = yield* durableEngine.snapshot();
				const expectsDurability = configuration.durableEngine === 'external';
				if (durableSnapshot.durable !== expectsDurability) {
					return yield* new ApplicationStartError({
						operation: 'BoltServer.Application.validateDurability',
						message: 'Configured durable engine selection does not match the adapter'
					});
				}
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
		/** Runs the ordered transport, drain, durable-engine, bundle, and facility finalizers once. */
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
							const durableEngine = yield* DurableEngine;
							yield* health
								.drain(configuration.drainTimeoutMillis)
								.pipe(
									Effect.ensuring(durableEngine.stop()),
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
