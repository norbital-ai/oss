import {
	FacilityCall,
	TaskRequest,
	TaskResponse,
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
		input: TaskRequest,
		signal: AbortSignal
	) => Promise<unknown>;
}

/** Adapts one configured durable engine; it deliberately owns no competing task DTOs. */
export const makeTaskBinding = (
	provider: Provider
): FacilityBinding<TaskRequest, TaskResponse> => ({
	call: (unsafeMetadata, unsafeInput, signal) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const metadata = yield* Schema.decodeUnknownEffect(FacilityCall)(unsafeMetadata);
				const input = yield* Schema.decodeUnknownEffect(TaskRequest)(unsafeInput);
				if (signal.aborted)
					return failure(makeWireError('tasks.cancelled', 'Task call was cancelled'));
				return success(
					yield* Schema.decodeUnknownEffect(TaskResponse)(
						yield* Effect.tryPromise(() => provider.call(metadata, input, signal))
					)
				);
			}).pipe(
				Effect.catch(() =>
					Effect.succeed(
						failure(
							makeWireError('tasks.failed', 'Durable task operation failed', {
								retryable: !signal.aborted,
								outcome: signal.aborted ? 'unknown' : 'known'
							})
						)
					)
				)
			)
		)
});

/** Selects and constructs the configured durable task provider; stupidity:allow Q3 stupidity:allow Q4 -- public Config-selected provider factory entry point. */
export const makeTaskBindingFromConfig = <Error>(
	factories: Readonly<Record<string, ConfiguredProviderFactory<Provider, Error>>>
) => selectConfiguredProvider('TASKS', factories).pipe(Effect.map(makeTaskBinding));

/** Exposes explicit and Config-selected durable task binding construction. */
export const TaskFacilities = { make: makeTaskBinding, fromConfig: makeTaskBindingFromConfig };
