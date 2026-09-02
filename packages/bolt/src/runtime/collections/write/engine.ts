/** Chunked imports and concrete declarative graph preparation. */
import { Effect, Schema } from 'effect';
import { EffectId, type ChangeBatch } from '@norbital-ai/bolt-protocol';
import type { FieldDefinition, WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import type { AuthoredRefusal, RefusalSite } from '#lib/authoring/refusal.js';
import type * as AccessControl from '#lib/runtime/access/access-control.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import type {
	CollectionHookModule,
	HookWriteOps
} from '#lib/runtime/collections/hooks/boundary.js';
import {
	type BrowserMutationFence,
	type MutationInput
} from '#lib/runtime/collections/collections.contract.js';
import { WRITE_DEPTH_LIMIT, ownsManyRelation, type WritableManyRelation } from './plan.js';

export type GraphPreparedOperation = Readonly<{
	readonly action: 'create' | 'update' | 'delete';
	readonly collection: string;
	readonly id: string;
	readonly values: Readonly<Record<string, Schema.Json>>;
	readonly definition: WorkspaceDefinition['collections'][number];
	readonly visibility: AccessControl.RowPredicate;
	readonly previous?: Readonly<Record<string, unknown>>;
	readonly module?: CollectionHookModule;
	readonly depth: number;
	readonly taskScope: EffectId;
	readonly clearLock?: boolean;
	readonly snapshot?: string;
}>;

export type AppliedDeclarativeGraph = Readonly<{
	readonly operations: ReadonlyArray<GraphPreparedOperation>;
	readonly records: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
	readonly batch: ChangeBatch;
}>;

export type GraphIncludedRelationship = Readonly<{
	readonly edge: WritableManyRelation;
	readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
}>;

export type GraphRootSeed = Readonly<{
	readonly collection: string;
	readonly payload: Readonly<Record<string, unknown>>;
	readonly id: string;
	readonly action: 'create' | 'update' | 'delete';
	readonly readExisting?: boolean;
}>;

type GraphRelatedRows = Readonly<{
	readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
	readonly json: string;
}>;

type GraphStoredRow = Readonly<{
	readonly row: Readonly<Record<string, unknown>>;
	readonly snapshot: string;
}>;

type GraphNodeIdentity = Readonly<{
	readonly id: string;
	readonly action: 'create' | 'update';
	readonly clearLock: boolean;
	readonly ownerTransition?: 'preserve' | 'claim';
}>;
type PlannedGraphNodeIdentity = GraphNodeIdentity &
	Readonly<{ readonly ownerTransition: 'preserve' | 'claim' }>;
type GraphDecodedInput = Readonly<{
	readonly submitted: Readonly<{
		readonly own: Readonly<Record<string, Schema.Json>>;
		readonly included: ReadonlyArray<GraphIncludedRelationship>;
	}>;
	readonly decoded: Readonly<Record<string, Schema.Json>>;
}>;

export type GraphPreparePorts<Error = unknown, Requirements = never> = Readonly<{
	readonly effectId: EffectId;
	readonly subject: Identity.Subject;
	readonly rootCollection: string;
	readonly hookDepth: number;
	readonly elevated: boolean;
	readonly browserMutation?: BrowserMutationFence;
	readonly operations: Array<GraphPreparedOperation>;
	readonly graphCoordinates: Set<string>;
	readonly preparedDeletes: Set<string>;
	readonly approvalRequirements: Array<{
		collection: string;
		action: 'create' | 'update' | 'delete';
		approval?: Schema.Json;
	}>;
	readonly workspace: {
		readonly definition: WorkspaceDefinition;
		readonly collection: (
			name: string
		) => Effect.Effect<WorkspaceDefinition['collections'][number], Error, Requirements>;
	};
	readonly authoredHooks: Readonly<Record<string, CollectionHookModule | undefined>>;
	readonly policyWrite: (
		subject: Identity.Subject,
		action: 'create' | 'update' | 'delete',
		collection: string,
		row: Readonly<Record<string, unknown>>,
		elevation: 'after' | 'none'
	) => Effect.Effect<{ readonly predicate: AccessControl.RowPredicate }, Error, Requirements>;
	readonly scope: () => EffectId;
	readonly registerExecutionInvariant: (
		collection: string,
		action: 'create' | 'update' | 'delete',
		visibility: AccessControl.RowPredicate
	) => void;
	readonly registerRelationshipSnapshot: (
		edge: WritableManyRelation,
		parentId: string,
		json: string
	) => void;
	readonly resolveWritableManyRelation: (
		definition: WorkspaceDefinition,
		parentCollection: string,
		name: string
	) => WritableManyRelation | undefined;
	readonly graphRefusal: (
		collection: string,
		action: 'create' | 'update' | 'delete',
		message: string
	) => Effect.Effect<never, AuthoredRefusal>;
	readonly relatedRows: (
		effectId: EffectId,
		edge: WritableManyRelation,
		parentId: string
	) => Effect.Effect<GraphRelatedRows, Error, Requirements>;
	readonly storedGraphRow: (
		effectId: EffectId,
		collection: string,
		id: string
	) => Effect.Effect<GraphStoredRow | undefined, Error, Requirements>;
	readonly recordSnapshot: (
		collection: string,
		id: string
	) => Effect.Effect<string, Error, Requirements>;
	readonly ensureGraphRowUnlocked: (
		collection: string,
		id: string
	) => Effect.Effect<void, Error, Requirements>;
	readonly assertExpectedRootVersion: (
		collection: string,
		id: string,
		row: Readonly<Record<string, unknown>> | undefined
	) => Effect.Effect<void, Error, Requirements>;
	readonly assertBrowserBaseVersion: (
		effectId: EffectId,
		fence: BrowserMutationFence,
		collection: string,
		id: string,
		previous: Readonly<Record<string, unknown>> | undefined
	) => Effect.Effect<void, Error, Requirements>;
	readonly buildApi: (
		effectId: EffectId,
		subject: Identity.Subject,
		elevated: boolean,
		depth: number,
		staged?: HookWriteOps<Error>
	) => unknown;
	readonly runHook: (
		hook: { readonly handler: (context: unknown) => unknown } | undefined,
		context: unknown,
		site: RefusalSite
	) => Effect.Effect<unknown, AuthoredRefusal>;
	readonly authorizePolicyWrite: (
		effectId: EffectId,
		subject: Identity.Subject,
		visibility: AccessControl.RowPredicate,
		action: 'create' | 'update' | 'delete',
		collection: string,
		context: Readonly<Record<string, unknown>>
	) => Effect.Effect<void, Error, Requirements>;
	readonly resolveApproval: (
		effectId: EffectId,
		subject: Identity.Subject,
		visibility: AccessControl.RowPredicate,
		action: 'create' | 'update' | 'delete',
		collection: string,
		context: Readonly<Record<string, unknown>>
	) => Effect.Effect<Schema.Json | undefined, Error, Requirements>;
	readonly splitGraphPayload: (
		collection: string,
		payload: Readonly<Record<string, unknown>>,
		action: 'create' | 'update'
	) => Effect.Effect<
		{
			readonly own: Readonly<Record<string, Schema.Json>>;
			readonly included: ReadonlyArray<GraphIncludedRelationship>;
		},
		Error,
		Requirements
	>;
	readonly decodeMutateInput: (
		collection: string,
		values: Readonly<Record<string, Schema.Json>>,
		module: CollectionHookModule | undefined,
		action: 'create' | 'update'
	) => Effect.Effect<Readonly<Record<string, Schema.Json>>, Error, Requirements>;
	readonly encodeMutationValues: (
		values: Readonly<Record<string, unknown>>,
		fields: Readonly<Record<string, FieldDefinition>>
	) => Readonly<Record<string, Schema.Json>>;
	readonly referenceValueProblem: (
		values: Readonly<Record<string, unknown>>,
		fields: Readonly<Record<string, FieldDefinition>>
	) => string | undefined;
	readonly runMutateBefore: (
		effectId: EffectId,
		subject: Identity.Subject,
		input: MutationInput,
		existing: Readonly<Record<string, unknown>> | undefined,
		module: CollectionHookModule | undefined,
		depth: number,
		prepared: unknown,
		staged?: HookWriteOps<Error>
	) => Effect.Effect<Readonly<Record<string, Schema.Json>>, Error, Requirements>;
	readonly runMutatePrepare: (
		effectId: EffectId,
		subject: Identity.Subject,
		collection: string,
		inputs: ReadonlyArray<Readonly<Record<string, Schema.Json>>>,
		module: CollectionHookModule | undefined,
		depth: number,
		staged?: HookWriteOps<Error>
	) => Effect.Effect<unknown, Error, Requirements>;
	readonly primeRelatedRows: (
		seeds?: ReadonlyArray<GraphRootSeed>
	) => Effect.Effect<void, Error, Requirements>;
	readonly stageHookWrites: HookWriteOps<Error>;
	readonly randomId: () => string;
}>;

type GraphPrepareFns<E = unknown, R = never> = Readonly<{
	readonly prepareDelete: (
		collection: string,
		row: Readonly<Record<string, unknown>>,
		depth: number,
		requiresBrowserBaseVersion: boolean
	) => Effect.Effect<void, E, R>;
	readonly prepareNode: (
		collection: string,
		payload: Readonly<Record<string, unknown>>,
		depth: number,
		ownership?: Readonly<{ readonly column: string; readonly parentId: string }>,
		identity?: GraphNodeIdentity,
		requiresBrowserBaseVersion?: boolean,
		preDecoded?: GraphDecodedInput,
		wavePrepared?: unknown
	) => Effect.Effect<string, E, R>;
}>;

/** Prepares the authorized operations in one declarative graph. */
export const makeGraphPreparers = <Error, Requirements>(
	ports: GraphPreparePorts<Error, Requirements>
): GraphPrepareFns<Error | AuthoredRefusal, Requirements> => {
	const prepareDelete: GraphPrepareFns<Error | AuthoredRefusal, Requirements>['prepareDelete'] =
		Effect.fn('Collections.prepareGraphDelete')(
			function* (collection, row, depth, requiresBrowserBaseVersion) {
				const operationPosition = ports.operations.length;
				const id = row['id'];
				if (typeof id !== 'string' || id.length === 0)
					return yield* ports.graphRefusal(
						collection,
						'delete',
						`A stored ${collection} row selected for reconciliation has no identifier.`
					);
				if (depth > WRITE_DEPTH_LIMIT)
					return yield* ports.graphRefusal(
						collection,
						'delete',
						`A cascading relationship delete on ${collection} is more than ${WRITE_DEPTH_LIMIT} levels deep.`
					);
				const identity = `${collection}\u0000${id}`;
				if (ports.preparedDeletes.has(identity)) return;
				ports.preparedDeletes.add(identity);
				const definition = yield* ports.workspace.collection(collection);
				if (depth === 0 && collection === ports.rootCollection)
					yield* ports.assertExpectedRootVersion(collection, id, row);
				const snapshot = yield* ports.recordSnapshot(collection, id);
				if (ports.browserMutation !== undefined && requiresBrowserBaseVersion)
					yield* ports.assertBrowserBaseVersion(
						EffectId.make(`${ports.effectId}:base-version:${collection}:${id}`),
						ports.browserMutation,
						collection,
						id,
						row
					);
				yield* ports.ensureGraphRowUnlocked(collection, id);
				const accessPlan = yield* ports.policyWrite(
					ports.subject,
					'delete',
					collection,
					row,
					ports.elevated ? 'after' : 'none'
				);
				const visibility = accessPlan.predicate;
				ports.registerExecutionInvariant(collection, 'delete', visibility);
				const module = ports.authoredHooks[collection];
				if (module?.delete?.perRecord?.before !== undefined) {
					const api = ports.buildApi(
						ports.effectId,
						ports.subject,
						false,
						ports.hookDepth + depth + 1,
						ports.stageHookWrites
					);
					yield* ports.runHook(
						module.delete.perRecord.before,
						{ existing: row, api },
						{
							collection,
							action: 'delete.before'
						}
					);
				}
				const context = { record: row };
				yield* ports.authorizePolicyWrite(
					EffectId.make(`${ports.effectId}:graph:policy-authorization:${collection}:${id}`),
					ports.subject,
					visibility,
					'delete',
					collection,
					context
				);
				const approval = yield* ports.resolveApproval(
					EffectId.make(`${ports.effectId}:graph:approval-flow:${collection}:${id}`),
					ports.subject,
					visibility,
					'delete',
					collection,
					context
				);
				if (approval !== undefined)
					ports.approvalRequirements.push({
						collection,
						action: 'delete',
						approval
					});
				// Deleting an owned row necessarily deletes the rows it owns. Plan every descendant through
				// the same authorization, approval, hooks, history, sync and event pipeline before the
				// database's foreign-key cascade can make them disappear invisibly.
				for (const relation of ports.workspace.definition.relations) {
					if (relation.source !== collection || relation.cardinality !== 'many') continue;
					const edge = ports.resolveWritableManyRelation(
						ports.workspace.definition,
						collection,
						relation.name
					);
					if (edge === undefined || !ownsManyRelation(edge)) continue;
					const related = yield* ports.relatedRows(ports.scope(), edge, id);
					ports.registerRelationshipSnapshot(edge, id, related.json);
					for (const child of related.rows)
						yield* prepareDelete(edge.childCollection, child, depth + 1, false);
				}
				ports.operations.splice(operationPosition, 0, {
					action: 'delete',
					collection,
					id,
					values: {},
					definition,
					visibility,
					previous: row,
					snapshot,
					...(module === undefined ? {} : { module }),
					depth,
					taskScope: ports.scope()
				});
			}
		);

	const prepareNode: GraphPrepareFns<Error | AuthoredRefusal, Requirements>['prepareNode'] =
		Effect.fn('Collections.prepareGraphNode')(
			// repository-health:allow COMPLEX1 -- This recursive graph planner is the single policy/hook/relationship owner; guard clauses bound every branch and splitting it would duplicate the shared atomic plan state.
			function* (
				collection,
				payload,
				depth,
				ownership,
				identity,
				requiresBrowserBaseVersion = true,
				preDecoded,
				wavePrepared
			) {
				const operationPosition = ports.operations.length;
				if (depth > WRITE_DEPTH_LIMIT)
					return yield* ports.graphRefusal(
						collection,
						'create',
						`A nested write on ${collection} is more than ${WRITE_DEPTH_LIMIT} levels deep.`
					);
				const submittedId = payload['id'];
				if (
					submittedId !== undefined &&
					(typeof submittedId !== 'string' || submittedId.length === 0)
				)
					return yield* ports.graphRefusal(
						collection,
						'update',
						`The id of a ${collection} mutation must be a non-empty string.`
					);
				const action = identity?.action ?? (typeof submittedId === 'string' ? 'update' : 'create');
				const id =
					identity?.id ?? (typeof submittedId === 'string' ? submittedId : ports.randomId());
				const coordinate = `${collection}\u0000${id}`;
				if (ports.graphCoordinates.has(coordinate))
					return yield* ports.graphRefusal(
						collection,
						action,
						`The mutation graph names ${collection} ${id} more than once.`
					);
				ports.graphCoordinates.add(coordinate);
				const definition = yield* ports.workspace.collection(collection);
				const module = ports.authoredHooks[collection];
				const submitted =
					preDecoded?.submitted ?? (yield* ports.splitGraphPayload(collection, payload, action));
				// A before hook may add a relationship graph the browser never observed. Those rows are
				// trusted server-derived work and cannot honestly be required to carry client base versions.
				const browserRelationshipNames = new Set(
					requiresBrowserBaseVersion ? submitted.included.map((entry) => entry.edge.name) : []
				);
				let own: Readonly<Record<string, Schema.Json>> = submitted.own;
				let included = submitted.included;
				let previous: Readonly<Record<string, unknown>> | undefined;
				let snapshot: string | undefined;
				if (action === 'create' && typeof submittedId === 'string' && requiresBrowserBaseVersion) {
					const collision = (yield* ports.storedGraphRow(
						EffectId.make(`${ports.effectId}:create-identity:${collection}:${id}`),
						collection,
						id
					))?.row;
					if (collision !== undefined)
						return yield* ports.graphRefusal(
							collection,
							'create',
							`The requested ${collection} identity is already in use.`
						);
				}
				const accessPlan = yield* ports.policyWrite(
					ports.subject,
					action,
					collection,
					own,
					ports.elevated ? 'after' : 'none'
				);
				const visibility = accessPlan.predicate;
				ports.registerExecutionInvariant(collection, action, visibility);
				if (action === 'update') yield* ports.ensureGraphRowUnlocked(collection, id);
				// The field grant is `policy.write`'s decision, made directly above: it refuses any
				// submitted field the matching grant does not name, for creates and updates alike, and
				// for every node of the graph — always on the caller-owned shape, before input decoding
				// and hooks, so server-derived fields a hook adds are never mistaken for forged ones.

				// Only an update has anything to read first: the row it lands on, the fence the browser
				// declared against it, and the snapshot the ledger keeps. Everything after this — the
				// decode, `prepare`, `before`, and the graph split of what `before` returned — is one
				// path, because it is one write.
				if (action === 'update') {
					previous = (yield* ports.storedGraphRow(
						EffectId.make(`${ports.effectId}:graph:row:${collection}:${id}`),
						collection,
						id
					))?.row;
					if (depth === 0 && collection === ports.rootCollection)
						yield* ports.assertExpectedRootVersion(collection, id, previous);
					if (ports.browserMutation !== undefined && requiresBrowserBaseVersion)
						yield* ports.assertBrowserBaseVersion(
							EffectId.make(`${ports.effectId}:base-version:${collection}:${id}`),
							ports.browserMutation,
							collection,
							id,
							previous
						);
					snapshot = yield* ports.recordSnapshot(collection, id);
				}
				own =
					preDecoded?.decoded ?? (yield* ports.decodeMutateInput(collection, own, module, action));
				if (module?.mutate?.perRecord?.before !== undefined) {
					// The id rides the input on an update and only there. It is the one thing a
					// `prepare` can read to tell a recalculation from a first build, because it sees a
					// batch of inputs and no rows; `before` is told the same fact as `existing`.
					const hookInput = action === 'update' ? { ...own, id } : own;
					const hooked = yield* ports.runMutateBefore(
						ports.effectId,
						ports.subject,
						{ collection, id, values: hookInput },
						previous,
						module,
						ports.hookDepth + depth,
						wavePrepared,
						ports.stageHookWrites
					);
					// Only a `before` hook can reshape the graph, so the one re-split below runs only
					// when one ran: a payload the hook never saw is not split and decoded a second time.
					const returned = yield* ports.splitGraphPayload(collection, hooked, action);
					yield* ports.primeRelatedRows([
						{
							collection,
							payload: { ...hooked, id },
							id,
							action,
							readExisting: requiresBrowserBaseVersion || action !== 'create'
						}
					]);
					own = returned.own;
					const byName = new Map(included.map((entry) => [entry.edge.name, entry]));
					for (const entry of returned.included) byName.set(entry.edge.name, entry);
					included = [...byName.values()];
				}

				// Relationship ownership comes from the graph position, never from a writable payload.
				// Existing children are proved to belong to this parent below. Their owner key is stripped
				// rather than trusted. A trusted authored graph may additionally claim an unowned stored row;
				// that one explicit transition writes null -> parent id through the ordinary update pipeline.
				if (ownership !== undefined) {
					const owned = { ...own };
					delete owned[ownership.column];
					own =
						action === 'create' || identity?.ownerTransition === 'claim'
							? { ...owned, [ownership.column]: ownership.parentId }
							: owned;
				}
				own = ports.encodeMutationValues(own, definition.fields);
				const referenceProblem = ports.referenceValueProblem(own, definition.fields);
				if (referenceProblem !== undefined)
					return yield* ports.graphRefusal(collection, action, referenceProblem);
				const context =
					action === 'update'
						? {
								previous: previous ?? { id },
								changes: own,
								record: { ...(previous ?? {}), id, ...own }
							}
						: { record: { id, ...own } };
				yield* ports.authorizePolicyWrite(
					EffectId.make(`${ports.effectId}:graph:policy-authorization:${collection}:${id}`),
					ports.subject,
					visibility,
					action,
					collection,
					context
				);
				const approval = yield* ports.resolveApproval(
					EffectId.make(`${ports.effectId}:graph:approval-flow:${collection}:${id}`),
					ports.subject,
					visibility,
					action,
					collection,
					context
				);
				if (approval !== undefined)
					ports.approvalRequirements.push({
						collection,
						action,
						approval
					});
				ports.operations.splice(operationPosition, 0, {
					action,
					collection,
					id,
					values: own,
					definition,
					visibility,
					...(previous === undefined ? {} : { previous }),
					...(snapshot === undefined ? {} : { snapshot }),
					...(module === undefined ? {} : { module }),
					depth,
					taskScope: ports.scope(),
					...(identity?.clearLock === true ? { clearLock: true } : {})
				});

				/**
				 * Pass one resolves every included relation's stored membership and each desired
				 * child's identity. No node is prepared yet: the children of this node are one wave,
				 * so their `prepare` hook runs once per (collection × wave) below instead of once
				 * per node.
				 */
				type PlannedChild = Readonly<{
					readonly relation: WritableManyRelation;
					readonly child: Readonly<Record<string, unknown>>;
					readonly identity: PlannedGraphNodeIdentity | undefined;
					readonly requiresBrowserBaseVersion: boolean;
				}>;
				const childWaves: Array<PlannedChild> = [];
				const relationOmissions: Array<{
					readonly relation: WritableManyRelation;
					readonly byId: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
					readonly desiredIds: ReadonlySet<string>;
				}> = [];
				for (const relation of included) {
					const relationshipRequiresBrowserBaseVersion =
						requiresBrowserBaseVersion && browserRelationshipNames.has(relation.edge.name);
					const related =
						action === 'create'
							? undefined
							: yield* ports.relatedRows(ports.scope(), relation.edge, id);
					if (related !== undefined)
						ports.registerRelationshipSnapshot(relation.edge, id, related.json);
					const existing = related?.rows ?? [];
					const byId = new Map(
						existing.flatMap((row) =>
							typeof row['id'] === 'string' ? [[row['id'], row] as const] : []
						)
					);
					const desiredIds = new Set<string>();
					for (const child of relation.rows) {
						const childId = child['id'];
						let childIdentity: PlannedGraphNodeIdentity | undefined;
						if (childId !== undefined && (typeof childId !== 'string' || childId.length === 0))
							return yield* ports.graphRefusal(
								relation.edge.childCollection,
								'update',
								`The id of a nested ${relation.edge.childCollection} mutation must be a non-empty string.`
							);
						if (typeof childId === 'string') {
							if (desiredIds.has(childId))
								return yield* ports.graphRefusal(
									relation.edge.childCollection,
									'update',
									`The desired ${relation.edge.name} relationship contains ${childId} more than once.`
								);
							if (byId.has(childId)) {
								childIdentity = {
									id: childId,
									action: 'update',
									clearLock: false,
									ownerTransition: 'preserve'
								};
							} else if (ports.browserMutation !== undefined) {
								// The wave's read planning has already classified this row. Under a browser
								// mutation it reads a child id only when the browser declared that row existing,
								// so an id it did not read is one nothing claims exists yet — whether the browser
								// sent it or a `before` hook minted it.
								//
								// This condition used to be `relationshipRequiresBrowserBaseVersion`, which is
								// false exactly for the edges a hook introduces. The one fact "the browser never
								// declared this row" then made read planning skip the read and made the authored
								// branch below demand it, so a hook that mints ids for the rows it creates could
								// never write: `payroll_runs` create computed a whole run — 89 payslips, 2,784
								// captured inputs — and was refused with "The write-wave read omitted
								// payslip_work_day_inputs …". Minting those ids is not incidental; the run's
								// adjustments carry foreign keys naming the junction rows in the same statement.
								//
								// A server-only mutation (`browserMutation === undefined`) still takes the claim
								// path below, where read planning does read child ids and absence is a real
								// refusal.
								const declaredExisting = ports.browserMutation.baseVersions.some(
									(entry) =>
										entry.row.collection === relation.edge.childCollection &&
										entry.row.recordId === childId
								);
								if (declaredExisting === true)
									return yield* ports.graphRefusal(
										relation.edge.childCollection,
										'update',
										`${childId} is not currently owned by ${collection} ${id}, so this relationship mutation cannot move or overwrite it.`
									);
								childIdentity = {
									id: childId,
									action: 'create',
									clearLock: false,
									ownerTransition: 'preserve'
								};
							} else {
								// Only a relation introduced by trusted authored code reaches this branch. Resolve the
								// explicit identity as an existing row: absence is never reinterpreted as a create, and
								// a non-null owner is never overwritten. This is the sole ownership-claim transition.
								const stored = yield* ports.storedGraphRow(
									EffectId.make(
										`${ports.effectId}:claim-owner:${relation.edge.childCollection}:${childId}`
									),
									relation.edge.childCollection,
									childId
								);
								if (stored === undefined)
									return yield* ports.graphRefusal(
										relation.edge.childCollection,
										'update',
										`${childId} does not identify an existing ${relation.edge.childCollection} row, so it cannot be claimed by ${collection} ${id}.`
									);
								const storedOwner = stored.row[relation.edge.childColumn];
								if (storedOwner !== null && storedOwner !== id)
									return yield* ports.graphRefusal(
										relation.edge.childCollection,
										'update',
										`${childId} is already owned by another ${collection} row, so this relationship mutation cannot move or overwrite it.`
									);
								childIdentity = {
									id: childId,
									action: 'update',
									clearLock: false,
									ownerTransition: storedOwner === null ? 'claim' : 'preserve'
								};
							}
							desiredIds.add(childId);
						}
						childWaves.push({
							relation: relation.edge,
							child,
							identity: childIdentity,
							requiresBrowserBaseVersion: relationshipRequiresBrowserBaseVersion
						});
					}
					// Inclusion authorizes reconciliation of the children it names, but absence is
					// destructive only for an owned edge. A non-cascade `many` is a convenient write
					// surface over independently-lived rows; treating its array as ownership would let a
					// partial editor delete siblings it does not own.
					const omitted = [...byId.keys()].filter((childId) => !desiredIds.has(childId));
					if (!relation.edge.cascade && omitted.length > 0)
						return yield* ports.graphRefusal(
							relation.edge.childCollection,
							'update',
							`${relation.edge.name} omitted existing rows (${omitted.join(', ')}), but the relationship is not cascade-owned.`
						);
					relationOmissions.push({ relation: relation.edge, byId, desiredIds });
				}

				/**
				 * The wave's `prepare`, once per (collection × wave). Collections with no prepared
				 * hook take the ordinary per-node decode; only a declared `prepare` earns a batch.
				 */
				type PreparedChildBatch = GraphDecodedInput & Readonly<{ readonly child: PlannedChild }>;
				const childBatches = new Map<string, ReadonlyArray<PreparedChildBatch>>();
				const childWavePrepared = new Map<string, unknown>();
				{
					const batchByCollection = new Map<string, Array<PreparedChildBatch>>();
					for (const planned of childWaves) {
						const childCollection = planned.relation.childCollection;
						const childAction = planned.identity?.action ?? 'create';
						const childModule = ports.authoredHooks[childCollection];
						if (childModule?.mutate?.prepare === undefined) continue;
						const submitted = yield* ports.splitGraphPayload(
							childCollection,
							planned.child,
							childAction
						);
						const decoded = yield* ports.decodeMutateInput(
							childCollection,
							submitted.own,
							childModule,
							childAction
						);
						const bucket = batchByCollection.get(childCollection) ?? [];
						bucket.push({ child: planned, submitted, decoded });
						batchByCollection.set(childCollection, bucket);
					}
					for (const [childCollection, batch] of batchByCollection) {
						const childModule = ports.authoredHooks[childCollection];
						if (childModule === undefined) continue;
						const inputs = batch.map(({ child, decoded }) =>
							child.identity?.action === 'update' ? { ...decoded, id: child.identity.id } : decoded
						);
						const prepared = yield* ports.runMutatePrepare(
							ports.effectId,
							ports.subject,
							childCollection,
							inputs,
							childModule,
							ports.hookDepth + depth + 1,
							ports.stageHookWrites
						);
						childWavePrepared.set(childCollection, prepared);
						childBatches.set(childCollection, batch);
					}
				}

				/**
				 * Pass two plans each relation's children in declaration order, then its omission
				 * deletes — the order the per-node path produced, minus its per-node `prepare`.
				 */
				for (const [relationIndex, relation] of included.entries()) {
					for (const planned of childWaves) {
						if (planned.relation !== relation.edge) continue;
						const batch = childBatches.get(planned.relation.childCollection) ?? [];
						const match = batch.find((entry) => entry.child === planned);
						yield* prepareNode(
							planned.relation.childCollection,
							planned.child,
							depth + 1,
							{
								column: planned.relation.childColumn,
								parentId: id
							},
							planned.identity,
							planned.requiresBrowserBaseVersion,
							match === undefined
								? undefined
								: { submitted: match.submitted, decoded: match.decoded },
							match === undefined
								? undefined
								: childWavePrepared.get(planned.relation.childCollection)
						);
					}
					const omission = relationOmissions[relationIndex];
					if (omission === undefined) continue;
					for (const [childId, childRow] of omission.byId) {
						if (ownsManyRelation(relation.edge) && !omission.desiredIds.has(childId))
							yield* prepareDelete(
								relation.edge.childCollection,
								childRow,
								depth + 1,
								requiresBrowserBaseVersion && browserRelationshipNames.has(relation.edge.name)
							);
					}
				}
				return id;
			}
		);

	return { prepareDelete, prepareNode };
};
