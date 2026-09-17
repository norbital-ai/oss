/**
 * Lowering for a declared collection write (RFC §4.2–4.3).
 *
 * A caller submits the collection's declared input; the transform (if any) returns full
 * model-shaped payloads; this module turns those payloads into the `GraphPreparedOperation`s the
 * existing statement planner and commit transaction already know how to execute.
 *
 * The grammar is explicit actions, never omission: `with` entries name `create`, `update`,
 * `link`, `unlink` and `delete`, and nothing is removed that was not named.
 */
import { Effect, type Schema } from 'effect';
import { AuthoredRefusal } from '#lib/authoring/refusal.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import type { WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import type { GraphPreparedOperation } from './engine.js';
import { WRITE_DEPTH_LIMIT, type WritableManyRelation } from './plan.js';

export type DeclaredAction = 'create' | 'update' | 'delete';

/** The runtime shape of one collection, as the workspace definition carries it. */
export type DeclaredCollection = WorkspaceDefinition['collections'][number];

export type DeclaredLowering = Readonly<{
	readonly definitionOf: (collection: string) => DeclaredCollection | undefined;
	readonly relationOf: (collection: string, name: string) => WritableManyRelation | undefined;
	readonly previousOf: (
		collection: string,
		id: string
	) => Readonly<Record<string, unknown>> | undefined;
	readonly visibilityOf: (
		collection: string,
		action: DeclaredAction
	) => GraphPreparedOperation['visibility'];
	/** Encodes authored values to the wire: instants, references, generated columns dropped. */
	readonly encode: (
		definition: DeclaredCollection,
		values: Readonly<Record<string, unknown>>
	) => Readonly<Record<string, Schema.Json>>;
	/** A reference value that names no declared target, as the sentence the refusal carries. */
	readonly referenceProblem: (
		definition: DeclaredCollection,
		values: Readonly<Record<string, Schema.Json>>
	) => string | undefined;
	readonly allocateId: () => string;
	readonly taskScope: GraphPreparedOperation['taskScope'];
}>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0;

const refuse = (collection: string, action: DeclaredAction, message: string) =>
	Effect.fail(new AuthoredRefusal({ collection, action, message }));

/** What one payload's own fields are, beside the relation actions it carries. */
type SplitPayload = Readonly<{
	readonly own: Readonly<Record<string, unknown>>;
	readonly relations: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}>;

const splitPayload = (
	collection: string,
	action: DeclaredAction,
	definition: DeclaredCollection,
	relationOf: DeclaredLowering['relationOf'],
	payload: Readonly<Record<string, unknown>>
): Effect.Effect<SplitPayload, AuthoredRefusal> => {
	const own: Record<string, unknown> = { ...payload };
	const relations = new Map<string, Readonly<Record<string, unknown>>>();
	for (const key of Object.keys(payload)) {
		const value = payload[key];
		// Identity is the caller's target, never a writable field.
		if (key === 'id') {
			delete own[key];
			continue;
		}
		if (value === undefined) {
			delete own[key];
			continue;
		}
		if (SYSTEM_COLUMN_NAMES.includes(key))
			return refuse(
				collection,
				action,
				`${collection}.${key} is managed by Bolt and cannot be written.`
			);
		const edge = relationOf(collection, key);
		if (edge === undefined) continue;
		if (!isRecord(value))
			return refuse(
				collection,
				action,
				`${collection}.${key} is a relation, so its value must be an object of actions.`
			);
		delete own[key];
		relations.set(key, value);
	}
	for (const key of Object.keys(own))
		if (!(key in definition.fields))
			return refuse(
				collection,
				action,
				`${collection} has no field ${JSON.stringify(key)} in its declared payload.`
			);
	return Effect.succeed({ own, relations });
};

/** Lowers one payload and its nested relation actions into ordered operations. */
export const lowerDeclaredPayload = (
	context: DeclaredLowering,
	collection: string,
	action: DeclaredAction,
	payload: Readonly<Record<string, unknown>>,
	depth: number,
	ownership?: Readonly<{
		readonly collection: string;
		readonly id: string;
		readonly column: string;
	}>,
	explicitId?: string
): Effect.Effect<ReadonlyArray<GraphPreparedOperation>, AuthoredRefusal> =>
	Effect.gen(function* () {
		if (depth > WRITE_DEPTH_LIMIT)
			return yield* refuse(
				collection,
				action,
				`A nested write on ${collection} is more than ${WRITE_DEPTH_LIMIT} levels deep.`
			);
		const definition = context.definitionOf(collection);
		if (definition === undefined)
			return yield* refuse(collection, action, `Unknown collection ${collection}.`);
		const id =
			explicitId ?? (isNonEmptyString(payload['id']) ? (payload['id'] as string) : undefined);
		const stored = id === undefined ? undefined : context.previousOf(collection, id);
		if (action === 'delete') {
			if (id === undefined || stored === undefined)
				return yield* refuse(
					collection,
					'delete',
					`The ${collection} delete names a record that does not exist.`
				);
			return [
				{
					action: 'delete',
					collection,
					id,
					values: {},
					definition,
					visibility: context.visibilityOf(collection, 'delete'),
					previous: stored,
					snapshot: JSON.stringify(stored),
					depth,
					taskScope: context.taskScope
				}
			];
		}
		const effectiveAction: 'create' | 'update' =
			action === 'update' || stored !== undefined ? 'update' : 'create';
		if (effectiveAction === 'update' && stored === undefined)
			return yield* refuse(
				collection,
				action,
				`${collection} ${id ?? '(new)'} does not exist, so it cannot be updated.`
			);
		const recordId = effectiveAction === 'create' ? (id ?? context.allocateId()) : (id as string);
		const split = yield* splitPayload(
			collection,
			effectiveAction,
			definition,
			context.relationOf,
			payload
		);
		const operations: Array<GraphPreparedOperation> = [];
		const own = { ...split.own };
		if (ownership !== undefined) own[ownership.column] = ownership.id;
		/**
		 * A create payload is checked against the full model before it is lowered (RFC §4.6).
		 *
		 * The caller was bounded by its declared selection, but a transform returns model-shaped
		 * rows and may simply omit a column the table requires. Without this the omission reaches the
		 * insert and surfaces as a database not-null fault the caller cannot classify; the transform
		 * is where the mistake is, so the refusal names it there.
		 */
		if (effectiveAction === 'create') {
			for (const [name, field] of Object.entries(definition.fields)) {
				if (
					field.required !== true ||
					field.sqlDefault !== undefined ||
					field.generated !== undefined
				)
					continue;
				if (own[name] === undefined)
					return yield* refuse(
						collection,
						'create',
						`The ${collection} create payload leaves required field ${JSON.stringify(name)} unset.`
					);
			}
		}
		const encoded = context.encode(definition, own);
		const referenceProblem = context.referenceProblem(definition, encoded);
		if (referenceProblem !== undefined)
			return yield* refuse(collection, effectiveAction, referenceProblem);
		operations.push({
			action: effectiveAction,
			collection,
			id: recordId,
			values: encoded,
			definition,
			visibility: context.visibilityOf(collection, effectiveAction),
			...(stored === undefined ? {} : { previous: stored, snapshot: JSON.stringify(stored) }),
			depth,
			taskScope: context.taskScope
		});
		for (const [name, actions] of split.relations) {
			const edge = context.relationOf(collection, name);
			if (edge === undefined)
				return yield* refuse(collection, effectiveAction, `Unknown relation ${name}.`);
			const childDefinition = context.definitionOf(edge.childCollection);
			if (childDefinition === undefined)
				return yield* refuse(edge.childCollection, effectiveAction, 'Unknown child collection.');
			const childOwnership = { collection, id: recordId, column: edge.childColumn };
			for (const [relationAction, value] of Object.entries(actions)) {
				const entries = Array.isArray(value) ? value : [value];
				if (relationAction === 'delete') {
					for (const entry of entries) {
						const childId = isRecord(entry) ? entry['id'] : undefined;
						if (!isNonEmptyString(childId))
							return yield* refuse(
								edge.childCollection,
								'delete',
								`A ${name} delete action needs a record id.`
							);
						operations.push(
							...(yield* lowerDeclaredPayload(
								context,
								edge.childCollection,
								'delete',
								{ id: childId },
								depth + 1,
								undefined,
								childId
							))
						);
					}
					continue;
				}
				if (relationAction === 'link' || relationAction === 'unlink') {
					for (const entry of entries) {
						const childId = isRecord(entry) ? entry['id'] : undefined;
						if (!isNonEmptyString(childId))
							return yield* refuse(
								edge.childCollection,
								'update',
								`A ${name} ${relationAction} action needs a record id.`
							);
						const child = context.previousOf(edge.childCollection, childId);
						if (child === undefined)
							return yield* refuse(
								edge.childCollection,
								'update',
								`${edge.childCollection} ${childId} does not exist.`
							);
						const set = isRecord(entry) && isRecord(entry['set']) ? entry['set'] : {};
						operations.push({
							action: 'update',
							collection: edge.childCollection,
							id: childId,
							values: context.encode(childDefinition, {
								[edge.childColumn]: relationAction === 'link' ? recordId : null,
								...set
							}),
							definition: childDefinition,
							visibility: context.visibilityOf(edge.childCollection, 'update'),
							previous: child,
							snapshot: JSON.stringify(child),
							depth: depth + 1,
							taskScope: context.taskScope
						});
					}
					continue;
				}
				if (relationAction === 'upsert') {
					for (const entry of entries) {
						if (!isRecord(entry) || !isRecord(entry['values']))
							return yield* refuse(
								edge.childCollection,
								'create',
								`A ${name} upsert entry needs a "values" record.`
							);
						const values = {
							...entry['values'],
							...(isRecord(entry['onConflictDoUpdate']) ? entry['onConflictDoUpdate'] : {})
						};
						const upsertId = isNonEmptyString(values['id']) ? values['id'] : undefined;
						// By-id upsert: the wave read decided create vs update. A unique key that is not the
						// id is enforced by the database's constraint, not guessed here.
						operations.push(
							...(yield* lowerDeclaredPayload(
								context,
								edge.childCollection,
								'create',
								values,
								depth + 1,
								childOwnership,
								upsertId
							))
						);
					}
					continue;
				}
				if (relationAction !== 'create' && relationAction !== 'update')
					return yield* refuse(
						collection,
						effectiveAction,
						`${collection}.${name} does not accept action ${JSON.stringify(relationAction)}.`
					);
				for (const entry of entries) {
					if (!isRecord(entry))
						return yield* refuse(
							edge.childCollection,
							'create',
							`Every ${name} ${relationAction} entry must be a record.`
						);
					const entryId = entry['id'];
					// An update entry carries its patch under `set`; ids never become writable fields.
					const payload =
						relationAction === 'update' && isRecord(entry['set']) ? { ...entry['set'] } : entry;
					operations.push(
						...(yield* lowerDeclaredPayload(
							context,
							edge.childCollection,
							relationAction,
							payload,
							depth + 1,
							childOwnership,
							isNonEmptyString(entryId) ? entryId : undefined
						))
					);
				}
			}
		}
		return operations;
	});
