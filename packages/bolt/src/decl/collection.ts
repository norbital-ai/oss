// `collection()` (§3.3.4): the exposed portion of one model. Data in the literal; the one transform and each query,
// action and similarity body attach in their own statements (X-2), so no literal's type depends on a body.
import type {
	ActionCtx,
	BodyReturn,
	DeleteInput,
	QueryCtx,
	TransformCtx,
	TransformRow
} from './ctx.ts';
import type {
	Checked,
	Exact,
	InputFields,
	InputKind,
	InputOf,
	ValidInput,
	ValidInputs,
	ValueOf
} from './fields.ts';
import type {
	Columns,
	FedName,
	FieldName,
	ManyRels,
	ModelName,
	TeamName,
	OneRels,
	OwnedFk,
	OneTarget,
	PolicyName,
	RelNameOf,
	Row,
	SystemName,
	VectorField,
	WritableField
} from './names.ts';
import type { ConnectionName } from './runtime/names.ts';
import type { Where } from './where.ts';
import type { Json, Msg, Vector } from './values.ts';

/**
 * How the in-app agent may call a query or action: `direct` (default), `confirm` (an in-app confirmation card first) or `never`.
 */
export type AgentUse = 'direct' | 'confirm' | 'never';
/** The write and approval events a collection's `notifications` rules react to. */
export type NotificationEvent =
	| 'committed'
	| 'rejected'
	| 'approvalStarted'
	| 'approvalStepRequested'
	| 'approvalStepApproved'
	| 'approvalChangesRequested'
	| 'approvalWithdrawn'
	| 'approvalSuperseded'
	| 'approvalResubmitted'
	| 'approvalCommented'
	| 'approvalCompleted';
/** A column of `C` holding a member: an FK to `sys_user`, or `created_by`/`updated_by`. */
export type UserField<C> =
	| ({ [R in keyof OneRels<C>]: OneTarget<C, R> extends 'sys_user' ? R : never }[keyof OneRels<C>] &
			string)
	| 'created_by'
	| 'updated_by';
/**
 * Whom a notification goes to: the requestor, the current step's approvers, a team, a member named by a field of the row, or a policy's holders.
 */
export type Recipient<C> =
	| 'requestor'
	| 'step_approvers'
	| { team: TeamName }
	| { user: UserField<C> }
	| { policy: PolicyName };
/** Data available to a pure recipient callback: native write images or caller-readable action targets, expressed as JSON. */
export type NotificationInput = {
	readonly event: NotificationEvent;
	readonly action: string;
	readonly collection: string;
	readonly records: readonly {
		readonly id: string;
		readonly values: Readonly<Record<string, Json>>;
	}[];
	readonly requestor: string | null;
	readonly approvers: readonly TeamName[];
};
/** A member ID, an authored team, or a policy's holders: the members whose source team (`+team.ts`) or sign-up lists it. */
export type NotificationRecipient =
	{ readonly user: string } | { readonly team: TeamName } | { readonly policy: PolicyName };
/** Pure: runs in a fresh bounded isolate with no host I/O. IDs and policy names are validated before the guarded write.
 * @example
 * event => event.requestor === null ? [] : [{ user: event.requestor }] */
export type NotificationRecipients = (event: NotificationInput) => readonly NotificationRecipient[];
type Title = Msg | { one: Msg; many: Msg };
/**
 * One notification rule: a pure recipient callback or descriptors, triggering writes and title/body. Every resolved member
 * gets an in-app notice; `channel` (a conversation connection, `bolt check` refuses any other) also sends it to their handle there.
 */
export type NotificationRule<C, A extends string = never> = {
	channel?: 'inbox' | ConnectionName;
	to: readonly Recipient<C>[] | NotificationRecipients;
	on?: { action?: readonly ('create' | 'update' | 'delete' | A)[] };
	title: Title;
	body?: Title;
};
/** The compiled literal retains callback presence as a marker; Full checks authored names and recipients. */
type NotificationSpec = {
	channel?: string;
	to: readonly unknown[] | NotificationRecipients | true;
	on?: { action?: readonly string[] };
	title: string | { one: string; many?: string };
	body?: string | { one: string; many?: string };
};

/** A create/update allowlist: writable columns, plus explicit relation actions per many-relation (never by omission). */
/** An update never lists an owned child's parent key (rule 41). A create's `filled` names the fields its transform fills
 * when the input omits them (GAP-6): optional in `Insert`, still `required` after the transform (rule 23). */
export type Selection<M, Op = 'create'> = {
	columns: readonly (Op extends 'update'
		? Exclude<WritableField<M>, OwnedFk<M>>
		: WritableField<M>)[];
	filled?: Op extends 'update' ? never : readonly WritableField<M>[];
	with?: {
		[R in keyof ManyRels<M>]?: {
			create?: Selection<ManyRels<M>[R]>;
			update?: Selection<ManyRels<M>[R], 'update'>;
			upsert?: Selection<ManyRels<M>[R]>;
			link?: {};
			unlink?: {};
			delete?: {};
		};
	};
};
type Candidates = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
type Reserved = 'create' | 'update' | 'delete' | 'upsert' | 'import' | 'export' | 'erase';

/**
 * A collection query: a description, the typed `input` fields, the `output` kind and how the agent may call it. Its body attaches with `c.query(name, fn)`.
 */
export type QuerySpec = {
	description: string;
	input: InputFields;
	output: InputKind;
	agent?: AgentUse;
};
/**
 * A collection action: typed `input`, optional `output`, `target: 'record'` to run on chosen rows, `internal` to hide it from callers, and agent use. Its body attaches with `c.action(name, fn)`.
 */
export type ActionSpec = {
	description: string;
	input: InputFields;
	output?: InputKind;
	target?: 'record';
	internal?: true;
	agent?: AgentUse;
};
/** A named similarity search: its typed `input` and how many `candidates` the body returns per call (1–16). */
export type SimilarSpec = { description: string; input: InputFields; candidates?: Candidates };
/** The value a query, action or automation literal declares as its `output` (`undefined` when it declares none). */
export type OutputOf<X> = X extends { output: infer O } ? ValueOf<O> : undefined;
type SelectionBase = {
	columns: readonly string[];
	filled?: readonly string[];
	with?: { readonly [r: string]: { [a: string]: SelectionBase | {} } };
};
/**
 * The general shape of `collection()`'s spec: what callers `read`, the `create`/`update` input allowlists, `delete`, and the named
 * `queries`, `actions`, `similarity` searches and `notifications`.
 */
export interface ProjectReadCtx extends QueryCtx {
	readonly admin: boolean;
	readonly policies: readonly string[];
	readonly fields: readonly string[];
}
/** A read projection: the JSON `fields` computed by the attached body over the trusted `context` columns. */
export type ReadProjection = { fields: readonly string[]; context: readonly string[] };

/** A collection's spec: its read exposure, write allowlists and named queries, actions and similarities. */
export type CollectionSpec = {
	description?: string;
	/** The fields and relations callers read (grants narrow them further). */
	read: {
		fields: 'all' | readonly string[];
		relations?: 'all' | readonly string[];
		projection?: ReadProjection;
	};
	/** The generated `create`: its input allowlist (`columns`, `filled`, and relation actions under `with`). */
	create?: { input: SelectionBase };
	/** The generated `update`: its input allowlist. */
	update?: { input: SelectionBase };
	/** The generated `delete`; `{ transform: true }` runs the transform on it. */
	delete?: {} | { transform: true };
	/** Named read operations; bodies attach with `c.query`. */
	queries?: { readonly [q: string]: QuerySpec };
	/** Named write operations; bodies attach with `c.action`. */
	actions?: { readonly [a: string]: ActionSpec };
	/** Named similarity searches; bodies attach with `c.similarity`. */
	similarity?: { readonly [s: string]: SimilarSpec };
	/** Notification rules per write or approval event. */
	notifications?: { readonly [E in NotificationEvent]?: readonly NotificationSpec[] };
};

type InputPart<X> = X extends { input: unknown } ? ValidInputs<X['input']> : never;
type OutputPart<X> = X extends { output: unknown } ? ValidInput<X['output']> : never;
type QueriesFor<Q> = {
	[N in keyof Q]: N extends Reserved
		? `error: '${N & string}' is a generated verb`
		: QueryEntry<Q[N]>;
};
// a query and an action of one name would share a callable, a limit key and a grant name
type ActionsFor<A, QKeys> = {
	[N in keyof A]: N extends Reserved
		? `error: '${N & string}' is a generated verb`
		: N extends QKeys
			? `error: '${N & string}' is already a query`
			: ActionEntry<A[N]>;
};
type QueryEntry<X> = {
	description: string;
	input: InputPart<X>;
	output: OutputPart<X>;
	agent?: AgentUse;
};
type ActionEntry<X> = {
	description: string;
	input: InputPart<X>;
	output?: OutputPart<X>;
	target?: 'record';
	internal?: true;
	agent?: AgentUse;
};
type Part<S, K extends string> = S extends { [P in K]: infer V } ? V : {};
interface Full<K, S> {
	description?: string;
	read: {
		fields: 'all' | readonly FieldName<K>[];
		relations?: 'all' | readonly RelNameOf<K>[];
		projection?: { fields: readonly FieldName<K>[]; context: readonly FieldName<K>[] };
	};
	create?: { input: Selection<K> };
	update?: { input: Selection<K, 'update'> };
	delete?: {} | { transform: true };
	queries?: QueriesFor<Part<S, 'queries'>>;
	actions?: ActionsFor<Part<S, 'actions'>, keyof Part<S, 'queries'>>;
	similarity?: {
		[N in keyof Part<S, 'similarity'>]: {
			description: string;
			input: InputPart<Part<S, 'similarity'>[N]>;
			candidates?: Candidates;
		};
	};
	notifications?: {
		[E in NotificationEvent]?: readonly NotificationRule<K, keyof Part<S, 'actions'> & string>[];
	};
}
/** A feed writes its target's rows: the collection exposes no create, delete or action; its `update` columns are its local fields. */
type SpecFor<K, S, F = Full<K, S>> = K extends FedName
	? Omit<F, 'create' | 'delete' | 'actions'>
	: F;

type Queries<S> = Part<S, 'queries'>;
type Actions<S> = Part<S, 'actions'>;
type Similarities<S> = Part<S, 'similarity'>;
type In<X> = X extends { input: infer I } ? InputOf<I> : never;
/** A body as attach stores it and the guest calls it by path. */
export type Body = (...args: never[]) => unknown;

/**
 * A body as attach stores it: a generator through the guest edge, its ctx the argument at `at` (-1: none). The wrapper
 * runs only at the guest ABI; authored bodies retain their generator signatures. The edge's `install()` sets `wrap`
 * only in a bundle that carries generator bodies, so a body-free bundle carries no Effect (D8).
 */
export function attached<F extends Body>(body: F, at: number): F {
	// Keep the compiler's generator diagnostic when no generator installed the edge.
	if (attached.wrap === undefined)
		throw new Error('ctx-bearing body must be a generator function; guest edge missing');
	return attached.wrap(body, at) as F;
}
/** The ambient property adds no module initialization to bundles without a guest edge. */
export declare namespace attached {
	export let wrap: ((body: Body, at: number) => Body) | undefined;
}

type TransformBody<K, S> = TransformBodyOf<K, S>;
type TransformBodyOf<K, S, R = TransformRow<K>> = (
	inputs: readonly (R | (S extends { delete: { transform: true } } ? DeleteInput : never))[],
	ctx: TransformCtx<K>
) => BodyReturn<readonly (R | DeleteInput)[]>;
type SimilarityBody<K, X> = {
	/** The vector to rank by, and a filter applied inside the index scan. */
	probe: (input: In<X>) => { field: VectorField<K>; vector: Vector; where?: Where<K> };
	/** Exact score over the candidate page, ascending; `undefined` keeps index order. */
	rerank?: (input: In<X>, row: Row<K>) => number | undefined;
};

export type Collection<K extends ModelName | SystemName, S> = CollectionOf<K, S>;
type CollectionOf<
	K extends ModelName | SystemName,
	S,
	QueryMap = Queries<S>,
	ActionMap = Actions<S>,
	SimilarityMap = Similarities<S>
> = {
	readonly name: K;
	readonly spec: S;
	/** The attached bodies, read by the compiler. */
	readonly bodies: {
		project?: Body;
		transform?: Body;
		queries: Record<string, Body>;
		actions: Record<string, Body>;
		similarity: Record<string, object>;
	};
	/** The read projection's body (`read.projection`): its `fields` from the trusted `context` columns; at most once. */
	project(
		body: (
			row: Readonly<Record<string, Json>>,
			ctx: ProjectReadCtx
		) => BodyReturn<Readonly<Record<string, Json>>>
	): void;
	/** The one transform for every write batch (R2); at most once. */
	transform(body: TransformBody<K, S>): void;
	// The name alone infers `Q`: inferring from the body's return into `ValueOf` walked every kind's branch (~2 ms a call).
	query<Q extends keyof QueryMap & string>(
		name: Q,
		body: (
			input: NoInfer<In<QueryMap[Q]>>,
			ctx: QueryCtx
		) => BodyReturn<NoInfer<ValueOf<QueryMap[Q] extends { output: infer O } ? O : never>>>
	): void;
	action<A extends keyof ActionMap & string>(
		name: A,
		body: (
			input: NoInfer<In<ActionMap[A]>>,
			ctx: NoInfer<ActionCtx<K, ActionMap[A]>>
		) => BodyReturn<NoInfer<ActionMap[A] extends { output: infer O } ? ValueOf<O> : unknown>>
	): void;
	similarity<N extends keyof SimilarityMap & string>(
		name: N,
		body: NoInfer<SimilarityBody<K, SimilarityMap[N]>>
	): void;
};

/**
 * `src/data/collection/<m>/+collection.ts`: what callers may do with model `<m>`: the fields they `read`, the `create` and
 * `update` input allowlists, `delete`, and named queries, actions and similarity searches. Bodies attach after the literal
 * with `c.transform`, `c.query`, `c.action` and `c.similarity`.
 * @example
 * const c = collection('products', {
 * 	read: { fields: 'all' },
 * 	create: { input: { columns: ['code', 'name', 'unit_price'] } },
 * 	queries: { active_count: { description: 'Active products', input: {}, output: { kind: 'int' } } }
 * });
 * export default c;
 * c.query('active_count', function* (_, ctx) {
 * 	return (yield* ctx.read('products', { where: { active: { eq: true } }, all: true })).rows.length;
 * });
 */
export function collection<const K extends ModelName | SystemName, const S extends CollectionSpec>(
	name: K,
	spec: S & NoInfer<Checked<CollectionSpec, S, Exact<S, SpecFor<K, S>>>>
): Collection<K, S> {
	const bodies: Collection<K, S>['bodies'] = { queries: {}, actions: {}, similarity: {} };
	const declared = (part: 'queries' | 'actions' | 'similarity', key: string): void => {
		const names = (spec as CollectionSpec)[part];
		if (names === undefined || !Object.hasOwn(names, key))
			throw new Error(`collection ${name}: ${part} '${key}' is not declared`);
		if (Object.hasOwn(bodies[part], key))
			throw new Error(`collection ${name}: ${part} '${key}' is attached twice`);
	};
	return {
		name,
		spec,
		bodies,
		project(body) {
			if (spec.read.projection === undefined)
				throw new Error(`collection ${name}: read projection is not declared`);
			if (bodies.project !== undefined)
				throw new Error(`collection ${name}: projection is attached twice`);
			bodies.project = attached(body, 1);
		},
		transform(body) {
			if (bodies.transform !== undefined)
				throw new Error(`collection ${name}: transform is attached twice`);
			bodies.transform = attached(body, 1);
		},
		query(key, body) {
			declared('queries', key);
			bodies.queries[key] = attached(body, 1);
		},
		action(key, body) {
			declared('actions', key);
			bodies.actions[key] = attached(body, 1);
		},
		similarity(key, body) {
			declared('similarity', key);
			bodies.similarity[key] = body;
		}
	};
}
