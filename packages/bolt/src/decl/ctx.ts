// What collection bodies see (§3.4) and the write shapes they call with (X-24): rows, selections, `act`, outcomes.
// Every ctx member answers an Effect with typed failures (D8): bodies are generators that `yield*` them.
// ponytail: `aggregate` and `history` belong to the reads area.
import type { Effect } from 'effect';
import type { Actor } from './access/actor.ts';
import type { ActConflict, ActRefused, ActUnknown, ReadFailed, Refusal } from './errors.ts';
import type { OutputOf } from './collection.ts';
import type { DateLiteral, InputOf, Simplify } from './fields.ts';
import type {
	CallerValue,
	CollectionName,
	HeavyField,
	Is,
	CollectionSpecOf,
	ColumnValue,
	Columns,
	ManyRelFk,
	ManyRels,
	NamesPart,
	OmittableOnInsert,
	OneRels,
	OneTarget,
	ReadField,
	ReadableName,
	ReadRelation,
	RelTarget,
	Row,
	RowState,
	StoredRow,
	WorkspaceReadRow,
	WorkspaceReadField,
	TargetName,
	WritableField
} from './names.ts';
import type { Notify, Schedule, StartInput } from './runtime/facilities.ts';
import type { StartableName } from './access/policy.ts';
import type { ModelWhere, OrderBy, Where } from './where.ts'; // hook:query (OrderBy)
import type {
	DatePeriod,
	Decimal,
	IanaZone,
	Id,
	Instant,
	InstantPeriod,
	PlainDate,
	RequestId,
	Json
} from './values.ts';

// ── effects (D8) ──
/**
 * What a `ctx` member answers: an Effect succeeding with `A` and failing with its typed failures `E`, `yield*`ed in a
 * generator body. One interface with declared variance keeps the check cost flat (G1).
 */
export interface Eff<out A, out E = never> extends Effect.Effect<A, E> {}
/** A body's failure: every failure is tagged (D3), and a body requires no service. */
export type BodyError = { readonly _tag: string };
/** What a ctx-bearing body returns: a generator (`function*`) whose return is the body's output. */
export type BodyReturn<O> = Effect.fn.Return<O, BodyError>;

// ── reads ──
declare const cursor: unique symbol;
/** An opaque page cursor: pass a page's `next` back as `after` to read on. */
export type Cursor = string & { readonly [cursor]: true };
/** Rule 9: every read states a limit or asks for everything. */
export type Paged =
	{ limit: number; after?: Cursor; all?: never } | { all: true; limit?: never; after?: never };
/** One page of a read: its `rows`, and the `next` cursor, `null` on the last page. */
export type Page<T> = { readonly rows: readonly T[]; readonly next: Cursor | null };
/** A manifest-checked dynamic read keeps the native identity; its selected values require domain decoding. */
export type DeclaredRow<C extends string> = {
	readonly id: Id<C>;
} & Readonly<Record<string, unknown>>;
/** Evaluated predicates and scalar field names, checked by the host against the actual model and reader. */
export type DeclaredQuery = {
	readonly mode: 'declared';
	readonly where?: Json | undefined;
	readonly select?: readonly string[] | undefined;
	readonly all: true;
};
type RelSelect<C, R> = R extends keyof OneRels<C>
	? { select: Select<OneTarget<C, R>> }
	: { select: Select<RelTarget<C, R>>; where?: Where<RelTarget<C, R>> } & Paged;
// Single mapped types with declared variance: TS otherwise measures a generic alias's variance over the whole
// names index, which cost seconds per workspace (G1 scale fixture).
/** A `select` literal: exposed fields as `true`, exposed relations as nested selects (an FK may be either). */
export type Select<in out C> = {
	readonly [P in ReadField<C> | ReadRelation<C>]?: P extends ReadRelation<C>
		? RelSelect<C, P> | (P extends ReadField<C> ? true : never)
		: true;
};
type SelectOf<X> = X extends { select: infer S } ? S : {};
/** The row a `select` returns: `id`, the selected fields, and the selected relations. */
type Picked<in out C, in out S> = {
	readonly [P in 'id' | (keyof S & (ReadField<C> | ReadRelation<C>))]: P extends 'id'
		? Id<C & string>
		: S[P & keyof S] extends true
			? CallerValue<C, P>
			: P extends keyof OneRels<C>
				? | Picked<OneTarget<C, P>, SelectOf<S[P & keyof S]>>
					| (OneRels<C>[P] extends { optional: true } ? null : never)
				: readonly Picked<RelTarget<C, P>, SelectOf<S[P & keyof S]>>[];
};
/** A model's natural key as values; exists only where the model declares `key` (§3.3.9). */
export type KeyValues<C> =
	NamesPart<'models'> extends { [P in C & string]: { key: readonly (infer K)[] } }
		? { readonly [P in K & string]: ColumnValue<C, P> }
		: never;
/** One history entry of a row of `C` (rule 17). */
export type Revision<C> = {
	readonly revision: number;
	readonly at: Instant;
	readonly actor: { readonly kind: Actor['kind']; readonly id: string } | null;
	readonly cause: 'direct' | 'cascade' | 'derived' | 'seed' | 'erased';
	readonly changed: Partial<Row<C>>;
};
/**
 * A selected row with its read state. Invariant in `S`, as `Picked` is: a structural mapped type makes a wider
 * select a subtype of a narrower one, so `[...a.rows, ...b.rows]` subtype-reduces to the narrower row and
 * `'field' in row` narrows the field to `unknown`.
 */
type PickedRow<in out C, in out S> = {
	[K in keyof (Picked<C, S> & RowState)]: (Picked<C, S> & RowState)[K];
};
/** A `get`'s row: the caller row, or the selected fields and relations. */
export type ReadResult<C, S> = [keyof S] extends [never] ? Row<C> : PickedRow<C, S>;
/** A read's row without a `select`: the caller row less its heavy fields, which only a `select` or a `get` returns. */
export type ListRow<C> = Omit<Row<C>, HeavyField<C>>;
/** A read's row: the list row, or the selected fields and relations. */
export type ListResult<C, S> = [keyof S] extends [never] ? ListRow<C> : PickedRow<C, S>;

type QueriesOfC<C> = CollectionSpecOf<C> extends { queries: infer Q } ? Q : {};
type ActionsOfC<C> = CollectionSpecOf<C> extends { actions: infer A } ? A : {};
export type SimilaritiesOfC<C> = CollectionSpecOf<C> extends { similarity: infer S } ? S : {};
export type SimilarityName<C> = keyof SimilaritiesOfC<C> & string;
/** The names of `C`'s declared queries. */
export type QueryName<C> = keyof QueriesOfC<C> & string;
/** The names of `C`'s declared actions. */
export type ActionName<C> = keyof ActionsOfC<C> & string;
export type In<X> = X extends { input: infer I } ? InputOf<I> : undefined;

/**
 * One member of a keyed read (`ctx.read({ key: member })`): a read of `collection` (its `where`, `select`, `orderBy` and
 * page, as `read` takes them), or with an `id` that row (`get`). A field's `{ in: { member, field } }` takes the values
 * of `field` across the rows an EARLIER member of the same read answered, inside the same statement: a dependent read
 * (an entity, then the versions its `settings_code` names) is still one read.
 */
export type ReadMember<C extends string> =
	| ({
			readonly collection: Is<C, ReadableName>;
			readonly where?: Where<C> | MemberWhere<C>;
			readonly select?: Select<C>;
			readonly orderBy?: OrderBy<C>;
	  } & Paged)
	| { readonly collection: Is<C, ReadableName>; readonly id: Id<C>; readonly select?: Select<C> };
/** An earlier keyed member's values of one of its fields: `{ in: { member: 'entity', field: 'settings_code' } }`. */
export type MemberIn =
	| { readonly in: { readonly member: string; readonly field: string } }
	| { readonly nin: { readonly member: string; readonly field: string } };
/** A keyed member's `where` that names an earlier member's values (each other clause as `Where` takes it). */
export type MemberWhere<C> = {
	readonly [P in ReadField<C>]?: MemberIn | NonNullable<Where<C>[P & keyof Where<C>]>;
};
/** A keyed read's members by key. */
export type ReadSet = { readonly [key: string]: { readonly collection: string } };
type MemberAnswer<M> = M extends { collection: infer C extends string; id: unknown }
	? ReadResult<C, SelectOf<M>> | null
	: M extends { collection: infer C extends string }
		? Page<ListResult<C, SelectOf<M>>>
		: never;
/** A keyed read's answer: each member's page (or row, for an `id` member) under its key. */
export type ReadSetAnswer<M> = { readonly [K in keyof M]: MemberAnswer<M[K]> };
/** A workspace keyed read's member (`ctx.db.read({ key: member })`): stored rows, or with an `id` that row. */
export type StoredMember<C extends string> =
	| ({
			readonly collection: Is<C, ReadableName>;
			readonly where?: ModelWhere<C> | MemberWhere<C>;
			readonly select?: { readonly [P in WorkspaceReadField<C>]?: true };
	  } & Paged)
	| { readonly collection: Is<C, ReadableName>; readonly id: Id<C> };
type WorkspaceSelection<C, S, R = WorkspaceReadRow<C>> = Pick<R, (keyof S | 'id') & keyof R>;
/** The unmasked stored result of one native workspace read member, with its exact selected fields. */
export type StoredAnswer<M> = M extends { collection: infer C extends string; id: unknown }
	? StoredRow<C> | null
	: M extends { collection: infer C extends string }
		? Page<[keyof SelectOf<M>] extends [never] ? StoredRow<C> : WorkspaceSelection<C, SelectOf<M>>>
		: never;

/** Reads as the caller (queries, actions): exposed fields only. Only the collection name (and `select`) infers: `NoInfer`
 * keeps TS from inferring back through `Where` and `ActInput`, which walked their conditional branches on every call. */
export interface CallerReads<E = never> {
	/** Dynamic declarations use the same native caller policies, exposure and masked values as literal reads. */
	read<C extends string>(
		collection: Is<C, ReadableName>,
		query: DeclaredQuery
	): Eff<Page<DeclaredRow<C>>, ReadFailed>;
	read<C extends string, const S extends Select<C> = {}>(
		collection: Is<C, ReadableName>,
		q: {
			where?: NoInfer<Where<C>>;
			select?: S;
			orderBy?: NoInfer<OrderBy<C>>;
			search?: string;
		} & Paged
	): Eff<Page<ListResult<C, S>>, E>; // hook:query (orderBy)
	/**
	 * A keyed set of reads in one crossing and ONE statement: each member is a read (or, with `id`, a `get`) under the
	 * caller's read policies, answered under its key. Every member states its page (rule 9); the row and byte caps hold
	 * per member and name the member that breaks them.
	 * @example
	 * const { contracts, entity } = yield* ctx.read({
	 *   contracts: { collection: 'contract', where: { company_id: { eq: id } }, all: true },
	 *   entity: { collection: 'entity', id },
	 *   versions: { collection: 'settings', where: { code: { in: { member: 'entity', field: 'settings_code' } } }, all: true },
	 * });
	 */
	read<const M extends ReadSet>(
		set: M & { readonly [K in keyof M]: ReadMember<M[K]['collection']> }
	): Eff<ReadSetAnswer<M>, E>;
	/** `{ revision }` (L-BOLT-181): the record as of that revision, folded from its history; `null` once pruned past its create. */
	get<C extends string, const S extends Select<C> = {}>(
		collection: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		q?: { select?: S; revision?: number }
	): Eff<ReadResult<C, S> | null, E>;
	/** A named similarity search (§3.3.4): nearest first, each row with its `$distance`. */
	similar<C extends string, N extends SimilarityName<C>, const S extends Select<C> = {}>(
		collection: Is<C, ReadableName>,
		search: N,
		input: NoInfer<In<SimilaritiesOfC<C>[N]>>,
		q: { where?: NoInfer<Where<C>>; select?: S; limit: number }
	): Eff<readonly (ListResult<C, S> & { readonly $distance: number })[], E>;
	/** Over `search.semantic` (L-BOLT-123): nearest by meaning to a text, or to a record's own embedding (the record itself left out). */
	similar<C extends string, const S extends Select<C> = {}>(
		collection: Is<C, ReadableName>,
		q: {
			to: string | { record: { id: NoInfer<Id<C>> } };
			where?: NoInfer<Where<C>>;
			select?: S;
			limit: number;
		}
	): Eff<readonly (ListResult<C, S> & { readonly $distance: number })[], E>;
	query<C extends string, Q extends QueryName<C>>(
		collection: Is<C, CollectionName>,
		query: Q,
		input: NoInfer<In<QueriesOfC<C>[Q]>>
	): Eff<OutputOf<QueriesOfC<C>[Q]>, E>;
}
/** Reads as the workspace (the transform, rule 15): unmasked stored rows. */
export interface WorkspaceReads {
	/** Dynamic declarations read actual stored values; selected names and operands are manifest-checked. */
	read<C extends string>(
		collection: Is<C, ReadableName>,
		query: DeclaredQuery
	): Eff<Page<DeclaredRow<C>>, ReadFailed>;
	/** `select` names stored fields or existing native sequence labels (rule 72); `id` always comes. Defaults remain stored rows without sequences, roll-ups or computed fields. */
	read<C extends string, const S extends { readonly [P in WorkspaceReadField<C>]?: true } = {}>(
		collection: Is<C, ReadableName>,
		q: { where?: NoInfer<ModelWhere<C>>; select?: S } & Paged
	): Eff<Page<[keyof S] extends [never] ? StoredRow<C> : WorkspaceSelection<C, S>>>;
	/** A keyed set of stored reads in one crossing and one statement (as the caller's `read({ … })`, unmasked). */
	read<const M extends ReadSet>(
		set: M & { readonly [K in keyof M]: StoredMember<M[K]['collection']> }
	): Eff<{ readonly [K in keyof M]: StoredAnswer<M[K]> }>;
	get<C extends string>(
		collection: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		q?: { revision?: number }
	): Eff<StoredRow<C> | null>;
	/** Stored rows overlaid with this batch's inputs (PH GAP-5). */
	after<C extends string>(
		collection: Is<C, ReadableName>,
		where: NoInfer<ModelWhere<C>>
	): Eff<readonly StoredRow<C>[]>;
	after<C extends string, const S extends { readonly [P in keyof StoredRow<C>]?: true } = {}>(
		collection: Is<C, ReadableName>,
		where: NoInfer<ModelWhere<C>>,
		query: { select?: S; orderBy?: NoInfer<OrderBy<C>> } & Paged
	): Eff<
		Page<
			[keyof S] extends [never]
				? StoredRow<C>
				: Pick<StoredRow<C>, (keyof S | 'id') & keyof StoredRow<C>>
		>
	>;
}
interface Clock {
	readonly actor: Actor;
	now: Instant;
	today: PlainDate;
	tz: IanaZone;
	todayIn(zone: IanaZone): PlainDate;
}

// ── writes ──
type Cols<Sel> = Sel extends { columns: readonly (infer P extends string)[] } ? P : never;
type RelValues<T, A> = {
	readonly [V in keyof A]?: V extends 'create'
		? readonly InsertValues<T, A[V]>[]
		: V extends 'upsert'
			? readonly (InsertValues<T, A[V]> | ({ id: Id<T & string> } & PatchValues<T, A[V]>))[]
			: V extends 'update'
				? readonly { target: Id<T & string>; set: PatchValues<T, A[V]> }[]
				: readonly Id<T & string>[];
};
type WithValues<M, Sel> = Sel extends { with: infer W }
	? { readonly [R in keyof W]?: RelValues<RelTarget<M, R>, W[R]> }
	: {};
type Filled<Sel> = Sel extends { filled: readonly (infer P extends string)[] } ? P : never;
/** A written value: the row's own value, or the plain literal decode accepts for it (ISO date or instant text, decimal
 * text or an integer), at a period's ends too. */
export type Loose<V> = V extends Decimal
	? Decimal | number | `${number}`
	: V extends PlainDate
		? PlainDate | DateLiteral
		: V extends Instant
			? Instant | `${DateLiteral}T${string}`
			: V extends DatePeriod
				? { readonly from: Loose<PlainDate>; readonly to: Loose<PlainDate> | null }
				: V extends InstantPeriod
					? { readonly start: Loose<Instant>; readonly end: Loose<Instant> | null }
					: V;
type OptionalCols<M, Sel> = {
	[P in Cols<Sel>]: P extends Filled<Sel> ? P : OmittableOnInsert<M, P> extends true ? P : never;
}[Cols<Sel>];
type InsertValues<M, Sel, Optional = OptionalCols<M, Sel>> = Simplify<
	{ readonly [P in Exclude<Cols<Sel>, Optional>]: Loose<ColumnValue<M, P>> } & {
		readonly [P in Cols<Sel> & Optional]?: Loose<ColumnValue<M, P>>;
	} & WithValues<M, Sel>
>;
type PatchValues<M, Sel> = Simplify<
	{ readonly [P in Cols<Sel>]?: Loose<ColumnValue<M, P>> } & WithValues<M, Sel>
>;
export type InputSel<C, Op> =
	CollectionSpecOf<C> extends { [P in Op & string]: { input: infer Sel } } ? Sel : never;
/** A create input of `C`: its `create` allowlist, required fields required. */
export type Insert<C> = InsertValues<C, InputSel<C, 'create'>>;
/** An update `set` of `C`: its `update` allowlist, every field optional. */
export type Patch<C> = PatchValues<C, InputSel<C, 'update'>>;

export type Keyed<C> =
	NamesPart<'models'> extends {
		[P in C & string]: { key: readonly unknown[] } | { unique: readonly unknown[] };
	}
		? true
		: false;
// an upsert names its record by id (rule 28), so it needs both arms; an import matches the natural key (rule 30)
type Verbs<C, S = CollectionSpecOf<C>> =
	| (S extends { create: unknown }
			? | 'create'
				| (Keyed<C> extends true ? 'import' : never)
				| (S extends { update: unknown } ? 'upsert' : never)
			: never)
	| (S extends { update: unknown } ? 'update' : never)
	| (S extends { delete: unknown } ? 'delete' : never);
/** Every callable: a collection's generated verb or declared action (X-1, X-24). */
export type Callable = {
	[C in CollectionName]: `${C}.${Verbs<C> | ActionName<C>}`;
}[CollectionName];
type Targets<C> = Id<C & string> | readonly Id<C & string>[];
type ActionArg<C, X> = X extends { target: 'record' }
	? { target: Targets<C> } & ({} extends In<X> ? { input?: In<X> } : { input: In<X> })
	: In<X>;
/**
 * The input a callable takes (`'<c>.create'`, `'<c>.update'`, `'<c>.<action>'`, …): an insert, `{ target, set }`, `{ target }` or the action's declared input.
 */
export type ActInput<N> = N extends `${infer C}.${infer V}`
	? V extends 'create'
		? Insert<C> | readonly Insert<C>[]
		: V extends 'upsert'
			? Insert<C> | ({ id: Id<C> } & Patch<C>) | readonly (Insert<C> | ({ id: Id<C> } & Patch<C>))[]
			: V extends 'import'
				? readonly Insert<C>[]
				: V extends 'update'
					? { target: Targets<C>; set: Patch<C> } | readonly { target: Id<C>; set: Patch<C> }[]
					: V extends 'delete'
						? { target: Targets<C> }
						: V extends ActionName<C>
							? ActionArg<C, ActionsOfC<C>[V]>
							: never
	: never;
/** A generated upsert preserves input order; an import reports every row's resolution. */
export type ImportReport<C> = {
	readonly rows: readonly {
		readonly index: number | null;
		readonly id: Id<C & string> | null;
		readonly action: 'created' | 'updated' | 'kept' | 'skipped' | 'deleted';
	}[];
};
/** The output actually returned by a callable; record actions may target several records. */
export type ActOutput<N> = N extends `${infer C}.${infer V}`
	? V extends 'upsert'
		? readonly (Id<C> | null)[]
		: V extends 'import'
			? ImportReport<C>
			: V extends ActionName<C>
				? ActionsOfC<C>[V] extends { target: 'record' }
					? OutputOf<ActionsOfC<C>[V]> | readonly OutputOf<ActionsOfC<C>[V]>[]
					: OutputOf<ActionsOfC<C>[V]>
				: undefined
	: never;
/** `onConflict` is required on `upsert` (rule 28): `update` merges into the row its `id` names, `keep` leaves it. */
export type ActOptions = {
	key?: string;
	once?: string;
	onConflict?: 'update' | 'keep';
	observed?: Readonly<Record<string, number>>;
};
type OptionsOf<N> = N extends `${string}.upsert`
	? [options: ActOptions & { onConflict: 'update' | 'keep' }]
	: [options?: ActOptions];

// ── outcomes (rule 32, §3.3.9) ──
type Written = readonly {
	[C in CollectionName]: { readonly collection: C; readonly id: Id<C>; readonly revision: number };
}[CollectionName][];
/** Nested and erased rows retain their actual collection, whose discriminator determines the id's brand. */
type WrittenOf<_N> = Written;
/**
 * The engine's own refusal codes (rule 32), beside an authored `refused`: grants, constraints, budgets, rate limits and stale requests.
 */
export type PlatformRefusal =
	| 'locked'
	| 'sourceChanged'
	| 'readBudgetExceeded'
	| 'forbidden'
	| 'notFound'
	| 'invalidInput'
	| 'unique'
	| 'check'
	| 'overlap'
	| 'missingRef'
	| 'restricted'
	| 'required'
	| 'overflow'
	| 'rateLimited'
	| 'keyReuse'
	| 'approvalSplit' // hook:approvals (rule 44)
	/** L-BOLT-171: the act names a schema (`Bolt-Contract`) this workspace no longer runs; reload the page. */
	| 'releaseChanged'
	/** Rule 31: an `issuedAt` older than 23 h or more than 5 min ahead. */
	| 'expired'
	/** Rule 42: a throw from tenant code (its message reaches members only); the guest budgets (rule 72). */
	| 'internal'
	| 'cpuBudget'
	| 'crossingBudget'
	| 'memory'
	| 'tooLarge';
/**
 * The write is in the database: `output` is the action's result, `records` every row written with its new revision.
 */
export type Committed<O, N = string> = { kind: 'committed'; output: O; records: WrittenOf<N> };
/** The write is held for approval (§3.8): `requestId` names the approval request, `records` the held rows. */
export type PendingApproval<N = string> = {
	kind: 'pendingApproval';
	requestId: RequestId;
	records: WrittenOf<N>;
};
/**
 * The write was refused: `code` is `refused` for an authored refusal or a platform code, with the message and the field or rows it names.
 */
export type Refused = {
	kind: 'refused';
	code: 'refused' | PlatformRefusal;
	message: string;
	field?: string;
	row?: number;
	rows?: readonly number[];
	/** A.2 L-BOLT-043: the tenant code that refused — `'<collection>.transform'` or `'<collection>.<action>'`. */
	rule?: string;
	data?: { readonly requestId: RequestId };
};
/** The write lost a race: another write changed the named fields of these records since they were read. */
export type Conflict = {
	kind: 'conflict';
	records: readonly { collection: CollectionName; id: string; fields: readonly string[] }[];
};
/** The outcome could not be confirmed (a lost connection); `invocation` is the id to look the write up by. */
export type Unknown = { kind: 'unknown'; invocation: string };
/**
 * Every result of a write (rule 32): `committed`, `pendingApproval`, `refused`, `conflict` or `unknown`, told apart by `kind`.
 */
export type Outcome<O, N = string> =
	Committed<O, N> | PendingApproval<N> | Refused | Conflict | Unknown;
/**
 * `ctx.act` in an action or automation: runs a callable with its typed input. It succeeds with a committed or held write
 * and fails with `ActRefused`, `ActConflict` or `ActUnknown`; `Effect.catchTag` recovers the one a body handles.
 * @example
 * const { records } = yield* ctx.act('orders.create', { customer, lines: { create: [{ sku, qty: 1 }] } });
 */
export interface Act {
	/** A held write is a success. */
	<const N extends string>(
		callable: Is<N, Callable>,
		input: NoInfer<ActInput<N>>,
		...options: NoInfer<OptionsOf<N>>
	): Eff<Committed<ActOutput<N>, N> | PendingApproval<N>, ActRefused | ActConflict | ActUnknown>;
	/**
	 * Generated verbs (`create`, `update`, `upsert`, `delete`) over several collections as ONE act: planned together (their
	 * reads one round trip per step), committed as one statement; the first that does not commit fails it. The acts are
	 * independent: none names a row another creates. Answers each act's output, in order.
	 * @example
	 * yield* ctx.act.many([{ callable: 'task.create', input: rows }, { callable: 'slip.update', input: holds }]);
	 */
	many(
		acts: readonly { readonly callable: Callable; readonly input: Json }[]
	): Eff<Committed<readonly unknown[]>, ActRefused | ActConflict | ActUnknown>;
}

// ── contexts ──
// Contexts are interfaces with declared variance: measuring the variance of a generic alias over a large names index
// cost seconds per body (G1 scale fixture).
/** Server-rendered page loaders receive caller-scoped reads and a clock, with no write or facility authority. */
export interface PageReadContext extends Readonly<Clock>, CallerReads<ReadFailed> {}

/**
 * What a query body sees: the actor, clock and timezone, caller reads (`read`, `get`, `similar`, `query`) and `refuse`.
 */
export interface QueryCtx extends Clock, CallerReads {
	invocationId: string;
	/** Ends the body with an authored refusal (rule 32), `return yield* ctx.refuse(…)`; `field` names an input field. */
	refuse(message: string, at?: { field?: string }): Eff<never, Refusal>;
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
	act: Act;
	schedule: Schedule;
	notify: Notify;
	refuse(message: string, at?: { field?: InputField<X> }): Eff<never, Refusal>;
	/** The row a `target: 'record'` action runs on; `never` on any other action. */
	target: X extends { target: 'record' } ? Row<C> : never;
}

/** One element of a transform batch: the submitted input, which the transform returns with derived values set. */
export type TransformRow<M> = TransformRowOf<M>;
type TransformRowOf<M, Writable extends PropertyKey = WritableField<M>> = {
	readonly [P in Writable]?: Loose<ColumnValue<M, P>>;
} & {
	readonly [R in keyof ManyRels<M>]?: TransformRelations<ManyRels<M>[R], ManyRelFk<M, R>>;
} & Underived<M, Writable>;
// A returned payload is not a fresh literal, so excess keys pass unseen: derived and system columns are named `never`.
type Underived<M, Writable = WritableField<M>> = {
	readonly [P in Exclude<keyof Columns<M>, Writable>]?: never;
};
// A nested create names its parent through the relation, so the child's FK to it is implied.
type TransformInsert<T, Fk> = {
	readonly [
		P in Exclude<WritableField<T>, Fk> as OmittableOnInsert<T, P> extends true ? never : P
	]: ColumnValue<T, P>;
} & {
	readonly [
		P in Exclude<WritableField<T>, Fk> as OmittableOnInsert<T, P> extends true ? P : never
	]?: ColumnValue<T, P>;
} & {
	readonly [R in keyof ManyRels<T>]?: TransformRelations<ManyRels<T>[R], ManyRelFk<T, R>>;
} & Underived<T>;
type TransformRelations<T, Fk> = T extends TargetName
	? {
			create?: readonly TransformInsert<T, Fk>[];
			upsert?: readonly TransformInsert<T, Fk>[];
			update?: readonly { target: Id<T & string>; set: TransformRow<T> }[];
			link?: readonly Id<T & string>[];
			unlink?: readonly Id<T & string>[];
			delete?: readonly Id<T & string>[];
		}
	: never;
export type DeleteInput = { readonly $delete: true };
/** Native planning evidence; a reservation is never a claim that the row was committed or approved. */
export type PreparedCreateReceipt = {
	readonly collection: string;
	readonly id: string;
	readonly path: readonly (string | number)[];
	readonly values: Readonly<Record<string, Json>>;
	readonly committed: false;
	readonly phase: 'PREPARED_NATIVE_CREATE';
	readonly invocation_id: string;
	readonly related_sources: readonly PreparedCreateReceipt[];
	readonly related_actions: readonly Json[];
};
/**
 * What the collection transform sees: the clock, `existing[i]` (the stored row of `inputs[i]`, `undefined` on create), the
 * workspace reads in `db` (unmasked, including `db.after`) and `refuse`.
 */
export interface TransformCtx<in out M> extends Clock {
	/** The act's invocation: what a prepared create's receipts carry as `invocation_id`. */
	readonly invocationId: string;
	readonly policies: readonly string[];
	readonly admin: boolean;
	refuse(message: string, at?: { field?: WritableField<M> }): Eff<never, Refusal>;
	/** `existing[i]` is the stored row of `inputs[i]`, `undefined` for a create. */
	existing: readonly (StoredRow<M> | undefined)[];
	/** Engine-assigned identities for submitted roots and native relation children; never caller fields. */
	readonly staged: readonly {
		readonly collection: string;
		readonly id: string;
		readonly path: readonly (string | number)[];
		readonly operation: string;
		readonly parent?: {
			readonly collection: string;
			readonly id: string;
			readonly relation: string;
			readonly field: string;
		};
	}[];
	db: WorkspaceReads & {
		/** Reserve an engine identity for a generated owned child path. No write or approval occurs here. */
		prepareCreate(
			collection: CollectionName,
			values: Readonly<Record<string, Json>>,
			options: { readonly path: readonly (string | number)[] }
		): Eff<PreparedCreateReceipt>;
	};
}

// ── the names the page client (§3.5, `client/page-bolt.ts`) shares with the `ctx` above ──
/** Every query callable (`'<c>.<q>'`). */
export type QueryCallable = { [C in CollectionName]: `${C}.${QueryName<C>}` }[CollectionName];
type QueryOf<N> = N extends `${infer C}.${infer Q}`
	? QueriesOfC<C>[Q & keyof QueriesOfC<C>]
	: never;
/** A `query` callable's input and output (`'<c>.<q>'`). */
export type QueryInput<N> = In<QueryOf<N>>;
/** A `query` callable's output (`'<c>.<q>'`): the query's declared `output` value. */
export type QueryOutput<N> = OutputOf<QueryOf<N>>;
/** A key of `src/i18n/+messages.ts`. */
export type MessageKey = keyof NamesPart<'messages'> & string;
/** An `aggregate` row: the bucket values under `key`, then each measure asked for (a sum or average is a `Decimal`). */
export type AggRow = {
	readonly key?: { readonly [field: string]: unknown };
	readonly count?: number;
	readonly sum?: { readonly [field: string]: Decimal | null };
	readonly avg?: { readonly [field: string]: Decimal | null };
	readonly min?: { readonly [field: string]: unknown };
	readonly max?: { readonly [field: string]: unknown };
};
/** The names ui's views are typed by (`@norbital-ai/ui`'s `Workspace`); none until the workspace declares a collection. */
export type ViewNames = [keyof NamesPart<'collections'>] extends [never]
	? never
	: {
			collections: {
				[C in CollectionName]: {
					row: ListRow<C>;
					record: Row<C>;
					insert: Insert<C>;
					where: Where<C>;
					orderBy: OrderBy<C>;
					/** Many-relations a view may show as a column (a table's multi-link cell). */
					many: ReadRelation<C> & keyof ManyRels<C> & string;
				};
			};
			queries: { [N in QueryCallable]: { input: QueryInput<N>; output: QueryOutput<N> } };
			actions: { [N in Callable]: ActInput<N> };
			automations: { [A in StartableName]: StartInput<A> };
		};
