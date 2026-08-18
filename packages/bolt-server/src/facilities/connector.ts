import {
	ConnectorRequest,
	ConnectorResponse,
	FacilityCall,
	failure,
	makeWireError,
	success,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { Effect, Schema } from 'effect';
import { selectConfiguredProvider, type ConfiguredProviderFactory } from '../config.js';

// stupidity:allow AL10 -- provider SPI stays beside its wire adapter in the required 14-file architecture
export interface Provider {
	readonly call: (
		metadata: FacilityCall,
		input: ConnectorRequest,
		signal: AbortSignal
	) => Promise<unknown>;
}

/** Adapts a configured connector map to the schema-checked neutral facility contract. */
export const makeConnectorBinding = (
	provider: Provider
): FacilityBinding<ConnectorRequest, ConnectorResponse> => ({
	call: (unsafeMetadata, unsafeInput, signal) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const metadata = yield* Schema.decodeUnknownEffect(FacilityCall)(unsafeMetadata);
				const input = yield* Schema.decodeUnknownEffect(ConnectorRequest)(unsafeInput);
				if (signal.aborted) {
					return failure(makeWireError('connector.cancelled', 'Connector call was cancelled'));
				}
				return success(
					yield* Schema.decodeUnknownEffect(ConnectorResponse)(
						yield* Effect.tryPromise(() => provider.call(metadata, input, signal))
					)
				);
			}).pipe(
				Effect.catch(() =>
					Effect.succeed(
						failure(
							makeWireError('connector.failed', 'Connector provider operation failed', {
								retryable: !signal.aborted,
								outcome: signal.aborted ? 'unknown' : 'known'
							})
						)
					)
				)
			)
		)
});

/** Selects and constructs the configured connector provider; stupidity:allow Q3 stupidity:allow Q4 -- public Config-selected provider factory entry point. */
export const makeConnectorBindingFromConfig = <Error>(
	factories: Readonly<Record<string, ConfiguredProviderFactory<Provider, Error>>>
) => selectConfiguredProvider('CONNECTOR', factories).pipe(Effect.map(makeConnectorBinding));

/** Exposes explicit and Config-selected connector binding construction. */
export const ConnectorFacilities = {
	make: makeConnectorBinding,
	fromConfig: makeConnectorBindingFromConfig
};
