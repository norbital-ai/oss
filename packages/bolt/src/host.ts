import { createHmac } from 'node:crypto';
import {
	LlmProviderConfigurationError,
	llm_provider,
	type LlmProviderDescriptor,
	type LlmProviderEndpoint
} from './llm_provider.js';

export { compileHostModelSchema } from './compiler/schema-migrations.js';

/** Computes the host-side HMAC without pulling Node's crypto module into runtime/browser bundles. */
export const systemSignature = (secret: string, payload: string): string =>
	createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

type ProviderRegistry = Readonly<Record<string, LlmProviderDescriptor>>;

declare const modelRegistryKind: unique symbol;

export type LanguageModelRegistry<TRegistry extends ProviderRegistry = ProviderRegistry> =
	Readonly<TRegistry> &
		Readonly<{
			readonly [modelRegistryKind]?: 'language';
		}>;

export type EmbeddingModelRegistry<TRegistry extends ProviderRegistry = ProviderRegistry> =
	Readonly<TRegistry> &
		Readonly<{
			readonly [modelRegistryKind]?: 'embedding';
		}>;

type CheckedRegistration<
	TKey extends string,
	TDescriptor extends LlmProviderDescriptor
> = TDescriptor extends { readonly endpoint: LlmProviderEndpoint }
	? TKey extends `openai-compatible/${TDescriptor['model']}`
		? TDescriptor
		: never
	: TKey extends `openai-compatible/${string}`
		? never
		: TKey extends `${infer TAdapter}/${TDescriptor['model']}`
			? TAdapter extends ''
				? never
				: TDescriptor
			: never;

type CheckedRegistry<TRegistry extends ProviderRegistry> = Readonly<{
	readonly [TKey in keyof TRegistry]: TKey extends string
		? CheckedRegistration<TKey, TRegistry[TKey]>
		: never;
}>;

export type BoltAIConfig<
	TLanguageModels extends ProviderRegistry = ProviderRegistry,
	TEmbeddingModels extends ProviderRegistry = ProviderRegistry
> = Readonly<{
	readonly defaultModel: Extract<keyof TLanguageModels, string>;
	readonly models: LanguageModelRegistry<TLanguageModels> & CheckedRegistry<TLanguageModels>;
	readonly defaultEmbeddingModel: Extract<keyof TEmbeddingModels, string>;
	readonly embeddingModels: EmbeddingModelRegistry<TEmbeddingModels> &
		CheckedRegistry<TEmbeddingModels>;
}>;

export type ColonyBoltHostConfig<
	TLanguageModels extends ProviderRegistry = ProviderRegistry,
	TEmbeddingModels extends ProviderRegistry = ProviderRegistry
> = Readonly<{
	readonly mode: 'colony';
	readonly ai: BoltAIConfig<TLanguageModels, TEmbeddingModels>;
}>;

export type SelfHostedBoltHostConfig<
	TLanguageModels extends ProviderRegistry = ProviderRegistry,
	TEmbeddingModels extends ProviderRegistry = ProviderRegistry
> = Readonly<{
	readonly mode: 'self-hosted';
	readonly db: string;
	readonly identity: unknown;
	readonly publicUrl: string;
	readonly ai: BoltAIConfig<TLanguageModels, TEmbeddingModels>;
}>;

export type BoltHostConfig<
	TLanguageModels extends ProviderRegistry = ProviderRegistry,
	TEmbeddingModels extends ProviderRegistry = ProviderRegistry
> =
	| ColonyBoltHostConfig<TLanguageModels, TEmbeddingModels>
	| SelfHostedBoltHostConfig<TLanguageModels, TEmbeddingModels>;

const ADAPTER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const validateRegistry = (kind: 'language' | 'embedding', registry: ProviderRegistry): void => {
	if (Object.keys(registry).length === 0) {
		throw new LlmProviderConfigurationError(
			'invalid-default',
			`ai.${kind === 'language' ? 'models' : 'embeddingModels'}`,
			`${kind} model registry cannot be empty`
		);
	}

	for (const [key, descriptor] of Object.entries(registry)) {
		llm_provider(descriptor);

		const separator = key.indexOf('/');
		const adapter = separator < 0 ? '' : key.slice(0, separator);
		const providerModel = separator < 0 ? '' : key.slice(separator + 1);
		const path = `ai.${kind === 'language' ? 'models' : 'embeddingModels'}.${key}`;
		if (!ADAPTER_NAME.test(adapter) || providerModel.length === 0) {
			throw new LlmProviderConfigurationError(
				'invalid-registry-key',
				path,
				'registry keys must be <adapter>/<provider-model>'
			);
		}
		if (providerModel !== descriptor.model) {
			throw new LlmProviderConfigurationError(
				'model-key-mismatch',
				path,
				`registry suffix ${JSON.stringify(providerModel)} does not match descriptor model ${JSON.stringify(descriptor.model)}`
			);
		}

		const hasEndpoint = descriptor.endpoint !== undefined;
		if ((adapter === 'openai-compatible') !== hasEndpoint) {
			throw new LlmProviderConfigurationError(
				'adapter-key-mismatch',
				path,
				hasEndpoint
					? 'endpoint descriptors require the openai-compatible adapter key'
					: 'the openai-compatible adapter requires an endpoint descriptor'
			);
		}
	}
};

const validateAIConfig = (config: BoltHostConfig): void => {
	validateRegistry('language', config.ai.models);
	validateRegistry('embedding', config.ai.embeddingModels);

	if (!Object.prototype.hasOwnProperty.call(config.ai.models, config.ai.defaultModel)) {
		throw new LlmProviderConfigurationError(
			'invalid-default',
			'ai.defaultModel',
			'defaultModel must name a language model registry key'
		);
	}
	if (
		!Object.prototype.hasOwnProperty.call(
			config.ai.embeddingModels,
			config.ai.defaultEmbeddingModel
		)
	) {
		throw new LlmProviderConfigurationError(
			'invalid-default',
			'ai.defaultEmbeddingModel',
			'defaultEmbeddingModel must name an embedding model registry key'
		);
	}

	for (const key of Object.keys(config.ai.models)) {
		if (Object.prototype.hasOwnProperty.call(config.ai.embeddingModels, key)) {
			throw new LlmProviderConfigurationError(
				'registry-kind-mismatch',
				`ai.models.${key}`,
				'a registry key cannot be both a language and embedding model'
			);
		}
	}
};

/** Defines and validates the one authored host configuration shape. */
export function defineBoltHost<
	const TLanguageModels extends ProviderRegistry,
	const TEmbeddingModels extends ProviderRegistry
>(
	config: ColonyBoltHostConfig<TLanguageModels, TEmbeddingModels>
): ColonyBoltHostConfig<TLanguageModels, TEmbeddingModels>;
export function defineBoltHost<
	const TLanguageModels extends ProviderRegistry,
	const TEmbeddingModels extends ProviderRegistry
>(
	config: SelfHostedBoltHostConfig<TLanguageModels, TEmbeddingModels>
): SelfHostedBoltHostConfig<TLanguageModels, TEmbeddingModels>;
export function defineBoltHost(config: BoltHostConfig): BoltHostConfig {
	validateAIConfig(config);
	return config;
}
