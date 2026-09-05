import { Schema } from 'effect';
import type { EnvironmentReference as AuthoredEnvironmentReference } from './authoring/workspace-schema.js';

const isObject = Schema.is(
	Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
);
const isString = Schema.is(Schema.String);

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;
const DESCRIPTOR_KEYS = new Set(['model', 'apiKey', 'endpoint']);

export type EnvironmentReference<TName extends string = string> = AuthoredEnvironmentReference &
	Readonly<{
		readonly env: TName;
	}>;

export type LlmProviderEndpoint<TEnvironmentName extends string = string> =
	string | EnvironmentReference<TEnvironmentName>;

/**
 * Provider-neutral authored model connection. The registry key supplies the adapter name; this
 * value carries only provider model identity and references needed to establish that connection.
 * A hosted adapter names a credential and no endpoint; an OpenAI-compatible one names an endpoint.
 */
export type LlmProviderDescriptor<
	TModel extends string = string,
	TCredentialEnvironment extends string = string,
	TEndpointEnvironment extends string = string
> =
	| Readonly<{
			readonly model: TModel;
			readonly apiKey: EnvironmentReference<TCredentialEnvironment>;
			readonly endpoint?: never;
	  }>
	| Readonly<{
			readonly model: TModel;
			readonly apiKey?: EnvironmentReference<TCredentialEnvironment>;
			readonly endpoint: LlmProviderEndpoint<TEndpointEnvironment>;
	  }>;

type LlmProviderConfigurationErrorCode =
	| 'unsupported-option'
	| 'invalid-model'
	| 'invalid-environment-reference'
	| 'invalid-endpoint'
	| 'invalid-registry-key'
	| 'model-key-mismatch'
	| 'adapter-key-mismatch'
	| 'invalid-default'
	| 'registry-kind-mismatch';

export class LlmProviderConfigurationError extends Error {
	readonly name = 'LlmProviderConfigurationError';
	readonly code: LlmProviderConfigurationErrorCode;
	readonly path: string;

	constructor(code: LlmProviderConfigurationErrorCode, path: string, message: string) {
		super(`${path}: ${message}`);
		this.code = code;
		this.path = path;
	}
}

const fail = (code: LlmProviderConfigurationErrorCode, path: string, message: string): never => {
	throw new LlmProviderConfigurationError(code, path, message);
};

const validateEnvironmentReference = (reference: EnvironmentReference, path: string): void => {
	if (
		!isObject(reference) ||
		Object.keys(reference).length !== 1 ||
		!isString(reference.env) ||
		!ENVIRONMENT_NAME.test(reference.env)
	) {
		fail(
			'invalid-environment-reference',
			path,
			'environment references must be exactly { env: "UPPER_SNAKE_CASE" }'
		);
	}
};

const parseLiteralEndpoint = (endpoint: string, path: string): URL => {
	try {
		return new URL(endpoint);
	} catch {
		/* best effort */
		return fail('invalid-endpoint', path, 'literal endpoints must be absolute HTTP(S) URLs');
	}
};

const validateLiteralEndpoint = (endpoint: string, path: string): void => {
	const parsed = parseLiteralEndpoint(endpoint, path);

	if (
		(parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
		parsed.hostname.length === 0 ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.search.length > 0 ||
		parsed.hash.length > 0
	) {
		fail(
			'invalid-endpoint',
			path,
			'literal endpoints require HTTP(S), a host, and no credentials, query, or fragment'
		);
	}
};

/**
 * Defines and validates one provider-neutral model descriptor. It deliberately creates no SDK
 * client, Effect Layer, retry policy, pricing object, or runtime Task state.
 */
export const llm_provider = <const TDescriptor extends LlmProviderDescriptor>(
	descriptor: TDescriptor &
		Readonly<Record<Exclude<keyof TDescriptor, 'model' | 'apiKey' | 'endpoint'>, never>>
): TDescriptor => {
	for (const key of Object.keys(descriptor)) {
		if (!DESCRIPTOR_KEYS.has(key)) {
			fail('unsupported-option', `llm_provider.${key}`, 'unsupported provider option');
		}
	}

	if (
		!isString(descriptor.model) ||
		descriptor.model.trim() !== descriptor.model ||
		descriptor.model.length === 0 ||
		descriptor.model.split('/').some((segment) => segment.length === 0 || /\s/.test(segment))
	) {
		fail(
			'invalid-model',
			'llm_provider.model',
			'model must be a non-empty slash-delimited provider model identifier without whitespace'
		);
	}

	const ownsEndpoint = Object.prototype.hasOwnProperty.call(descriptor, 'endpoint');
	if (ownsEndpoint && descriptor.endpoint === undefined) {
		fail('invalid-endpoint', 'llm_provider.endpoint', 'endpoint cannot be undefined');
	}

	if (descriptor.endpoint === undefined) {
		if (descriptor.apiKey === undefined) {
			fail(
				'invalid-environment-reference',
				'llm_provider.apiKey',
				'hosted adapters require an environment credential reference'
			);
		}
		validateEnvironmentReference(descriptor.apiKey, 'llm_provider.apiKey');
		return descriptor;
	}

	if (descriptor.apiKey !== undefined) {
		validateEnvironmentReference(descriptor.apiKey, 'llm_provider.apiKey');
	}
	if (isString(descriptor.endpoint)) {
		validateLiteralEndpoint(descriptor.endpoint, 'llm_provider.endpoint');
	} else {
		validateEnvironmentReference(descriptor.endpoint, 'llm_provider.endpoint');
	}

	return descriptor;
};
