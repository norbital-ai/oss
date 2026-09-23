/**
 * The collection authoring contract: one declared input per operation, at most one transform,
 * and notification rules per lifecycle event.
 *
 * A collection wraps a `defineModel` declaration. Its `create` and `update` keys declare the caller
 * facing selection — `columns` allowlists fields, `with` allowlists relation actions — and expose a
 * direct endpoint; `delete: {}` exposes `delete(id)`. Its `transform` may replace the decoded input
 * with the full model-shaped payload the engine commits. Its `notifications` name channels and
 * message builders per lifecycle event. A model with no `+collection.ts` is read-only.
 *
 * The authored module is `src/collections/<name>/+collection.ts`:
 *
 * ```ts
 * import model from './+model.js';
 *
 * export default defineCollection({
 *   model,
 *   create: {
 *     input: {
 *       columns: { employment_id: true, principal: true },
 *       with: { repayment_loan: { create: { columns: { due_date: true, amount_due: true } } } }
 *     }
 *   },
 *   delete: {},
 *   transform: (inputs, { existing, db }) => Effect.gen(function* () { … })
 * });
 * ```
 */
import { Effect, Schema } from 'effect';
import type { NotificationRecipient } from '@norbital-ai/bolt-protocol';
import type { PersonChannel } from './channels-schema.js';
import type { WorkspaceAuthoringTypes } from './authoring-types.js';
import type {
	AnySchema,
	Api,
	BuilderData,
	DefaultWorkspaceSchema,
	SchemaRow,
	TableName
} from './contracts-schema.js';
import type { AnyModelFieldBuilder, ModelDeclaration } from './models-schema.js';
import type { AuthoredRefusal } from './refusal.js';

/** The relation actions a selection may accept. */
export type CollectionRelationAction =
	'create' | 'update' | 'upsert' | 'link' | 'unlink' | 'delete';

/** One leaf selection: fields by name, relations by name. `true` selects a field. */
export interface CollectionInputSelection {
	readonly columns?: Readonly<Record<string, true>> | undefined;
	readonly with?: Readonly<Record<string, CollectionRelationSelection>> | undefined;
}

/**
 * One relation's accepted actions.
 *
 * `delete: {}` accepts a delete of a related record; the value is deliberately empty because a
 * delete carries no further selection. `link`/`unlink` accept an optional `columns` selection for
 * the settlement metadata their `set` may patch.
 */
export interface CollectionRelationSelection {
	readonly create?: CollectionInputSelection | undefined;
	readonly update?: CollectionInputSelection | undefined;
	readonly upsert?: CollectionInputSelection | undefined;
	readonly link?: CollectionInputSelection | undefined;
	readonly unlink?: CollectionInputSelection | undefined;
	readonly delete?: Readonly<Record<never, never>> | undefined;
}

/** The input selection one operation declares. */
export interface CollectionOperationDeclaration {
	readonly input: CollectionInputSelection;
}

/** A column's authored value: the builder's data with `$type`, nullability and dimensions applied. */
type ColumnValue<Builder> = BuilderData<Builder>;

type RequiredColumnKeys<C extends Readonly<Record<string, AnyModelFieldBuilder>>> = {
	[K in keyof C]: C[K] extends { readonly _: { readonly notNull: true } }
		? C[K] extends { readonly _: { readonly hasDefault: true } }
			? never
			: K
		: never;
}[keyof C];

/**
 * The columns a selection exposes, typed from the model's own builders.
 *
 * Create requires the selected non-nullable, undefaulted columns; update takes a patch.
 */
export type CollectionSelectedColumns<
	C extends Readonly<Record<string, AnyModelFieldBuilder>>,
	Selection,
	Mode extends 'create' | 'update'
> = Selection extends { readonly columns: infer Columns }
	? {
			readonly [
				K in keyof Columns & keyof C as Mode extends 'create'
					? K extends RequiredColumnKeys<C>
						? K
						: never
					: never
			]: ColumnValue<C[K]>;
		} & {
			readonly [
				K in keyof Columns & keyof C as Mode extends 'create'
					? K extends RequiredColumnKeys<C>
						? never
						: K
					: K
			]?: ColumnValue<C[K]>;
		}
	: // repository-health:allow UTIL1 -- The empty-arm truth table belongs to the public contract generic, not to a shared helper.
		Readonly<Record<never, never>>;

/** --- the workspace the collection is compiled into --- */

type WorkspaceModels = WorkspaceAuthoringTypes extends { readonly models: infer Models }
	? Models
	: Readonly<Record<string, ModelDeclaration>>;

/** The collection name a model declaration is registered under, or `string` when unsynced. */
type CollectionNameOf<M extends ModelDeclaration> = {
	[K in keyof WorkspaceModels]: WorkspaceModels[K] extends M
		? M extends WorkspaceModels[K]
			? K
			: never
		: never;
}[keyof WorkspaceModels] &
	string;

type RowFor<M extends ModelDeclaration> =
	CollectionNameOf<M> extends TableName<DefaultWorkspaceSchema>
		? SchemaRow<DefaultWorkspaceSchema, CollectionNameOf<M>>
		: { readonly [K in keyof M['columns']]: ColumnValue<M['columns'][K]> } & {
				readonly id: string;
			};

/** Runtime-owned fields never accepted in a payload. */
type SystemPayloadKey =
	| 'id'
	| 'created_at'
	| 'updated_at'
	| 'sys_period'
	| 'row_version'
	| 'approval_id'
	| 'record_embedding'
	| 'embedded_at'
	| 'record_embedding_fingerprint';

type InsertOf<S extends AnySchema, N extends TableName<S>> = Omit<
	S['tables'][N]['$inferInsert'],
	SystemPayloadKey
>;
type PatchOf<S extends AnySchema, N extends TableName<S>> = Partial<
	Omit<S['tables'][N]['$inferSelect'], SystemPayloadKey>
>;

type RelationsOf<S extends AnySchema, N extends TableName<S>> = N extends keyof S['relations']
	? NonNullable<S['relations'][N]>
	: Readonly<Record<never, never>>;

type ManyRelationName<S extends AnySchema, N extends TableName<S>> = {
	[K in keyof RelationsOf<S, N>]: RelationsOf<S, N>[K] extends {
		readonly cardinality: 'many';
		readonly target: TableName<S>;
		readonly column: PropertyKey;
	}
		? K
		: never;
}[keyof RelationsOf<S, N>];

type RelationTarget<S extends AnySchema, N extends TableName<S>, K> = RelationsOf<S, N>[K &
	keyof RelationsOf<S, N>] extends { readonly target: infer Target extends TableName<S> }
	? Target
	: never;

type RelationColumn<S extends AnySchema, N extends TableName<S>, K> = RelationsOf<S, N>[K &
	keyof RelationsOf<S, N>] extends { readonly column: infer Column extends PropertyKey }
	? Column
	: never;

/**
 * The six relation actions of the payload grammar (RFC §4.3), typed from the relation's target.
 *
 * `create` rows omit the column the parent fills; `update` patches by id; `upsert` takes Drizzle's
 * `values`/`onConflictDoUpdate` pair; `link`/`unlink` name existing rows and may patch settlement
 * metadata; `delete` names rows. Nothing is deleted by omission.
 */
export type CollectionRelationActions<
	S extends AnySchema,
	Target extends TableName<S>,
	Column extends PropertyKey,
	Depth extends ReadonlyArray<unknown>
> = Readonly<{
	readonly create?: ReadonlyArray<Omit<CollectionPayload<S, Target, Depth>, Column & string>>;
	readonly update?: ReadonlyArray<
		Readonly<{ readonly id: string; readonly set: PatchOf<S, Target> }>
	>;
	readonly upsert?: ReadonlyArray<
		Readonly<{
			readonly values: Omit<CollectionPayload<S, Target, Depth>, Column & string> & {
				readonly id?: string;
			};
			readonly onConflictDoUpdate?: PatchOf<S, Target>;
		}>
	>;
	readonly link?: ReadonlyArray<
		Readonly<{ readonly id: string; readonly set?: PatchOf<S, Target> }>
	>;
	readonly unlink?: ReadonlyArray<
		Readonly<{ readonly id: string; readonly set?: PatchOf<S, Target> }>
	>;
	readonly delete?: ReadonlyArray<Readonly<{ readonly id: string }>>;
}>;

/** A payload: the model's insert values plus the relation actions of every many relation. */
export type CollectionPayload<
	S extends AnySchema,
	N extends TableName<S>,
	Depth extends ReadonlyArray<unknown> = []
> = Depth['length'] extends 2
	? InsertOf<S, N>
	: InsertOf<S, N> & {
			readonly [K in ManyRelationName<S, N>]?: CollectionRelationActions<
				S,
				RelationTarget<S, N, K>,
				RelationColumn<S, N, K>,
				[...Depth, unknown]
			>;
		};

/** A patch payload: partial model values plus relation actions. */
export type CollectionPatchPayload<S extends AnySchema, N extends TableName<S>> = PatchOf<S, N> & {
	readonly [K in ManyRelationName<S, N>]?: CollectionRelationActions<
		S,
		RelationTarget<S, N, K>,
		RelationColumn<S, N, K>,
		[unknown]
	>;
};

type PayloadFor<M extends ModelDeclaration, Mode extends 'create' | 'update'> =
	CollectionNameOf<M> extends TableName<DefaultWorkspaceSchema>
		? Mode extends 'create'
			? CollectionPayload<DefaultWorkspaceSchema, CollectionNameOf<M>>
			: CollectionPatchPayload<DefaultWorkspaceSchema, CollectionNameOf<M>>
		: Readonly<Record<string, unknown>>;

/** Relations a selection's `with` names: the typed actions when the workspace is synced. */
export type CollectionSelectedRelations<
	M extends ModelDeclaration,
	Selection,
	Mode extends 'create' | 'update'
> = Selection extends { readonly with: infer With }
	? {
			readonly [K in keyof With]?: K extends keyof PayloadFor<M, Mode>
				? PayloadFor<M, Mode>[K]
				: Readonly<Record<string, unknown>>;
		}
	: Readonly<Record<never, never>>;

/** The caller-facing input type of one operation, before the transform. */
export type CollectionInputOf<
	M extends ModelDeclaration,
	Declaration extends CollectionOperationDeclaration | undefined,
	Mode extends 'create' | 'update'
> = Declaration extends { readonly input: infer Selection }
	? CollectionSelectedColumns<M['columns'], Selection, Mode> &
			CollectionSelectedRelations<M, Selection, Mode>
	: never;

/** The read handle a transform may use: the workspace's reads, no writes, no policy. */
export type CollectionTransformDatabase = Api['db'];

/**
 * One transform. It runs once per admitted batch, reads as the workspace, and returns one payload
 * per input, in order, or refuses. Returning the payload is how it asks for writes.
 */
export type CollectionTransform<M extends ModelDeclaration, Input> = (
	inputs: ReadonlyArray<Input>,
	context: Readonly<{
		/** The stored root row per input, `undefined` on a create. */
		readonly existing: ReadonlyArray<RowFor<M> | undefined>;
		/** The reads-only tenant database surface, budgeted to two waves per operation. */
		readonly db: CollectionTransformDatabase;
	}>
) => Effect.Effect<
	ReadonlyArray<PayloadFor<M, 'create'> | PayloadFor<M, 'update'>>,
	AuthoredRefusal
>;

/** One control of a similarity index's capture form: what the browser shows to state a target. */
type SimilarityInputField = Readonly<{
	readonly label?: string;
	/** `reference` picks one record of `collection` — a condition the search narrows by. */
	readonly kind: 'number' | 'text' | 'enum' | 'reference';
	readonly values?: ReadonlyArray<string>;
	readonly collection?: string;
	/** Equalities that narrow which records a `reference` control offers. */
	readonly where?: Readonly<Record<string, string | number | boolean>>;
	readonly min?: number;
	readonly max?: number;
	readonly step?: number;
	readonly optional?: boolean;
}>;

/** The search commands every collection offers itself; no declared index may take their names. */
const RESERVED_SEARCH_COMMANDS: ReadonlyArray<string> = ['text', 'semantic'];

const SIMILARITY_METRICS = ['l2', 'cosine', 'ip'] as const;
type SimilarityMetric = (typeof SIMILARITY_METRICS)[number];

/**
 * One similarity index: a domain's own notion of "nearest", declared beside the write contract.
 *
 * The index ranks by a `vector({ dimensions })` column the model declares (index it with HNSW and
 * the opclass matching `metric`). `embed` fills that column from the row on every write — the
 * runtime calls it after the transform, so the vector is the workspace's own work and never a
 * caller's input. `target` turns a capture-form value into the probe a search ranks by. `rerank`
 * is the exact measure when the index metric is only a candidate stage: it is run over the page the
 * index returned, and its value is what the row reports as its distance.
 *
 * A domain whose "nearest" depends on a condition the form states — a colour under one light, a
 * position in one frame — keeps one vector column per condition: `embed` then returns every
 * column's vector at once, and `target` names the column the probe is measured against. A
 * condition that narrows rather than re-measures — the base a colour is moulded in — is a `where`
 * on the target: equalities on the collection's own columns, applied beside the ranking.
 */
type SimilarityIndexDeclaration<M extends ModelDeclaration = ModelDeclaration> = Readonly<{
	readonly label?: string;
	/** The `vector()` column the index ranks by unless `target` names another. */
	readonly column: string;
	/** Defaults to `l2`. */
	readonly metric?: SimilarityMetric;
	/** The capture form: one control per key, rendered in this order. */
	readonly input: Readonly<Record<string, SimilarityInputField>>;
	/** The vector for each column the index spans, keyed by column; `null` leaves the row unranked there. */
	readonly embed: (row: RowFor<M>) => Readonly<Record<string, ReadonlyArray<number> | null>>;
	/** The probe; the column it is measured against when not `column`; equalities that narrow. */
	readonly target: (input: Readonly<Record<string, unknown>>) => Readonly<{
		readonly column?: string;
		readonly probe: ReadonlyArray<number>;
		readonly where?: Readonly<Record<string, string | number | boolean | null>>;
	}>;
	readonly rerank?: (input: Readonly<Record<string, unknown>>, row: RowFor<M>) => number;
}>;

/** The events every collection may notify on, one for each approval-machine transition. */
export type CollectionNotificationEvent =
	| 'committed'
	| 'rejected'
	| 'approvalStarted'
	| 'approvalStepRequested'
	| 'approvalStepApproved'
	| 'approvalChangesRequested'
	| 'approvalWithdrawn'
	| 'approvalSuperseded'
	| 'approvalConflicted'
	| 'approvalCompleted';

/** What every lifecycle event carries to its rules. */
export interface CollectionLifecycleEvent {
	readonly event: CollectionNotificationEvent;
	readonly collection: string;
	readonly action: 'create' | 'update' | 'delete';
	/** The ids of the records the operation wrote or held, root first. */
	readonly ids: ReadonlyArray<string>;
	/** The user who submitted the operation. */
	readonly requestor: string;
	/** The open request, on approval events. */
	readonly approval?: Readonly<{
		readonly requestId: string;
		readonly step: Readonly<{ readonly index: number; readonly approvers: ReadonlyArray<string> }>;
		readonly decidedBy?: string;
		readonly reason?: string;
	}>;
}

/**
 * One declared notification rule: a person channel, who, and what. The channel is one of the
 * workspace's declared channels that can reach a person (`inbox`, `email`, a chat); naming none is a
 * type error, and a workspace that declares none has no notification rules to write.
 */
export type CollectionNotificationRule = {
	readonly channel: PersonChannel;
	/** User ids, or `{ team }` for every member of a team — an approval step's approvers are teams. */
	readonly recipients: (event: CollectionLifecycleEvent) => ReadonlyArray<NotificationRecipient>;
	readonly message: (
		event: CollectionLifecycleEvent
	) => Readonly<{ readonly title: string; readonly body: string }>;
};

export type CollectionNotifications = Readonly<
	Partial<Record<CollectionNotificationEvent, ReadonlyArray<CollectionNotificationRule>>>
>;

/** The declaration `defineCollection` accepts. */
export interface CollectionDeclaration<
	M extends ModelDeclaration = ModelDeclaration,
	Create extends CollectionOperationDeclaration | undefined = undefined,
	Update extends CollectionOperationDeclaration | undefined = undefined,
	Delete extends Readonly<Record<never, never>> | undefined = undefined
> {
	readonly model: M;
	/** Presence exposes `create`; absent, the collection accepts no direct create. */
	readonly create?: Create;
	/** Presence exposes `update`; absent, the collection accepts no direct update. */
	readonly update?: Update;
	/** Presence exposes `delete(id)`; a delete has no input and no transform. */
	readonly delete?: Delete;
	/** `NoInfer`: the transform is checked against the declaration, never a source of its generics. */
	readonly transform?: NoInfer<
		CollectionTransform<
			M,
			| (Create extends undefined ? never : CollectionInputOf<M, Create, 'create'>)
			| (Update extends undefined ? never : CollectionInputOf<M, Update, 'update'>)
		>
	>;
	readonly notifications?: CollectionNotifications;
	/** Similarity indexes, each a `/<name>` search command on this collection. */
	readonly similarity?: Readonly<Record<string, SimilarityIndexDeclaration<M>>>;
}

export type AnyCollectionDeclaration = CollectionDeclaration<
	ModelDeclaration,
	CollectionOperationDeclaration | undefined,
	CollectionOperationDeclaration | undefined,
	Readonly<Record<never, never>> | undefined
>;

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const validateSelection = (selection: CollectionInputSelection, site: string): void => {
	if (!isRecord(selection)) throw new TypeError(`${site} must be an object.`);
	for (const key of Object.keys(selection)) {
		if (key !== 'columns' && key !== 'with')
			throw new TypeError(
				`${site} has unknown key ${JSON.stringify(key)}. A selection declares only "columns" and "with".`
			);
	}
	if (selection.with !== undefined) {
		for (const [relation, actions] of Object.entries(selection.with)) {
			if (!isRecord(actions))
				throw new TypeError(`${site}.with.${relation} must be an object of relation actions.`);
			for (const [action, nested] of Object.entries(actions)) {
				if (action === 'delete') continue;
				if (
					action !== 'create' &&
					action !== 'update' &&
					action !== 'upsert' &&
					action !== 'link' &&
					action !== 'unlink'
				)
					throw new TypeError(
						`${site}.with.${relation} has unknown action ${JSON.stringify(action)}.`
					);
				if (nested !== undefined)
					validateSelection(
						nested as CollectionInputSelection,
						`${site}.with.${relation}.${action}`
					);
			}
		}
	}
};

/**
 * Declares one collection's write contract.
 *
 * Validation happens here, at module load, so a malformed selection fails the sync with the file
 * that holds it rather than surfacing as an empty input endpoint at run time.
 */
export const defineCollection = <
	const M extends ModelDeclaration,
	const Create extends CollectionOperationDeclaration | undefined = undefined,
	const Update extends CollectionOperationDeclaration | undefined = undefined,
	const Delete extends Readonly<Record<never, never>> | undefined = undefined
>(
	declaration: CollectionDeclaration<M, Create, Update, Delete>
): CollectionDeclaration<M, Create, Update, Delete> => {
	if (!isRecord(declaration) || !isRecord(declaration.model))
		throw new TypeError('defineCollection requires a model declaration.');
	if (declaration.create !== undefined) validateSelection(declaration.create.input, 'create.input');
	if (declaration.update !== undefined) validateSelection(declaration.update.input, 'update.input');
	if (declaration.delete !== undefined && !isRecord(declaration.delete))
		throw new TypeError('delete must be `{}`: a delete has no input.');
	if (declaration.notifications !== undefined) {
		for (const [event, rules] of Object.entries(declaration.notifications)) {
			if (!Array.isArray(rules))
				throw new TypeError(`notifications.${event} must be an array of rules.`);
			for (const rule of rules) {
				if (!isRecord(rule) || typeof rule['channel'] !== 'string')
					throw new TypeError(`notifications.${event} has a rule without a channel.`);
				if (typeof rule['recipients'] !== 'function' || typeof rule['message'] !== 'function')
					throw new TypeError(
						`notifications.${event}: a ${rule['channel']} rule needs recipients and message builders.`
					);
			}
		}
	}
	if (declaration.similarity !== undefined) {
		if (!isRecord(declaration.similarity))
			throw new TypeError('similarity must map index names to declarations.');
		for (const [name, index] of Object.entries(declaration.similarity)) {
			if (!/^[a-z][a-z0-9_]*$/.test(name))
				throw new TypeError(
					`similarity.${name}: an index name is lower-case letters, digits and underscores; it becomes the /${name} search command.`
				);
			if (RESERVED_SEARCH_COMMANDS.includes(name))
				throw new TypeError(
					`similarity.${name}: /${name} is the platform's own search command and cannot be declared.`
				);
			if (!isRecord(index)) throw new TypeError(`similarity.${name} must be an object.`);
			if (typeof index['column'] !== 'string' || index['column'] === '')
				throw new TypeError(`similarity.${name} must name the vector column it ranks by.`);
			if (
				index['metric'] !== undefined &&
				!(SIMILARITY_METRICS as ReadonlyArray<unknown>).includes(index['metric'])
			)
				throw new TypeError(
					`similarity.${name}.metric must be one of ${SIMILARITY_METRICS.join(', ')}.`
				);
			if (!isRecord(index['input']) || Object.keys(index['input']).length === 0)
				throw new TypeError(`similarity.${name}.input must declare at least one control.`);
			for (const [field, control] of Object.entries(index['input'])) {
				if (
					!isRecord(control) ||
					!['number', 'text', 'enum', 'reference'].includes(String(control['kind']))
				)
					throw new TypeError(
						`similarity.${name}.input.${field}.kind must be number, text, enum or reference.`
					);
				if (control['kind'] === 'enum' && !Array.isArray(control['values']))
					throw new TypeError(`similarity.${name}.input.${field} is an enum with no values.`);
				if (control['kind'] === 'reference' && typeof control['collection'] !== 'string')
					throw new TypeError(
						`similarity.${name}.input.${field} is a reference with no collection.`
					);
			}
			if (typeof index['embed'] !== 'function' || typeof index['target'] !== 'function')
				throw new TypeError(`similarity.${name} needs embed(row) and target(input) functions.`);
			if (index['rerank'] !== undefined && typeof index['rerank'] !== 'function')
				throw new TypeError(`similarity.${name}.rerank must be a function when present.`);
		}
	}
	return Object.freeze({ ...declaration });
};

/**
 * The live carrier for one authored collection: what the artifact hands the runtime.
 *
 * `transform` is `unknown` for the reason every authored carrier is runtime-shaped: the authored
 * declaration types it precisely, the runtime invokes it with composed values no schema can name.
 */
export type AuthoredCollectionModule = Readonly<{
	readonly create?: CollectionOperationDeclaration;
	readonly update?: CollectionOperationDeclaration;
	readonly delete?: Readonly<Record<never, never>>;
	readonly transform?: unknown;
	readonly notifications?: CollectionNotifications;
	readonly similarity?: Readonly<Record<string, SimilarityIndexDeclaration>>;
}>;
