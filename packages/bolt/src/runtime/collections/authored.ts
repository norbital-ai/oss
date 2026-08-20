import { Context, Duration, Effect, Schema } from 'effect';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import { AuthoredRefusal, refusalOf } from '../../authoring/refusal.js';
import type { AuthoredIntegrationModule } from '../../authoring/integration-introspection.js';
import type { Identity, Subject } from '../identity/identity.js';
import type { Collections } from './collections.js';
import type { Automations } from '../automations/automations.js';
import type { AI, Files } from '../facilities/services.js';
import { Database } from '../facilities/database.js';

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

/** The per-record halves of one operation. Both run once per record, whatever the batch size. */
export type AuthoredPerRecord = Readonly<{
	readonly before?: AuthoredHookPoint;
	readonly after?: AuthoredHookPoint;
}>;

export type AuthoredCollectionHookModule = Readonly<{
	readonly create?: Readonly<{
		readonly input?: Schema.Codec<unknown, unknown>;
		/** Runs once for the batch; what it returns reaches every record's hooks as `prepared`. */
		readonly prepare?: (context: unknown, api: unknown) => unknown;
		readonly perRecord?: AuthoredPerRecord;
	}>;
	readonly update?: Readonly<{
		readonly input?: Schema.Codec<unknown, unknown>;
		readonly perRecord?: AuthoredPerRecord;
	}>;
	readonly delete?: Readonly<{
		readonly perRecord?: AuthoredPerRecord;
	}>;
}>;

export type AuthoredPipelineModule = Readonly<{
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

export type AuthoredAutomationModule = Readonly<{
	readonly name: string;
	readonly trigger: Readonly<
		| { readonly _tag: 'Schedule'; readonly cron: string }
		| {
				readonly _tag: 'Change';
				readonly collection: string;
				readonly event: 'created' | 'updated' | 'deleted';
		  }
	>;
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

export const emptyAuthoredRuntime: AuthoredRuntime = {
	hooks: {},
	pipelines: {},
	automations: {},
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
 * Three arrival paths, because a refusal can be raised from any of the three worlds the surface
 * admits, and each delivers it differently:
 *
 * - a plain handler throws **synchronously**, caught by the `try` below;
 * - an `async` handler **rejects**, caught off the promise;
 * - an `Effect.gen` handler throws inside the generator, which Effect converts to a **defect**
 *   before anyone else sees it, caught by `catchDefect`.
 *
 * A non-refusal keeps its existing treatment on every path, including the `catch` on the promise
 * branch: the bare one-argument `tryPromise` wraps a rejection in `UnknownError`, whose message is
 * the literal "An error occurred in Effect.tryPromise", and what the handler actually threw is the
 * only useful part of the failure.
 */
export const runAuthoredHandler = <A>(
	handler: () => A | Promise<A> | Effect.Effect<A>
): Effect.Effect<A, AuthoredRefusal> =>
	Effect.suspend((): Effect.Effect<A, AuthoredRefusal> => {
		let produced: A | Promise<A> | Effect.Effect<A>;
		try {
			produced = handler();
		} catch (cause) {
			return raise<A>(cause);
		}
		if (Effect.isEffect(produced))
			return produced.pipe(Effect.catchDefect((defect) => raise<A>(defect))) as Effect.Effect<
				A,
				AuthoredRefusal
			>;
		if (produced instanceof Promise)
			return Effect.tryPromise({
				try: () => produced as Promise<A>,
				catch: (cause) => cause
			}).pipe(Effect.catch((cause: unknown) => raise<A>(cause)));
		return Effect.succeed(produced);
	});

/** The collection operations an authored api can reach, bound by the runtime to the current invocation. */
export type AuthoredCollectionOps = Readonly<{
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
	readonly findNearest: (
		collection: string,
		input: Readonly<Record<string, unknown>>
	) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, unknown, never>;
	readonly create: (
		collection: string,
		id: string,
		values: Readonly<Record<string, Schema.Json>>
	) => Effect.Effect<Readonly<Record<string, unknown>>, unknown, never>;
	readonly update: (
		collection: string,
		id: string,
		values: Readonly<Record<string, Schema.Json>>
	) => Effect.Effect<Readonly<Record<string, unknown>>, unknown, never>;
	readonly delete: (collection: string, id: string) => Effect.Effect<void, unknown, never>;
	readonly mutate: (
		collection: string,
		payloads: ReadonlyArray<Readonly<Record<string, unknown>>>,
		options?: { readonly batchSize?: number }
	) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, unknown, never>;
	/**
	 * Starts a declared automation in the background.
	 *
	 * The third door an author has, beside `{ schedule }` and `{ trigger }`, and the only one that
	 * says "from code, later, with retry". It is deliberately not a task API: a task is not a thing an
	 * author has, and a second way to start background work would compete with the automations the
	 * workspace already declares.
	 */
	readonly runAutomation: (
		name: string,
		input: Schema.Json,
		options: Readonly<{ readonly after?: string | number }> | undefined
	) => Effect.Effect<{ readonly taskId: string }, unknown, never>;
	readonly approvalFindMany: (
		input: Readonly<Record<string, unknown>>
	) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, unknown, never>;
	readonly approvalFindFirst: (
		input: Readonly<Record<string, unknown>>
	) => Effect.Effect<Readonly<Record<string, unknown>> | undefined, unknown, never>;
	readonly infer: (
		input: Readonly<{
			readonly schema: Schema.Codec<unknown, unknown>;
			readonly prompt: string;
			readonly model?: string;
			readonly images?: ReadonlyArray<{
				readonly assetId: string;
				readonly detail?: 'auto' | 'low' | 'high';
			}>;
		}>
	) => Effect.Effect<unknown, unknown, never>;
	readonly readFileAsset: (assetId: string) => Effect.Effect<
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

/** What an authored `readFileAsset` answers with, and what an inference image is built from. */
export type AuthoredFileAsset = Readonly<{
	readonly id: string;
	readonly name: string;
	readonly mimeType: string | null;
	readonly size: number;
	readonly bytes: Uint8Array;
}>;

/** One image an authored `api.infer` attached to its turn. */
export type AuthoredInferenceImage = Readonly<{
	readonly assetId: string;
	readonly detail?: 'auto' | 'low' | 'high';
}>;

/**
 * How much of a turn an authored `api.infer` may spend on pictures.
 *
 * Both are refusals, not truncations: a bound that silently dropped an image would leave the model
 * answering about a scene it was never shown, which reads exactly like it answering correctly.
 */
const MAX_INFERENCE_IMAGES = 8;
const MAX_INFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

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
	readAsset: (assetId: string) => Effect.Effect<AuthoredFileAsset, Database.FacilityError>
): Effect.Effect<Schema.Json, Database.FacilityError> =>
	Effect.gen(function* () {
		if (images === undefined || images.length === 0) return prompt as Schema.Json;
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
			const asset = yield* readAsset(image.assetId);
			if (asset.mimeType === null || !asset.mimeType.startsWith('image/')) {
				return yield* refuse(
					'ai.not_an_image',
					`document_asset ${image.assetId} is ${asset.mimeType ?? 'of unknown type'}, which is not an image.`
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
		return parts as Schema.Json;
	});

/**
 * The delay `api.automations.run(..., { after })` asked for, in milliseconds.
 *
 * A number is already milliseconds. A string goes to `Duration`, which accepts `'1 hour'`,
 * `'30 seconds'` and the rest of the vocabulary durations are written in everywhere else here — and
 * refuses anything else by throwing, at the line the author wrote, which is where a mistyped
 * duration should surface. The alternative, silently treating an unreadable string as "no delay",
 * would turn a typo into work that ran immediately and looked deliberate.
 */
export const afterMillisOf = (after: string | number): number =>
	typeof after === 'number' ? after : Duration.toMillis(after as Duration.Input);

const asQueryInput = (
	input: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> => input;

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
		findMany: (input: Readonly<Record<string, unknown>> = {}) =>
			ops.findMany(collection, asQueryInput(input)),
		findFirst: (input: Readonly<Record<string, unknown>> = {}) =>
			ops.findFirst(collection, asQueryInput(input)),
		count: (input: Readonly<Record<string, unknown>> = {}) =>
			ops.count(collection, asQueryInput(input)),
		findNearest: (input: Readonly<Record<string, unknown>>) =>
			ops.findNearest(collection, asQueryInput(input)),
		create: (input: Readonly<Record<string, unknown>>) => {
			const identifier =
				typeof input['norbital_id'] === 'string'
					? input['norbital_id']
					: globalThis.crypto.randomUUID();
			return ops.create(collection, identifier, input as Readonly<Record<string, Schema.Json>>);
		},
		update: (id: string, input: Readonly<Record<string, unknown>>) =>
			ops.update(collection, id, input as Readonly<Record<string, Schema.Json>>),
		/**
		 * The elevated writes, on the collection like everything else that reaches one.
		 *
		 * They were also declared on `db` itself, taking the collection as a first argument — two ways
		 * to say one thing, and the db-level pair was never implemented: this proxy answers any string
		 * with `collectionApi(property)`, so `api.db.mutate` was an object named `mutate` and
		 * `yield* api.db.mutate('payslips', rows)` raised `is not iterable` while typechecking
		 * cleanly. hr-payroll's whole PERSIST phase was written that way, so every payroll run
		 * computed through seven phases and threw on its first write.
		 *
		 * Elevated only: these bypass the row predicate, and a hook running as an ordinary subject
		 * must not.
		 */
		...(options.elevated === true
			? {
					mutate: (
						payloads: ReadonlyArray<Readonly<Record<string, unknown>>>,
						options?: { readonly batchSize?: number }
					) => ops.mutate(collection, payloads, options),
					delete: (identifiers: ReadonlyArray<string>) => deleteAll(collection, identifiers)
				}
			: {})
	});
	const query = new Proxy<Readonly<Record<string, unknown>>>(
		{},
		{
			get: (_target, property) =>
				property === 'approval_request'
					? {
							findMany: (input: Readonly<Record<string, unknown>> = {}) =>
								ops.approvalFindMany(asQueryInput(input)),
							findFirst: (input: Readonly<Record<string, unknown>> = {}) =>
								ops.approvalFindFirst(asQueryInput(input))
						}
					: typeof property === 'string'
						? collectionApi(property)
						: undefined
		}
	);
	/**
	 * Every identifier, not the first one.
	 *
	 * `ops.delete` takes a single id, and the array form used to hand it `identifiers[0]`. That is a
	 * silent wrong answer rather than a failure: `clearRunResults` exists to remove every payslip of
	 * a run before recomputing it, and removing one turned a recalculation into a partial wipe that
	 * reported success.
	 */
	const deleteAll = (collection: string, identifiers: ReadonlyArray<string>) =>
		Effect.forEach(identifiers, (identifier) => ops.delete(collection, identifier), {
			discard: true
		});

	const database = new Proxy<Readonly<Record<string, unknown>>>(
		{},
		{
			get: (_target, property) =>
				property === 'query'
					? query
					: typeof property === 'string'
						? collectionApi(property)
						: undefined
		}
	);
	return {
		db: database,
		automations: {
			run: (
				name: string,
				input: Schema.Json = {},
				options?: Readonly<{ readonly after?: string | number }>
			) => ops.runAutomation(name, input, options)
		},
		infer: (
			input: Readonly<{
				readonly schema: Schema.Codec<unknown, unknown>;
				readonly prompt: string;
				readonly model?: string;
				readonly images?: ReadonlyArray<{
					readonly assetId: string;
					readonly detail?: 'auto' | 'low' | 'high';
				}>;
			}>
		) => ops.infer(input),
		readFileAsset: (assetId: string) => ops.readFileAsset(assetId)
	};
};

/** Binds the invocation-scoped authoring ops to the runtime services, for callers outside the collections layer. */
export const makeBoundAuthoringOps = (
	effectId: EffectIdType,
	subject: Subject,
	collections: Collections.Interface,
	ai: AI.Interface,
	files: Files.Interface,
	automations: Automations.Interface
): AuthoredCollectionOps => {
	type QueryInput = Parameters<Collections.Interface['findMany']>[2];
	type NearestInput = Parameters<Collections.Interface['findNearest']>[2];
	const query = (collection: string, input: Readonly<Record<string, unknown>>): QueryInput =>
		({ collection, ...input }) as QueryInput;
	const nearest = (collection: string, input: Readonly<Record<string, unknown>>): NearestInput =>
		({ collection, ...input }) as NearestInput;
	/**
	 * The bytes and description behind a `file()` column's value.
	 *
	 * A `file()` column holds the `norbital_id` of a `document_asset` row, and that row is the only
	 * thing that names the object-store key the bytes were written under, along with the file name,
	 * size and mime type nothing else records. Asking the Files facility for the *asset id* — which
	 * is what this used to do — asks for a key no upload ever wrote, so every authored
	 * `readFileAsset` resolved against nothing and `mimeType` was hardcoded `null` because there was
	 * no row being read to get one from.
	 */
	const readAsset = (assetId: string): Effect.Effect<AuthoredFileAsset, Database.FacilityError> =>
		Effect.gen(function* () {
			const row = yield* collections
				.findFirst(effectId, subject, {
					collection: 'document_asset',
					where: { norbital_id: { eq: assetId } }
				})
				.pipe(Effect.orElseSucceed(() => undefined));
			const record =
				typeof row === 'object' && row !== null && !Array.isArray(row)
					? (row as Readonly<Record<string, unknown>>)
					: undefined;
			const storageKey =
				typeof record?.['storage_key'] === 'string' ? record['storage_key'] : undefined;
			if (storageKey === undefined) {
				return yield* new Database.FacilityError({
					operation: 'files.read',
					code: 'files.asset_missing',
					message: `No document_asset ${assetId}, so there is no stored object to read.`,
					retryable: false,
					outcome: 'known'
				});
			}
			const response = yield* files.execute(effectId, { _tag: 'Read', key: storageKey });
			const bytes = response.bytes ?? new Uint8Array();
			return {
				id: assetId,
				name: typeof record?.['file_name'] === 'string' ? record['file_name'] : assetId,
				mimeType: typeof record?.['mime_type'] === 'string' ? record['mime_type'] : null,
				size: bytes.byteLength,
				bytes
			};
		});
	return {
		findMany: (collection, input) =>
			collections
				.findMany(effectId, subject, query(collection, input))
				.pipe(Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)),
		findFirst: (collection, input) =>
			collections
				.findFirst(effectId, subject, query(collection, input))
				.pipe(Effect.map((row) => row as Readonly<Record<string, unknown>> | undefined)),
		count: (collection, input) => collections.count(effectId, subject, query(collection, input)),
		findNearest: (collection, input) =>
			collections
				.findNearest(effectId, subject, nearest(collection, input))
				.pipe(Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)),
		create: (collection, id, values) =>
			Effect.gen(function* () {
				yield* collections.create(effectId, subject, { collection, id, values });
				const row = yield* collections.findFirst(effectId, subject, {
					collection,
					where: { norbital_id: { eq: id } }
				});
				return row === undefined
					? ({ norbital_id: id, ...values } as Readonly<Record<string, unknown>>)
					: (row as Readonly<Record<string, unknown>>);
			}),
		update: (collection, id, values) =>
			Effect.gen(function* () {
				yield* collections.update(effectId, subject, { collection, id, values });
				const row = yield* collections.findFirst(effectId, subject, {
					collection,
					where: { norbital_id: { eq: id } }
				});
				return row === undefined
					? ({ norbital_id: id, ...values } as Readonly<Record<string, unknown>>)
					: (row as Readonly<Record<string, unknown>>);
			}),
		delete: (collection, id) => collections.delete(effectId, subject, collection, id),
		mutate: (collection, payloads) =>
			Effect.all(
				payloads.map((payload) =>
					Effect.gen(function* () {
						const identifier =
							typeof payload['norbital_id'] === 'string'
								? payload['norbital_id']
								: globalThis.crypto.randomUUID();
						yield* collections.create(effectId, subject, {
							collection,
							id: identifier,
							values: payload as Readonly<Record<string, Schema.Json>>
						});
						const row = yield* collections.findFirst(effectId, subject, {
							collection,
							where: { norbital_id: { eq: identifier } }
						});
						return row === undefined
							? ({ norbital_id: identifier, ...payload } as Readonly<Record<string, unknown>>)
							: (row as Readonly<Record<string, unknown>>);
					})
				),
				{ concurrency: 'unbounded' }
			),
		/**
		 * Runs a declared automation later, under the subject this handler is already running as.
		 *
		 * `after` accepts what Effect's `Duration` accepts — `'1 hour'`, `'30 seconds'`, or a number of
		 * milliseconds — so an author writes the delay the way they would write any other duration in
		 * this codebase rather than learning a second vocabulary for one field. Absent means as soon as
		 * a tick can take it.
		 *
		 * Delegated to `Automations.start` rather than writing a row here, so the nesting bound, the
		 * `bolt_run_as` stamp and the "is this automation declared?" check all happen in the one place
		 * that has always owned them.
		 */
		runAutomation: (name, input, options) =>
			Effect.gen(function* () {
				const after = options?.after;
				const taskId = yield* automations.start(effectId, subject, name, input, {
					// `Duration.toMillis` accepts `'1 hour'`, `'30 seconds'` and a bare number of millis
					// alike, so an author writes a delay the way durations are written everywhere else in
					// this codebase rather than learning a second vocabulary for one field.
					...(after === undefined ? {} : { afterMillis: afterMillisOf(after) })
				});
				return { taskId };
			}),
		approvalFindMany: (input) =>
			collections
				.findMany(effectId, subject, { collection: 'approval_request', ...input })
				.pipe(Effect.map((rows) => rows as ReadonlyArray<Readonly<Record<string, unknown>>>)),
		approvalFindFirst: (input) =>
			collections
				.findFirst(effectId, subject, { collection: 'approval_request', ...input })
				.pipe(Effect.map((row) => row as Readonly<Record<string, unknown>> | undefined)),
		infer: (input) =>
			Effect.gen(function* () {
				const content = yield* inferenceTurnContent(input.prompt, input.images, readAsset);
				const response = yield* ai.execute(effectId, {
					_tag: 'Turn',
					model: input.model ?? 'gpt-5',
					messages: [{ role: 'user', content }],
					tools: [],
					maxOutputTokens: 4_096
				});
				return Schema.decodeUnknownSync(input.schema)(response.output);
			}),
		readFileAsset: (assetId) => readAsset(assetId)
	};
};
