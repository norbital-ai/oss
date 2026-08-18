import {
	FacilityCall,
	HostToolRequest,
	HostToolResponse,
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
		input: HostToolRequest,
		signal: AbortSignal
	) => Promise<unknown>;
}

/** Adapts only explicitly registered host tools to the neutral facility contract. */
export const makeHostToolBinding = (
	provider: Provider
): FacilityBinding<HostToolRequest, HostToolResponse> => ({
	call: (unsafeMetadata, unsafeInput, signal) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const metadata = yield* Schema.decodeUnknownEffect(FacilityCall)(unsafeMetadata);
				const input = yield* Schema.decodeUnknownEffect(HostToolRequest)(unsafeInput);
				if (signal.aborted) {
					return failure(makeWireError('host_tools.cancelled', 'Host tool call was cancelled'));
				}
				return success(
					yield* Schema.decodeUnknownEffect(HostToolResponse)(
						yield* Effect.tryPromise(() => provider.call(metadata, input, signal))
					)
				);
			}).pipe(
				Effect.catch(() =>
					Effect.succeed(
						failure(
							makeWireError('host_tools.failed', 'Host tool operation failed', {
								retryable: !signal.aborted,
								outcome: signal.aborted ? 'unknown' : 'known'
							})
						)
					)
				)
			)
		)
});

/** Selects and constructs the configured host-tool provider; stupidity:allow Q3 stupidity:allow Q4 -- public Config-selected provider factory entry point. */
export const makeHostToolBindingFromConfig = <Error>(
	factories: Readonly<Record<string, ConfiguredProviderFactory<Provider, Error>>>
) => selectConfiguredProvider('HOST_TOOLS', factories).pipe(Effect.map(makeHostToolBinding));

/** Exposes explicit and Config-selected host-tool binding construction. */
export const HostToolFacilities = {
	make: makeHostToolBinding,
	fromConfig: makeHostToolBindingFromConfig
};
