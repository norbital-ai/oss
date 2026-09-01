// repository-health:allow SEM_PARALLEL -- authored facade consumes the collections contract leaf; the pair is linked through collections.contract, not parallel.
import { Context, Duration, Effect, Layer, Option, Result, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import {
	AIRequest,
	EffectId,
	ImageAsset,
	ModelId,
	ProviderCallId,
	type EffectId as EffectIdType
} from '@norbital-ai/bolt-protocol';
import { AuthoredRefusal, refusalOf } from '#lib/authoring/refusal.js';
import type { AutomationProgression } from '#lib/authoring/automations-schema.js';
import type { FileRef } from '#lib/authoring/models-schema.js';
import type { AuthoredIntegrationModule } from '#lib/authoring/integration-introspection.js';
import type { PolicyRuntimeFunction } from '#lib/authoring/policy-introspection.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import type { Subject } from '#lib/runtime/identity/identity.js';
import type { Interface as CollectionsInterface } from './collections.contract.js';
import * as Collections from './collections.js';
import * as Automations from '#lib/runtime/automations/automations.js';
import { AI, Files, type AIInterface, type FilesInterface } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { DispatchError } from '#lib/runtime/workspace.js';
import { readFileAsset, type FileAsset } from './file-assets.js';
import { nearestQueryInput, queryInput } from './query-input.js';
import { HookEffectIds } from './hooks/boundary.js';

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
	/** One argument: the context carries the invocation api, so no second positional exists. */
	readonly handler: (context: unknown) => unknown;
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
		readonly prepare?: (context: unknown) => unknown;
		readonly perRecord?: AuthoredPerRecord;
	}>;
	readonly delete?: Readonly<{
		readonly perRecord?: AuthoredPerRecord;
	}>;
}>;

type AuthoredPipelineModule = Readonly<{
	readonly export?: Readonly<{
		readonly description: string;
		handler(context: unknown, api: unknown): unknown;
	}>;
	readonly import?: Readonly<{
		readonly description: string;
		readonly input?: Schema.Codec<unknown, unknown>;
		handler(context: unknown, api: unknown): unknown;
	}>;
}>;

type AuthoredAutomationModule = Readonly<{
	readonly name: string;
	readonly description?: string;
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
 * Calling `handler(context)` in the argument position meant the throw escaped before this function
 * was entered, past every recovery written here, and out through whichever generator happened to be
 * running. Passing `() => handler(context)` moves the call inside `Effect.suspend`, where it can be
 * caught.
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
		readonly readFileAsset: (file: FileRef) => Effect.Effect<FileAsset, unknown, never>;
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

/** One image an authored `api.infer` attached to its turn, taken straight from a `file()` column. */
type AuthoredInferenceImage = Readonly<{
	readonly file: FileRef;
	readonly detail?: 'auto' | 'low' | 'high';
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
	readonly model: string;
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
	readonly readFileAsset: (file: FileRef) => Effect.Effect<FileAsset, unknown, never>;
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

/** Leaves schema-constrained inference enough room to finish one complete JSON value. */
const MAX_STRUCTURED_INFERENCE_OUTPUT_TOKENS = 8_192;

/**
 * The provider-neutral ImageAsset descriptors an authored `api.infer` sends beside its Effect
 * message. Bytes remain host-only and provider dialect remains Colony-only.
 *
 * Bytes must not be read or base64-expanded here: a 1 MiB JPEG becomes a request larger than the
 * facility bridge's 1 MiB ceiling, and encoding a review batch consumes the isolate's CPU budget.
 */
const inferenceImageAssets = (
	images: ReadonlyArray<AuthoredInferenceImage> | undefined
): Effect.Effect<ReadonlyArray<ImageAsset>, Database.FacilityError> =>
	Effect.gen(function* () {
		if (images === undefined || images.length === 0) return [];
		const refuse = (code: string, message: string) =>
			new Database.FacilityError({
				operation: 'ai.generate',
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
		const assets: Array<ImageAsset> = [];
		let total = 0;
		for (const image of images) {
			const file = image.file;
			if (file.storage_key.trim() === '' || file.file_name.trim() === '') {
				return yield* refuse(
					'ai.asset_missing',
					'This image value names no stored object, so there is nothing to send.'
				);
			}
			if (!file.mime_type.startsWith('image/')) {
				return yield* refuse(
					'ai.not_an_image',
					`${file.file_name} is ${file.mime_type || 'of unknown type'}, which is not an image.`
				);
			}
			if (!Number.isInteger(file.file_size) || file.file_size < 0) {
				return yield* refuse(
					'ai.invalid_image_size',
					`${file.file_name} has an invalid declared size.`
				);
			}
			total += file.file_size;
			if (total > MAX_INFERENCE_IMAGE_BYTES) {
				return yield* refuse(
					'ai.images_too_large',
					`The images on one inference turn total more than ${MAX_INFERENCE_IMAGE_BYTES} bytes.`
				);
			}
			assets.push(
				ImageAsset.make({
					key: file.storage_key,
					name: file.file_name,
					mimeType: file.mime_type,
					size: file.file_size,
					...(image.detail === undefined ? {} : { detail: image.detail })
				})
			);
		}
		return assets;
	});

/**
 * The delay `api.automations.run(..., { after })` asked for, in milliseconds, or `undefined` only
 * when a supplied value is invalid. Omitting `after` means zero so the run is due immediately.
 *
 * A number is already milliseconds. A string goes to `Duration`, which accepts `'1 hour'`,
 * `'30 seconds'` and the rest of the vocabulary durations are written in everywhere else here. An
 * unreadable string answers `undefined` — the caller refuses the automation through its typed
 * channel, naming the string, which is where a mistyped duration surfaces rather than being read
 * as "no delay" or swallowed as a defect.
 */
const durationUnits = new Set<string>([
	'nano',
	'nanos',
	'micro',
	'micros',
	'milli',
	'millis',
	'second',
	'seconds',
	'minute',
	'minutes',
	'hour',
	'hours',
	'day',
	'days',
	'week',
	'weeks'
]);

const isDurationInputString = (
	value: string
): value is `${number} ${Duration.Unit}` | 'Infinity' | '-Infinity' => {
	if (value === 'Infinity' || value === '-Infinity') return true;
	const separator = value.lastIndexOf(' ');
	if (separator <= 0) return false;
	const amount = value.slice(0, separator);
	const unit = value.slice(separator + 1);
	return amount.trim() !== '' && Number.isFinite(Number(amount)) && durationUnits.has(unit);
};

export const afterMillisOf = (after: string | number | undefined): number | undefined => {
	if (after === undefined) return 0;
	if (typeof after === 'number') return after;
	if (!isDurationInputString(after)) return undefined;
	const decoded = Duration.fromInput(after);
	return Option.isSome(decoded) ? Duration.toMillis(decoded.value) : undefined;
};

/**
 * The `infer` member of the authoring api, owned in one place.
 *
 * The authored schema remains the local decode authority. The provider receives one encoded Effect
 * message and the host resolves any image descriptors before its provider call.
 */
export const inferOp =
	(effectId: EffectIdType, ai: AIInterface): AuthoringOps['infer'] =>
	(input) =>
		Effect.gen(function* () {
			const refusal = (code: string, message: string) =>
				new Database.FacilityError({
					operation: 'ai.generate',
					code,
					message,
					retryable: false,
					outcome: 'known'
				});
			const unsupportedKeys = Object.keys(input).filter(
				(key) => key !== 'schema' && key !== 'prompt' && key !== 'model' && key !== 'images'
			);
			if (unsupportedKeys.length > 0) {
				return yield* refusal(
					'ai.request_invalid',
					'api.infer received unsupported request fields.'
				);
			}
			const modelId = yield* Schema.decodeUnknownEffect(ModelId)(input.model).pipe(
				Effect.mapError(() => refusal('ai.model_invalid', 'api.infer requires a non-empty model id.'))
			);
			const imageAssets = yield* inferenceImageAssets(input.images);
			const jsonSchema = Schema.toJsonSchemaDocument(input.schema).schema;
			const message = yield* Schema.encodeEffect(Prompt.Message)(
				Prompt.userMessage({ content: [Prompt.textPart({ text: input.prompt })] })
			).pipe(
				Effect.mapError(() => refusal('ai.message_invalid', 'The Effect prompt could not be encoded.'))
			);
			const response = yield* ai.generate(
				effectId,
				AIRequest.cases.Generate.make({
					callId: ProviderCallId.make(`${effectId}:infer`),
					modelId,
					messages: [message],
					maxOutputTokens: MAX_STRUCTURED_INFERENCE_OUTPUT_TOKENS,
					output: { _tag: 'Object', objectName: 'inference', jsonSchema },
					...(imageAssets.length === 0 ? {} : { imageAssets })
				})
			);
			if (response.result._tag !== 'Object') {
				return yield* refusal('ai.response_invalid', 'The AI provider returned the wrong output kind.');
			}
			return yield* Schema.decodeUnknownEffect(input.schema)(response.result.value).pipe(
				Effect.mapError(() =>
					refusal('ai.response_invalid', 'The AI provider response does not match the authored schema.')
				)
			);
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
	new Proxy({}, {
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
	const readAsset = (file: FileRef) => readFileAsset(effectId, files, file);
	/**
	 * A direct automation, integration, or remote may issue more than one write in one invocation.
	 * The mutation engine derives a create's stable id from its effect id, so reusing the parent here
	 * made every id-less create after the first collide with the first row. The same boundary issuer
	 * used by collection hooks gives each authored write a replay-stable ordinal owned by the runtime.
	 */
	const writeEffectIds = new HookEffectIds(effectId);
	return {
		allowedCollections: collections.authoringCollectionNames,
		findMany: (collection, input) =>
			collections.findMany(effectId, subject, queryInput(collection, input)),
		findFirst: (collection, input) =>
			collections.findFirst(effectId, subject, queryInput(collection, input)),
		count: (collection, input) =>
			collections.count(effectId, subject, queryInput(collection, input)),
		findNearest: (collection, input) =>
			collections.findNearest(effectId, subject, nearestQueryInput(collection, input)),
		mutate: (collection, values) =>
			collections
				.mutate(
					writeEffectIds.next({ phase: 'mutate', collection }),
					subject,
					collection,
					[values],
					false,
					0
				)
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
		infer: inferOp(effectId, ai),
		readFileAsset: readAsset
	};
};

type RuntimeRemoteApi = Pick<RuntimeAuthoringApi, 'db' | 'infer' | 'readFileAsset'>;
export type RuntimeRemoteHandler = ReturnType<
	() => (input: unknown, api: RuntimeRemoteApi) => unknown
>;

/** Merges authored remotes and tools once; ambiguous exact membership is a bundle-construction error. */
export const mergeRuntimeHandlers = (
	remotes: Readonly<Record<string, RuntimeRemoteHandler>>,
	tools: Readonly<Record<string, RuntimeRemoteHandler>>
): Readonly<Record<string, RuntimeRemoteHandler>> => {
	const merged: Record<string, RuntimeRemoteHandler> = { ...remotes };
	for (const [name, handler] of Object.entries(tools)) {
		if (name.length === 0) throw new Error('An authored command name may not be empty');
		if (merged[name] !== undefined)
			throw new Error(`Duplicate authored command: ${name}`);
		merged[name] = handler;
	}
	return Object.freeze(merged);
};

type RuntimeRemoteRegistry = Readonly<{
	readonly names: ReadonlySet<string>;
	readonly invoke: (
		name: string,
		input: unknown,
		subject: Identity.Subject,
		effectId: EffectId
	) => Effect.Effect<Schema.Json, DispatchError | AuthoredRefusal>;
}>;

export const RemoteRegistry = Context.Service<RuntimeRemoteRegistry>(
	'@norbital-ai/bolt/RemoteRegistry'
);

/** Exact authored-command membership and Effect-native execution, co-owned with its narrowed API. */
export const remoteRegistryLayer = (
	handlers: Readonly<Record<string, RuntimeRemoteHandler>>
) =>
	Layer.effect(
		RemoteRegistry,
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			const ai = yield* AI.Service;
			const files = yield* Files.Service;
			const automations = yield* Automations.Service;
			const names = new Set(Object.keys(handlers));
			if (names.has(''))
				return yield* Effect.fail(new Error('An authored command name may not be empty'));
			return RemoteRegistry.of({
				names,
				invoke: Effect.fn('RemoteRegistry.invoke')(function* (name, input, subject, effectId) {
					const handler = handlers[name];
					if (handler === undefined)
						return yield* new DispatchError({
							code: 'unknown_command',
							message: `Unknown workspace command: ${name}`
						});
					const api: RuntimeRemoteApi = makeAuthoringApi(
						makeBoundAuthoringOps(effectId, subject, collections, ai, files, automations)
					);
					const output = yield* runAuthoredHandler(() => handler(input, api)).pipe(
						Effect.mapError((cause) =>
							cause instanceof AuthoredRefusal
								? cause
								: DispatchError.from('remote_failed', cause)
						)
					);
					return yield* Schema.decodeUnknownEffect(Schema.Json)(output).pipe(
						Effect.mapError(
							() =>
								new DispatchError({
									code: 'invalid_command_output',
									message: `Workspace command ${name} returned a non-JSON value`
								})
						)
					);
				})
			});
		})
	);
