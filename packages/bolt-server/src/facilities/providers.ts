import {
	AIRequest,
	AIResponse,
	CommunicationRequest,
	CommunicationResponse,
	ConfigRequest,
	ConfigResponse,
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

/** The SPI a communication provider implements, mirroring the wire contract's call shape. */
export interface CommunicationProvider {
	readonly call: (
		metadata: FacilityCall,
		input: CommunicationRequest,
		signal: AbortSignal
		// repository-health:allow EFF2 -- Provider SPI mirrors the protocol-owned Promise facility boundary for external adapters.
	) => Promise<unknown>;
}

/** The SPI an AI provider implements, mirroring the wire contract's call shape. */
export interface AiProvider {
	readonly call: (
		metadata: FacilityCall,
		input: AIRequest,
		signal: AbortSignal,
		onProgress?: import('@norbital-ai/bolt-protocol').FacilityProgress
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

/** Validates communication envelopes without embedding any channel-provider semantics. */
export const makeCommunicationBinding = (
	provider: CommunicationProvider
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
	factories: Readonly<Record<string, ConfiguredProviderFactory<CommunicationProvider, Error>>>
) =>
	selectConfiguredProvider('COMMUNICATION', factories).pipe(Effect.map(makeCommunicationBinding));

/**
 * Adapts any caller-supplied AI provider to the wire contract.
 *
 * bolt-server does not ship a model adapter and does not restrict the provider name. The host
 * registers whatever speaks `AIRequest` / `AIResponse` — OpenRouter, Ollama, a recorded fixture,
 * or a composite router.
 */
export const makeAiBinding = (provider: AiProvider): FacilityBinding<AIRequest, AIResponse> =>
	makeWireBinding({
		request: AIRequest,
		response: AIResponse,
		cancelled: { code: 'ai.cancelled', message: 'AI call was cancelled' },
		failed: { code: 'ai.failed', message: 'AI provider operation failed' },
		invoke: provider.call.bind(provider)
	});

/**
 * Selects one factory from the host's map via `BOLT_SERVER_AI_PROVIDER`.
 *
 * The registered names are the host's. This package does not enumerate vendors.
 */
export const makeAiBindingFromConfig = <Error>(
	factories: Readonly<Record<string, ConfiguredProviderFactory<AiProvider, Error>>>
) => selectConfiguredProvider('AI', factories).pipe(Effect.map(makeAiBinding));

export type AiProviderRouterOptions = Readonly<{
	readonly providers: Readonly<Record<string, AiProvider>>;
	readonly aliases?: Readonly<Record<string, string>>;
	readonly defaultProvider: string;
}>;

const registeredProvider = (options: AiProviderRouterOptions, name: string): AiProvider => {
	const provider = options.providers[name];
	if (provider === undefined) {
		throw new Error(
			`No AI provider is registered for ${JSON.stringify(name)}; registered providers: ${Object.keys(options.providers).join(', ')}`
		);
	}
	return provider;
};

const providerNameForModelId = (options: AiProviderRouterOptions, modelId: string): string => {
	const slash = modelId.indexOf('/');
	const namespace = slash === -1 ? options.defaultProvider : modelId.slice(0, slash);
	return options.aliases?.[namespace] ?? namespace;
};

/**
 * Routes Catalog / Generate / Embed to host-registered providers.
 *
 * Catalog uses `defaultProvider`. Generate and Embed use the first `modelId` segment, then
 * `aliases`, then the registered name. Unprefixed ids use `defaultProvider`. No vendor is implied.
 */
export const makeAiProviderRouter = (options: AiProviderRouterOptions): AiProvider => ({
	call: (metadata: FacilityCall, request: AIRequest, signal: AbortSignal, onProgress) => {
		switch (request._tag) {
			case 'Catalog':
				return registeredProvider(options, options.defaultProvider).call(metadata, request, signal);
			case 'Generate':
			case 'Embed':
				return registeredProvider(options, providerNameForModelId(options, request.modelId)).call(
					metadata,
					request,
					signal,
					onProgress
				);
			default: {
				const _exhaustive: never = request;
				throw new Error(`unhandled AI request: ${JSON.stringify(_exhaustive)}`);
			}
		}
	}
});

/** Answers named config keys from a host-owned map. Missing keys return no value. */
export const makeConfigBinding = (
	values: Readonly<Record<string, string>>
): FacilityBinding<ConfigRequest, ConfigResponse> =>
	makeWireBinding({
		request: ConfigRequest,
		response: ConfigResponse,
		cancelled: { code: 'config.cancelled', message: 'Config call was cancelled' },
		failed: { code: 'config.failed', message: 'Config provider operation failed' },
		invoke: async (_metadata, input) =>
			Object.hasOwn(values, input.key) ? { value: values[input.key] } : {}
	});

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
