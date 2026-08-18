import {
	CommunicationRequest,
	CommunicationResponse,
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
		input: CommunicationRequest,
		signal: AbortSignal
	) => Promise<unknown>;
}

/** Validates communication envelopes without embedding any channel-provider semantics. */
export const makeCommunicationBinding = (
	provider: Provider
): FacilityBinding<CommunicationRequest, CommunicationResponse> => ({
	call: (unsafeMetadata, unsafeInput, signal) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const metadata = yield* Schema.decodeUnknownEffect(FacilityCall)(unsafeMetadata);
				const input = yield* Schema.decodeUnknownEffect(CommunicationRequest)(unsafeInput);
				if (signal.aborted) {
					return failure(
						makeWireError('communication.cancelled', 'Communication call was cancelled')
					);
				}
				return success(
					yield* Schema.decodeUnknownEffect(CommunicationResponse)(
						yield* Effect.tryPromise(() => provider.call(metadata, input, signal))
					)
				);
			}).pipe(
				Effect.catch(() =>
					Effect.succeed(
						failure(
							makeWireError('communication.failed', 'Communication provider operation failed', {
								retryable: !signal.aborted,
								outcome: signal.aborted ? 'unknown' : 'known'
							})
						)
					)
				)
			)
		)
});

/** Selects and constructs the configured communication provider; stupidity:allow Q3 stupidity:allow Q4 -- public Config-selected provider factory entry point. */
export const makeCommunicationBindingFromConfig = <Error>(
	factories: Readonly<Record<string, ConfiguredProviderFactory<Provider, Error>>>
) =>
	selectConfiguredProvider('COMMUNICATION', factories).pipe(Effect.map(makeCommunicationBinding));

/** Exposes explicit and Config-selected communication binding construction. */
export const CommunicationFacilities = {
	make: makeCommunicationBinding,
	fromConfig: makeCommunicationBindingFromConfig
};
