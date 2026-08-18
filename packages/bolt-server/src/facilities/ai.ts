import {
	AIRequest,
	AIResponse,
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
		input: AIRequest,
		signal: AbortSignal
	) => Promise<unknown>;
}

/** Validates both sides of an AI provider call at the neutral facility boundary. */
export const makeAiBinding = (provider: Provider): FacilityBinding<AIRequest, AIResponse> => ({
	call: (unsafeMetadata, unsafeInput, signal) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const metadata = yield* Schema.decodeUnknownEffect(FacilityCall)(unsafeMetadata);
				const input = yield* Schema.decodeUnknownEffect(AIRequest)(unsafeInput);
				if (signal.aborted) return failure(makeWireError('ai.cancelled', 'AI call was cancelled'));
				const output = yield* Effect.tryPromise(() => provider.call(metadata, input, signal));
				return success(yield* Schema.decodeUnknownEffect(AIResponse)(output));
			}).pipe(
				Effect.catch(() =>
					Effect.succeed(
						failure(
							makeWireError('ai.failed', 'AI provider operation failed', {
								retryable: !signal.aborted,
								outcome: signal.aborted ? 'unknown' : 'known'
							})
						)
					)
				)
			)
		)
});

/** Selects and constructs the configured AI provider before adapting it to the wire contract; stupidity:allow Q3 stupidity:allow Q4 -- public Config-selected provider factory entry point. */
export const makeAiBindingFromConfig = <Error>(
	factories: Readonly<Record<string, ConfiguredProviderFactory<Provider, Error>>>
) => selectConfiguredProvider('AI', factories).pipe(Effect.map(makeAiBinding));

/** Exposes explicit and Config-selected AI binding construction. */
export const AiFacilities = { make: makeAiBinding, fromConfig: makeAiBindingFromConfig };
