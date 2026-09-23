// repository-health:allow SEM_PARALLEL -- authored facade consumes the collections contract leaf; the pair is linked through collections.contract, not parallel.
import { Context, Duration, Effect, Layer, Option, Result, Schema } from 'effect';
import { decodeNumber } from '@norbital-ai/std/json';
import { EffectId, type EffectId as EffectIdType } from '@norbital-ai/bolt-protocol';
import { AuthoredRefusal, refusalOf } from '#lib/authoring/refusal.js';
import type { HttpConnection } from '#lib/authoring/contracts-schema.js';
import type { AutomationProgression, AutomationApi } from '#lib/authoring/automations-schema.js';
import type { FileRef } from '#lib/authoring/models-schema.js';
import type { AuthoredCollectionModule } from '#lib/authoring/collection-schema.js';
import type { AuthoredIntegrationModule } from '#lib/authoring/integration-introspection.js';
import type { PolicyRuntimeFunction } from '#lib/authoring/policy-introspection.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import type { Subject } from '#lib/runtime/identity/identity.js';
import type {
	BatchMutationError,
	CollectionHistorySnapshot,
	Interface as CollectionsInterface,
	QueryError,
	WriteCommit
} from './collections.contract.js';
import * as Collections from './collections.js';
import * as Automations from '#lib/runtime/automations/automations.js';
import {
	AI,
	Files,
	type AIInterface,
	type FilesInterface,
	type HostToolsInterface
} from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { DispatchError } from '#lib/runtime/workspace.js';
import { readFileAsset, type FileAsset } from './file-assets.js';
import { nearestQueryInput, queryInput } from './query-input.js';
import type { CollectionHistoryAnchor } from '@norbital-ai/bolt-protocol';
import * as InvocationBudget from '#lib/runtime/budget.js';
import { inferOp, type InferenceRequest } from '#lib/runtime/inference.js';
import type {
	EmbeddingPassSummary,
	EmbedRecordsOptions
} from '#lib/runtime/collections/services/embeddings.js';

const isNumber = Schema.is(Schema.Number);

/**
 * The runtime carrier for a workspace's authored business logic.
 *
 * Collections, pipelines, and automations are imported live into the artifact and handed to the
 * runtime here, exactly as remotes and tools are. The carrier is deliberately runtime-shaped — plain
 * objects with `handler` functions — so a compiled workspace's modules arrive without any schema
 * ceremony: the authoring *types* in `@norbital-ai/bolt/authoring` are the compile-time contract,
 * and this is where those shapes are read at run time.
 */

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
	readonly connection?: HttpConnection;
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
	/**
	 * The declared write contract of every `+collection.ts`, keyed by collection name.
	 *
	 * The serializable half — selections and notification channel names — rides on the compiled
	 * collection; this carries the live transform and message builders the runtime invokes.
	 */
	readonly collections: Readonly<Record<string, AuthoredCollectionModule>>;
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
	collections: {},
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
	// repository-health:allow GUARD2 -- The authored boundary admits any thenable from author-supplied JavaScript, and recognizing one needs the object-or-function duck check no schema can express.
	if (typeof value !== 'object' && typeof value !== 'function') return false;
	// repository-health:allow GUARD2 -- A thenable is recognized by `then` being callable; no Effect schema accepts functions.
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
type AuthoringReadOps<E = never> = Readonly<{
	/** Exact generic database members structurally visible to authored code. */
	readonly allowedCollections: ReadonlySet<string>;
	readonly findMany: (
		collection: string,
		input: Readonly<Record<string, unknown>>
	) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, E, never>;
	readonly findFirst: (
		collection: string,
		input: Readonly<Record<string, unknown>>
	) => Effect.Effect<Readonly<Record<string, unknown>> | undefined, E, never>;
	readonly count: (
		collection: string,
		input: Readonly<Record<string, unknown>>
	) => Effect.Effect<number, E, never>;
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
	) => Effect.Effect<ReadonlyArray<Readonly<Record<string, unknown>>>, E, never>;
}>;

/** Every operation an ordinary authored handler can reach, bound to the current invocation. */
export type AuthoringOps<E = never> = AuthoringReadOps<E> &
	Readonly<{
		/**
		 * One declared collection write (RFC §4.2): the caller submits the collection's declared
		 * inputs and the engine commits the transform's payload graph in one transaction.
		 */
		readonly write: (
			collection: string,
			action: 'create' | 'update' | 'delete',
			inputs: ReadonlyArray<Readonly<Record<string, unknown>>>
		) => Effect.Effect<WriteCommit, E, never>;
		/** A record's revisions, oldest first, or the one revision an anchor names (RFC §4.7). */
		readonly history: (
			collection: string,
			id: string,
			at?: CollectionHistoryAnchor
		) => Effect.Effect<ReadonlyArray<CollectionHistorySnapshot>, E, never>;
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
		) => Effect.Effect<{ readonly taskId: string }, E, never>;
		readonly infer: (input: InferenceRequest) => Effect.Effect<unknown, E, never>;
		readonly readFileAsset: (file: FileRef) => Effect.Effect<FileAsset, E, never>;
		/**
		 * Fills missing platform record embeddings for one collection, host-side.
		 *
		 * A record embedding is a platform column, so no authored write can set it: the host reads
		 * the declared fields, resolves a file field into its image, embeds, and writes the vector.
		 * Bounded per call and re-runnable — it selects only rows that have none — so an authored
		 * pass loops until nothing is selected. This is how a workspace keeps its own similarity
		 * index current without a host-side seeding step.
		 */
		readonly embed: (
			input: Readonly<{
				readonly collection: string;
				readonly ids?: ReadonlyArray<string>;
				readonly limit?: number;
			}>
		) => Effect.Effect<EmbeddingPassSummary, E, never>;
	}>;

/** A preflight the runtime may place in front of an authored operation. */
type AuthoredOperationGuard<E = never> = (operation: string) => Effect.Effect<void, E, never>;

/**
 * Places one guard immediately before every operation reachable through the authored API.
 *
 * Kept separate from `makeBoundAuthoringOps` deliberately: hooks, integrations, and remotes share
 * those bindings but do not belong to a cancellable automation task. Only automation dispatch wraps
 * its bound operations with this function.
 */
export const guardAuthoringOps = <E, G>(
	ops: AuthoringOps<E>,
	guard: AuthoredOperationGuard<G>
): AuthoringOps<E | G> => ({
	allowedCollections: ops.allowedCollections,
	findMany: (collection, input) =>
		guard(`db.${collection}.findMany`).pipe(Effect.andThen(ops.findMany(collection, input))),
	findFirst: (collection, input) =>
		guard(`db.${collection}.findFirst`).pipe(Effect.andThen(ops.findFirst(collection, input))),
	count: (collection, input) =>
		guard(`db.${collection}.count`).pipe(Effect.andThen(ops.count(collection, input))),
	findNearest: (collection, input) =>
		guard(`db.${collection}.findNearest`).pipe(Effect.andThen(ops.findNearest(collection, input))),
	write: (collection, action, inputs) =>
		guard(`collection.${collection}.${action}`).pipe(
			Effect.andThen(ops.write(collection, action, inputs))
		),
	history: (collection, id, at) =>
		guard(`collection_history.${collection}`).pipe(Effect.andThen(ops.history(collection, id, at))),
	runAutomation: (name, input, options) =>
		guard(`automations.${name}.run`).pipe(Effect.andThen(ops.runAutomation(name, input, options))),
	infer: (input) => guard('ai.infer').pipe(Effect.andThen(ops.infer(input))),
	readFileAsset: (file) => guard('files.read').pipe(Effect.andThen(ops.readFileAsset(file))),
	embed: (input) => guard(`ai.embed.${input.collection}`).pipe(Effect.andThen(ops.embed(input)))
});

/** The Effect-native capability object supplied to authored handlers after invocation binding. */
export type RuntimeAuthoringApi<E = never> = Readonly<{
	readonly db: object;
	/** The declared write surface, keyed by collection name (RFC §4.2). */
	readonly collection: object;
	/** The record log, keyed by collection name (RFC §4.7). */
	readonly collection_history: object;
	readonly automations: Readonly<{
		readonly run: (
			name: string,
			input?: Schema.Json,
			options?: Readonly<{ readonly after?: string | number }>
		) => Effect.Effect<{ readonly taskId: string }, E, never>;
	}>;
	readonly infer: (input: InferenceRequest) => Effect.Effect<unknown, E, never>;
	readonly readFileAsset: (file: FileRef) => Effect.Effect<FileAsset, E, never>;
	readonly embed: (input: {
		readonly collection: string;
		readonly ids?: ReadonlyArray<string>;
		readonly limit?: number;
	}) => Effect.Effect<EmbeddingPassSummary, E, never>;
}>;

/** The automation-only extension. Hooks and remotes receive `RuntimeAuthoringApi` and cannot emit. */
type RuntimeAutomationApi<E = never> = RuntimeAuthoringApi<E> &
	Readonly<{
		readonly runId: string;
		readonly connection: {
			readonly get: (
				input: Parameters<AutomationApi['connection']['get']>[0]
			) => Effect.Effect<import('@norbital-ai/bolt-protocol').IntegrationHttpResponse, E>;
		};
		readonly readUrl: (
			url: string
		) => Effect.Effect<import('@norbital-ai/bolt-protocol').WebPage, E, never>;
		readonly progress: (value: AutomationProgression) => Effect.Effect<void, E, never>;
		readonly notify: (
			reminder: Parameters<AutomationApi['notify']>[0]
		) => Effect.Effect<void, E, never>;
	}>;

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
	return amount.trim() !== '' && Number.isFinite(decodeNumber(amount)) && durationUnits.has(unit);
};

export const afterMillisOf = (after: string | number | undefined): number | undefined => {
	if (after === undefined) return 0;
	if (isNumber(after)) return after;
	if (!isDurationInputString(after)) return undefined;
	const decoded = Duration.fromInput(after);
	return Option.isSome(decoded) ? Duration.toMillis(decoded.value) : undefined;
};

/**
 * Builds the Effect-native api an authored handler receives.
 *
 * Every method returns an Effect bound to the invocation's effect id and subject, so authored
 * business logic composes with `Effect.gen` — the same shape the authoring types declare.
 */
const collectionReadApi = <E>(
	ops: AuthoringReadOps<E>,
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
	new Proxy(
		{},
		{
			get: (_target, property) =>
				typeof property === 'string' && allowedCollections.has(property)
					? collection(property)
					: undefined
		}
	);

/** The reads-only `db` a transform receives: the workspace's reads, no writes, no policy. */
export const makeTransformDb = <E>(ops: AuthoringReadOps<E>): object =>
	databaseApi(ops.allowedCollections, (collection) =>
		Object.freeze(collectionReadApi(ops, collection))
	);

export const makeAuthoringApi = <E>(ops: AuthoringOps<E>): RuntimeAuthoringApi<E> => {
	const database = makeTransformDb(ops);
	/**
	 * The declared write surface: `api.collection.<name>.create(input)`, `.createMany(inputs)`,
	 * `.update(id, input)`, `.updateMany(inputs)`, `.delete(id)` and `.deleteMany(ids)`. Which of
	 * them exist is the collection's declaration; the runtime refuses the rest.
	 */
	const collections = databaseApi(ops.allowedCollections, (collection) =>
		Object.freeze({
			create: (input: Readonly<Record<string, unknown>> = {}) =>
				ops.write(collection, 'create', [input]).pipe(Effect.map((commit) => commit.records[0])),
			createMany: (inputs: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
				ops.write(collection, 'create', inputs).pipe(Effect.map((commit) => commit.records)),
			update: (id: string, input: Readonly<Record<string, unknown>> = {}) =>
				ops
					.write(collection, 'update', [{ ...input, id }])
					.pipe(Effect.map((commit) => commit.records[0])),
			updateMany: (inputs: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
				ops.write(collection, 'update', inputs).pipe(Effect.map((commit) => commit.records)),
			delete: (id: string) => ops.write(collection, 'delete', [{ id }]).pipe(Effect.asVoid),
			deleteMany: (ids: ReadonlyArray<string>) =>
				ids.length === 0
					? Effect.void
					: ops
							.write(
								collection,
								'delete',
								ids.map((id) => ({ id }))
							)
							.pipe(Effect.asVoid)
		})
	);
	const history = databaseApi(ops.allowedCollections, (collection) =>
		Object.freeze({
			revisions: (id: string) => ops.history(collection, id),
			at: (id: string, anchor: CollectionHistoryAnchor) =>
				ops.history(collection, id, anchor).pipe(Effect.map((revisions) => revisions[0]?.values))
		})
	);
	return {
		db: database,
		collection: collections,
		collection_history: history,
		automations: {
			run: (
				name: string,
				input: Schema.Json = {},
				options?: Readonly<{ readonly after?: string | number }>
			) => ops.runAutomation(name, input, options)
		},
		infer: (input: InferenceRequest) => ops.infer(input),
		readFileAsset: (file: FileRef) => ops.readFileAsset(file),
		embed: (input: {
			readonly collection: string;
			readonly ids?: ReadonlyArray<string>;
			readonly limit?: number;
		}) => ops.embed(input)
	};
};

/** Builds the smaller, read-only capability object supplied to policy decisions. */
export const makePolicyDecisionApi = <E>(ops: AuthoringReadOps<E>, subject: Subject): unknown =>
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

/** Adds the current durable run's progression and reminder capabilities without widening the ordinary API. */
export const makeAutomationApi = <E, P, W, C, N>(
	api: RuntimeAuthoringApi<E>,
	progress: (value: AutomationProgression) => Effect.Effect<void, P, never>,
	readUrl: (url: string) => Effect.Effect<import('@norbital-ai/bolt-protocol').WebPage, W, never>,
	runId: string,
	connection: {
		readonly get: (
			input: Parameters<AutomationApi['connection']['get']>[0]
		) => Effect.Effect<import('@norbital-ai/bolt-protocol').IntegrationHttpResponse, C>;
	},
	notify: (reminder: Parameters<AutomationApi['notify']>[0]) => Effect.Effect<void, N, never>
): RuntimeAutomationApi<E | P | W | C | N> => ({
	...api,
	progress,
	readUrl,
	runId,
	connection,
	notify
});

const effectLabel = (value: string): string => encodeURIComponent(value).replaceAll('%', '_');

/**
 * Invocation-local issuer for authored writes.
 *
 * The mutation engine derives a create's stable id from its effect id, so two writes sharing one id
 * silently collapse into one. The ordinal is state owned by the boundary, not by an author who
 * could accidentally reuse it, and the coordinate keeps the id readable in a ledger.
 */
class WriteEffectIds {
	#issued = 0;
	readonly parent: EffectIdType;

	constructor(parent: EffectIdType) {
		this.parent = parent;
	}

	next(phase: string, collection: string): EffectIdType {
		this.#issued += 1;
		return EffectId.make(
			[
				this.parent,
				'write',
				effectLabel(phase),
				effectLabel(collection),
				String(this.#issued)
			].join(':')
		);
	}
}

/** The automation holding this api (name, args, depth): a self-start with moved args continues it. */
export type AutomationContinuation = Readonly<{
	readonly name: string;
	readonly args: Schema.Json;
	readonly depth: number;
}>;

/** What the collections layer binds an authored api to, late-bound so the layer can build itself. */
export type AuthoringPorts<E = never> = Readonly<{
	readonly allowedCollections: ReadonlySet<string>;
	readonly findMany: CollectionsInterface['findMany'];
	readonly count: CollectionsInterface['count'];
	readonly findNearest: CollectionsInterface['findNearest'];
	readonly history: CollectionsInterface['history'];
	readonly write: CollectionsInterface['write'];
	readonly startAutomation: (
		effectId: EffectIdType,
		name: string,
		input: Schema.Json,
		scope: Readonly<Record<string, Schema.Json>>,
		options?: Readonly<{
			readonly after?: string | number;
			readonly taskId?: string;
			readonly parentDepth?: number;
			readonly continuationOf?: AutomationContinuation;
		}>
	) => Effect.Effect<{ readonly taskId: string }, AuthoringError<E>>;
	readonly infer: AuthoringOps<E>['infer'];
	readonly readFileAsset: AuthoringOps<E>['readFileAsset'];
	readonly embed: (
		effectId: EffectIdType,
		input: Parameters<AuthoringOps<E>['embed']>[0]
	) => Effect.Effect<EmbeddingPassSummary, E, never>;
}>;

type AuthoringError<E> =
	| QueryError
	| BatchMutationError
	| Schema.SchemaError
	| Automations.AutomationStopped
	| Automations.AutomationDeferredUnsupported
	| Automations.AutomationContinuationUnchanged
	| E;

/** Read operations bound to one subject, shared by handlers, transforms and policy decisions. */
export const makeAuthoringReadOps = <E>(
	ports: Pick<AuthoringPorts<E>, 'allowedCollections' | 'findMany' | 'count' | 'findNearest'>,
	effectId: EffectIdType,
	subject: Subject
): AuthoringReadOps<QueryError> => ({
	allowedCollections: ports.allowedCollections,
	findMany: (collection, input) => ports.findMany(effectId, subject, queryInput(collection, input)),
	findFirst: (collection, input) =>
		ports
			.findMany(effectId, subject, { ...queryInput(collection, input), limit: 1 })
			.pipe(Effect.map((rows) => rows[0])),
	count: (collection, input) => ports.count(effectId, subject, queryInput(collection, input)),
	findNearest: (collection, input) =>
		ports.findNearest(effectId, subject, nearestQueryInput(collection, input))
});

/**
 * Builds the invocation-bound authoring api from explicit ports.
 *
 * The api carries the subject it was built for and nothing else decides authority: the declared
 * principal for an automation, the caller for a function or a pipeline. The vocabulary is the same
 * in every context, and every write it issues is one declared collection write.
 */
export const makeAuthoringOps = <E>(
	ports: AuthoringPorts<E>,
	effectId: EffectIdType,
	subject: Subject,
	automation?: AutomationContinuation
): AuthoringOps<AuthoringError<E>> => {
	const writeEffectIds = new WriteEffectIds(effectId);
	return {
		...makeAuthoringReadOps(ports, effectId, subject),
		write: (collection, action, inputs) =>
			ports.write(writeEffectIds.next(action, collection), subject, [
				{ collection, action, inputs }
			]),
		history: (collection, id, at) => ports.history(effectId, subject, collection, id, at),
		runAutomation: (name, input, options) =>
			ports.startAutomation(
				writeEffectIds.next('automation', name),
				name,
				input,
				{},
				{
					...options,
					...(automation === undefined
						? {}
						: { parentDepth: automation.depth, continuationOf: automation })
				}
			),
		infer: ports.infer,
		readFileAsset: ports.readFileAsset,
		embed: (input) => ports.embed(effectId, input)
	};
};

/**
 * Maps one authored `embedRecords` call onto the collection backfill and its single summary.
 *
 * The backfill is a multi-collection pass; an authored call names exactly one collection and either
 * a bounded page of its rows or every row still missing a vector. Shared so the automation
 * dispatch, the bound ops and the collections layer all narrow the pass the same way.
 */
export const embedRecordsSummary = <E>(
	collections: Readonly<{
		embedRecords: (
			effectId: EffectIdType,
			options?: EmbedRecordsOptions
		) => Effect.Effect<ReadonlyArray<EmbeddingPassSummary>, E>;
	}>,
	effectId: EffectIdType,
	input: Readonly<{
		readonly collection: string;
		readonly ids?: ReadonlyArray<string>;
		readonly limit?: number;
	}>
): Effect.Effect<EmbeddingPassSummary, E> =>
	collections
		.embedRecords(effectId, {
			...(input.limit === undefined ? {} : { limit: input.limit }),
			only: new Set([input.collection]),
			...(input.ids === undefined ? {} : { targets: new Map([[input.collection, [...input.ids]]]) })
		})
		.pipe(
			Effect.map(
				(summaries) =>
					summaries.find((summary) => summary.collection === input.collection) ?? {
						collection: input.collection,
						selected: 0,
						embedded: 0,
						failed: 0
					}
			)
		);

/** Binds the invocation-scoped authoring ops to the runtime services, for callers outside the collections layer. */
export const makeBoundAuthoringOps = (
	effectId: EffectIdType,
	subject: Subject,
	collections: CollectionsInterface,
	ai: AIInterface,
	files: FilesInterface,
	/**
	 * The host capabilities an authored `api.infer` may name. Absent for integrations and remotes:
	 * only automation and collection work carries a host tool binding, and a request without one refuses.
	 */
	hostTools?: HostToolsInterface
): AuthoringOps<AuthoringError<never>> =>
	makeAuthoringOps(
		{
			allowedCollections: collections.authoringCollectionNames,
			findMany: collections.findMany,
			count: collections.count,
			findNearest: collections.findNearest,
			history: collections.history,
			write: collections.write,
			startAutomation: (childEffectId, name, input, scope, options) =>
				collections.runAutomation(childEffectId, name, input, scope, options),
			infer: inferOp(
				effectId,
				ai,
				hostTools === undefined ? undefined : { effectId, subject, hostTools }
			),
			readFileAsset: (file) => readFileAsset(effectId, files, file),
			embed: (id, input) => embedRecordsSummary(collections, id, input)
		},
		effectId,
		subject
	);

type RuntimeRemoteApi<E = never> = Pick<RuntimeAuthoringApi<E>, 'db' | 'infer' | 'readFileAsset'>;
export type RuntimeRemoteHandler = ReturnType<
	() => (input: unknown, api: RuntimeRemoteApi<AuthoringError<never>>) => unknown
>;

/** Merges authored remotes and tools once; ambiguous exact membership is a bundle-construction error. */
export const mergeRuntimeHandlers = (
	remotes: Readonly<Record<string, RuntimeRemoteHandler>>,
	tools: Readonly<Record<string, RuntimeRemoteHandler>>
): Readonly<Record<string, RuntimeRemoteHandler>> => {
	const merged: Record<string, RuntimeRemoteHandler> = { ...remotes };
	for (const [name, handler] of Object.entries(tools)) {
		if (name.length === 0) throw new Error('An authored command name may not be empty');
		if (merged[name] !== undefined) throw new Error(`Duplicate authored command: ${name}`);
		merged[name] = handler;
	}
	return Object.freeze(merged);
};

/** One authored function as an outside caller sees it: its name, what it does, what it takes. */
export type RemoteDescription = Readonly<{
	readonly name: string;
	readonly description: string | undefined;
	readonly input: Schema.Json | undefined;
}>;

const describeRemote = (name: string, handler: RuntimeRemoteHandler): RemoteDescription => {
	const input: unknown = Reflect.get(handler, 'input');
	const description: unknown = Reflect.get(handler, 'description');
	const document = Schema.isSchema(input) ? Schema.toJsonSchemaDocument(input) : undefined;
	const definitions = document?.definitions ?? {};
	return {
		name,
		description: typeof description === 'string' ? description : undefined,
		input:
			document === undefined
				? undefined
				: (Schema.decodeUnknownSync(Schema.Json)({
						...document.schema,
						...(Object.keys(definitions).length === 0 ? {} : { $defs: definitions })
					}) as Schema.Json)
	};
};

type RuntimeRemoteRegistry = Readonly<{
	readonly names: ReadonlySet<string>;
	/** Every authored function, described for an OpenAPI document; tools are not listed. */
	readonly describe: () => ReadonlyArray<RemoteDescription>;
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
export const remoteRegistryLayer = (handlers: Readonly<Record<string, RuntimeRemoteHandler>>) =>
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
				describe: () =>
					Object.entries(handlers)
						.filter(([, handler]) => Reflect.get(handler, 'input') !== undefined)
						.map(([name, handler]) => describeRemote(name, handler)),
				invoke: Effect.fn('RemoteRegistry.invoke')(function* (name, input, subject, effectId) {
					const handler = handlers[name];
					if (handler === undefined)
						return yield* new DispatchError({
							code: 'unknown_command',
							message: `Unknown workspace command: ${name}`
						});
					const api = makeAuthoringApi(
						makeBoundAuthoringOps(effectId, subject, collections, ai, files)
					);
					const output = yield* runAuthoredHandler(() => handler(input, api)).pipe(
						Effect.mapError((cause) =>
							cause instanceof AuthoredRefusal ? cause : DispatchError.from('remote_failed', cause)
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
