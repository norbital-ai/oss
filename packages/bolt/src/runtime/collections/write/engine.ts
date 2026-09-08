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
import { prepareOwnedDescendants } from './cascade-delete.js';
import { membershipIdentitySnapshot } from './identity-snapshot.js';
import { WRITE_DEPTH_LIMIT, ownsManyRelation, type WritableManyRelation } from './plan.js';

const isString = Schema.is(Schema.String);
const isNonEmptyString = Schema.is(Schema.NonEmptyString);

/** Prepared own fields of the enclosing graph node; callers cannot supply this context. */
export type GraphMutationParent = Readonly<{
	readonly collection: string;
	readonly id: string;
	readonly column: string;
	readonly values: Readonly<Record<string, unknown>>;
}>;

type GraphDeleteParent = GraphMutationParent & Readonly<{ readonly action: 'update' | 'delete' }>;

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
type GraphSubmittedInput = Readonly<{
	readonly own: Readonly<Record<string, Schema.Json>>;
	readonly included: ReadonlyArray<GraphIncludedRelationship>;
}>;
/** A payload already split, and decoded through the collection's input when a `prepare` batch ran. */
type GraphDecodedInput = Readonly<{
	readonly submitted: GraphSubmittedInput;
	readonly decoded?: Readonly<Record<string, Schema.Json>>;
}>;

export type GraphPreparePorts<Error = unknown, Requirements = never> = Readonly<{
	readonly effectId: EffectId;
	/**
	 * The workspace: the author of every row a hook returns or writes, and of the omission deletes of
	 * a relationship a hook returned. Every hook api is bound to it; `policyWrite` answers it
	 * unrestricted with no approval route.
	 */
	readonly workspaceSubject: Identity.Subject;
	readonly rootCollection: string;
	readonly hookDepth: number;
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
		author: Identity.Subject,
		action: 'create' | 'update' | 'delete',
		collection: string,
		row: Readonly<Record<string, unknown>>
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
	readonly buildApi: (effectId: EffectId, depth: number, staged?: HookWriteOps<Error>) => unknown;
	readonly runHook: (
		hook: { readonly handler: (context: unknown) => unknown } | undefined,
		context: unknown,
		site: RefusalSite
	) => Effect.Effect<unknown, AuthoredRefusal>;
	readonly authorizePolicyWrite: (
		effectId: EffectId,
		author: Identity.Subject,
		visibility: AccessControl.RowPredicate,
		action: 'create' | 'update' | 'delete',
		collection: string,
		context: Readonly<Record<string, unknown>>
	) => Effect.Effect<void, Error, Requirements>;
	readonly resolveApproval: (
		effectId: EffectId,
		author: Identity.Subject,
		visibility: AccessControl.RowPredicate,
		action: 'create' | 'update' | 'delete',
		collection: string,
		context: Readonly<Record<string, unknown>>
	) => Effect.Effect<Schema.Json | undefined, Error, Requirements>;
	readonly splitGraphPayload: (
		collection: string,
		payload: Readonly<Record<string, unknown>>,
		action: 'create' | 'update'
	) => Effect.Effect<GraphSubmittedInput, Error, Requirements>;
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
		input: MutationInput,
		existing: Readonly<Record<string, unknown>> | undefined,
		module: CollectionHookModule | undefined,
		depth: number,
		prepared: unknown,
		staged?: HookWriteOps<Error>,
		relationships?: ReadonlyArray<string>,
		parent?: GraphMutationParent,
		relationshipSizes?: Readonly<Partial<Record<string, number>>>
	) => Effect.Effect<Readonly<Record<string, Schema.Json>>, Error, Requirements>;
	readonly runMutatePrepare: (
		effectId: EffectId,
		collection: string,
		inputs: ReadonlyArray<Readonly<Record<string, Schema.Json>>>,
		module: CollectionHookModule | undefined,
		depth: number,
		staged?: HookWriteOps<Error>
	) => Effect.Effect<unknown, Error, Requirements>;
	readonly runDeletePrepare: (
		effectId: EffectId,
		collection: string,
		existing: ReadonlyArray<Readonly<Record<string, unknown>>>,
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

/**
 * Every node names its author: the caller, judged on the shape it submitted, or the workspace,
 * whose hooks derived the row. A caller-initiated cascade descends as the caller's; a row under a
 * relationship a hook returned, a staged hook write and their omissions are the workspace's.
 */
export type GraphPrepareFns<E = unknown, R = never> = Readonly<{
	readonly prepareDelete: (
		collection: string,
		row: Readonly<Record<string, unknown>>,
		depth: number,
		author: Identity.Subject,
		requiresBrowserBaseVersion: boolean,
		wavePrepared?: unknown,
		parent?: GraphDeleteParent
	) => Effect.Effect<void, E, R>;
	readonly prepareNode: (
		collection: string,
		payload: Readonly<Record<string, unknown>>,
		depth: number,
		author: Identity.Subject,
		ownership?: GraphMutationParent,
		identity?: GraphNodeIdentity,
		requiresBrowserBaseVersion?: boolean,
		preDecoded?: GraphDecodedInput,
		wavePrepared?: unknown
	) => Effect.Effect<string, E, R>;
}>;

/** One desired child of an included relationship, split once and classified against the store. */
type PlannedChild = Readonly<{
	readonly child: Readonly<Record<string, unknown>>;
	readonly submitted: GraphSubmittedInput;
	readonly identity: PlannedGraphNodeIdentity | undefined;
}>;

/** One included relationship: whose rows they are, and which stored children it omits. */
type PlannedRelation = Readonly<{
	readonly edge: WritableManyRelation;
	readonly author: Identity.Subject;
	readonly requiresBrowserBaseVersion: boolean;
	readonly children: ReadonlyArray<PlannedChild>;
	readonly omitted: ReadonlyArray<Readonly<Record<string, unknown>>>;
}>;

/** Prepares the authorized operations in one declarative graph. */
export const makeGraphPreparers = <Error, Requirements>(
	ports: GraphPreparePorts<Error, Requirements>
): GraphPrepareFns<Error | AuthoredRefusal, Requirements> => {
	/**
	 * Resolves an included relationship's stored membership and each desired child's identity.
	 * No node is prepared here: the children of one node are one wave, so their `prepare` hook
	 * runs once per (collection × wave) in `prepareNode` instead of once per node.
	 */
	const planRelation = Effect.fn('Collections.planGraphRelation')(function* (
		collection: string,
		id: string,
		action: 'create' | 'update',
		relation: GraphIncludedRelationship,
		author: Identity.Subject,
		requiresBrowserBaseVersion: boolean
	) {
		const { edge } = relation;
		const related =
			action === 'create' ? undefined : yield* ports.relatedRows(ports.scope(), edge, id);
		if (related !== undefined)
			ports.registerRelationshipSnapshot(edge, id, membershipIdentitySnapshot(related.rows));
		const byId = new Map(
			(related?.rows ?? []).flatMap((row) =>
				isString(row['id']) ? [[row['id'], row] as const] : []
			)
		);
		const desiredIds = new Set<string>();
		const children: Array<PlannedChild> = [];
		for (const child of relation.rows) {
			const childId = child['id'];
			let identity: PlannedGraphNodeIdentity | undefined;
			if (childId !== undefined && !isNonEmptyString(childId))
				return yield* ports.graphRefusal(
					edge.childCollection,
					'update',
					`The id of a nested ${edge.childCollection} mutation must be a non-empty string.`
				);
			if (isString(childId)) {
				if (desiredIds.has(childId))
					return yield* ports.graphRefusal(
						edge.childCollection,
						'update',
						`The desired ${edge.name} relationship contains ${childId} more than once.`
					);
				if (byId.has(childId)) {
					identity = {
						id: childId,
						action: 'update',
						clearLock: false,
						ownerTransition: 'preserve'
					};
				} else if (ports.browserMutation !== undefined) {
					// Under a browser mutation the wave read a child id only when the browser declared that
					// row existing, so an id it did not read is one nothing claims exists yet, whether the
					// browser sent it or a `before` hook minted it. A hook that mints ids for the rows it
					// creates must be able to write them: `payroll_runs` computes a whole run whose
					// adjustments carry foreign keys naming junction rows in the same statement (learning 50).
					const declaredExisting = ports.browserMutation.baseVersions.some(
						(entry) =>
							entry.row.collection === edge.childCollection && entry.row.recordId === childId
					);
					if (declaredExisting === true)
						return yield* ports.graphRefusal(
							edge.childCollection,
							'update',
							`${childId} is not currently owned by ${collection} ${id}, so this relationship mutation cannot move or overwrite it.`
						);
					identity = {
						id: childId,
						action: 'create',
						clearLock: false,
						ownerTransition: 'preserve'
					};
				} else {
					// A server-side graph. An unstored id is a nested create (agents mint message and
					// directive ids on the same statement); a stored row owned by another parent cannot
					// move; a null owner or this parent is claim / update.
					const stored = yield* ports.storedGraphRow(
						EffectId.make(`${ports.effectId}:claim-owner:${edge.childCollection}:${childId}`),
						edge.childCollection,
						childId
					);
					if (stored === undefined) {
						identity = {
							id: childId,
							action: 'create',
							clearLock: false,
							ownerTransition: 'preserve'
						};
					} else {
						const storedOwner = stored.row[edge.childColumn];
						if (storedOwner !== null && storedOwner !== id)
							return yield* ports.graphRefusal(
								edge.childCollection,
								'update',
								`${childId} is already owned by another ${collection} row, so this relationship mutation cannot move or overwrite it.`
							);
						identity = {
							id: childId,
							action: 'update',
							clearLock: false,
							ownerTransition: storedOwner === null ? 'claim' : 'preserve'
						};
					}
				}
				desiredIds.add(childId);
			}
			const submitted = yield* ports.splitGraphPayload(
				edge.childCollection,
				child,
				identity?.action ?? 'create'
			);
			children.push({ child, submitted, identity });
		}
		// Inclusion authorizes reconciliation of the children it names, but absence is destructive
		// only for an owned edge. A non-cascade `many` is a convenient write surface over
		// independently-lived rows; treating its array as ownership would let a partial editor
		// delete siblings it does not own.
		const omitted = [...byId.entries()].filter(([childId]) => !desiredIds.has(childId));
		if (!edge.cascade && omitted.length > 0)
			return yield* ports.graphRefusal(
				edge.childCollection,
				'update',
				`${edge.name} omitted existing rows (${omitted.map(([childId]) => childId).join(', ')}), but the relationship is not cascade-owned.`
			);
		return {
			edge,
			author,
			requiresBrowserBaseVersion,
			children,
			omitted: ownsManyRelation(edge) ? omitted.map(([, row]) => row) : []
		} satisfies PlannedRelation;
	});

	const prepareDelete: GraphPrepareFns<Error | AuthoredRefusal, Requirements>['prepareDelete'] =
		Effect.fn('Collections.prepareGraphDelete')(
			function* (collection, row, depth, author, requiresBrowserBaseVersion, wavePrepared, parent) {
				const operationPosition = ports.operations.length;
				const id = row['id'];
				if (!isNonEmptyString(id))
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
				const accessPlan = yield* ports.policyWrite(author, 'delete', collection, row);
				const visibility = accessPlan.predicate;
				ports.registerExecutionInvariant(collection, 'delete', visibility);
				const module = ports.authoredHooks[collection];
				if (module?.delete?.perRecord?.before !== undefined) {
					const api = ports.buildApi(
						ports.effectId,
						ports.hookDepth + depth + 1,
						ports.stageHookWrites
					);
					yield* ports.runHook(
						module.delete.perRecord.before,
						{
							existing: row,
							prepared: wavePrepared,
							api,
							...(parent === undefined ? {} : { parent })
						},
						{
							collection,
							action: 'delete.before'
						}
					);
				}
				const context = { record: row };
				yield* ports.authorizePolicyWrite(
					EffectId.make(`${ports.effectId}:graph:policy-authorization:${collection}:${id}`),
					author,
					visibility,
					'delete',
					collection,
					context
				);
				const approval = yield* ports.resolveApproval(
					EffectId.make(`${ports.effectId}:graph:approval-flow:${collection}:${id}`),
					author,
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
				yield* prepareOwnedDescendants(ports, prepareDelete, collection, id, depth, author, row);
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
				author,
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
				if (submittedId !== undefined && !isNonEmptyString(submittedId))
					return yield* ports.graphRefusal(
						collection,
						'update',
						`The id of a ${collection} mutation must be a non-empty string.`
					);
				const action = identity?.action ?? (isString(submittedId) ? 'update' : 'create');
				const id = identity?.id ?? (isString(submittedId) ? submittedId : ports.randomId());
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
				let own: Readonly<Record<string, Schema.Json>> = submitted.own;
				let previous: Readonly<Record<string, unknown>> | undefined;
				let snapshot: string | undefined;
				if (action === 'create' && isString(submittedId) && requiresBrowserBaseVersion) {
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
				// The author is judged on the shape it sent, before input decoding and before any hook:
				// allow decision, row predicate, and every submitted field inside the matching grant, so
				// the fields a hook adds are never mistaken for forged ones. For the caller that is the
				// whole check; the workspace's plan is unrestricted with no approval route.
				const accessPlan = yield* ports.policyWrite(author, action, collection, own);
				const visibility = accessPlan.predicate;
				ports.registerExecutionInvariant(collection, action, visibility);
				if (action === 'update') {
					yield* ports.ensureGraphRowUnlocked(collection, id);
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
				// The relationships the author submitted are planned and judged now, before the hook.
				// A row the author has no grant for is refused on the author's own claim, even when the
				// hook would have replaced that relationship with its own complete set.
				const relations = new Map<string, PlannedRelation>();
				for (const relation of submitted.included) {
					const planned = yield* planRelation(
						collection,
						id,
						action,
						relation,
						author,
						requiresBrowserBaseVersion
					);
					for (const child of planned.children)
						yield* ports.policyWrite(
							author,
							child.identity?.action ?? 'create',
							relation.edge.childCollection,
							child.submitted.own
						);
					relations.set(relation.edge.name, planned);
				}
				if (module?.mutate?.perRecord?.before !== undefined) {
					// The id rides the input on an update and only there. It is the one thing a
					// `prepare` can read to tell a recalculation from a first build, because it sees a
					// batch of inputs and no rows; `before` is told the same fact as `existing`.
					const hookInput = action === 'update' ? { ...own, id } : own;
					const hooked = yield* ports.runMutateBefore(
						ports.effectId,
						{ collection, id, values: hookInput },
						previous,
						module,
						ports.hookDepth + depth,
						wavePrepared,
						ports.stageHookWrites,
						[...relations.keys()],
						ownership,
						Object.fromEntries(
							[...relations].map(([name, relation]) => [name, relation.children.length])
						)
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
					// A relationship the hook returned is the workspace's complete set for that edge. It
					// replaces what the author submitted under the same name (judged above), its rows
					// carry no browser base versions, and its omissions are the workspace's deletes.
					for (const relation of returned.included)
						relations.set(
							relation.edge.name,
							yield* planRelation(collection, id, action, relation, ports.workspaceSubject, false)
						);
				}

				// Relationship ownership comes from the graph position, never from a writable payload.
				// Existing children are proved to belong to this parent in `planRelation`. Their owner
				// key is stripped rather than trusted. A server-side graph may additionally claim an
				// unowned stored row; that one explicit transition writes null -> parent id through the
				// ordinary update pipeline.
				if (ownership !== undefined) {
					const owned = { ...own };
					delete owned[ownership.column];
					own =
						action === 'create' || identity?.ownerTransition === 'claim'
							? { ...owned, [ownership.column]: ownership.id }
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
					author,
					visibility,
					action,
					collection,
					context
				);
				// The graph is one approval, decided from the caller's rows: the workspace's plan
				// carries no route, so its rows ride the root's.
				const approval = yield* ports.resolveApproval(
					EffectId.make(`${ports.effectId}:graph:approval-flow:${collection}:${id}`),
					author,
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
				 * The wave's `prepare`, once per (collection × wave). Collections with no prepared
				 * hook take the ordinary per-node decode; only a declared `prepare` earns a batch.
				 */
				const decodedChildren = new Map<PlannedChild, Readonly<Record<string, Schema.Json>>>();
				const childWavePrepared = new Map<string, unknown>();
				{
					const batchByCollection = new Map<string, Array<PlannedChild>>();
					for (const planned of relations.values())
						for (const child of planned.children) {
							const childCollection = planned.edge.childCollection;
							const childModule = ports.authoredHooks[childCollection];
							if (childModule?.mutate?.prepare === undefined) continue;
							decodedChildren.set(
								child,
								yield* ports.decodeMutateInput(
									childCollection,
									child.submitted.own,
									childModule,
									child.identity?.action ?? 'create'
								)
							);
							const bucket = batchByCollection.get(childCollection) ?? [];
							bucket.push(child);
							batchByCollection.set(childCollection, bucket);
						}
					for (const [childCollection, batch] of batchByCollection) {
						const childModule = ports.authoredHooks[childCollection];
						if (childModule === undefined) continue;
						const inputs = batch.map((child) => {
							const decoded = decodedChildren.get(child) ?? child.submitted.own;
							return child.identity?.action === 'update'
								? { ...decoded, id: child.identity.id }
								: decoded;
						});
						const prepared = yield* ports.runMutatePrepare(
							ports.effectId,
							childCollection,
							inputs,
							childModule,
							ports.hookDepth + depth + 1,
							ports.stageHookWrites
						);
						childWavePrepared.set(childCollection, prepared);
					}
				}

				/**
				 * Pass two plans each relation's children in declaration order, then its omission
				 * deletes, each as its relation's author.
				 */
				for (const planned of relations.values()) {
					const childCollection = planned.edge.childCollection;
					for (const child of planned.children) {
						const decoded = decodedChildren.get(child);
						yield* prepareNode(
							childCollection,
							child.child,
							depth + 1,
							planned.author,
							{ collection, id, column: planned.edge.childColumn, values: context.record },
							child.identity,
							planned.requiresBrowserBaseVersion,
							decoded === undefined
								? { submitted: child.submitted }
								: { submitted: child.submitted, decoded },
							childWavePrepared.get(childCollection)
						);
					}
					for (const childRow of planned.omitted)
						yield* prepareDelete(
							childCollection,
							childRow,
							depth + 1,
							planned.author,
							planned.requiresBrowserBaseVersion,
							undefined,
							{
								collection,
								id,
								column: planned.edge.childColumn,
								values: context.record,
								action: 'update'
							}
						);
				}
				return id;
			}
		);

	return { prepareDelete, prepareNode };
};
