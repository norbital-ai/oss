// `collection()` (§3.3.4): the exposed portion of one model. Data in the literal; the one transform and each query,
// action and similarity body attach in their own statements (X-2), so no literal's type depends on a body.
import type { ActionCtx, DeleteInput, QueryCtx, TransformCtx, TransformRow } from './ctx.ts';
import type { Checked, Exact, InputFields, InputKind, InputOf, ValidInput, ValidInputs, ValueOf } from './fields.ts';
import type {
	Columns, Direction, FieldName, ManyRels, ModelName, OneRels, OwnedFk, OneTarget, PersonChannelName, PolicyName,
	RelNameOf, Row, SystemName, TeamName, VectorField, WritableField
} from './names.ts';
import type { Where } from './where.ts';
import type { Msg, Vector } from './values.ts';

/**
 * How the in-app agent may call a query or action: `direct` (default), `confirm` (an in-app confirmation card first) or `never`.
 */
export type AgentUse = 'direct' | 'confirm' | 'never';
/** The write and approval events a collection's `notifications` rules react to. */
export type NotificationEvent = 'committed' | 'rejected' | 'approvalStarted' | 'approvalStepRequested' | 'approvalStepApproved'
	| 'approvalChangesRequested' | 'approvalWithdrawn' | 'approvalSuperseded' | 'approvalConflicted' | 'approvalCompleted';
/** A column of `C` holding a member: an FK to `sys_user`, or `created_by`/`updated_by`. */
export type UserField<C> = { [R in keyof OneRels<C>]: OneTarget<C, R> extends 'sys_user' ? R : never }[keyof OneRels<C>] & string | 'created_by' | 'updated_by';
/**
 * Whom a notification goes to: the requestor, the current step's approvers, a team, a member named by a field of the row, or a policy's holders.
 */
export type Recipient<C> = 'requestor' | 'step_approvers' | { team: TeamName } | { user: UserField<C> } | { policy: PolicyName };
type Title = Msg | { one: Msg; many: Msg };
/**
 * One notification rule: the person channel it is sent on, its recipients, which write `action`s trigger it, and its title and body messages.
 */
export type NotificationRule<C> = { channel: PersonChannelName; to: readonly Recipient<C>[];
	on?: { action?: readonly ('create' | 'update' | 'delete')[] }; title: Title; body?: Title };

/** A create/update allowlist: writable columns, plus explicit relation actions per many-relation (never by omission). */
/** An update never lists an owned child's parent key (rule 41). A create's `filled` names the fields its transform fills
 * when the input omits them (GAP-6): optional in `Insert`, still `required` after the transform (rule 23). */
export type Selection<M, Op = 'create'> = { columns: readonly (Op extends 'update' ? Exclude<WritableField<M>, OwnedFk<M>> : WritableField<M>)[];
	filled?: Op extends 'update' ? never : readonly WritableField<M>[];
	with?: { [R in keyof ManyRels<M>]?: { create?: Selection<ManyRels<M>[R]>; update?: Selection<ManyRels<M>[R], 'update'>;
		upsert?: Selection<ManyRels<M>[R]>; link?: {}; unlink?: {}; delete?: {} } } };
type Candidates = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
type Reserved = 'create' | 'update' | 'delete' | 'upsert' | 'import' | 'export' | 'erase';

/**
 * A collection query: a description, the typed `input` fields, the `output` kind and how the agent may call it. Its body attaches with `c.query(name, fn)`.
 */
export type QuerySpec = { description: string; input: InputFields; output: InputKind; agent?: AgentUse };
/**
 * A collection action: typed `input`, optional `output`, `target: 'record'` to run on chosen rows, `internal` to hide it from callers, and agent use. Its body attaches with `c.action(name, fn)`.
 */
export type ActionSpec = { description: string; input: InputFields; output?: InputKind; target?: 'record'; internal?: true; agent?: AgentUse };
/** A named similarity search: its typed `input` and how many `candidates` the body returns per call (1–16). */
export type SimilarSpec = { description: string; input: InputFields; candidates?: Candidates };
/** The value a query, action or automation literal declares as its `output` (`undefined` when it declares none). */
export type OutputOf<X> = X extends { output: infer O } ? ValueOf<O> : undefined;
type SelectionBase = { columns: readonly string[]; filled?: readonly string[]; with?: { readonly [r: string]: { [a: string]: SelectionBase | {} } } };
/**
 * The general shape of `collection()`'s spec: what callers `read`, the `create`/`update` input allowlists, `delete`, and the named
 * `queries`, `actions`, `similarity` searches and `notifications`.
 */
export type CollectionSpec = {
	description?: string;
	/** The fields and relations callers read (grants narrow them further). */
	read: { fields: 'all' | readonly string[]; relations?: 'all' | readonly string[] };
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
	notifications?: { readonly [E in NotificationEvent]?: readonly object[] };
};

type InputPart<X> = X extends { input: infer I } ? ValidInputs<I> : never;
type OutputPart<X> = X extends { output: infer O } ? ValidInput<O> : never;
type QueriesFor<Q> = { [N in keyof Q]: N extends Reserved ? `error: '${N & string}' is a generated verb`
	: { description: string; input: InputPart<Q[N]>; output: OutputPart<Q[N]>; agent?: AgentUse } };
// a query and an action of one name would share a callable, a limit key and a grant name
type ActionsFor<A, Q> = { [N in keyof A]: N extends Reserved ? `error: '${N & string}' is a generated verb`
	: N extends keyof Q ? `error: '${N & string}' is already a query`
	: { description: string; input: InputPart<A[N]>; output?: OutputPart<A[N]>; target?: 'record'; internal?: true; agent?: AgentUse } };
type Part<S, K extends string> = S extends { [P in K]: infer V } ? V : {};
type Full<K, S> = {
	description?: string;
	read: { fields: 'all' | readonly FieldName<K>[]; relations?: 'all' | readonly RelNameOf<K>[] };
	create?: { input: Selection<K> };
	update?: { input: Selection<K, 'update'> };
	delete?: {} | { transform: true };
	queries?: QueriesFor<Part<S, 'queries'>>;
	actions?: ActionsFor<Part<S, 'actions'>, Part<S, 'queries'>>;
	similarity?: { [N in keyof Part<S, 'similarity'>]: { description: string; input: InputPart<Part<S, 'similarity'>[N]>; candidates?: Candidates } };
	notifications?: { [E in NotificationEvent]?: readonly NotificationRule<K>[] };
};
/** P14: a collection whose integration is one_way is read-only by type. */
type SpecFor<K, S> = Direction<K> extends 'one_way' ? Omit<Full<K, S>, 'create' | 'update' | 'delete' | 'actions'> : Full<K, S>;

type Queries<S> = Part<S, 'queries'>;
type Actions<S> = Part<S, 'actions'>;
type Similarities<S> = Part<S, 'similarity'>;
type In<X> = X extends { input: infer I } ? InputOf<I> : never;
type Body = (...args: never[]) => unknown;

export type TransformBody<K, S> = (
	inputs: readonly (TransformRow<K> | (S extends { delete: { transform: true } } ? DeleteInput : never))[],
	ctx: TransformCtx<K>
) => Promise<readonly (TransformRow<K> | DeleteInput)[]>;
export type SimilarityBody<K, X> = {
	/** The vector to rank by, and a filter applied inside the index scan. */
	probe: (input: In<X>) => { field: VectorField<K>; vector: Vector; where?: Where<K> };
	/** Exact score over the candidate page, ascending; `undefined` keeps index order. */
	rerank?: (input: In<X>, row: Row<K>) => number | undefined;
};

export type Collection<K extends ModelName | SystemName, S> = {
	readonly name: K;
	readonly spec: S;
	/** The attached bodies, read by the compiler. */
	readonly bodies: { transform?: Body; queries: Record<string, Body>; actions: Record<string, Body>; similarity: Record<string, object> };
	/** The one transform for every write batch (R2); at most once. A one_way collection has none. */
	transform(body: Direction<K> extends 'one_way' ? never : TransformBody<K, S>): void;
	// The name alone infers `Q`: inferring from the body's return into `ValueOf` walked every kind's branch (~2 ms a call).
	query<Q extends keyof Queries<S> & string>(name: Q,
		body: (input: NoInfer<In<Queries<S>[Q]>>, ctx: QueryCtx) => Promise<NoInfer<ValueOf<Queries<S>[Q] extends { output: infer O } ? O : never>>>): void;
	action<A extends keyof Actions<S> & string>(name: A,
		body: (input: NoInfer<In<Actions<S>[A]>>, ctx: NoInfer<ActionCtx<K, Actions<S>[A]>>) => Promise<NoInfer<Actions<S>[A] extends { output: infer O } ? ValueOf<O> : unknown>>): void;
	similarity<N extends keyof Similarities<S> & string>(name: N, body: NoInfer<SimilarityBody<K, Similarities<S>[N]>>): void;
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
 * c.query('active_count', async (_, ctx) => (await ctx.read('products', { where: { active: { eq: true } }, all: true })).rows.length);
 */
export function collection<const K extends ModelName | SystemName, const S extends CollectionSpec>(name: K, spec: S & Checked<CollectionSpec, S, Exact<S, SpecFor<K, S>>>): Collection<K, S> {
	const bodies: Collection<K, S>['bodies'] = { queries: {}, actions: {}, similarity: {} };
	const declared = (part: 'queries' | 'actions' | 'similarity', key: string): void => {
		const names = (spec as CollectionSpec)[part];
		if (names === undefined || !Object.hasOwn(names, key)) throw new Error(`collection ${name}: ${part} '${key}' is not declared`);
		if (Object.hasOwn(bodies[part], key)) throw new Error(`collection ${name}: ${part} '${key}' is attached twice`);
	};
	return {
		name,
		spec,
		bodies,
		transform(body) {
			if (bodies.transform !== undefined) throw new Error(`collection ${name}: transform is attached twice`);
			bodies.transform = body;
		},
		query(key, body) {
			declared('queries', key);
			bodies.queries[key] = body;
		},
		action(key, body) {
			declared('actions', key);
			bodies.actions[key] = body;
		},
		similarity(key, body) {
			declared('similarity', key);
			bodies.similarity[key] = body;
		}
	};
}
