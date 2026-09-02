import { Effect, Schema } from 'effect';
import { getErrorMessage } from '../error/index.js';

/**
 * Failure from the owned HTTP request helper. Call sites map this into a domain tagged error
 * rather than inventing a second fetch wrapper.
 */
export class HttpFailure extends Schema.TaggedError<HttpFailure>()('Std.HttpFailure', {
	operation: Schema.String,
	status: Schema.optionalKey(Schema.Number),
	reason: Schema.String
}) {
	readonly message =
		this.status === undefined
			? `${this.operation}: ${this.reason}`
			: `${this.operation} (${this.status}): ${this.reason}`;
}

export type HttpRequestOptions = Readonly<{
	readonly operation?: string;
	readonly init?: NonNullable<Parameters<typeof globalThis.fetch>[1]>;
	readonly transport?: typeof globalThis.fetch;
}>;

/**
 * The one place production code may reach `globalThis.fetch`. Callers receive a typed Effect
 * and never write `fetch(` themselves.
 */
export const httpRequest = (
	input: Parameters<typeof globalThis.fetch>[0],
	options: HttpRequestOptions = {}
): Effect.Effect<Response, HttpFailure> => {
	const transport = options.transport ?? globalThis.fetch;
	const operation = options.operation ?? 'request';
	return Effect.tryPromise({
		try: (signal) => transport(input, { ...options.init, signal: options.init?.signal ?? signal }),
		catch: (cause) =>
			new HttpFailure({
				operation,
				reason: getErrorMessage(cause)
			})
	});
};
