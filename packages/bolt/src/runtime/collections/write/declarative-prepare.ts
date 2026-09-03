import { Deferred, Effect, Result, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type * as AccessControl from '#lib/runtime/access/access-control.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import type { AuthoredRefusal } from '#lib/authoring/refusal.js';
import {
	describeGeneratedColumnWrite,
	describeInvalidCustomValue
} from '#lib/runtime/collections/custom-values.js';
import type { BrowserMutationFence } from '#lib/runtime/collections/collections.contract.js';
import type { HookWriteOps } from '#lib/runtime/collections/hooks/boundary.js';
import type {
	GraphIncludedRelationship,
	GraphPreparedOperation,
	GraphPreparePorts,
	GraphRootSeed
} from './engine.js';
import { makeGraphPreparers } from './engine.js';
import { ownsManyRelation, WRITE_DEPTH_LIMIT, type WritableManyRelation } from './plan.js';
import type {
	GraphReadSession,
	GraphWaveReadResult,
	RelatedRowsRequest,
	RelatedRowsResult
} from './graph-read.js';
import { relatedRowsKey, storedGraphRowKey } from './graph-read.js';

export type RelationshipSnapshot = Readonly<{
	readonly edge: WritableManyRelation;
	readonly parentId: string;
	readonly json: string;
}>;

export const DeclarativeReviewRow = Schema.Struct({
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	snapshot: Schema.String
});

const DeclarativeReviewRelationship = Schema.Struct({
	name: Schema.NonEmptyString,
	parentCollection: Schema.NonEmptyString,
	parentColumn: Schema.NonEmptyString,
	childCollection: Schema.NonEmptyString,
	childColumn: Schema.NonEmptyString,
	cascade: Schema.Boolean,
	parentId: Schema.NonEmptyString,
	snapshot: Schema.String
});

export const DeclarativeReview = Schema.Struct({
	version: Schema.Literal(1),
	rows: Schema.Array(DeclarativeReviewRow),
	relationships: Schema.Array(DeclarativeReviewRelationship),
	policyFingerprint: Schema.String
});

export type DeclarativeReview = typeof DeclarativeReview.Type;

type PreparedDeclarativeGraph = Readonly<{
	readonly collection: string;
	readonly rootId: string;
	readonly operations: ReadonlyArray<GraphPreparedOperation>;
	readonly relationshipSnapshots: ReadonlyArray<RelationshipSnapshot>;
	readonly approval?: Schema.Json;
	readonly review?: DeclarativeReview;
}>;

type DeclarativePreparationOptions<ReadError> = Readonly<{
	readonly approved: boolean;
	readonly elevated: boolean;
	readonly rootId: string;
	readonly rootAction: 'create' | 'update' | 'delete';
	readonly clearRootLock: boolean;
	readonly expectedRootVersion?: number;
	readonly approvalRequestId?: string;
	readonly browserMutation?: BrowserMutationFence;
	readonly readSession: GraphReadSession<ReadError>;
	readonly primeRoots: ReadonlyArray<GraphRootSeed>;
	readonly rootPreparation: Deferred.Deferred<unknown, AuthoredRefusal>;
	readonly rootDeletePreparation: Deferred.Deferred<unknown, AuthoredRefusal>;
}>;

type ActiveGraphEnginePorts<Error, Requirements> = Omit<
	GraphPreparePorts<Error, Requirements>,
	| 'effectId'
	| 'subject'
	| 'rootCollection'
	| 'hookDepth'
	| 'elevated'
	| 'browserMutation'
	| 'operations'
	| 'graphCoordinates'
	| 'preparedDeletes'
	| 'approvalRequirements'
	| 'scope'
	| 'registerExecutionInvariant'
	| 'registerRelationshipSnapshot'
	| 'relatedRows'
	| 'storedGraphRow'
	| 'recordSnapshot'
	| 'ensureGraphRowUnlocked'
	| 'assertExpectedRootVersion'
	| 'primeRelatedRows'
	| 'stageHookWrites'
	| 'runMutatePrepare'
	| 'runDeletePrepare'
>;

export type PrepareDeclarativeGraphPorts<Error, ReadError, Requirements> = ActiveGraphEnginePorts<
	Error,
	Requirements
> &
	Readonly<{
		readonly queuedGraphWaveRead: (
			session: GraphReadSession<ReadError>,
			participant: string,
			rows: ReadonlyArray<Readonly<{ collection: string; id: string }>>,
			relations: ReadonlyArray<RelatedRowsRequest>
		) => Effect.Effect<GraphWaveReadResult, ReadError, Requirements>;
		readonly runMutatePrepare: (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			inputs: ReadonlyArray<Readonly<Record<string, Schema.Json>>>,
			module: GraphPreparePorts<Error, Requirements>['authoredHooks'][string] | undefined,
			depth: number,
			staged?: Pick<HookWriteOps<Error>, 'mutate'>
		) => Effect.Effect<unknown, AuthoredRefusal, Requirements>;
		readonly runDeletePrepare: (
			effectId: EffectId,
			subject: Identity.Subject,
			collection: string,
			existing: ReadonlyArray<Readonly<Record<string, unknown>>>,
			module: GraphPreparePorts<Error, Requirements>['authoredHooks'][string] | undefined,
			depth: number,
			staged?: Pick<HookWriteOps<Error>, 'mutate'>
		) => Effect.Effect<unknown, AuthoredRefusal, Requirements>;
		readonly refuseRunawayHooks: (
			action: string,
			collection: string,
			depth: number
		) => Effect.Effect<void, Error>;
		readonly deriveRecordId: (seed: string) => string;
		readonly predicateStatement: (predicate: AccessControl.RowPredicate) => Readonly<{
			sql: string;
			parameters: ReadonlyArray<Schema.Json>;
		}>;
		readonly approvalFingerprint: (value: Schema.Json | undefined) => string;
		readonly approvalRouteFingerprint: (value: Schema.Json | undefined) => string;
		readonly approvalConflict: (requestId: string, reason: string) => Error;
		readonly versionConflict: (
			collection: string,
			id: string,
			baseVersion: number,
			currentVersion: number | null
		) => Error;
		readonly approvalRequired: (
			input: Readonly<{
				collection: string;
				action: 'create' | 'update' | 'delete';
				approval?: Schema.Json;
				review: DeclarativeReview;
				coordinates: ReadonlyArray<Readonly<{ collection: string; id: string }>>;
			}>
		) => Effect.Effect<never, Error, Requirements>;
	}>;

export const reviewedRelationshipOf = (snapshot: RelationshipSnapshot) => ({
	name: snapshot.edge.name,
	parentCollection: snapshot.edge.parentCollection,
	parentColumn: snapshot.edge.parentColumn,
	childCollection: snapshot.edge.childCollection,
	childColumn: snapshot.edge.childColumn,
	cascade: snapshot.edge.cascade,
	parentId: snapshot.parentId,
	snapshot: snapshot.json
});

/**
 * A client-minted record id, as RFC 9562 defines one — versions 1 through 8, not 1 through 5.
 *
 * The narrower `[1-5]` predated UUIDv7 and silently made every v7 record **un-updatable**: a create
 * passes because the browser mints v4 (`crypto.randomUUID`), but an update carries the row's own
 * id, and seeded data is v7 (`019f6f10-…-7000-…`). Every one of BCA's 34 job assignments therefore
 * refused an edit with "must carry a valid client-minted UUID" while the command itself answered
 * 200 — a rejection that reads like a success everywhere except the form.
 */
const MUTATION_RECORD_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * Whether a value is a record id a browser is allowed to have minted.
 *
 * Exported because it is a contract, not a detail: it decides which existing rows a browser may
 * update at all, and the version range is the whole of it.
 */
export const isClientMintedRecordId = (value: unknown): value is string =>
	typeof value === 'string' && MUTATION_RECORD_ID.test(value);

/**
 * Validates the caller-authored graph once, before PREPARE reads or authored hooks run.
 *
 * Splitting remains responsible for turning fields and relationship rows into engine inputs. This
 * walk is the sole validation authority for the submitted graph: it follows exactly the writable
 * many edges the engine follows and refuses values which would otherwise be stripped or silently
 * ignored. Hook-derived writes are trusted server work and still pass through the structural split.
 */
const validateSubmittedGraph = <Error, ReadError, Requirements>(
	ports: PrepareDeclarativeGraphPorts<Error, ReadError, Requirements>,
	rootCollection: string,
	rootPayload: Readonly<Record<string, unknown>>,
	rootAction: 'create' | 'update' | 'delete',
	clientGraph: boolean
): Effect.Effect<void, Error | AuthoredRefusal, Requirements> =>
	Effect.gen(function* () {
		const pending: Array<
			Readonly<{
				collection: string;
				payload: Readonly<Record<string, unknown>>;
				action: 'create' | 'update' | 'delete';
				depth: number;
			}>
		> = [{ collection: rootCollection, payload: rootPayload, action: rootAction, depth: 0 }];
		while (pending.length > 0) {
			const node = pending.shift();
			if (node === undefined) break;
			if (node.depth > WRITE_DEPTH_LIMIT)
				return yield* ports.graphRefusal(
					node.collection,
					node.action,
					`A nested write on ${node.collection} is more than ${WRITE_DEPTH_LIMIT} levels deep.`
				);

			const submittedId = node.payload['id'];
			if (
				submittedId !== undefined &&
				(typeof submittedId !== 'string' || submittedId.length === 0)
			)
				return yield* ports.graphRefusal(
					node.collection,
					node.action,
					`The id of a ${node.collection} mutation must be a non-empty string.`
				);
			if (
				clientGraph &&
				((typeof submittedId === 'string' && !isClientMintedRecordId(submittedId)) ||
					(node.depth === 0 && typeof submittedId !== 'string'))
			)
				return yield* ports.graphRefusal(
					node.collection,
					node.action,
					`${node.action} mutation ${node.collection} must carry a valid client-minted UUID.`
				);

			if (node.action === 'delete') continue;
			const definition = ports.workspace.definition.collections.find(
				(collection) => collection.name === node.collection
			);
			const submitted = yield* ports.splitGraphPayload(node.collection, node.payload, node.action);
			if (definition === undefined) continue;
			const invalid =
				describeGeneratedColumnWrite(definition.fields, submitted.own) ??
				describeInvalidCustomValue(
					definition.fields,
					submitted.own,
					ports.workspace.definition.customTypes
				);
			if (invalid !== undefined)
				return yield* ports.graphRefusal(node.collection, node.action, invalid);
			for (const included of submitted.included)
				for (const payload of included.rows)
					pending.push({
						collection: included.edge.childCollection,
						payload,
						action: typeof payload['id'] === 'string' ? 'update' : 'create',
						depth: node.depth + 1
					});
		}
	});

/** Owns PREPARE for one complete declarative mutation graph. */
export const prepareDeclarativeGraph = <Error, ReadError extends Error, Requirements>(
	ports: PrepareDeclarativeGraphPorts<Error, ReadError, Requirements>,
	effectId: EffectId,
	subject: Identity.Subject,
	rootCollection: string,
	rootPayload: Readonly<Record<string, unknown>>,
	hookDepth: number,
	options: DeclarativePreparationOptions<ReadError>
): Effect.Effect<PreparedDeclarativeGraph, Error | ReadError | AuthoredRefusal, Requirements> =>
	Effect.gen(function* () {
		yield* validateSubmittedGraph(
			ports,
			rootCollection,
			rootPayload,
			options.rootAction,
			options.browserMutation !== undefined
		);
		const operations: Array<GraphPreparedOperation> = [];
		const graphCoordinates = new Set<string>();
		const relationshipSnapshots = new Map<string, RelationshipSnapshot>();
		const { readSession, rootPreparation, rootDeletePreparation } = options;
		const relatedRowsCache = readSession.relatedRows;
		const storedGraphRowsCache = readSession.storedRows;
		const cacheRelatedRows = (request: RelatedRowsRequest, value: RelatedRowsResult): void => {
			relatedRowsCache.set(relatedRowsKey(request.edge, request.parentId), value);
			for (const [index, row] of value.rows.entries()) {
				const id = row['id'];
				const raw = value.raw[index];
				if (typeof id !== 'string' || raw === undefined) continue;
				storedGraphRowsCache.set(storedGraphRowKey(request.edge.childCollection, id), {
					row,
					snapshot: JSON.stringify(raw)
				});
			}
		};
		const relatedRows = (
			_requestEffectId: EffectId,
			edge: WritableManyRelation,
			parentId: string
		) => {
			const cached = relatedRowsCache.get(relatedRowsKey(edge, parentId));
			return cached === undefined
				? ports.graphRefusal(
						edge.childCollection,
						'update',
						`The write-wave read omitted relationship ${edge.name} for ${parentId}.`
					)
				: Effect.succeed(cached);
		};
		const cascadeEdgesFrom = (collection: string): ReadonlyArray<WritableManyRelation> =>
			ports.workspace.definition.relations.flatMap((relation) => {
				if (relation.source !== collection || relation.cardinality !== 'many') return [];
				const edge = ports.resolveWritableManyRelation(
					ports.workspace.definition,
					collection,
					relation.name
				);
				return edge !== undefined && ownsManyRelation(edge) ? [edge] : [];
			});
		type PrimedRelationshipRequest = RelatedRowsRequest &
			Readonly<{ desiredIds: ReadonlySet<string> }>;
		const primeRelatedRows = (requestedSeeds?: ReadonlyArray<GraphRootSeed>) =>
			Effect.gen(function* () {
				const initial = new Map<string, PrimedRelationshipRequest>();
				const rows = new Map<string, Readonly<{ collection: string; id: string }>>();
				const collect = (
					collection: string,
					payload: Readonly<Record<string, unknown>>,
					id: string,
					action: 'create' | 'update' | 'delete',
					readExisting = true
				): void => {
					if (action !== 'create' || readExisting) {
						const rowKey = storedGraphRowKey(collection, id);
						if (!rows.has(rowKey)) rows.set(rowKey, { collection, id });
					}
					if (action === 'delete') {
						for (const edge of cascadeEdgesFrom(collection)) {
							const key = relatedRowsKey(edge, id);
							if (!initial.has(key))
								initial.set(key, { edge, parentId: id, desiredIds: new Set() });
						}
						return;
					}
					for (const [name, value] of Object.entries(payload)) {
						const edge = ports.resolveWritableManyRelation(
							ports.workspace.definition,
							collection,
							name
						);
						if (edge === undefined || !Array.isArray(value)) continue;
						const desiredIds = new Set(
							value.flatMap((child) => {
								if (child === null || typeof child !== 'object' || Array.isArray(child)) return [];
								const childId = Reflect.get(child, 'id');
								return typeof childId === 'string' && childId.length > 0 ? [childId] : [];
							})
						);
						if (action === 'update') {
							const key = relatedRowsKey(edge, id);
							if (!initial.has(key)) initial.set(key, { edge, parentId: id, desiredIds });
						}
						for (const child of value) {
							if (child === null || typeof child !== 'object' || Array.isArray(child)) continue;
							const childPayload = child as Readonly<Record<string, unknown>>;
							const childId = childPayload['id'];
							if (typeof childId !== 'string' || childId.length === 0) continue;
							const browserExisting = options.browserMutation?.baseVersions.some(
								(entry) =>
									entry.row.collection === edge.childCollection && entry.row.recordId === childId
							);
							collect(
								edge.childCollection,
								childPayload,
								childId,
								options.browserMutation === undefined || browserExisting === true
									? 'update'
									: 'create'
							);
						}
					}
				};
				const seeds = requestedSeeds ?? options.primeRoots;
				for (const seed of seeds)
					collect(seed.collection, seed.payload, seed.id, seed.action, seed.readExisting);
				const initialRead = yield* ports.queuedGraphWaveRead(
					readSession,
					options.rootId,
					[...rows.entries()]
						.filter(([key]) => !storedGraphRowsCache.has(key))
						.map(([, request]) => request),
					[...initial.entries()]
						.filter(([key]) => !relatedRowsCache.has(key))
						.map(([, request]) => request)
				);
				for (const [key, value] of initialRead.stored) storedGraphRowsCache.set(key, value);
				for (const [key, value] of initialRead.related) {
					const request = initial.get(key);
					if (request !== undefined) cacheRelatedRows(request, value);
				}
				let wave = [...initial.values()];
				const visited = new Set<string>();
				while (wave.length > 0) {
					const pending = wave.filter(
						(request) => !visited.has(relatedRowsKey(request.edge, request.parentId))
					);
					if (pending.length === 0) break;
					for (const request of pending)
						visited.add(relatedRowsKey(request.edge, request.parentId));
					const missing = pending.filter(
						(request) => !relatedRowsCache.has(relatedRowsKey(request.edge, request.parentId))
					);
					const queried =
						missing.length === 0
							? { stored: new Map(), related: new Map() }
							: yield* ports.queuedGraphWaveRead(readSession, options.rootId, [], missing);
					const loaded = new Map<string, RelatedRowsResult>();
					for (const request of pending) {
						const key = relatedRowsKey(request.edge, request.parentId);
						const value = relatedRowsCache.get(key) ?? queried.related.get(key);
						if (value !== undefined) {
							cacheRelatedRows(request, value);
							loaded.set(key, value);
						}
					}
					const next = new Map<string, PrimedRelationshipRequest>();
					for (const request of pending) {
						if (!request.edge.cascade) continue;
						const children = loaded.get(relatedRowsKey(request.edge, request.parentId))?.rows ?? [];
						for (const row of children) {
							const childId = row['id'];
							if (typeof childId !== 'string' || request.desiredIds.has(childId)) continue;
							for (const edge of cascadeEdgesFrom(request.edge.childCollection)) {
								const key = relatedRowsKey(edge, childId);
								if (!visited.has(key) && !next.has(key))
									next.set(key, { edge, parentId: childId, desiredIds: new Set() });
							}
						}
					}
					wave = [...next.values()];
				}
			});
		const approvalRequirements: Array<{
			readonly collection: string;
			readonly action: 'create' | 'update' | 'delete';
			readonly approval?: Schema.Json;
		}> = [];
		const executionInvariants: Array<Schema.Json> = [];
		const registerExecutionInvariant = (
			collection: string,
			action: 'create' | 'update' | 'delete',
			visibility: AccessControl.RowPredicate
		): void => {
			const predicate = ports.predicateStatement(visibility);
			executionInvariants.push({
				collection,
				action,
				allowed: visibility.allowed,
				sql: predicate.sql,
				parameters: [...predicate.parameters],
				fields: visibility.fields === undefined ? null : [...visibility.fields].toSorted(),
				authorization: visibility.authorization ?? null,
				approval: visibility.approval ?? null
			});
		};
		let ordinal = 0;
		const preparedDeletes = new Set<string>();
		const registerRelationshipSnapshot = (
			edge: WritableManyRelation,
			parentId: string,
			json: string
		): void => {
			const key = `${edge.childCollection}\u0000${edge.childColumn}\u0000${parentId}`;
			if (!relationshipSnapshots.has(key)) relationshipSnapshots.set(key, { edge, parentId, json });
		};
		const storedGraphRow = (_rowEffectId: EffectId, collection: string, id: string) => {
			const key = storedGraphRowKey(collection, id);
			return storedGraphRowsCache.has(key)
				? Effect.succeed(storedGraphRowsCache.get(key))
				: ports.graphRefusal(
						collection,
						'update',
						`The write-wave read omitted ${collection} ${id}.`
					);
		};
		const recordSnapshot = (collection: string, id: string) =>
			Effect.gen(function* () {
				const stored = yield* storedGraphRow(
					EffectId.make(`${effectId}:graph:snapshot:${collection}:${id}`),
					collection,
					id
				);
				return stored === undefined
					? yield* ports.graphRefusal(collection, 'update', `${collection} ${id} no longer exists.`)
					: stored.snapshot;
			});
		const ensureGraphRowUnlocked = (collection: string, id: string) =>
			Effect.gen(function* () {
				const lockedValue = (yield* storedGraphRow(
					EffectId.make(`${effectId}:graph:approval-lock:${collection}:${id}`),
					collection,
					id
				))?.row['approval_id'];
				const locked =
					typeof lockedValue === 'string' && lockedValue.length > 0 ? lockedValue : undefined;
				if (locked !== undefined && locked !== options.approvalRequestId)
					return yield* Effect.fail(
						ports.approvalConflict(
							locked,
							`${collection} ${id} is held by an approval that has not resumed`
						)
					);
			});
		const assertExpectedRootVersion = (
			collection: string,
			id: string,
			row: Readonly<Record<string, unknown>> | undefined
		) => {
			const expected = options.expectedRootVersion;
			if (expected === undefined) return Effect.void;
			const stored = row?.['row_version'];
			const current =
				typeof stored === 'number' && Number.isInteger(stored) && stored >= 1 ? stored : null;
			return current === expected
				? Effect.void
				: Effect.fail(ports.versionConflict(collection, id, expected, current));
		};
		let stagedWriteCalls = 0;
		const stagedWrites: Array<GraphRootSeed & { readonly action: 'create' | 'update' }> = [];
		const stageHookWrites: HookWriteOps<Error> = {
			mutate: (collection: string, values: Readonly<Record<string, unknown>>) =>
				ports.refuseRunawayHooks('staged mutate', collection, ++stagedWriteCalls).pipe(
					Effect.map(() => {
						const submittedId = values['id'];
						const id =
							typeof submittedId === 'string'
								? submittedId
								: ports.deriveRecordId(`${effectId}:staged:${stagedWriteCalls}:${collection}`);
						const action = typeof submittedId === 'string' ? 'update' : 'create';
						stagedWrites.push({
							collection,
							payload: { ...values, id },
							id,
							action,
							readExisting: typeof submittedId === 'string'
						});
					})
				)
		};
		const graphPreparers = makeGraphPreparers<Error | AuthoredRefusal, Requirements>({
			...ports,
			buildApi: (effectId, subject, elevated, depth) =>
				ports.buildApi(effectId, subject, elevated, depth, stageHookWrites),
			runMutateBefore: (effectId, subject, input, existing, module, depth, prepared) =>
				ports.runMutateBefore(
					effectId,
					subject,
					input,
					existing,
					module,
					depth,
					prepared,
					stageHookWrites
				),
			runMutatePrepare: (effectId, subject, collection, inputs, module, depth) =>
				ports.runMutatePrepare(effectId, subject, collection, inputs, module, depth, stageHookWrites),
			runDeletePrepare: (effectId, subject, collection, existing, module, depth) =>
				ports.runDeletePrepare(
					effectId,
					subject,
					collection,
					existing,
					module,
					depth,
					stageHookWrites
				),
			effectId,
			subject,
			rootCollection,
			hookDepth,
			elevated: options.elevated,
			...(options.browserMutation === undefined
				? {}
				: { browserMutation: options.browserMutation }),
			operations,
			graphCoordinates,
			preparedDeletes,
			approvalRequirements,
			scope: () => EffectId.make(`${effectId}:graph:${ordinal++}`),
			registerExecutionInvariant,
			registerRelationshipSnapshot,
			relatedRows,
			storedGraphRow,
			recordSnapshot,
			ensureGraphRowUnlocked,
			assertExpectedRootVersion,
			primeRelatedRows,
			stageHookWrites
		});

		yield* primeRelatedRows();
		const rootId = options.rootId;
		let rootPrepared: unknown;
		let rootPreDecoded:
			| Readonly<{
					submitted: Readonly<{
						own: Readonly<Record<string, Schema.Json>>;
						included: ReadonlyArray<GraphIncludedRelationship>;
					}>;
					decoded: Readonly<Record<string, Schema.Json>>;
			  }>
			| undefined;
		if (options.rootAction !== 'delete') {
			const rootModule = ports.authoredHooks[rootCollection];
			const preparationSeeds = options.primeRoots;
			const decodedRoots = yield* Effect.forEach(
				preparationSeeds.filter(
					(seed): seed is typeof seed & { readonly action: 'create' | 'update' } =>
						seed.action !== 'delete'
				),
				(seed) =>
					Effect.gen(function* () {
						const split = yield* ports.splitGraphPayload(
							seed.collection,
							seed.payload,
							seed.action
						);
						const decoded = yield* ports.decodeMutateInput(
							seed.collection,
							split.own,
							rootModule,
							seed.action
						);
						return { seed, split, decoded };
					})
			);
			const ownEntry = decodedRoots.find(
				(entry) => entry.seed.collection === rootCollection && entry.seed.id === options.rootId
			);
			if (ownEntry !== undefined)
				rootPreDecoded = { submitted: ownEntry.split, decoded: ownEntry.decoded };
			const rootInputs = decodedRoots.map(({ seed, decoded }) =>
				seed.action === 'update' ? { ...decoded, id: seed.id } : decoded
			);
			const preparationOwner = preparationSeeds.find((seed) => seed.action !== 'delete');
			if (preparationOwner?.id === options.rootId) {
				const attempted = yield* Effect.result(
					ports.runMutatePrepare(
						effectId,
						subject,
						rootCollection,
						rootInputs,
						rootModule,
						hookDepth,
						stageHookWrites
					)
				);
				if (Result.isFailure(attempted)) {
					yield* Deferred.fail(rootPreparation, attempted.failure);
					return yield* Effect.fail(attempted.failure);
				}
				rootPrepared = attempted.success;
				yield* Deferred.succeed(rootPreparation, rootPrepared);
			} else {
				rootPrepared = yield* Deferred.await(rootPreparation);
			}
		}
		if (options.rootAction === 'delete') {
			const deleteSeeds = options.primeRoots.filter((seed) => seed.action === 'delete');
			const deleteOwner = deleteSeeds[0];
			if (deleteOwner === undefined || deleteOwner.id === options.rootId) {
				const existing: Array<Readonly<Record<string, unknown>>> = [];
				for (const seed of deleteSeeds) {
					const storedExisting = storedGraphRowsCache.get(
						storedGraphRowKey(seed.collection, seed.id)
					);
					if (storedExisting !== undefined) existing.push(storedExisting.row);
				}
				const attempted = yield* Effect.result(
					ports.runDeletePrepare(
						effectId,
						subject,
						rootCollection,
						existing,
						ports.authoredHooks[rootCollection],
						hookDepth,
						stageHookWrites
					)
				);
				if (Result.isFailure(attempted)) {
					yield* Deferred.fail(rootDeletePreparation, attempted.failure);
					return yield* Effect.fail(attempted.failure);
				}
				rootPrepared = attempted.success;
				yield* Deferred.succeed(rootDeletePreparation, rootPrepared);
			} else {
				rootPrepared = yield* Deferred.await(rootDeletePreparation);
			}
			const stored = yield* storedGraphRow(
				EffectId.make(`${effectId}:graph:root-delete`),
				rootCollection,
				rootId
			);
			if (stored === undefined) {
				if (options.expectedRootVersion !== undefined)
					yield* assertExpectedRootVersion(rootCollection, rootId, undefined);
				return yield* ports.graphRefusal(
					rootCollection,
					'delete',
					`${rootCollection} ${rootId} no longer exists.`
				);
			}
			yield* graphPreparers.prepareDelete(rootCollection, stored.row, 0, true, rootPrepared);
		} else {
			yield* graphPreparers.prepareNode(
				rootCollection,
				rootPayload,
				0,
				undefined,
				{ id: rootId, action: options.rootAction, clearLock: options.clearRootLock },
				true,
				rootPreDecoded,
				rootPrepared
			);
		}
		while (stagedWrites.length > 0) {
			const wave = stagedWrites.splice(0);
			yield* primeRelatedRows(wave);
			const stagedBatches = new Map<
				string,
				Array<
					Readonly<{
						staged: GraphRootSeed;
						submitted: Readonly<{
							own: Readonly<Record<string, Schema.Json>>;
							included: ReadonlyArray<GraphIncludedRelationship>;
						}>;
						decoded: Readonly<Record<string, Schema.Json>>;
					}>
				>
			>();
			for (const staged of wave) {
				const stagedModule = ports.authoredHooks[staged.collection];
				if (stagedModule?.mutate?.prepare === undefined) continue;
				const submitted = yield* ports.splitGraphPayload(
					staged.collection,
					staged.payload,
					staged.action
				);
				const decoded = yield* ports.decodeMutateInput(
					staged.collection,
					submitted.own,
					stagedModule,
					staged.action
				);
				const bucket = stagedBatches.get(staged.collection) ?? [];
				bucket.push({ staged, submitted, decoded });
				stagedBatches.set(staged.collection, bucket);
			}
			const stagedPrepared = new Map<string, unknown>();
			for (const [stagedCollection, batch] of stagedBatches) {
				const stagedModule = ports.authoredHooks[stagedCollection];
				if (stagedModule === undefined) continue;
				const inputs = batch.map(({ staged, decoded }) =>
					staged.action === 'update' ? { ...decoded, id: staged.id } : decoded
				);
				stagedPrepared.set(
					stagedCollection,
					yield* ports.runMutatePrepare(
						effectId,
						subject,
						stagedCollection,
						inputs,
						stagedModule,
						hookDepth,
						stageHookWrites
					)
				);
			}
			for (const staged of wave) {
				const entry = stagedBatches
					.get(staged.collection)
					?.find((candidate) => candidate.staged === staged);
				yield* graphPreparers.prepareNode(
					staged.collection,
					staged.payload,
					0,
					undefined,
					{ id: staged.id, action: staged.action, clearLock: false },
					false,
					entry === undefined ? undefined : { submitted: entry.submitted, decoded: entry.decoded },
					entry === undefined ? undefined : stagedPrepared.get(staged.collection)
				);
			}
		}
		const policyFingerprint = ports.approvalFingerprint(
			executionInvariants.toSorted((left, right) =>
				ports.approvalFingerprint(left).localeCompare(ports.approvalFingerprint(right))
			)
		);
		const firstApproval = approvalRequirements[0];
		let approvalReview: DeclarativeReview | undefined;
		if (firstApproval !== undefined) {
			const fingerprint = ports.approvalRouteFingerprint(firstApproval.approval);
			const mixed = approvalRequirements.find(
				(requirement) => ports.approvalRouteFingerprint(requirement.approval) !== fingerprint
			);
			if (mixed !== undefined)
				return yield* ports.graphRefusal(
					rootCollection,
					options.rootAction,
					`The mutation graph resolves to different approval routes (${firstApproval.collection}.${firstApproval.action} and ${mixed.collection}.${mixed.action}); one atomic graph must have one concrete flow.`
				);
			const review: DeclarativeReview = {
				version: 1,
				rows: operations
					.flatMap((operation) =>
						operation.snapshot === undefined
							? []
							: [
									{
										collection: operation.collection,
										id: operation.id,
										snapshot: operation.snapshot
									}
								]
					)
					.toSorted((left, right) =>
						`${left.collection}\u0000${left.id}`.localeCompare(
							`${right.collection}\u0000${right.id}`
						)
					),
				relationships: [...relationshipSnapshots.values()]
					.map(reviewedRelationshipOf)
					.toSorted((left, right) =>
						`${left.childCollection}\u0000${left.childColumn}\u0000${left.parentId}`.localeCompare(
							`${right.childCollection}\u0000${right.childColumn}\u0000${right.parentId}`
						)
					),
				policyFingerprint
			};
			approvalReview = review;
			if (!options.approved)
				return yield* ports.approvalRequired({
					collection: firstApproval.collection,
					action: firstApproval.action,
					...(firstApproval.approval === undefined ? {} : { approval: firstApproval.approval }),
					review,
					coordinates: operations
						.map((operation) => ({ collection: operation.collection, id: operation.id }))
						.toSorted((left, right) =>
							`${left.collection}\u0000${left.id}`.localeCompare(
								`${right.collection}\u0000${right.id}`
							)
						)
				});
		}
		return {
			collection: rootCollection,
			rootId,
			operations,
			relationshipSnapshots: [...relationshipSnapshots.values()],
			...(firstApproval?.approval === undefined ? {} : { approval: firstApproval.approval }),
			...(approvalReview === undefined ? {} : { review: approvalReview })
		};
	});
