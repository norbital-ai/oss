import { z } from 'zod';
import type { StandardSchemaV1 } from '@standard-schema/spec';

export type MaybePromise<T> = T | Promise<T>;

export interface Middleware {
	apply<I, O>(next: (input: I) => MaybePromise<O>): (input: I) => MaybePromise<O>;
}

export type RemoteLiveGeneratorReturn<Output> = MaybePromise<
	| AsyncGenerator<Output>
	| AsyncIterator<Output>
	| AsyncIterable<Output>
	| Generator<Output>
	| Iterator<Output>
	| Iterable<Output>
>;

export const NoArgRemoteInputSchema = z.void();

// stupidity:allow R5b -- canonical public guard distinguishes handlers from Standard Schema functions
export function isNonSchemaFunction(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === 'function' && !('~standard' in (value as object));
}

export function applyRemoteMiddleware<I, O>(
	middleware: readonly Middleware[],
	handler: (input: I) => MaybePromise<O>
): (input: I) => MaybePromise<O> {
	let wrapped = handler;
	for (let i = middleware.length - 1; i >= 0; i--) {
		wrapped = middleware[i].apply(wrapped);
	}
	return wrapped;
}

export type { Middleware as RemoteMiddleware };
export type RemoteSchemaInput<Schema extends StandardSchemaV1> =
	StandardSchemaV1.InferInput<Schema>;
export type RemoteSchemaOutput<Schema extends StandardSchemaV1> =
	StandardSchemaV1.InferOutput<Schema>;
