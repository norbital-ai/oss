import { requireWorkspaceAuth } from '$lib/server/bootstrap/workspace_store.js';
import {
	applyRemoteMiddleware,
	type MaybePromise,
	type Middleware
} from '@norbital-ai/platform-utils/remote';
import { error } from '$lib/server/http.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';

export type { MaybePromise, Middleware };

export function requireAuthMiddleware(): Middleware {
	return {
		apply<I, O>(next: (input: I) => MaybePromise<O>) {
			return (input: I) => {
				requireWorkspaceAuth();
				return next(input);
			};
		}
	};
}

type RemoteInput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferInput<Schema>;
type RemoteOutput<Schema extends StandardSchemaV1> = StandardSchemaV1.InferOutput<Schema>;

export class Guard {
	private constructor(readonly middleware: readonly Middleware[]) {}

	static init(): Guard {
		return new Guard([]);
	}

	use(middleware: Middleware): Guard {
		return new Guard([...this.middleware, middleware]);
	}

	command<Schema extends StandardSchemaV1, Output>(
		schema: Schema,
		handler: (input: RemoteOutput<Schema>) => MaybePromise<Output>
	): (input: RemoteInput<Schema>) => Promise<Output>;
	command<Schema extends StandardSchemaV1, Output>(
		schema: Schema,
		handler: (input: RemoteOutput<Schema>) => MaybePromise<Output>
	): (input: RemoteInput<Schema>) => Promise<Output> {
		const wrapped = wrapWithRemoteErrorHandling(this.middleware, handler);
		return async (input) => {
			const validation = await schema['~standard'].validate(input);
			if (validation.issues?.length || !('value' in validation)) {
				error(400, validation.issues?.[0]?.message ?? 'Invalid remote input');
			}
			return wrapped(validation.value);
		};
	}

	query<Schema extends StandardSchemaV1, Output>(
		schema: Schema,
		handler: (input: RemoteOutput<Schema>) => MaybePromise<Output>
	): (input: RemoteInput<Schema>) => Promise<Output>;
	query<Schema extends StandardSchemaV1, Output>(
		schema: Schema,
		handler: (input: RemoteOutput<Schema>) => MaybePromise<Output>
	): (input: RemoteInput<Schema>) => Promise<Output> {
		return this.command(schema, handler);
	}
}

function wrapWithRemoteErrorHandling<I = void, O = unknown>(
	middleware: readonly Middleware[],
	handler: (input: I) => MaybePromise<O>
): (input: I) => Promise<O> {
	const wrapped = applyRemoteMiddleware(middleware, handler);
	return async (input: I) => {
		try {
			return await wrapped(input);
		} catch (err) {
			throwRemoteError(err);
		}
	};
}

const httpErrorSchema = z.object({
	status: z.number(),
	body: z.object({ message: z.unknown() }).passthrough().optional(),
	message: z.unknown().optional()
});

function throwRemoteError(err: unknown): never {
	const parsed = httpErrorSchema.safeParse(err);
	if (parsed.success) {
		const { status, body, message: topLevelMessage } = parsed.data;
		const bodyMessage = body?.message;
		const message =
			typeof bodyMessage === 'string'
				? bodyMessage
				: typeof topLevelMessage === 'string'
					? topLevelMessage
					: 'Remote operation failed';
		error(status, message);
	}
	throw err;
}
