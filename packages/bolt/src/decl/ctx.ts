// What collection bodies see (§3.4) and the write shapes they call with (X-24): rows, selections, `act`, outcomes.
// ponytail: `aggregate` and `history` belong to the reads area.
import type { Actor } from './access/actor.ts';
import type { DateLiteral, InputOf, Simplify, ValueOf } from './fields.ts';
import type {
	CallerValue, CollectionName, FileField, HeavyField, Is, CollectionSpecOf, ColumnValue, Columns, ManyRelFk, ManyRels, NamesPart, OmittableOnInsert, OneRels, OneTarget, ReadField, ReadableName,
	ReadRelation, RelTarget, Row, StoredRow, TargetName, WritableField
} from './names.ts';
import type { Notify, Schedule, StartInput } from './runtime/facilities.ts';
import type { StartableName } from './access/policy.ts';
import type { ModelWhere, OrderBy, Where } from './where.ts'; // hook:query (OrderBy)
import type { DatePeriod, Decimal, IanaZone, Id, Instant, InstantPeriod, PlainDate, FileRef, RequestId, Json } from './values.ts';
import type { WireRead } from '../protocol/wire.ts';

// ── reads ──
declare const cursor: unique symbol;
/** An opaque page cursor: pass a page's `next` back as `after` to read on. */
export type Cursor = string & { readonly [cursor]: true };
/** Rule 9: every read states a limit or asks for everything. */
export type Paged = { limit: number; after?: Cursor; all?: never } | { all: true; limit?: never; after?: never };
/** One page of a read: its `rows`, and the `next` cursor, `null` on the last page. */
export type Page<T> = { readonly rows: readonly T[]; readonly next: Cursor | null };
type RelSelect<C, R> = R extends keyof OneRels<C> ? { select: Select<OneTarget<C, R>> }
	: { select: Select<RelTarget<C, R>>; where?: Where<RelTarget<C, R>> } & Paged;
// Single mapped types with declared variance: TS otherwise measures a generic alias's variance over the whole
// names index, which cost seconds per workspace (G1 scale fixture).
/** A `select` literal: exposed fields as `true`, exposed relations as nested selects (an FK may be either). */
export type Select<in out C> = { readonly [P in ReadField<C> | ReadRelation<C>]?:
	P extends ReadRelation<C> ? RelSelect<C, P> | (P extends ReadField<C> ? true : never) : true };
type SelectOf<X> = X extends { select: infer S } ? S : {};
/** The row a `select` returns: `id`, the selected fields, and the selected relations. */
export type Picked<in out C, in out S> = { readonly [P in 'id' | (keyof S & (ReadField<C> | ReadRelation<C>))]:
	P extends 'id' ? Id<C & string>
	: S[P & keyof S] extends true ? CallerValue<C, P>
	: P extends keyof OneRels<C> ? Picked<OneTarget<C, P>, SelectOf<S[P & keyof S]>> | (OneRels<C>[P] extends { optional: true } ? null : never)
	: readonly Picked<RelTarget<C, P>, SelectOf<S[P & keyof S]>>[] };
/** A model's natural key as values; exists only where the model declares `key` (§3.3.9). */
export type KeyValues<C> = NamesPart<'models'> extends { [P in C & string]: { key: readonly (infer K)[] } }
	? { readonly [P in K & string]: ColumnValue<C, P> } : never;
/** A read that has not run: `await q` reads once, `live(q)` subscribes (rule 64); `read` is its wire form. */
export type Q<T> = PromiseLike<T> & { readonly read: WireRead };
export type LiveError = { code: string; message: string };
/** A live read, a Svelte store: `$view` in a component, or `.current`. */
export type Live<T> = { readonly current: T | undefined; readonly error: LiveError | undefined; subscribe(run: (value: T | undefined) => void): () => void };
/** One history entry of a row of `C` (rule 17). */
export type Revision<C> = { readonly revision: number; readonly at: Instant;
	readonly actor: { readonly kind: Actor['kind']; readonly id: string } | null;
	readonly cause: 'direct' | 'cascade' | 'derived' | 'seed' | 'erased' | 'hold' | 'restore';
	readonly approval_id: RequestId | null; readonly changed: Partial<Row<C>> };
type ReadResult<C, S> = [keyof S] extends [never] ? Row<C> : Picked<C, S>;
/** A read's row without a `select`: the caller row less its heavy fields, which only a `select` or a `get` returns. */
export type ListRow<C> = Omit<Row<C>, HeavyField<C>>;
type ListResult<C, S> = [keyof S] extends [never] ? ListRow<C> : Picked<C, S>;

type QueriesOfC<C> = CollectionSpecOf<C> extends { queries: infer Q } ? Q : {};
type ActionsOfC<C> = CollectionSpecOf<C> extends { actions: infer A } ? A : {};
type SimilaritiesOfC<C> = CollectionSpecOf<C> extends { similarity: infer S } ? S : {};
type SimilarityName<C> = keyof SimilaritiesOfC<C> & string;
/** The names of `C`'s declared queries. */
export type QueryName<C> = keyof QueriesOfC<C> & string;
/** The names of `C`'s declared actions. */
export type ActionName<C> = keyof ActionsOfC<C> & string;
type In<X> = X extends { input: infer I } ? InputOf<I> : undefined;
type Out<X> = X extends { output: infer O } ? ValueOf<O> : undefined;

/** Reads as the caller (queries, actions): exposed fields only. Only the collection name (and `select`) infers: `NoInfer`
 * keeps TS from inferring back through `Where` and `ActInput`, which walked their conditional branches on every call. */
export interface CallerReads {
	read<C extends string, const S extends Select<C> = {}>(collection: Is<C, ReadableName>, q: { where?: NoInfer<Where<C>>; select?: S; orderBy?: NoInfer<OrderBy<C>> } & Paged): Promise<Page<ListResult<C, S>>>; // hook:query (orderBy)
	/** `{ revision }` (L-BOLT-181): the record as of that revision, folded from its history; `null` once pruned past its create. */
	get<C extends string, const S extends Select<C> = {}>(collection: Is<C, ReadableName>, id: NoInfer<Id<C>>, q?: { select?: S; revision?: number }): Promise<ReadResult<C, S> | null>;
	/** A named similarity search (§3.3.4): nearest first, each row with its `$distance`. */
	similar<C extends string, N extends SimilarityName<C>, const S extends Select<C> = {}>(collection: Is<C, ReadableName>, search: N,
		input: NoInfer<In<SimilaritiesOfC<C>[N]>>, q: { where?: NoInfer<Where<C>>; select?: S; limit: number }): Promise<readonly (ListResult<C, S> & { readonly $distance: number })[]>;
	/** Over `search.semantic` (L-BOLT-123): nearest by meaning to a text, or to a record's own embedding (the record itself left out). */
	similar<C extends string, const S extends Select<C> = {}>(collection: Is<C, ReadableName>,
		q: { to: string | { record: { id: NoInfer<Id<C>> } }; where?: NoInfer<Where<C>>; select?: S; limit: number }): Promise<readonly (ListResult<C, S> & { readonly $distance: number })[]>;
	query<C extends string, Q extends QueryName<C>>(collection: Is<C, CollectionName>, query: Q, input: NoInfer<In<QueriesOfC<C>[Q]>>): Promise<Out<QueriesOfC<C>[Q]>>;
}
/** Reads as the workspace (the transform, rule 15): unmasked stored rows. */
export interface WorkspaceReads {
	/** `select` names the stored fields to read (a 7 MB lineage read only its needed columns, rule 72); `id` always comes. */
	read<C extends string, const S extends { readonly [P in keyof StoredRow<C>]?: true } = {}>(collection: Is<C, ReadableName>,
		q: { where?: NoInfer<ModelWhere<C>>; select?: S } & Paged): Promise<Page<[keyof S] extends [never] ? StoredRow<C> : Pick<StoredRow<C>, (keyof S | 'id') & keyof StoredRow<C>>>>;
	get<C extends string>(collection: Is<C, ReadableName>, id: NoInfer<Id<C>>, q?: { revision?: number }): Promise<StoredRow<C> | null>;
	/** Stored rows overlaid with this batch's inputs (PH GAP-5). */
	after<C extends string>(collection: Is<C, ReadableName>, where: NoInfer<ModelWhere<C>>): Promise<readonly StoredRow<C>[]>;
	after<C extends string, const S extends {readonly [P in keyof StoredRow<C>]?:true}={}>(collection:Is<C,ReadableName>,where:NoInfer<ModelWhere<C>>,query:{select?:S;orderBy?:NoInfer<OrderBy<C>>}&Paged):Promise<Page<[keyof S] extends [never]?StoredRow<C>:Pick<StoredRow<C>,(keyof S|'id')&keyof StoredRow<C>>>>;
}
interface Clock { actor: Actor; now: Instant; today: PlainDate; tz: IanaZone; todayIn(zone: IanaZone): PlainDate }

// ── writes ──
type Cols<Sel> = Sel extends { columns: readonly (infer P extends string)[] } ? P : never;
type RelValues<T, A> = { readonly [V in keyof A]?: V extends 'create' ? readonly SelValues<T, A[V], 'insert'>[]
	: V extends 'upsert' ? readonly (SelValues<T, A[V], 'insert'> | ({ id: Id<T & string> } & SelValues<T, A[V], 'patch'>))[]
	: V extends 'update' ? readonly { target: Id<T & string>; set: SelValues<T, A[V], 'patch'> }[] : readonly Id<T & string>[] };
type WithValues<M, Sel> = Sel extends { with: infer W } ? { readonly [R in keyof W]?: RelValues<RelTarget<M, R>, W[R]> } : {};
type Filled<Sel> = Sel extends { filled: readonly (infer P extends string)[] } ? P : never;
type Omittable<M, Sel, P> = P extends Filled<Sel> ? true : OmittableOnInsert<M, P>;
/** A written value: the row's own value, or the plain literal decode accepts for it (ISO date or instant text, decimal
 * text or an integer), at a period's ends too. */
export type Loose<V> = V extends Decimal ? Decimal | number | `${number}`
	: V extends PlainDate ? PlainDate | DateLiteral : V extends Instant ? Instant | `${DateLiteral}T${string}`
	: V extends DatePeriod ? { readonly from: Loose<PlainDate>; readonly to: Loose<PlainDate> | null }
	: V extends InstantPeriod ? { readonly start: Loose<Instant>; readonly end: Loose<Instant> | null }
	: V;
type SelValues<M, Sel, Mode> = Simplify<
	{ readonly [P in Cols<Sel> as Mode extends 'patch' ? never : Omittable<M, Sel, P> extends true ? never : P]: Loose<ColumnValue<M, P>> }
	& { readonly [P in Cols<Sel> as Mode extends 'patch' ? P : Omittable<M, Sel, P> extends true ? P : never]?: Loose<ColumnValue<M, P>> }
	& WithValues<M, Sel>>;
export type InputSel<C, Op> = CollectionSpecOf<C> extends { [P in Op & string]: { input: infer Sel } } ? Sel : never;
/** A create input of `C`: its `create` allowlist, required fields required. */
export type Insert<C> = SelValues<C, InputSel<C, 'create'>, 'insert'>;
/** An update `set` of `C`: its `update` allowlist, every field optional. */
export type Patch<C> = SelValues<C, InputSel<C, 'update'>, 'patch'>;

export type Keyed<C> = NamesPart<'models'> extends { [P in C & string]: { key: readonly unknown[] } | { unique: readonly unknown[] } } ? true : false;
// an upsert names its record by id (rule 28), so it needs both arms; an import matches the natural key (rule 30)
type Verbs<C, S = CollectionSpecOf<C>> = (S extends { create: unknown } ? 'create' | (Keyed<C> extends true ? 'import' : never) | (S extends { update: unknown } ? 'upsert' : never) : never)
	| (S extends { update: unknown } ? 'update' : never) | (S extends { delete: unknown } ? 'delete' : never);
/** Every callable: a collection's generated verb or declared action (X-1, X-24). */
export type Callable = { [C in CollectionName]: `${C}.${Verbs<C> | ActionName<C>}` }[CollectionName];
type Targets<C> = Id<C & string> | readonly Id<C & string>[];
type ActionArg<C, X> = X extends { target: 'record' } ? { target: Targets<C> } & ({} extends In<X> ? { input?: In<X> } : { input: In<X> }) : In<X>;
/**
 * The input a callable takes (`'<c>.create'`, `'<c>.update'`, `'<c>.<action>'`, …): an insert, `{ target, set }`, `{ target }` or the action's declared input.
 */
export type ActInput<N> = N extends `${infer C}.${infer V}`
	? V extends 'create' ? Insert<C> | readonly Insert<C>[]
	: V extends 'upsert' ? Insert<C> | ({ id: Id<C> } & Patch<C>) | readonly (Insert<C> | ({ id: Id<C> } & Patch<C>))[]
	: V extends 'import' ? readonly Insert<C>[]
	: V extends 'update' ? { target: Targets<C>; set: Patch<C> } | readonly { target: Id<C>; set: Patch<C> }[]
	: V extends 'delete' ? { target: Targets<C> }
	: V extends ActionName<C> ? ActionArg<C, ActionsOfC<C>[V]> : never
	: never;
/** The output an action callable returns: its declared `output` value, `undefined` for a generated verb. */
export type ActOutput<N> = N extends `${infer C}.${infer V}` ? V extends ActionName<C> ? Out<ActionsOfC<C>[V]> : undefined : never;
/** `onConflict` is required on `upsert` (rule 28): `update` merges into the row its `id` names, `keep` leaves it. */
export type ActOptions = { key?: string; once?: string; onConflict?: 'update' | 'keep' };
type OptionsOf<N> = N extends `${string}.upsert` ? [options: ActOptions & { onConflict: 'update' | 'keep' }] : [options?: ActOptions];

// ── outcomes (rule 32, §3.3.9) ──
type Written = readonly { collection: CollectionName; id: string; revision: number }[];
/** Rows a write reports, branded as the callable's collection (`'<c>.<verb>'`). */
type WrittenOf<N> = N extends `${infer C extends CollectionName}.${string}`
	? readonly { readonly collection: C; readonly id: Id<C>; readonly revision: number }[]
	: Written;
/**
 * The engine's own refusal codes (rule 32), beside an authored `refused`: grants, constraints, budgets, rate limits and stale requests.
 */
export type PlatformRefusal = 'approvalHeld' | 'locked' | 'readBudgetExceeded' | 'forbidden' | 'notFound' | 'invalidInput'
	| 'unique' | 'check' | 'overlap' | 'missingRef' | 'restricted' | 'required' | 'overflow' | 'rateLimited' | 'keyReuse'
	| 'approvalSplit' // hook:approvals (rule 44)
	/** L-BOLT-171: the act names a schema (`Bolt-Contract`) this workspace no longer runs; reload the page. */
	| 'releaseChanged'
	/** Rule 31: an `issuedAt` older than 23 h or more than 5 min ahead. */
	| 'expired'
	/** Rule 42: a throw from tenant code (its message reaches members only); the guest budgets (rule 72). */
	| 'internal' | 'cpuBudget' | 'crossingBudget' | 'memory' | 'tooLarge';
/**
 * The write is in the database: `output` is the action's result, `records` every row written with its new revision.
 */
export type Committed<O, N = string> = { kind: 'committed'; output: O; records: WrittenOf<N> };
/** The write is held for approval (§3.8): `requestId` names the approval request, `records` the held rows. */
export type PendingApproval<N = string> = { kind: 'pendingApproval'; requestId: RequestId; records: WrittenOf<N> };
/**
 * The write was refused: `code` is `refused` for an authored refusal or a platform code, with the message and the field or rows it names.
 */
export type Refused = { kind: 'refused'; code: 'refused' | PlatformRefusal; message: string; field?: string; row?: number; rows?: readonly number[];
	/** A.2 L-BOLT-043: the tenant code that refused — `'<collection>.transform'` or `'<collection>.<action>'`. */
	rule?: string;
	/** hook:approvals — rule 46: `approvalHeld { requestId }` names the request that holds the row. */
	data?: { readonly requestId: RequestId } };
/** The write lost a race: another write changed the named fields of these records since they were read. */
export type Conflict = { kind: 'conflict'; records: readonly { collection: CollectionName; id: string; fields: readonly string[] }[] };
/** The outcome could not be confirmed (a lost connection); `invocation` is the id to look the write up by. */
export type Unknown = { kind: 'unknown'; invocation: string };
/**
 * Every result of a write (rule 32): `committed`, `pendingApproval`, `refused`, `conflict` or `unknown`, told apart by `kind`.
 */
export type Outcome<O, N = string> = Committed<O, N> | PendingApproval<N> | Refused | Conflict | Unknown;
/**
 * `ctx.act` in an action or automation: runs a callable with its typed input. The call throws on `refused`, `conflict` and `unknown`
 * and returns a committed or held write; `ctx.act.try` returns every `Outcome` instead.
 * @example
 * const { records } = await ctx.act('orders.create', { customer, lines: { create: [{ sku, qty: 1 }] } });
 */
export interface Act {
	/** Throws `Refused | Conflict | Unknown`; a held write is a success. */
	<const N extends string>(callable: Is<N, Callable>, input: NoInfer<ActInput<N>>, ...options: NoInfer<OptionsOf<N>>): Promise<Committed<ActOutput<N>, N> | PendingApproval<N>>;
	try<const N extends string>(callable: Is<N, Callable>, input: NoInfer<ActInput<N>>, ...options: NoInfer<OptionsOf<N>>): Promise<Outcome<ActOutput<N>, N>>;
}

// ── contexts ──
// Contexts are interfaces with declared variance: measuring the variance of a generic alias over a large names index
// cost seconds per body (G1 scale fixture).
/**
 * What a query body sees: the actor, clock and timezone, caller reads (`read`, `get`, `similar`, `query`) and `refuse`.
 */
export interface QueryCtx extends Clock, CallerReads {
	invocationId: string;
	/** Ends the body with an authored refusal (rule 32); `field` names an input field. */
	refuse(message: string, at?: { field?: string }): never;
}
type InputField<X> = keyof (X extends { input: infer I } ? I : {}) & string;
/**
 * Every `ctx.act` is recorded into the action's one statement (rule 20), so nothing it writes is in the database until
 * the action returns: a later `ctx.read`/`ctx.get`, and a later act's transform, see the rows as they were before the
 * action. A later act may name a row an earlier one created (its id from `records`, rule 36). To read what you wrote,
 * keep the values you passed, or write the dependents in the same act (relation `with`, or one batch through the
 * transform, which sees the whole batch and `db.after`).
 */
export interface ActionCtx<in out C, in out X = {}> extends QueryCtx {
	readonly policies: readonly string[];
	readonly admin: boolean;
	act: Act; schedule: Schedule; notify: Notify;
	refuse(message: string, at?: { field?: InputField<X> }): never;
	/** The row a `target: 'record'` action runs on; `never` on any other action. */
	target: X extends { target: 'record' } ? Row<C> : never;
}

/** One element of a transform batch: the submitted input, which the transform returns with derived values set. */
export type TransformRow<M> = { readonly [P in WritableField<M>]?: Loose<ColumnValue<M, P>> }
	& { readonly [R in keyof ManyRels<M>]?: TransformRelations<ManyRels<M>[R], ManyRelFk<M, R>> } & Underived<M>;
// A returned payload is not a fresh literal, so excess keys pass unseen: derived and system columns are named `never`.
type Underived<M> = { readonly [P in Exclude<keyof Columns<M>, WritableField<M>>]?: never };
// A nested create names its parent through the relation, so the child's FK to it is implied.
type TransformInsert<T, Fk> = { readonly [P in Exclude<WritableField<T>, Fk> as OmittableOnInsert<T, P> extends true ? never : P]: ColumnValue<T, P> }
	& { readonly [P in Exclude<WritableField<T>, Fk> as OmittableOnInsert<T, P> extends true ? P : never]?: ColumnValue<T, P> }
	& { readonly [R in keyof ManyRels<T>]?: TransformRelations<ManyRels<T>[R], ManyRelFk<T, R>> } & Underived<T>;
type TransformRelations<T, Fk> = T extends TargetName ? {
	create?: readonly TransformInsert<T, Fk>[]; upsert?: readonly TransformInsert<T, Fk>[];
	update?: readonly { target: Id<T & string>; set: TransformRow<T> }[];
	link?: readonly Id<T & string>[]; unlink?: readonly Id<T & string>[]; delete?: readonly Id<T & string>[];
} : never;
export type DeleteInput = { readonly $delete: true };
/** Native planning evidence; a reservation is never a claim that the row was committed or approved. */
export type PreparedCreateReceipt={
	readonly collection:string;readonly id:string;readonly path:readonly (string|number)[];
	readonly values:Readonly<Record<string,Json>>;readonly committed:false;
	readonly phase:'PREPARED_NATIVE_CREATE';readonly invocation_id:string;
	readonly related_sources:readonly PreparedCreateReceipt[];
	readonly related_actions:readonly Json[];
};
/**
 * What the collection transform sees: the clock, `existing[i]` (the stored row of `inputs[i]`, `undefined` on create), the
 * workspace reads in `db` (unmasked, including `db.after`) and `refuse`.
 */
export interface TransformCtx<in out M> extends Clock {
	readonly policies: readonly string[];
	readonly admin: boolean;
	refuse(message: string, at?: { field?: WritableField<M> }): never;
	/** `existing[i]` is the stored row of `inputs[i]`, `undefined` for a create. */
	existing: readonly (StoredRow<M> | undefined)[];
	/** Engine-assigned identities for submitted roots and native relation children; never caller fields. */
	readonly staged: readonly { readonly collection:string; readonly id:string; readonly path:readonly (string|number)[]; readonly operation:string; readonly parent?:{readonly collection:string;readonly id:string;readonly relation:string;readonly field:string} }[];
	db: WorkspaceReads & {
		/** Reserve an engine identity for a generated owned child path. No write or approval occurs here. */
		prepareCreate(collection:CollectionName,values:Readonly<Record<string,Json>>,options:{readonly path:readonly (string|number)[]}):Promise<PreparedCreateReceipt>;
	};
}

// ── the page client (§3.5): `$bolt`'s reads and writes over the same names, rows and inputs as the `ctx` above ──
type QueryCallable = { [C in CollectionName]: `${C}.${QueryName<C>}` }[CollectionName];
type QueryOf<N> = N extends `${infer C}.${infer Q}` ? QueriesOfC<C>[Q & keyof QueriesOfC<C>] : never;
/** A `query` callable's input and output (`'<c>.<q>'`). */
export type QueryInput<N> = In<QueryOf<N>>;
/** A `query` callable's output (`'<c>.<q>'`): the query's declared `output` value. */
export type QueryOutput<N> = Out<QueryOf<N>>;
type UploadField = { [C in CollectionName]: `${C}.${FileField<C>}` }[CollectionName];
/** A key of `src/i18n/+messages.ts`. */
export type MessageKey = keyof NamesPart<'messages'> & string;
type Bucket<C> = ReadField<C> | { [U in 'day' | 'week' | 'month' | 'quarter' | 'year']: { [P in U]: ReadField<C> } }['day' | 'week' | 'month' | 'quarter' | 'year'];
type Measure<C> = readonly NoInfer<ReadField<C>>[];
type Measures<C> = { count?: true; sum?: Measure<C>; avg?: Measure<C>; min?: Measure<C>; max?: Measure<C>; where?: NoInfer<Where<C>> };
/** An `aggregate` row: the bucket values under `key`, then each measure asked for (a sum or average is a `Decimal`). */
export type AggRow = { readonly key?: { readonly [field: string]: unknown }; readonly count?: number;
	readonly sum?: { readonly [field: string]: Decimal | null }; readonly avg?: { readonly [field: string]: Decimal | null };
	readonly min?: { readonly [field: string]: unknown }; readonly max?: { readonly [field: string]: unknown } };
/** The typed members of `$bolt` (§3.5); a page reads and acts as its viewer, so rows are caller rows. */
export interface PageBolt {
	/**
	 * A page of rows the caller may read: `where`, `select`, `orderBy`, a text `search`, and `limit` (or `all: true`).
	 * @example
	 * const open = bolt.live(bolt.read('jobs', { where: { status: { eq: 'open' } }, orderBy: { due_on: 'asc' }, limit: 50 }));
	 */
	read<C extends string, const S extends Select<C> = {}>(collection: Is<C, ReadableName>,
		q: { where?: NoInfer<Where<C>>; select?: S; orderBy?: NoInfer<OrderBy<C>>; search?: string } & Paged): Q<Page<ListResult<C, S>>>;
	/** One record by id as the caller reads it, with an optional `select`; `null` when it is absent or not readable. */
	get<C extends string, const S extends Select<C> = {}>(collection: Is<C, ReadableName>, id: NoInfer<Id<C>>, select?: S): Q<ReadResult<C, S> | null>;
	/** The record as of `revision`, folded from its history (L-BOLT-181); `null` when its create was pruned or history is not readable. */
	get<C extends string>(collection: Is<C, ReadableName>, id: NoInfer<Id<C>>, select: undefined, options: { revision: number }): Q<StoredRow<C> | null>;
	/** Without `by`, one row over the whole scope; with `by`, a page of buckets (rule 9). */
	aggregate<C extends string>(collection: Is<C, ReadableName>, q: Measures<C> & { by?: never }): Q<AggRow>;
	aggregate<C extends string>(collection: Is<C, ReadableName>, q: Measures<C> & { by: NoInfer<Bucket<C>> | readonly NoInfer<Bucket<C>>[] } & Paged): Q<Page<AggRow>>;
	/** A named similarity search (§3.3.4): nearest first, each row with its `$distance`. */
	similar<C extends string, N extends SimilarityName<C>, const S extends Select<C> = {}>(collection: Is<C, ReadableName>, search: N,
		input: NoInfer<In<SimilaritiesOfC<C>[N]>>, q: { where?: NoInfer<Where<C>>; select?: S; limit: number }): Q<readonly (ListResult<C, S> & { readonly $distance: number })[]>;
	/** Over `search.semantic` (L-BOLT-123): nearest by meaning to a text, or to a record's own embedding (the record itself left out). */
	similar<C extends string, const S extends Select<C> = {}>(collection: Is<C, ReadableName>,
		q: { to: string | { record: { id: NoInfer<Id<C>> } }; where?: NoInfer<Where<C>>; select?: S; limit: number }): Q<readonly (ListResult<C, S> & { readonly $distance: number })[]>;
	/** A record's revisions, newest first, or as of an instant, a revision or before an approval request. */
	history<C extends string>(collection: Is<C, ReadableName>, id: NoInfer<Id<C>>,
		options?: { at?: { instant: Instant } | { revision: number } | { before: RequestId } }): Q<readonly Revision<C>[]>;
	/** Runs a collection query (`'<c>.<q>'`) with its typed input. */
	query<const N extends string>(name: Is<N, QueryCallable>, input: NoInfer<QueryInput<N>>): Q<QueryOutput<N>>;
	/** Keeps a read current: re-read when the rows it depends on change (or `on` those collections, or `every` interval); a reactive value in a page. */
	live<T>(q: Q<T>, options?: { every?: string; on?: readonly CollectionName[] }): Live<T>;
	/** Never rejects: a refusal is a business answer (rule 32). */
	act<const N extends string>(callable: Is<N, Callable>, input: NoInfer<ActInput<N>>, options?: { key?: string; once?: string }): Promise<Outcome<ActOutput<N>, N>>;
	/** Starts an automation now with its typed input; the handle's `id` is the run's id before the outcome settles. */
	start<const A extends string>(automation: Is<A, StartableName>, input: NoInfer<StartInput<A>>): PromiseLike<Outcome<unknown>> & { readonly id: Id<'sys_run'> };
	/** `accept` and `max` are checked before bytes are stored. */
	upload(file: Blob & { name?: string }, field: UploadField): Promise<FileRef>;
	/** The URL a page shows or downloads a stored file from. */
	fileUrl(ref: FileRef): string;
	/** A message of `+messages.ts` in the page's locale, `{name}` placeholders filled from `vars`. */
	t(key: MessageKey, vars?: { readonly [name: string]: string | number }): string;
	/**
	 * On-page sign-in (§5.11.2): `sendCode` texts or emails a six-digit code, `verify` proves it, signs the viewer in — a
	 * newcomer joins where the workspace declares `signup` — and reloads the page as them. A refusal is `message`. ui's
	 * `<PhoneVerify session={bolt.session} />` is the whole control.
	 */
	session: {
		sendCode(address: string): Promise<{ ok: true } | { ok: false; message: string }>;
		verify(address: string, code: string): Promise<{ ok: true } | { ok: false; message: string }>;
	};
	/** Who the page runs as; `null` before a visitor page has one. */
	actor: Actor | null;
}
/** The names ui's views are typed by (`@norbital-ai/ui`'s `Workspace`); none until the workspace declares a collection. */
export type ViewNames = [keyof NamesPart<'collections'>] extends [never] ? never : {
	collections: { [C in CollectionName]: { row: ListRow<C>; record: Row<C>; insert: Insert<C>; where: Where<C>; orderBy: OrderBy<C>;
		/** Many-relations a view may show as a column (a table's multi-link cell). */
		many: ReadRelation<C> & keyof ManyRels<C> & string } };
	queries: { [N in QueryCallable]: { input: QueryInput<N>; output: QueryOutput<N> } };
	actions: { [N in Callable]: ActInput<N> };
	automations: { [A in StartableName]: StartInput<A> };
};
