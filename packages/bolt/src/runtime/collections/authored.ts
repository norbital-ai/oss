import { Context, Effect, Schema } from 'effect';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import type { AuthoredIntegrationModule } from '../../authoring/integration-introspection.js';
import type { Identity, Subject } from '../identity/identity.js';
import type { Collections } from './collections.js';
import type { AI, Files } from '../facilities/services.js';

/**
 * The runtime carrier for a workspace's authored business logic.
 *
 * Hooks, pipelines, and automations are imported live into the artifact and handed to the runtime
 * here, exactly as remotes and tools are. The carrier is deliberately runtime-shaped — plain
 * objects with `handler` functions — so a compiled workspace's modules arrive without any schema
 * ceremony: the authoring *types* in `@norbital-ai/bolt/authoring` are the compile-time contract,
 * and this is where those shapes are read at run time.
 */

/** One authored hook point: an optional description and the handler the runtime invokes. */
export type AuthoredHookPoint = Readonly<{
	readonly description?: string;
	readonly handler: (context: unknown, api: unknown) => unknown;
}>;

export type AuthoredHookPhase = AuthoredHookPoint & {
	readonly batchHandler?: (context: unknown, api: unknown) => unknown;
};

export type AuthoredCollectionHookModule = Readonly<{
	readonly create?: Readonly<{ readonly input?: Schema.Codec<unknown, unknown>; readonly before?: AuthoredHookPhase; readonly after?: AuthoredHookPhase }>;
	readonly update?: Readonly<{ readonly input?: Schema.Codec<unknown, unknown>; readonly before?: AuthoredHookPoint; readonly after?: AuthoredHookPoint }>;
	readonly delete?: Readonly<{ readonly before?: AuthoredHookPoint; readonly after?: AuthoredHookPoint }>;
}>;

export type AuthoredPipelineModule = Readonly<{
	readonly export?: Readonly<{ readonly description: string; readonly handler: (context: unknown, api: unknown) => unknown }>;
	readonly import?: Readonly<{ readonly description: string; readonly input?: Schema.Codec<unknown, unknown>; readonly handler: (context: unknown, api: unknown) => unknown }>;
}>;

export type AuthoredAutomationModule = Readonly<{
	readonly name: string;
	readonly trigger: Readonly<{ readonly _tag: 'Schedule'; readonly cron: string } | { readonly _tag: 'Change'; readonly collection: string; readonly event: 'created' | 'updated' | 'deleted' }>;
	readonly handler: (api: unknown, context: unknown) => unknown;
}>;

/** Everything a workspace authored, carried beside the declaration so the runtime can run it. */
export type AuthoredRuntime = Readonly<{
	readonly hooks: Readonly<Record<string, AuthoredCollectionHookModule>>;
	readonly pipelines: Readonly<Record<string, AuthoredPipelineModule>>;
	readonly automations: Readonly<Record<string, AuthoredAutomationModule>>;
	/**
	 * The live half of every `+integrations.ts`, keyed by `<collection>.<integration>`.
	 *
	 * A binding's record schema and its identity reader are a `Schema.Codec` and a closure. Neither
	 * survives the JSON the workspace definition is, so the declaration carries the request and this
	 * carries the parts that have to be called.
	 */
	readonly integrations: Readonly<Record<string, AuthoredIntegrationModule>>;
}>;

export const emptyAuthoredRuntime: AuthoredRuntime = { hooks: {}, pipelines: {}, automations: {}, integrations: {} };

/** Identifies the authored-runtime carrier in Effect's context so wiring remains explicit and type checked. */
export const AuthoredRuntimeService = Context.Service<AuthoredRuntime>('@norbital-ai/bolt/AuthoredRuntime');

/**
 * Resolves one authored handler result to an Effect.
 *
 * The authoring surface admits `Effect | Promise | value` so an author eases in from either world;
 * everything lands in Effect here, before any hook, pipeline, or automation is composed.
 */
export const runAuthoredHandler = <A>(result: A | Promise<A> | Effect.Effect<A>): Effect.Effect<A> =>
	Effect.isEffect(result)
		? result
		: result instanceof Promise
			? // `catch` matters: the bare one-argument form wraps a rejection in `UnknownError`, whose
				// message is the literal "An error occurred in Effect.tryPromise". Whatever the authored
				// handler actually threw is the only useful part of the failure, so it is what survives.
				// `orDie` keeps the original contract — a rejected authored handler is a defect, not a
				// typed failure — while `catch` ensures the defect carries what the handler actually
				// threw rather than Effect's generic wrapper.
				Effect.tryPromise({
					try: () => result,
					catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause)))
				}).pipe(Effect.orDie)
			: Effect.succeed(result);

/** The collection operations an authored api can reach, bound by the runtime to the current invocation. */
export type AuthoredCollectionOps = Readonly<{
	readonly findMany: (collection: string, input: Readonly<Record<string, unknown>>) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, unknown, never>;
	readonly findFirst: (collection: string, input: Readonly<Record<string, unknown>>) => Effect.Effect<Readonly<Record<string, unknown>> | undefined, unknown, never>;
	readonly count: (collection: string, input: Readonly<Record<string, unknown>>) => Effect.Effect<number, unknown, never>;
	readonly findNearest: (collection: string, input: Readonly<Record<string, unknown>>) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, unknown, never>;
	readonly create: (collection: string, id: string, values: Readonly<Record<string, Schema.Json>>) => Effect.Effect<Readonly<Record<string, unknown>>, unknown, never>;
	readonly update: (collection: string, id: string, values: Readonly<Record<string, Schema.Json>>) => Effect.Effect<Readonly<Record<string, unknown>>, unknown, never>;
	readonly delete: (collection: string, id: string) => Effect.Effect<void, unknown, never>;
	readonly mutate: (collection: string, payloads: ReadonlyArray<Readonly<Record<string, unknown>>>) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, unknown, never>;
	readonly approvalFindMany: (input: Readonly<Record<string, unknown>>) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, unknown, never>;
	readonly approvalFindFirst: (input: Readonly<Record<string, unknown>>) => Effect.Effect<Readonly<Record<string, unknown>> | undefined, unknown, never>;
	readonly infer: (input: Readonly<{ readonly schema: Schema.Codec<unknown, unknown>; readonly prompt: string; readonly model?: string }>) => Effect.Effect<unknown, unknown, never>;
	readonly readFileAsset: (assetId: string) => Effect.Effect<{ readonly id: string; readonly name: string; readonly mimeType: string | null; readonly size: number; readonly bytes: Uint8Array }, unknown, never>;
}>;

const asQueryInput = (input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => input;

/**
 * Builds the Effect-native api an authored handler receives.
 *
 * Every method returns an Effect bound to the invocation's effect id and subject, so authored
 * business logic composes with `Effect.gen` — the same shape the authoring types declare.
 */
export const makeAuthoringApi = (
	ops: AuthoredCollectionOps,
	options: { readonly elevated?: boolean } = {}
): unknown => {
	const collectionApi = (collection: string): Readonly<Record<string, unknown>> => ({
		findMany: (input: Readonly<Record<string, unknown>> = {}) => ops.findMany(collection, asQueryInput(input)),
		findFirst: (input: Readonly<Record<string, unknown>> = {}) => ops.findFirst(collection, asQueryInput(input)),
		count: (input: Readonly<Record<string, unknown>> = {}) => ops.count(collection, asQueryInput(input)),
		findNearest: (input: Readonly<Record<string, unknown>>) => ops.findNearest(collection, asQueryInput(input)),
		create: (input: Readonly<Record<string, unknown>>) => {
			const identifier = typeof input['norbital_id'] === 'string' ? input['norbital_id'] : globalThis.crypto.randomUUID();
			return ops.create(collection, identifier, input as Readonly<Record<string, Schema.Json>>);
		},
		update: (id: string, input: Readonly<Record<string, unknown>>) => ops.update(collection, id, input as Readonly<Record<string, Schema.Json>>),
		...(options.elevated === true
			? {
					mutate: (payloads: ReadonlyArray<Readonly<Record<string, unknown>>>) => ops.mutate(collection, payloads),
					delete: (identifiers: ReadonlyArray<string>) => ops.delete(collection, identifiers[0] ?? '')
				}
			: {})
	});
	const query = new Proxy<Readonly<Record<string, unknown>>>({}, {
		get: (_target, property) =>
			property === 'approval_request'
				? {
						findMany: (input: Readonly<Record<string, unknown>> = {}) => ops.approvalFindMany(asQueryInput(input)),
						findFirst: (input: Readonly<Record<string, unknown>> = {}) => ops.approvalFindFirst(asQueryInput(input))
					}
				: typeof property === 'string'
					? collectionApi(property)
					: undefined
	});
	const database = new Proxy<Readonly<Record<string, unknown>>>({}, {
		get: (_target, property) =>
			property === 'query' ? query : typeof property === 'string' ? collectionApi(property) : undefined
	});
	return {
		db: database,
		infer: (input: Readonly<{ readonly schema: Schema.Codec<unknown, unknown>; readonly prompt: string; readonly model?: string }>) => ops.infer(input),
		readFileAsset: (assetId: string) => ops.readFileAsset(assetId)
	};
};

/** Binds the invocation-scoped authoring ops to the runtime services, for callers outside the collections layer. */
export const makeBoundAuthoringOps = (
	effectId: EffectIdType,
	subject: Subject,
	collections: Collections.Interface,
	ai: AI.Interface,
	files: Files.Interface
): AuthoredCollectionOps => {
	type QueryInput = Parameters<Collections.Interface['findMany']>[2];
	const query = (collection: string, input: Readonly<Record<string, unknown>>): QueryInput =>
		({ collection, ...input }) as QueryInput;
	return {
		findMany: (collection, input) =>
			collections.findMany(effectId, subject, query(collection, input)).pipe(
				Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)
			),
		findFirst: (collection, input) =>
			collections.findFirst(effectId, subject, query(collection, input)).pipe(
				Effect.map((row) => row as Readonly<Record<string, unknown>> | undefined)
			),
		count: (collection, input) => collections.count(effectId, subject, query(collection, input)),
		findNearest: (collection, input) =>
			collections.findMany(effectId, subject, query(collection, input)).pipe(
				Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)
			),
		create: (collection, id, values) =>
			Effect.gen(function* () {
				yield* collections.create(effectId, subject, { collection, id, values });
				const row = yield* collections.findFirst(effectId, subject, { collection, where: { norbital_id: { eq: id } } });
				return row === undefined
					? ({ norbital_id: id, ...values } as Readonly<Record<string, unknown>>)
					: (row as Readonly<Record<string, unknown>>);
			}),
		update: (collection, id, values) =>
			Effect.gen(function* () {
				yield* collections.update(effectId, subject, { collection, id, values });
				const row = yield* collections.findFirst(effectId, subject, { collection, where: { norbital_id: { eq: id } } });
				return row === undefined
					? ({ norbital_id: id, ...values } as Readonly<Record<string, unknown>>)
					: (row as Readonly<Record<string, unknown>>);
			}),
		delete: (collection, id) => collections.delete(effectId, subject, collection, id),
		mutate: (collection, payloads) =>
			Effect.all(
				payloads.map((payload) =>
					Effect.gen(function* () {
						const identifier = typeof payload['norbital_id'] === 'string' ? payload['norbital_id'] : globalThis.crypto.randomUUID();
						yield* collections.create(effectId, subject, {
							collection,
							id: identifier,
							values: payload as Readonly<Record<string, Schema.Json>>
						});
						const row = yield* collections.findFirst(effectId, subject, { collection, where: { norbital_id: { eq: identifier } } });
						return row === undefined
							? ({ norbital_id: identifier, ...payload } as Readonly<Record<string, unknown>>)
							: (row as Readonly<Record<string, unknown>>);
					})
				),
				{ concurrency: 'unbounded' }
			),
		approvalFindMany: (input) =>
			collections.findMany(effectId, subject, { collection: 'approval_request', ...input }).pipe(
				Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)
			),
		approvalFindFirst: (input) =>
			collections.findFirst(effectId, subject, { collection: 'approval_request', ...input }).pipe(
				Effect.map((row) => row as Readonly<Record<string, unknown>> | undefined)
			),
		infer: (input) =>
			ai.execute(effectId, {
				_tag: 'Turn',
				model: input.model ?? 'gpt-5',
				messages: [{ role: 'user', content: input.prompt }],
				tools: [],
				maxOutputTokens: 4_096
			}).pipe(Effect.map((response) => Schema.decodeUnknownSync(input.schema)(response.output))),
		readFileAsset: (assetId) =>
			files.execute(effectId, { _tag: 'Read', key: assetId }).pipe(
				Effect.map((response) => ({
					id: assetId,
					name: response.key ?? assetId,
					mimeType: null,
					size: (response.bytes ?? new Uint8Array()).byteLength,
					bytes: response.bytes ?? new Uint8Array()
				}))
			)
	};
};

