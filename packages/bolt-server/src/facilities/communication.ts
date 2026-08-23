import {
	CommunicationRequest,
	CommunicationResponse,
	FacilityCall,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { Effect } from 'effect';
import {
	makeWireBinding,
	selectConfiguredProvider,
	type ConfiguredProviderFactory
} from '../config.js';

/** The SPI a channel provider implements, mirroring the wire contract's call shape. */
export interface Provider {
	readonly call: (
		metadata: FacilityCall,
		input: CommunicationRequest,
		signal: AbortSignal
		// repository-health:allow EFF2 -- Provider SPI mirrors the protocol-owned Promise facility boundary for external adapters.
	) => Promise<unknown>;
}

/** Validates communication envelopes without embedding any channel-provider semantics. */
export const makeCommunicationBinding = (
	provider: Provider
): FacilityBinding<CommunicationRequest, CommunicationResponse> =>
	makeWireBinding({
		request: CommunicationRequest,
		response: CommunicationResponse,
		cancelled: {
			code: 'communication.cancelled',
			message: 'Communication call was cancelled'
		},
		failed: {
			code: 'communication.failed',
			message: 'Communication provider operation failed'
		},
		invoke: provider.call.bind(provider)
	});

/** Selects and constructs the configured communication provider. */
export const makeCommunicationBindingFromConfig = <Error>(
	factories: Readonly<Record<string, ConfiguredProviderFactory<Provider, Error>>>
) =>
	selectConfiguredProvider('COMMUNICATION', factories).pipe(Effect.map(makeCommunicationBinding));
