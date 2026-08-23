import {
	AIRequest,
	AIResponse,
	ConnectorRequest,
	ConnectorResponse,
	FacilityCall,
	HostToolRequest,
	HostToolResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { Effect } from 'effect';
import {
	makeWireBinding,
	selectConfiguredProvider,
	type ConfiguredProviderFactory
} from '../config.js';

/** The SPI an AI provider implements, mirroring the wire contract's call shape. */
export interface AiProvider {
	readonly call: (
		metadata: FacilityCall,
		input: AIRequest,
		signal: AbortSignal
		// repository-health:allow EFF2 -- Provider SPI mirrors the protocol-owned Promise facility boundary for external adapters.
	) => Promise<unknown>;
}

/** The SPI a connector provider implements, mirroring the wire contract's call shape. */
export interface ConnectorProvider {
	readonly call: (
		metadata: FacilityCall,
		input: ConnectorRequest,
		signal: AbortSignal
		// repository-health:allow EFF2 -- Provider SPI mirrors the protocol-owned Promise facility boundary for external adapters.
	) => Promise<unknown>;
}

/** The SPI a host-tool provider implements, mirroring the wire contract's call shape. */
export interface HostToolProvider {
	readonly call: (
		metadata: FacilityCall,
		input: HostToolRequest,
		signal: AbortSignal
		// repository-health:allow EFF2 -- Provider SPI mirrors the protocol-owned Promise facility boundary for external adapters.
	) => Promise<unknown>;
}

/** Validates both sides of an AI provider call at the neutral facility boundary. */
export const makeAiBinding = (provider: AiProvider): FacilityBinding<AIRequest, AIResponse> =>
	makeWireBinding({
		request: AIRequest,
		response: AIResponse,
		cancelled: { code: 'ai.cancelled', message: 'AI call was cancelled' },
		failed: { code: 'ai.failed', message: 'AI provider operation failed' },
		invoke: provider.call.bind(provider)
	});

/** Selects and constructs the configured AI provider before adapting it to the wire contract. */
export const makeAiBindingFromConfig = <Error>(
	factories: Readonly<Record<string, ConfiguredProviderFactory<AiProvider, Error>>>
) => selectConfiguredProvider('AI', factories).pipe(Effect.map(makeAiBinding));

/** Adapts a configured connector map to the schema-checked neutral facility contract. */
export const makeConnectorBinding = (
	provider: ConnectorProvider
): FacilityBinding<ConnectorRequest, ConnectorResponse> =>
	makeWireBinding({
		request: ConnectorRequest,
		response: ConnectorResponse,
		cancelled: { code: 'connector.cancelled', message: 'Connector call was cancelled' },
		failed: { code: 'connector.failed', message: 'Connector provider operation failed' },
		invoke: provider.call.bind(provider)
	});

/** Selects and constructs the configured connector provider. */
export const makeConnectorBindingFromConfig = <Error>(
	factories: Readonly<Record<string, ConfiguredProviderFactory<ConnectorProvider, Error>>>
) => selectConfiguredProvider('CONNECTOR', factories).pipe(Effect.map(makeConnectorBinding));

/** Adapts only explicitly registered host tools to the neutral facility contract. */
export const makeHostToolBinding = (
	provider: HostToolProvider
): FacilityBinding<HostToolRequest, HostToolResponse> =>
	makeWireBinding({
		request: HostToolRequest,
		response: HostToolResponse,
		cancelled: { code: 'host_tools.cancelled', message: 'Host tool call was cancelled' },
		failed: { code: 'host_tools.failed', message: 'Host tool operation failed' },
		invoke: provider.call.bind(provider)
	});

/** Selects and constructs the configured host-tool provider. */
export const makeHostToolBindingFromConfig = <Error>(
	factories: Readonly<Record<string, ConfiguredProviderFactory<HostToolProvider, Error>>>
) => selectConfiguredProvider('HOST_TOOLS', factories).pipe(Effect.map(makeHostToolBinding));
