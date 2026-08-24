import { Config, Effect, Option, Redacted, Schema } from 'effect';
import {
	EnvironmentName,
	FacilityCall,
	InvocationScope,
	ReleaseId,
	TenantId,
	failure,
	makeWireError,
	success,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';

export const ServerConfiguration = Schema.Struct({
	host: Schema.NonEmptyString,
	port: Schema.Int,
	bundlePath: Schema.NonEmptyString,
	scope: InvocationScope,
	mode: Schema.Literals(['development', 'production']),
	drainTimeoutMillis: Schema.Int,
	invocationTimeoutMillis: Schema.Int,
	requestBodyLimitBytes: Schema.Int
});

export interface ServerConfiguration extends Schema.Schema.Type<typeof ServerConfiguration> {}

/** Reports invalid or unavailable self-host process configuration. */
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
	'BoltServer.ConfigurationError',
	{
		operation: Schema.String,
		cause: Schema.Defect()
	}
) {}

const ConfiguredProviderSettingsSchema = Schema.Struct({
	name: Schema.NonEmptyString,
	endpoint: Schema.optional(Schema.String),
	credential: Schema.optional(Schema.Redacted(Schema.String))
});

/** The settings one configured provider is constructed from, owned by the schema above for the Factories that consume it. */
export interface ConfiguredProviderSettings extends Schema.Schema.Type<
	typeof ConfiguredProviderSettingsSchema
> {}

// The factory SPI stays an Effect service rather than a schema: `make` is a live construction boundary.
export interface ConfiguredProviderFactory<Provider, Error = never> {
	readonly make: (settings: ConfiguredProviderSettings) => Effect.Effect<Provider, Error>;
}

/** Reports a configured provider name for which the host has no registered factory. */
export class ProviderConfigurationError extends Schema.TaggedError<ProviderConfigurationError>()(
	'BoltServer.ProviderConfigurationError',
	{
		facility: Schema.NonEmptyString,
		provider: Schema.NonEmptyString,
		cause: Schema.Defect()
	}
) {}

/** Selects and constructs a provider without revealing its optional credential. */
export const selectConfiguredProvider = <Provider, Error>(
	facility: string,
	factories: Readonly<Record<string, ConfiguredProviderFactory<Provider, Error>>>
) =>
	Effect.gen(function* () {
		const prefix = `BOLT_SERVER_${facility.toUpperCase()}`;
		const values = yield* Effect.all({
			name: Config.nonEmptyString(`${prefix}_PROVIDER`),
			endpoint: Config.option(Config.nonEmptyString(`${prefix}_ENDPOINT`)),
			credential: Config.option(Config.redacted(`${prefix}_CREDENTIAL`))
		});
		const factory = factories[values.name];
		if (factory === undefined) {
			return yield* new ProviderConfigurationError({
				facility,
				provider: values.name,
				cause: new Error('configured provider is not registered')
			});
		}
		return yield* factory.make({
			name: values.name,
			...(Option.isSome(values.endpoint) ? { endpoint: values.endpoint.value } : {}),
			...(Option.isSome(values.credential) ? { credential: values.credential.value } : {})
		});
	});

type WireFailureDescription = Readonly<{
	readonly code: string;
	readonly message: string | ((cause: unknown) => string);
	/** `undefined` from a classifier preserves the binding's ordinary cancellation-based default. */
	readonly retryable?: boolean | ((cause: unknown) => boolean | undefined);
}>;

type WireBindingOptions<
	RequestSchema extends Schema.ConstraintDecoder<unknown>,
	ResponseSchema extends Schema.ConstraintDecoder<unknown>
> = Readonly<{
	readonly request: RequestSchema;
	readonly response: ResponseSchema;
	readonly cancelled: Readonly<{ readonly code: string; readonly message: string }>;
	readonly failed: WireFailureDescription;
	readonly invoke: (
		metadata: FacilityCall,
		input: RequestSchema['Type'],
		signal: AbortSignal
		// repository-health:allow EFF2 -- FacilityBinding is a protocol-owned Promise boundary implemented by physical host providers.
	) => Promise<unknown>;
	/** A completed database operation can become unknown while its result crosses cancellation. */
	readonly checkCancellationAfterInvoke?: boolean;
}>;

/** Owns schema checking, cancellation, and failure envelopes for every configured facility. */
export const makeWireBinding = <
	RequestSchema extends Schema.ConstraintDecoder<unknown>,
	ResponseSchema extends Schema.ConstraintDecoder<unknown>
>(
	options: WireBindingOptions<RequestSchema, ResponseSchema>
): FacilityBinding<RequestSchema['Type'], ResponseSchema['Type']> => ({
	call: (unsafeMetadata, unsafeInput, signal) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const metadata = yield* Schema.decodeUnknownEffect(FacilityCall)(unsafeMetadata);
				const input = yield* Schema.decodeUnknownEffect(options.request)(unsafeInput);
				if (signal.aborted) {
					return failure(makeWireError(options.cancelled.code, options.cancelled.message));
				}
				const output = yield* Effect.tryPromise(() => options.invoke(metadata, input, signal));
				if (options.checkCancellationAfterInvoke === true && signal.aborted) {
					return failure(
						makeWireError(options.cancelled.code, options.cancelled.message, {
							outcome: 'unknown'
						})
					);
				}
				return success(yield* Schema.decodeUnknownEffect(options.response)(output));
			}).pipe(
				Effect.catch((cause) =>
					Effect.succeed(
						failure(
							makeWireError(
								options.failed.code,
								typeof options.failed.message === 'function'
									? options.failed.message(cause)
									: options.failed.message,
								{
									retryable:
										(typeof options.failed.retryable === 'function'
											? options.failed.retryable(cause)
											: options.failed.retryable) ?? !signal.aborted,
									outcome: signal.aborted ? 'unknown' : 'known'
								}
							)
						)
					)
				)
			)
		)
});

/** Reads process configuration through Effect's current ConfigProvider. */
export const loadConfiguration = Effect.fn('BoltServer.Configuration.load')(
	function* () {
		const values = yield* Effect.all({
			host: Config.nonEmptyString('BOLT_SERVER_HOST').pipe(Config.withDefault('127.0.0.1')),
			port: Config.port('BOLT_SERVER_PORT').pipe(Config.withDefault(3100)),
			bundlePath: Config.nonEmptyString('BOLT_SERVER_BUNDLE'),
			tenantId: Config.schema(TenantId, 'BOLT_SERVER_TENANT_ID').pipe(
				Config.withDefault(TenantId.make('local'))
			),
			environment: Config.schema(EnvironmentName, 'BOLT_SERVER_ENVIRONMENT').pipe(
				Config.withDefault(EnvironmentName.make('development'))
			),
			releaseId: Config.schema(ReleaseId, 'BOLT_SERVER_RELEASE_ID').pipe(
				Config.withDefault(ReleaseId.make('local'))
			),
			mode: Config.literals(['development', 'production'], 'BOLT_SERVER_MODE').pipe(
				Config.withDefault('development')
			),
			drainTimeoutMillis: Config.int('BOLT_SERVER_DRAIN_TIMEOUT_MS').pipe(
				Config.withDefault(10_000)
			),
			/**
			 * The invocation deadline this host grants, in milliseconds.
			 *
			 * It is a deadline on the whole tree, not a bound on CPU occupancy, and this host has no
			 * second knob for the latter — deliberately, because it could not honour one. The bundle
			 * runs in this process rather than in a worker thread, so there is no thread to terminate
			 * and no way to interrupt a synchronous tenant loop from inside the loop's own event loop.
			 * A host that needs the isolate-thread bound has to run the bundle somewhere it can kill,
			 * which is what Colony's worker-per-artifact isolate exists for.
			 *
			 * That is an acceptable difference because the exposure is different: this serves one
			 * tenant, so a tenant that spins denies service to itself. The bound matters where one
			 * thread is shared between workspaces that did not choose each other.
			 */
			invocationTimeoutMillis: Config.int('BOLT_SERVER_INVOCATION_TIMEOUT_MS').pipe(
				Config.withDefault(30_000)
			),
			requestBodyLimitBytes: Config.int('BOLT_SERVER_REQUEST_BODY_LIMIT_BYTES').pipe(
				Config.withDefault(1_048_576)
			)
		});

		if (
			values.drainTimeoutMillis < 1 ||
			values.invocationTimeoutMillis < 1 ||
			values.requestBodyLimitBytes < 1
		) {
			return yield* new ConfigurationError({
				operation: 'BoltServer.Configuration.validateBounds',
				cause: new Error('timeouts and request body limit must be positive integers')
			});
		}

		return ServerConfiguration.make({
			host: values.host,
			port: values.port,
			bundlePath: values.bundlePath,
			scope: InvocationScope.make({
				tenantId: values.tenantId,
				environment: values.environment,
				releaseId: values.releaseId
			}),
			mode: values.mode,
			drainTimeoutMillis: values.drainTimeoutMillis,
			invocationTimeoutMillis: values.invocationTimeoutMillis,
			requestBodyLimitBytes: values.requestBodyLimitBytes
		});
	},
	(effect) =>
		effect.pipe(
			Effect.mapError((cause) =>
				cause instanceof ConfigurationError
					? cause
					: new ConfigurationError({
							operation: 'BoltServer.Configuration.load',
							cause
						})
			)
		)
);
