import type { RemoteQuery } from '$lib/client/remote-query.svelte.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { HandlerDefinition } from '../automations/handlers.js';

export type InvokeMap = Readonly<Record<string, HandlerDefinition>>;

type InvokeHandlerOutput<T extends HandlerDefinition> =
	T extends HandlerDefinition<StandardSchemaV1, 'query' | 'command', infer O> ? O : unknown;

/** Client-side tenant invoke handlers — queries return Pod reactive read results. */
export type InvokeClientApi<T extends InvokeMap> = {
	readonly [K in keyof T & string]: T[K] extends HandlerDefinition<infer S, 'query', infer O>
		? (input: StandardSchemaV1.InferInput<S>) => RemoteQuery<O>
		: T[K] extends HandlerDefinition<infer S, 'command', infer O>
			? (input: StandardSchemaV1.InferInput<S>) => Promise<O>
			: (
					input: StandardSchemaV1.InferInput<StandardSchemaV1>
				) => RemoteQuery<InvokeHandlerOutput<T[K]>>;
};
