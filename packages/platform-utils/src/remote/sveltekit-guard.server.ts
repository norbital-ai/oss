import {
	applyRemoteMiddleware,
	isNonSchemaFunction,
	NoArgRemoteInputSchema,
	type MaybePromise,
	type Middleware,
	type RemoteLiveGeneratorReturn,
	type RemoteSchemaInput,
	type RemoteSchemaOutput
} from './protocol.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
	InvalidField,
	RemoteCommand,
	RemoteForm,
	RemoteFormInput,
	RemoteLiveQueryFunction,
	RemoteQueryFunction
} from '@sveltejs/kit';

export type GuardWrapHandler = <I, O>(
	middleware: readonly Middleware[],
	handler: (input: I) => MaybePromise<O>
) => (input: I) => MaybePromise<O>;

export type SvelteKitQueryBindings = {
	<Output>(handler: () => MaybePromise<Output>): RemoteQueryFunction<void, Output, void>;
	<Schema extends StandardSchemaV1, Output>(
		schema: Schema,
		handler: (input: RemoteSchemaOutput<Schema>) => MaybePromise<Output>
	): RemoteQueryFunction<RemoteSchemaInput<Schema>, Output, RemoteSchemaOutput<Schema>>;
	live<Output>(
		generator: () => RemoteLiveGeneratorReturn<Output>
	): RemoteLiveQueryFunction<void, Output>;
	live<Schema extends StandardSchemaV1, Output>(
		schema: Schema,
		generator: (input: RemoteSchemaOutput<Schema>) => RemoteLiveGeneratorReturn<Output>
	): RemoteLiveQueryFunction<RemoteSchemaInput<Schema>, Output, RemoteSchemaOutput<Schema>>;
};

export type SvelteKitRemoteBindings = {
	command: {
		<Output>(handler: () => MaybePromise<Output>): RemoteCommand<void, Output>;
		<Schema extends StandardSchemaV1, Output>(
			schema: Schema,
			handler: (input: RemoteSchemaOutput<Schema>) => MaybePromise<Output>
		): RemoteCommand<RemoteSchemaInput<Schema>, Output>;
	};
	query: SvelteKitQueryBindings;
	form: {
		<Schema extends StandardSchemaV1<RemoteFormInput, Record<string, unknown>>, Output>(
			schema: Schema,
			handler: (
				data: RemoteSchemaOutput<Schema>,
				issue: InvalidField<RemoteSchemaInput<Schema>>
			) => MaybePromise<Output>
		): RemoteForm<RemoteSchemaInput<Schema>, Output>;
		<Output>(
			mode: 'unchecked',
			handler: (data: RemoteFormInput) => MaybePromise<Output>
		): RemoteForm<RemoteFormInput, Output>;
	};
};

export interface SvelteKitGuardInstance {
	readonly middleware: readonly Middleware[];
	use(mw: Middleware): SvelteKitGuardInstance;
	command<Output>(handler: () => MaybePromise<Output>): RemoteCommand<void, Output>;
	command<Schema extends StandardSchemaV1, Output>(
		schema: Schema,
		handler: (input: RemoteSchemaOutput<Schema>) => MaybePromise<Output>
	): RemoteCommand<RemoteSchemaInput<Schema>, Output>;
	query<Output>(handler: () => MaybePromise<Output>): RemoteQueryFunction<void, Output, void>;
	query<Schema extends StandardSchemaV1, Output>(
		schema: Schema,
		handler: (input: RemoteSchemaOutput<Schema>) => MaybePromise<Output>
	): RemoteQueryFunction<RemoteSchemaInput<Schema>, Output, RemoteSchemaOutput<Schema>>;
	live<Output>(
		generator: () => RemoteLiveGeneratorReturn<Output>
	): RemoteLiveQueryFunction<void, Output>;
	live<Schema extends StandardSchemaV1, Output>(
		schema: Schema,
		generator: (input: RemoteSchemaOutput<Schema>) => RemoteLiveGeneratorReturn<Output>
	): RemoteLiveQueryFunction<RemoteSchemaInput<Schema>, Output, RemoteSchemaOutput<Schema>>;
	form<Schema extends StandardSchemaV1<RemoteFormInput, Record<string, unknown>>, Output>(
		schema: Schema,
		handler: (
			data: RemoteSchemaOutput<Schema>,
			issue: InvalidField<RemoteSchemaInput<Schema>>
		) => MaybePromise<Output>
	): RemoteForm<RemoteSchemaInput<Schema>, Output>;
	form<Output>(
		mode: 'unchecked',
		handler: (data: RemoteFormInput) => MaybePromise<Output>
	): RemoteForm<RemoteFormInput, Output>;
}

export interface SvelteKitGuardConstructor {
	new (middleware: readonly Middleware[]): SvelteKitGuardInstance;
	init(): SvelteKitGuardInstance;
}

export function createSvelteKitGuard(
	bindings: SvelteKitRemoteBindings,
	wrapHandler: GuardWrapHandler = applyRemoteMiddleware
): { Guard: SvelteKitGuardConstructor } {
	const { command, form, query } = bindings;

	const wrapWithMiddleware = <I, O>(
		middleware: readonly Middleware[],
		handler: (input: I) => MaybePromise<O>
	): ((input: I) => MaybePromise<O>) => wrapHandler(middleware, handler);

	class SvelteKitGuard implements SvelteKitGuardInstance {
		constructor(readonly middleware: readonly Middleware[]) {}

		static init(): SvelteKitGuardInstance {
			return new SvelteKitGuard([]);
		}

		use(mw: Middleware): SvelteKitGuardInstance {
			return new SvelteKitGuard([...this.middleware, mw]);
		}

		command<Output>(handler: () => MaybePromise<Output>): RemoteCommand<void, Output>;
		command<Schema extends StandardSchemaV1, Output>(
			schema: Schema,
			handler: (input: RemoteSchemaOutput<Schema>) => MaybePromise<Output>
		): RemoteCommand<RemoteSchemaInput<Schema>, Output>;
		command<Schema extends StandardSchemaV1, Output>(
			schemaOrHandler: Schema | (() => MaybePromise<Output>),
			handler?: (input: RemoteSchemaOutput<Schema>) => MaybePromise<Output>
		): RemoteCommand<void, Output> | RemoteCommand<RemoteSchemaInput<Schema>, Output> {
			if (typeof schemaOrHandler === 'function') {
				if (isNonSchemaFunction(schemaOrHandler)) {
					const wrapped = wrapWithMiddleware(this.middleware, schemaOrHandler);
					return command(NoArgRemoteInputSchema, () => wrapped(undefined as void));
				}
				return command(schemaOrHandler as Schema, wrapWithMiddleware(this.middleware, handler!));
			}
			return command(schemaOrHandler, wrapWithMiddleware(this.middleware, handler!));
		}

		query<Output>(handler: () => MaybePromise<Output>): RemoteQueryFunction<void, Output, void>;
		query<Schema extends StandardSchemaV1, Output>(
			schema: Schema,
			handler: (input: RemoteSchemaOutput<Schema>) => MaybePromise<Output>
		): RemoteQueryFunction<RemoteSchemaInput<Schema>, Output, RemoteSchemaOutput<Schema>>;
		query<Schema extends StandardSchemaV1, Output>(
			schemaOrHandler: Schema | (() => MaybePromise<Output>),
			handler?: (input: RemoteSchemaOutput<Schema>) => MaybePromise<Output>
		):
			| RemoteQueryFunction<void, Output, void>
			| RemoteQueryFunction<RemoteSchemaInput<Schema>, Output, RemoteSchemaOutput<Schema>> {
			if (typeof schemaOrHandler === 'function') {
				if (isNonSchemaFunction(schemaOrHandler)) {
					const wrapped = wrapWithMiddleware(this.middleware, schemaOrHandler);
					return query(NoArgRemoteInputSchema, () => wrapped(undefined as void));
				}
				return query(schemaOrHandler as Schema, wrapWithMiddleware(this.middleware, handler!));
			}
			return query(schemaOrHandler, wrapWithMiddleware(this.middleware, handler!));
		}

		live<Output>(
			generator: () => RemoteLiveGeneratorReturn<Output>
		): RemoteLiveQueryFunction<void, Output>;
		live<Schema extends StandardSchemaV1, Output>(
			schema: Schema,
			generator: (input: RemoteSchemaOutput<Schema>) => RemoteLiveGeneratorReturn<Output>
		): RemoteLiveQueryFunction<RemoteSchemaInput<Schema>, Output, RemoteSchemaOutput<Schema>>;
		live<Schema extends StandardSchemaV1, Output>(
			schemaOrGenerator: Schema | (() => RemoteLiveGeneratorReturn<Output>),
			generator?: (input: RemoteSchemaOutput<Schema>) => RemoteLiveGeneratorReturn<Output>
		):
			| RemoteLiveQueryFunction<void, Output>
			| RemoteLiveQueryFunction<RemoteSchemaInput<Schema>, Output, RemoteSchemaOutput<Schema>> {
			if (typeof schemaOrGenerator === 'function' && isNonSchemaFunction(schemaOrGenerator)) {
				const wrapped = wrapWithMiddleware(this.middleware, schemaOrGenerator);
				return query.live(NoArgRemoteInputSchema, () => wrapped(undefined as void));
			}
			return query.live(
				schemaOrGenerator as Schema,
				wrapWithMiddleware(
					this.middleware,
					generator as (input: RemoteSchemaOutput<Schema>) => RemoteLiveGeneratorReturn<Output>
				)
			);
		}

		form<Schema extends StandardSchemaV1<RemoteFormInput, Record<string, unknown>>, Output>(
			schema: Schema,
			handler: (
				data: RemoteSchemaOutput<Schema>,
				issue: InvalidField<RemoteSchemaInput<Schema>>
			) => MaybePromise<Output>
		): RemoteForm<RemoteSchemaInput<Schema>, Output>;
		form<Output>(
			mode: 'unchecked',
			handler: (data: RemoteFormInput) => MaybePromise<Output>
		): RemoteForm<RemoteFormInput, Output>;
		form<Schema extends StandardSchemaV1<RemoteFormInput, Record<string, unknown>>, Output>(
			schemaOrMode: Schema | 'unchecked',
			handler:
				| ((
						data: RemoteSchemaOutput<Schema>,
						issue: InvalidField<RemoteSchemaInput<Schema>>
				  ) => MaybePromise<Output>)
				| ((data: RemoteFormInput) => MaybePromise<Output>)
		): RemoteForm<RemoteFormInput, Output> | RemoteForm<RemoteSchemaInput<Schema>, Output> {
			if (schemaOrMode === 'unchecked') {
				const wrapped = wrapWithMiddleware(
					this.middleware,
					handler as (data: RemoteFormInput) => MaybePromise<Output>
				);
				return form('unchecked', (data) => wrapped(data));
			}
			return form(schemaOrMode, (data, issue) => {
				const guarded = wrapWithMiddleware(this.middleware, (input: typeof data) =>
					(
						handler as (
							input: typeof data,
							formIssue: InvalidField<RemoteSchemaInput<Schema>>
						) => MaybePromise<Output>
					)(input, issue)
				);
				return guarded(data);
			});
		}
	}

	return { Guard: SvelteKitGuard };
}
