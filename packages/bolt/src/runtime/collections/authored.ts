// repository-health:allow SEM_PARALLEL -- authored facade consumes the collections contract leaf; the pair is linked through collections.contract, not parallel.
import { Context, Duration, Effect, Option, Result, Schema } from 'effect';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import { AuthoredRefusal, refusalOf } from '#lib/authoring/refusal.js';
import type { AutomationProgression } from '#lib/authoring/automations-schema.js';
import type { FileRef } from '#lib/authoring/models-schema.js';
import type { AuthoredIntegrationModule } from '#lib/authoring/integration-introspection.js';
import type { PolicyRuntimeFunction } from '#lib/authoring/policy-introspection.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import type { Subject } from '#lib/runtime/identity/identity.js';
import type { Interface as CollectionsInterface } from './collections.contract.js';
import type * as Automations from '#lib/runtime/automations/automations.js';
import type { AIInterface, FilesInterface } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';

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
type AuthoredHookPoint = Readonly<{
	readonly description?: string;
	readonly handler: (context: unknown, api: unknown) => unknown;
}>;

/** The per-record halves of one operation. Both run once per record, whatever the batch size. */
type AuthoredPerRecord = Readonly<{
	readonly before?: AuthoredHookPoint;
	readonly after?: AuthoredHookPoint;
}>;

export type AuthoredCollectionHookModule = Readonly<{
	/**
	 * The collection's declared write shape — `export const input` in its `+hooks.ts`, carried
	 * beside the default export rather than inside it.
	 *
	 * One input for one write. There used to be two, `create.input` and `update.input`, free to
	 * drift and describing the same operation; and neither could type the caller, because a hook
	 * property cannot be read without reading the hook. A standalone binding can.
	 */
	readonly input?: Schema.Codec<unknown, unknown>;
	readonly mutate?: Readonly<{
		/** Runs once for the batch; what it returns reaches every record's hooks as `prepared`. */
		readonly prepare?: (context: unknown, api: unknown) => unknown;
		readonly perRecord?: AuthoredPerRecord;
	}>;
	readonly delete?: Readonly<{
		readonly perRecord?: AuthoredPerRecord;
	}>;
}>;

type AuthoredPipelineModule = Readonly<{
	readonly export?: Readonly<{
		readonly description: string;
		readonly handler: (context: unknown, api: unknown) => unknown;
	}>;
	readonly import?: Readonly<{
		readonly description: string;
		readonly input?: Schema.Codec<unknown, unknown>;
		readonly handler: (context: unknown, api: unknown) => unknown;
	}>;
}>;

type AuthoredAutomationModule = Readonly<{
	readonly name: string;
	/** The automation's immutable authority, compiled from its own declaration. */
	readonly policies: ReadonlyArray<string>;
	readonly trigger: Readonly<
		| { readonly _tag: 'Schedule'; readonly cron: string }
		| { readonly _tag: 'Manual' }
		| {
				readonly _tag: 'Change';
				readonly collection: string;
				readonly event: 'created' | 'updated' | 'deleted';
		  }
	>;
	readonly input?: Schema.Codec<unknown, unknown>;
	readonly output?: Schema.Codec<unknown, unknown>;
	readonly handler: (api: unknown, context: unknown) => unknown;
}>;

/** Everything a workspace authored, carried beside the declaration so the runtime can run it. */
export type AuthoredRuntime = Readonly<{
	readonly hooks: Readonly<Record<string, AuthoredCollectionHookModule>>;
	readonly pipelines: Readonly<Record<string, AuthoredPipelineModule>>;
	readonly automations: Readonly<Record<string, AuthoredAutomationModule>>;
	/** Server-only write decisions. Their serializable policy grant carries only a derived marker. */
	readonly policyAuthorizations: Readonly<Record<string, PolicyRuntimeFunction>>;
	/** Server-only approval routers. Each call must return one branded concrete ApprovalFlow. */
	readonly approvalFlows: Readonly<Record<string, PolicyRuntimeFunction>>;
	/**
	 * The live half of every `+integrations.ts`, keyed by `<collection>.<integration>`.
	 *
	 * A binding's record schema and its identity reader are a `Schema.Codec` and a closure. Neither
	 * survives the JSON the workspace definition is, so the declaration carries the request and this
	 * carries the parts that have to be called.
	 */
	readonly integrations: Readonly<Record<string, AuthoredIntegrationModule>>;
}>;

export const emptyAuthoredRuntime: AuthoredRuntime = {
	hooks: {},
	pipelines: {},
	automations: {},
	policyAuthorizations: {},
	approvalFlows: {},
	integrations: {}
};

/** Identifies the authored-runtime carrier in Effect's context so wiring remains explicit and type checked. */
export const AuthoredRuntimeService = Context.Service<AuthoredRuntime>(
	'@norbital-ai/bolt/AuthoredRuntime'
);

/**
 * Either the refusal a cause carries, in the error channel, or the cause itself as a defect.
 *
 * This is the whole of the policy change in item 5, in one branch: a business rule becomes a typed
 * failure that `runtime/app.ts` can map to a 422 carrying the author's sentence, and everything
 * else keeps the contract it already had — an authored handler that genuinely broke is a defect,
 * because it is one.
 */
const raise = <A>(cause: unknown): Effect.Effect<A, AuthoredRefusal> => {
	const refusal = refusalOf(cause);
	return refusal === undefined ? Effect.die(cause) : Effect.fail(refusal);
};

/** Every result shape the authored surface admits, before the runtime settles it. */
// repository-health:allow EFF2 -- Authored JavaScript may return a thenable; runAuthoredHandler converts it into Effect immediately at this single boundary.
type AuthoredHandlerResult<A> = A | PromiseLike<A> | Effect.Effect<A>;

/** Recognises promises without tying authored code to this realm's `Promise` constructor. */
// repository-health:allow EFF2 -- The thenable predicate belongs to the same authored-JavaScript boundary and feeds only Effect.tryPromise below.
const isPromiseLike = <A>(value: AuthoredHandlerResult<A>): value is PromiseLike<A> => {
	if (value === null) return false;
	if (typeof value !== 'object' && typeof value !== 'function') return false;
	return typeof Reflect.get(value, 'then') === 'function';
};

/**
 * Resolves one authored handler to an Effect, with a refusal it threw in the error channel.
 *
 * The authoring surface admits `Effect | Promise | value` so an author eases in from either world;
 * everything lands in Effect here, before any hook, pipeline, or automation is composed.
 *
 * **It takes a thunk, not a result.** That is what makes the synchronous case reachable at all.
 * `refuse` throws, and the majority of authored handlers are plain functions — no `async`, no
 * `Effect.gen` — so the throw happens while the *argument* is being evaluated at the call site.
 * Passing `handler(context, api)` meant the throw escaped before this function was entered, past
 * every recovery written here, and out through whichever generator happened to be running. Passing
 * `() => handler(context, api)` moves the call inside `Effect.suspend`, where it can be caught.
 *
 * Three arrival paths, because a refusal can be raised from any world the surface admits:
 *
 * - a plain handler throws **synchronously**, caught by the `try` below;
 * - an async handler rejects its promise, caught by `Effect.tryPromise`;
 * - an `Effect.gen` handler throws inside the generator, which Effect converts to a **defect**
 *   before anyone else sees it, caught by `catchDefect`.
 */
export const runAuthoredHandler = <A>(
	handler: () => AuthoredHandlerResult<A>
): Effect.Effect<A, AuthoredRefusal> =>
	Effect.suspend((): Effect.Effect<A, AuthoredRefusal> => {
		const attempted = Result.try(handler);
		if (Result.isFailure(attempted)) return raise<A>(attempted.failure);
		const produced = attempted.success;
		if (Effect.isEffect(produced)) return produced.pipe(Effect.catchDefect(raise<A>));
		if (isPromiseLike(produced))
			return Effect.tryPromise({
				try: () => produced,
				catch: (cause) => cause
			}).pipe(Effect.catch(raise<A>));
		return Effect.succeed(produced);
	});

/** Read operations shared by authored handlers and policy decisions. */
export type AuthoringReadOps = Readonly<{
	/** Exact generic database members structurally visible to authored code. */
	readonly allowedCollections: ReadonlySet<string>;
	readonly findMany: (
		collection: string,
		input: Readonly<Record<string, unknown>>
	) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, unknown, never>;
	readonly findFirst: (
		collection: string,
		input: Readonly<Record<string, unknown>>
	) => Effect.Effect<Readonly<Record<string, unknown>> | undefined, unknown, never>;
	readonly count: (
		collection: string,
		input: Readonly<Record<string, unknown>>
	) => Effect.Effect<number, unknown, never>;
	/**
	 * Rows nearest a probe vector, closest first, each carrying the measured `distance`.
	 *
	 * A read like any other — same authorization, same row visibility, same field masking — which is
	 * why it sits with the reads rather than beside `mutate`. The ordering is the part that cannot be
	 * done anywhere else: only the database can answer it from the vector index.
	 */
	readonly findNearest: (
		collection: string,
		input: Readonly<Record<string, unknown>>
	) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, unknown, never>;
}>;

/** Every operation an ordinary authored handler can reach, bound to the current invocation. */
export type AuthoringOps = AuthoringReadOps &
	Readonly<{
		readonly mutate: (
			collection: string,
			values: Readonly<Record<string, unknown>>
		) => Effect.Effect<void, unknown, never>;
		/**
		 * Starts a declared automation in the current I/O flow, or waits until an explicit delay.
		 *
		 * The third door an author has, beside `{ schedule }` and `{ trigger }`, and the only one that
		 * says "from code". It is deliberately not a task API: a task is not a thing an author has, and
		 * a second way to start background work would compete with the automations the workspace already
		 * declares. With no `after`, the body begins here; with `after`, only the wait is scheduled.
		 */
		readonly runAutomation: (
			name: string,
			input: Schema.Json,
			options: Readonly<{ readonly after?: string | number }> | undefined
		) => Effect.Effect<{ readonly taskId: string }, unknown, never>;
		readonly infer: (input: InferenceRequest) => Effect.Effect<unknown, unknown, never>;
		readonly readFileAsset: (file: FileRef) => Effect.Effect<
			{
				readonly id: string;
				readonly name: string;
				readonly mimeType: string | null;
				readonly size: number;
				readonly bytes: Uint8Array;
			},
			unknown,
			never
		>;
	}>;

/** A preflight the runtime may place in front of an authored operation. */
type AuthoredOperationGuard = (operation: string) => Effect.Effect<void, unknown, never>;

/**
 * Places one guard immediately before every operation reachable through the authored API.
 *
 * Kept separate from `makeBoundAuthoringOps` deliberately: hooks, integrations, and remotes share
 * those bindings but do not belong to a cancellable automation task. Only automation dispatch wraps
 * its bound operations with this function.
 */
export const guardAuthoringOps = (
	ops: AuthoringOps,
	guard: AuthoredOperationGuard
): AuthoringOps => ({
	allowedCollections: ops.allowedCollections,
	findMany: (collection, input) =>
		guard(`db.${collection}.findMany`).pipe(Effect.andThen(ops.findMany(collection, input))),
	findFirst: (collection, input) =>
		guard(`db.${collection}.findFirst`).pipe(Effect.andThen(ops.findFirst(collection, input))),
	count: (collection, input) =>
		guard(`db.${collection}.count`).pipe(Effect.andThen(ops.count(collection, input))),
	findNearest: (collection, input) =>
		guard(`db.${collection}.findNearest`).pipe(Effect.andThen(ops.findNearest(collection, input))),
	mutate: (collection, values) =>
		guard(`db.${collection}.mutate`).pipe(Effect.andThen(ops.mutate(collection, values))),
	runAutomation: (name, input, options) =>
		guard(`automations.${name}.run`).pipe(Effect.andThen(ops.runAutomation(name, input, options))),
	infer: (input) => guard('ai.infer').pipe(Effect.andThen(ops.infer(input))),
	readFileAsset: (file) => guard('files.read').pipe(Effect.andThen(ops.readFileAsset(file)))
});

/**
 * What an authored `readFileAsset` answers with, and what an inference image is built from.
 *
 * `id` is the object store's key, which is the file's only identifier now — there is no second one.
 * It used to be a `document_asset` row id, and the gap between the two is exactly the bug this
 * shape closes: an id that named a row, a row that named a key, and an upload path that wrote the
 * key and never the row.
 */
type AuthoredFileAsset = Readonly<{
	readonly id: string;
	readonly name: string;
	readonly mimeType: string | null;
	readonly size: number;
	readonly bytes: Uint8Array;
}>;

/** One image an authored `api.infer` attached to its turn, taken straight from a `file()` column. */
type AuthoredInferenceImage = Readonly<{
	readonly file: FileRef;
	readonly detail?: 'auto' | 'low' | 'high';
}>;

/** Provider-neutral search controls carried from an authored inference to its host adapter. */
type AuthoredInferenceWebSearch = Readonly<{
	readonly maxResults: number;
	readonly allowedDomains?: ReadonlyArray<string>;
}>;

/**
 * One authored inference as the ops surface carries it: the schema the answer must decode to, and
 * the picture words to judge against.
 *
 * Named rather than inline because `AuthoringOps.infer` and the object literal behind the
 * authored `api.infer` must carry the same shape, and that shape is the contract between the
 * authoring surface and the AI facility.
 */
type InferenceRequest = Readonly<{
	readonly schema: Schema.Codec<unknown, unknown>;
	readonly prompt: string;
	readonly model?: string;
	readonly webSearch?: AuthoredInferenceWebSearch;
	readonly images?: ReadonlyArray<AuthoredInferenceImage>;
}>;

/** The Effect-native capability object supplied to authored handlers after invocation binding. */
export type RuntimeAuthoringApi = Readonly<{
	readonly db: object;
	readonly automations: Readonly<{
		readonly run: (
			name: string,
			input?: Schema.Json,
			options?: Readonly<{ readonly after?: string | number }>
		) => Effect.Effect<{ readonly taskId: string }, unknown, never>;
	}>;
	readonly infer: (input: InferenceRequest) => Effect.Effect<unknown, unknown, never>;
	readonly readFileAsset: (file: FileRef) => Effect.Effect<AuthoredFileAsset, unknown, never>;
}>;

/** The automation-only extension. Hooks and remotes receive `RuntimeAuthoringApi` and cannot emit. */
type RuntimeAutomationApi = RuntimeAuthoringApi &
	Readonly<{
		readonly progress: (value: AutomationProgression) => Effect.Effect<void, unknown, never>;
	}>;

/**
 * How much of a turn an authored `api.infer` may spend on pictures.
 *
 * Both are refusals, not truncations: a bound that silently dropped an image would leave the model
 * answering about a scene it was never shown, which reads exactly like it answering correctly.
 */
const MAX_INFERENCE_IMAGES = 8;
const MAX_INFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

/** Leaves grounded structured turns enough room to finish the required JSON instead of returning null. */
export const MAX_STRUCTURED_INFERENCE_OUTPUT_TOKENS = 8_192;

/**
 * Base64 over bytes, in chunks.
 *
 * `String.fromCharCode(...bytes)` is the one-liner and it is a stack overflow on anything the size
 * of a photograph — the spread becomes one argument per byte. Chunked, the argument count is
 * bounded whatever the file weighs.
 */
const base64 = (bytes: Uint8Array): string => {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
};

/**
 * The user turn `api.infer` sends, with the authored images attached to it.
 *
 * A prompt on its own is a plain string, which is what every provider means by a text-only turn. An
 * `images` list makes it the OpenAI-compatible content-part array the AI facility's gateway speaks,
 * with each asset inlined as a `data:` URL — the object store's keys are not reachable from the
 * provider's network, so a URL naming one would be fetched by nobody.
 *
 * The declaration sat in the authoring contract for a long time with nothing behind it: the turn was
 * built as `[{ role: 'user', content: prompt }]` and `images` was read nowhere, so a vision
 * automation asking a model to judge a photograph it never received answered confidently about
 * nothing at all.
 */
export const inferenceTurnContent = (
	prompt: string,
	images: ReadonlyArray<AuthoredInferenceImage> | undefined,
	readAsset: (file: FileRef) => Effect.Effect<AuthoredFileAsset, Database.FacilityError>
): Effect.Effect<Schema.Json, Database.FacilityError> =>
	Effect.gen(function* () {
		if (images === undefined || images.length === 0) return prompt;
		const refuse = (code: string, message: string) =>
			new Database.FacilityError({
				operation: 'ai.turn',
				code,
				message,
				retryable: false,
				outcome: 'known'
			});
		if (images.length > MAX_INFERENCE_IMAGES) {
			return yield* refuse(
				'ai.too_many_images',
				`An inference turn carries at most ${MAX_INFERENCE_IMAGES} images; ${images.length} were passed.`
			);
		}
		const parts: Array<Schema.Json> = [{ type: 'text', text: prompt }];
		let total = 0;
		for (const image of images) {
			const asset = yield* readAsset(image.file);
			if (asset.mimeType === null || !asset.mimeType.startsWith('image/')) {
				return yield* refuse(
					'ai.not_an_image',
					`${asset.name} is ${asset.mimeType ?? 'of unknown type'}, which is not an image.`
				);
			}
			total += asset.size;
			if (total > MAX_INFERENCE_IMAGE_BYTES) {
				return yield* refuse(
					'ai.images_too_large',
					`The images on one inference turn total more than ${MAX_INFERENCE_IMAGE_BYTES} bytes.`
				);
			}
			parts.push({
				type: 'image_url',
				image_url: {
					url: `data:${asset.mimeType};base64,${base64(asset.bytes)}`,
					detail: image.detail ?? 'auto'
				}
			});
		}
		return parts;
	});

/**
 * The delay `api.automations.run(..., { after })` asked for, in milliseconds, or `undefined` only
 * when a supplied value is invalid. Omitting `after` means zero so the run is due immediately.
 *
 * A number is already milliseconds. A string goes to `Duration`, which accepts `'1 hour'`,
 * `'30 seconds'` and the rest of the vocabulary durations are written in everywhere else here. An
 * unreadable string answers `undefined` — the caller refuses the automation through its typed
 * channel, naming the string, which is where a mistyped duration surfaces rather than being read
 * as "no delay" or swallowed as a defect. The single `as Duration.Input` is the boundary assert:
 * `Duration.Input` types a duration string as `${number} Unit`, which TypeScript cannot prove from a
 * value an authored handler passed, and `Duration.fromInput` is the decode that checks it at run
 * time.
 */
export const afterMillisOf = (after: string | number | undefined): number | undefined => {
	if (after === undefined) return 0;
	if (typeof after === 'number') return after;
	const decoded = Duration.fromInput(after as Duration.Input);
	return Option.isSome(decoded) ? Duration.toMillis(decoded.value) : undefined;
};

/** The one field the grounding pass reads back off a research turn. Built once, not per turn. */
const decodeResearchText = Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }));

/**
 * The `infer` member of the authoring api, owned in one place.
 *
 * Structured inference is one behaviour — an optional grounding turn whose prose is fed back in as
 * evidence, then the schema-constrained turn that has to answer in the author's shape. The two
 * builders differ only in how they resolve a `file()` value, which is why that arrives as an
 * argument rather than as a second copy of this.
 */
export const inferOp =
	(
		effectId: EffectIdType,
		ai: AIInterface,
		readAsset: (file: FileRef) => Effect.Effect<AuthoredFileAsset, Database.FacilityError>
	): AuthoringOps['infer'] =>
	(input) =>
		Effect.gen(function* () {
			const content = yield* inferenceTurnContent(input.prompt, input.images, readAsset);
			const model = input.model ?? 'gpt-5';
			const responseSchema = Schema.decodeUnknownSync(Schema.Json)(
				Schema.toJsonSchemaDocument(input.schema).schema
			);
			const groundedMessages =
				input.webSearch === undefined
					? [{ role: 'user' as const, content }]
					: yield* ai
							.execute(effectId, {
								_tag: 'Turn',
								model,
								messages: [{ role: 'user', content }],
								tools: [],
								maxOutputTokens: MAX_STRUCTURED_INFERENCE_OUTPUT_TOKENS,
								webSearch: input.webSearch
							})
							.pipe(
								Effect.map((research) => [
									{ role: 'user' as const, content },
									{ role: 'assistant' as const, content: decodeResearchText(research.output).text },
									{
										role: 'user' as const,
										content:
											'Encode the grounded research above as the requested JSON value. Preserve its evidence and do not add new claims.'
									}
								])
							);
			const response = yield* ai.execute(effectId, {
				_tag: 'Turn',
				model,
				messages: groundedMessages,
				tools: [],
				maxOutputTokens: MAX_STRUCTURED_INFERENCE_OUTPUT_TOKENS,
				responseSchema
			});
			return Schema.decodeUnknownSync(input.schema)(response.output);
		});

/**
 * Builds the Effect-native api an authored handler receives.
 *
 * Every method returns an Effect bound to the invocation's effect id and subject, so authored
 * business logic composes with `Effect.gen` — the same shape the authoring types declare.
 */
const collectionReadApi = (
	ops: AuthoringReadOps,
	collection: string
): Readonly<Record<string, unknown>> => ({
	findMany: (input: Readonly<Record<string, unknown>> = {}) => ops.findMany(collection, input),
	findFirst: (input: Readonly<Record<string, unknown>> = {}) => ops.findFirst(collection, input),
	count: (input: Readonly<Record<string, unknown>> = {}) => ops.count(collection, input),
	findNearest: (input: Readonly<Record<string, unknown>>) => ops.findNearest(collection, input)
});

const databaseApi = (
	allowedCollections: ReadonlySet<string>,
	collection: (name: string) => Readonly<Record<string, unknown>>
): object =>
	new Proxy(Object.create(null) as object, {
		get: (_target, property) =>
			typeof property === 'string' && allowedCollections.has(property)
				? collection(property)
				: undefined
	});

export const makeAuthoringApi = (ops: AuthoringOps): RuntimeAuthoringApi => {
	const database = databaseApi(ops.allowedCollections, (collection) => {
		const reads = collectionReadApi(ops, collection);
		return collection === 'approval_request'
			? Object.freeze(reads)
			: Object.freeze({
					...reads,
					mutate: (values: Readonly<Record<string, unknown>>) => ops.mutate(collection, values)
				});
	});

	return {
		db: database,
		automations: {
			run: (
				name: string,
				input: Schema.Json = {},
				options?: Readonly<{ readonly after?: string | number }>
			) => ops.runAutomation(name, input, options)
		},
		infer: (input: InferenceRequest) => ops.infer(input),
		readFileAsset: (file: FileRef) => ops.readFileAsset(file)
	};
};

/** Builds the smaller, read-only capability object supplied to policy decisions. */
export const makePolicyDecisionApi = (ops: AuthoringReadOps, subject: Subject): unknown =>
	Object.freeze({
		db: databaseApi(ops.allowedCollections, (collection) =>
			Object.freeze(collectionReadApi(ops, collection))
		),
		requestor: Object.freeze({
			id: subject.userId,
			userId: subject.userId,
			tenantId: subject.tenantId,
			...(subject.email === undefined ? {} : { email: subject.email }),
			...(subject.teamPath[0] === undefined ? {} : { team: subject.teamPath[0] }),
			teamPath: Object.freeze([...subject.teamPath]),
			admin: subject.admin === true
		})
	});

/** Adds the current durable run's progression capability without widening the ordinary API. */
export const makeAutomationApi = (
	api: RuntimeAuthoringApi,
	progress: RuntimeAutomationApi['progress']
): RuntimeAutomationApi => ({ ...api, progress });

/** Binds the invocation-scoped authoring ops to the runtime services, for callers outside the collections layer. */
export const makeBoundAuthoringOps = (
	effectId: EffectIdType,
	subject: Subject,
	collections: CollectionsInterface,
	ai: AIInterface,
	files: FilesInterface,
	automations: Automations.Interface,
	runAutomation?: AuthoringOps['runAutomation']
): AuthoringOps => {
	type QueryInput = Parameters<CollectionsInterface['findMany']>[2];
	type NearestQueryInput = Parameters<CollectionsInterface['findNearest']>[2];
	const query = (collection: string, input: Readonly<Record<string, unknown>>): QueryInput => ({
		collection,
		...input
	});
	/**
	 * A nearest-neighbour read's input, with the two fields the compiler cannot leave open.
	 *
	 * `column` and `probe` are what makes this a vector query rather than an ordinary one, and the
	 * runtime refuses either if it arrives wrong. They are read off the authored config here rather
	 * than spread blindly so that a handler that omits one fails with the runtime's own refusal
	 * naming the field, not with an `undefined` reaching the SQL builder.
	 */
	const nearestQuery = (
		collection: string,
		input: Readonly<Record<string, unknown>>
	): NearestQueryInput => {
		const { column, probe, metric, ...rest } = input;
		return {
			collection,
			...rest,
			column: typeof column === 'string' ? column : '',
			probe: Array.isArray(probe) ? (probe as ReadonlyArray<number>) : [],
			metric: metric === 'cosine' || metric === 'ip' ? metric : 'l2'
		};
	};
	/**
	 * The bytes and description behind a `file()` column's value.
	 *
	 * The value *is* the description — `{storage_key, file_name, file_size, mime_type}` — so this
	 * asks the Files facility for the key it names and attaches the rest. There is nothing to look
	 * up, which is the point: a `file()` column used to hold the `id` of a `document_asset`
	 * row, that row was the only thing naming the object-store key, and the upload path never wrote
	 * one. So every authored `readFileAsset` resolved against a row that did not exist, and
	 * `mimeType` came back `null` because there was no row to read it from.
	 */
	const readAsset = (file: FileRef): Effect.Effect<AuthoredFileAsset, Database.FacilityError> =>
		Effect.gen(function* () {
			const storageKey = typeof file?.storage_key === 'string' ? file.storage_key : undefined;
			if (storageKey === undefined) {
				return yield* new Database.FacilityError({
					operation: 'files.read',
					code: 'files.asset_missing',
					message: 'This file value names no stored object, so there is nothing to read.',
					retryable: false,
					outcome: 'known'
				});
			}
			const response = yield* files.execute(effectId, { _tag: 'Read', key: storageKey });
			const bytes = response.bytes ?? new Uint8Array();
			return {
				id: storageKey,
				name: typeof file.file_name === 'string' ? file.file_name : storageKey,
				mimeType: typeof file.mime_type === 'string' ? file.mime_type : null,
				size: bytes.byteLength,
				bytes
			};
		});
	return {
		allowedCollections: collections.authoringCollectionNames,
		findMany: (collection, input) =>
			collections.findMany(effectId, subject, query(collection, input)),
		findFirst: (collection, input) =>
			collections.findFirst(effectId, subject, query(collection, input)),
		count: (collection, input) => collections.count(effectId, subject, query(collection, input)),
		findNearest: (collection, input) =>
			collections.findNearest(effectId, subject, nearestQuery(collection, input)),
		mutate: (collection, values) =>
			collections
				.mutate(effectId, subject, collection, [values], false, 0, { declarative: true })
				.pipe(Effect.asVoid),
		/**
		 * Runs a declared automation under its own declared subject.
		 *
		 * `after` accepts what Effect's `Duration` accepts — `'1 hour'`, `'30 seconds'`, or a number of
		 * milliseconds — so an author writes the delay the way they would write any other duration in
		 * this codebase rather than learning a second vocabulary for one field. Absent means this
		 * invocation admits and executes the body directly; only a positive delay enters the timer.
		 *
		 * Delegated to Collections because it owns both the authored handler and the direct execution
		 * path. The optional override is used by an already-running automation to carry its nesting
		 * depth into a child; integrations and remotes take this same default rather than admitting a
		 * row that no scheduler is allowed to execute.
		 */
		runAutomation:
			runAutomation ??
			((name, input, options) => collections.runAutomation(effectId, name, input, {}, options)),
		infer: inferOp(effectId, ai, readAsset),
		readFileAsset: readAsset
	};
};
