// What server bodies see (§3.4) and the write shapes they call with (X-24): rows, the one read API `query`, `act`,
// outcomes, and each body's ctx. Every ctx member answers an Effect with typed failures (D8): bodies are generators that
// `yield*` them. Pages read through the same `query` (`page/page-bolt.ts`).
import type { Effect } from 'effect';
import type { Cursor } from '@norbital-ai/store';
import type { Actor } from './access/actor.ts';
import type { ApprovalStep, Flow, Verdict } from './access/policy.ts';
import type { ActConflict, ActRefused, ActUnknown, ReadFailed, Refusal } from './errors.ts';
import type { Checked, DateLiteral, Exact, InputOf, Simplify } from './fields.ts';
import type {
	AutomationName,
	ModelName,
	ExposureSpecOf,
	ColumnValue,
	Columns,
	HasSemantic,
	HeavyField,
	IndexInput,
	IndexName,
	Is,
	LayerColumn,
	LayerField,
	LayerFilled,
	ManyRels,
	NamesPart,
	OmittableOnInsert,
	OneRels,
	OwnedFk,
	OwnedInverse,
	OutputName,
	PathModel,
	Prefixes,
	ReadField,
	ReadPath,
	ReadableName,
	RootOf,
	Row,
	RowState,
	StoredRow,
	SubLayer,
	WritableField,
	WritePath
} from './names.ts';
import type { StartInput } from './runtime/facilities.ts';
import type { LayerWhere, ModelWhere, OrderBy, Where } from './where.ts'; // hook:query (OrderBy)
import type { DynamicRead } from '../protocol/read-request.ts';
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
/** An opaque page cursor: pass a page's `next` back as `after` to read on (the store's). */
export type { Cursor };
/** Rule 9: every read states a limit or asks for everything. */
export type Paged =
	{ limit: number; after?: Cursor; all?: never } | { all: true; limit?: never; after?: never };
/** One page of a read: its `rows`, and the `next` cursor, `null` on the last page. */
export type Page<T> = { readonly rows: readonly T[]; readonly next: Cursor | null };
/** The relations a view nests: the root's declared one-level read layers (`'<C>.<rel>'`). */
type SelectRel<C> = SubLayer<ReadPath<C>, C & string>;
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
/** A view's list row: the caller row less its heavy fields. */
export type ListRow<C> = Omit<Row<C>, HeavyField<C>>;

/**
 * A search over one of `C`'s `search.indexes`, keyed by the index with its probe input (`{ colour: { lab, … } }`), or over
 * `search.semantic`: nearest by meaning to a text, or to a record's own embedding (the record itself left out).
 */
export type IndexSearch<C> =
	| { [I in IndexName<C>]: { readonly [P in I]: InputOf<IndexInput<C, I>> } }[IndexName<C>]
	| (HasSemantic<C> extends true
			? { readonly semantic: string | { readonly record: Id<C & string> } }
			: never);
// ── aggregates ──
type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year';
/** What `aggregate` buckets by: a readable field, or a date or instant field truncated to a calendar unit. */
export type Bucket<C, O = 'default'> =
	| ReadField<C, O>
	| { [U in Unit]: { readonly [P in U]: ReadField<C, O> } }[Unit];
type BucketOf<B> = B extends string
	? B
	: B extends { readonly [unit: string]: infer F }
		? F
		: never;
/** The fields a `by` buckets on: a bucket's own field, or the field a calendar unit truncates. */
export type BucketField<B> = B extends readonly (infer X)[] ? BucketOf<X> : BucketOf<B>;
/** Readable fields `sum` and `avg` measure. */
type NumericField<C, O = 'default'> = {
	[P in ReadField<C, O> & keyof Columns<C>]: Columns<C>[P] extends {
		kind: 'int' | 'decimal' | 'money' | 'sum' | 'count';
	}
		? P
		: never;
}[ReadField<C, O> & keyof Columns<C>] &
	string;
/** What an `aggregate` measures over its scope (`where`): a `count`, sums and averages of numbers, minimums and maximums. */
export type Measures<C, O = 'default'> = {
	count?: true;
	sum?: readonly NoInfer<NumericField<C, O>>[];
	avg?: readonly NoInfer<NumericField<C, O>>[];
	min?: readonly NoInfer<ReadField<C, O>>[];
	max?: readonly NoInfer<ReadField<C, O>>[];
	where?: NoInfer<Where<C, O>>;
};
/**
 * An `aggregate` row: with `by`, the bucket's values under `key` (the bucketed fields of the row) and its row `count`
 * (always); then each measure asked for: `count`, a `sum` or `avg` per numeric field (a `Decimal`, `null` over no rows),
 * a `min` or `max` per field.
 */
export type AggRow<C, By = never, O = 'default'> = ([By] extends [never]
	? { readonly count?: number }
	: { readonly key: Pick<Row<C, O>, By & keyof Row<C, O>>; readonly count: number }) & {
	readonly sum?: { readonly [F in NumericField<C, O>]?: Decimal | null };
	readonly avg?: { readonly [F in NumericField<C, O>]?: Decimal | null };
	readonly min?: { readonly [F in keyof Row<C, O>]?: Row<C, O>[F] | null };
	readonly max?: { readonly [F in keyof Row<C, O>]?: Row<C, O>[F] | null };
};
/** Where a record's `history` starts: an instant, a revision, or just before an approval request. */
export type HistoryOptions<C = string> = {
	at?: { instant: Instant } | { revision: number } | { before: RequestId };
	/** The read output whose fields each revision shows (`default` when absent); the caller must hold it. */
	output?: OutputName<C>;
};

// ── read requests (decisions 1, 4, 7, 8): one layer map for pages, `ctx.query`, policies and the agent ──
// Each key without a dot is a root (a model with `read`); `'<root>.<rel>…'` is one of that root's declared read layers.
// A model is a root once per request. Naming a deep path implies its parents. Every list (a root page or a nested
// many-layer) defaults to `limit` 10,000 (the host cap) and the root's default order; only a root pages (`after`, `next`).
// JSON only: the same value crosses the page wire, `ctx.query` and the agent tool (`protocol/read-request.ts`).
type Dir = 'asc' | 'desc';
/** A deeper layer's order: its exposed fields, ascending, or `{ field: dir }`; up to four keys, then `id`. */
export type LayerOrderBy<F extends string> =
	F | { readonly [K in F]?: Dir } | readonly (F | { readonly [K in F]?: Dir })[];
/** What a layer `aggregate` measures over the layer's rows (per parent row on a nested layer), bucketed `by` fields. */
export type LayerAggregate<F extends string> = {
	count?: true;
	sum?: readonly F[];
	avg?: readonly F[];
	min?: readonly F[];
	max?: readonly F[];
	by?: F | readonly F[];
};
/**
 * A root layer of `C`: the read `output` it answers (`default` when absent), its filter, fields, order and page, a text
 * or index search, an aggregate, and `asOf`.
 */
export type RootRequest<C, O = 'default'> = {
	/** The model's named read output: its fixed fields and layers. The caller's policies grant it and filter its rows. */
	output?: OutputName<C>;
	where?: Where<C, O>;
	fields?: readonly ReadField<C, O>[];
	orderBy?: OrderBy<C, O>;
	/** 1 to 10,000 (the default). */
	limit?: number;
	after?: Cursor;
	search?: string | IndexSearch<C>;
	aggregate?: Omit<Measures<C, O>, 'where'> & { by?: Bucket<C, O> | readonly Bucket<C, O>[] };
	/** An ISO instant: the root and its layers as they stood then (folded from history). */
	asOf?: string;
};
/** A deeper layer `P` of `C`'s output `O`: `where` filters that layer's rows (a list) or nulls it (a ref), never removing the root. */
export type LayerRequest<C, P, O = 'default'> = {
	where?: LayerWhere<C, P, O>;
	fields?: readonly LayerField<C, P, O>[];
	orderBy?: LayerOrderBy<LayerField<C, P, O> & string>;
	/** 1 to 10,000 (the default) rows per parent row. */
	limit?: number;
	search?: string;
	aggregate?: LayerAggregate<LayerField<C, P, O> & string>;
};
/** The general shape a read request literal is inferred against (the constraint, not the check); JSON only, so a function is never a `where`. */
export type ReadRequestBase = {
	readonly [path: string]: {
		readonly output?: string;
		readonly where?: { readonly [key: string]: unknown };
		readonly fields?: readonly string[];
		readonly orderBy?: unknown;
		readonly limit?: number;
		readonly after?: Cursor;
		readonly search?: unknown;
		readonly aggregate?: object;
		readonly asOf?: string;
	};
};
/** The output root `C` of request `R` names (`default` when it names none). */
export type OutputOf<R, C> = C extends keyof R
	? R[C] extends { output: infer O extends string }
		? O
		: 'default'
	: 'default';
/** Each key of request `R` checked: a root of a model with `read`, or a read layer its output declares. */
export type RequestSpec<R> = {
	[K in keyof R]: K extends `${infer C}.${string}`
		? C extends ReadableName
			? K extends ReadPath<C, OutputOf<R, C>>
				? LayerRequest<C, K, OutputOf<R, C>>
				: `error: '${K & string}' is not a read layer ${C}'s ${OutputOf<R, C>} output declares`
			: `error: '${C}' is no read root: a root is a model with read`
		: K extends ReadableName
			? RootRequest<K, OutputOf<R, K>>
			: `error: '${K & string}' is no read root: a root is a model with read`;
};
/** A read request literal, checked exactly: an unknown key, path, field or option fails to type-check. */
export type ReadRequest<R> = R & NoInfer<Checked<ReadRequestBase, R, Exact<R, RequestSpec<R>>>>;
type At<R, P> = P extends keyof R ? R[P] : {};
type Named<R> = Prefixes<keyof R & string>;
type LayerPick<C, P, R> =
	At<R, P> extends { fields: readonly (infer F)[] }
		? F & string
		: LayerField<C, P, OutputOf<R, RootOf<P>>>;
/** A layer aggregate row; grouped (`by`), each bucket carries its `key` and row `count`. */
type LayerAggRow<F extends string, Grouped extends boolean = false> = (Grouped extends true
	? { readonly key: { readonly [K in F]?: unknown }; readonly count: number }
	: { readonly count?: number }) & {
	readonly sum?: { readonly [K in F]?: Decimal | null };
	readonly avg?: { readonly [K in F]?: Decimal | null };
	readonly min?: { readonly [K in F]?: unknown };
	readonly max?: { readonly [K in F]?: unknown };
};
type SubAnswer<C, Q extends string, R, T, S> = S extends keyof OneRels<T>
	? LayerRow<C, Q, R> | null
	: At<R, Q> extends { aggregate: infer A }
		? A extends { by: unknown }
			? readonly LayerAggRow<LayerField<C, Q, OutputOf<R, C>> & string, true>[]
			: LayerAggRow<LayerField<C, Q, OutputOf<R, C>> & string>
		: readonly LayerRow<C, Q, R>[];
/**
 * One row of layer `P` of the root's output: `id`, its picked fields (all the output exposes there without `fields`),
 * and each named sub-layer under its relation name in place of the FK (a ref: the row or `null`; a many-relation: its
 * rows).
 */
export type LayerRow<
	C,
	P extends string,
	R,
	T = PathModel<C, P>,
	S extends string = SubLayer<Named<R>, P>
> = Simplify<
	{ readonly id: Id<T & string> } & {
		readonly [
			F in Exclude<LayerPick<C, P, R>, S | 'id'> & (keyof Columns<T> | keyof OneRels<T>)
		]: ColumnValue<T, F>;
	} & { readonly [Q in S]: SubAnswer<C, `${P}.${Q}`, R, T, Q> }
>;
type RootRow<C extends string, R> = LayerRow<C, C, R> & RowState;
/**
 * A root's answer: its aggregate, its index or semantic search's nearest rows (each with `$distance`), or its page with
 * `total`, every row the read matches (scope, `where`, text search), its `limit` and `after` aside.
 */
type RootAnswer<C extends string, R> =
	At<R, C> extends { aggregate: infer A }
		? A extends { by: infer B }
			? Page<AggRow<C, BucketField<B>, OutputOf<R, C>>>
			: AggRow<C, never, OutputOf<R, C>>
		: At<R, C> extends { search: object }
			? Page<RootRow<C, R> & { readonly $distance: number }>
			: Page<RootRow<C, R>> & { readonly total: number };
/** A runtime-built read request's answer (`dynamicRead`): per root, a page of rows as JSON. */
export type DynamicAnswer = {
	readonly [root: string]: Page<{ readonly id: string; readonly [field: string]: Json }> & {
		readonly total?: number;
	};
};
/** A read request's answer: per root, a page of layer rows (or its aggregate), typed from its output's named layers. */
export type ReadAnswer<R> = {
	readonly [C in RootOf<keyof R & string>]: RootAnswer<C, R>;
};

/**
 * The one read API as the caller (queries, automations under their policies, page loaders): each root reads one named
 * output, the rows its granting policies admit. Pages call the same `query` on `bolt` (`PageBolt`); every read is one
 * read request (a layer map).
 */
export interface CallerQuery<E = never> {
	/**
	 * A read request: a layer map of roots (models with `read`) and the layers of the output each names, in one crossing
	 * and ONE statement, under the caller's authority: each root's policies granting that output alone filter it and
	 * its layers.
	 * @example
	 * const { orders, commercial_settings } = yield* ctx.query({
	 *   orders: { where: { status: { eq: 'issued' } }, fields: ['number', 'total'], limit: 100 },
	 *   'orders.lines': { where: { quantity: { gt: 0 } } },
	 *   commercial_settings: { limit: 1 }
	 * });
	 */
	query<const R extends ReadRequestBase>(request: ReadRequest<R>): Eff<ReadAnswer<R>, E>;
	/**
	 * The same layer map built at runtime (a rule engine's reads), made by `dynamicRead` from `@norbital-ai/bolt/protocol`:
	 * checked host-side against the declarations exactly as the literal form is, answered untyped.
	 */
	query(request: DynamicRead): Eff<DynamicAnswer, ReadFailed | E>;
	/** Without `by`, one row over the whole scope. */
	aggregate<C extends string>(
		model: Is<C, ReadableName>,
		args: Measures<C> & { by?: never }
	): Eff<AggRow<C>, E>;
	/** With `by`, a page of buckets (rule 9), each keyed by its bucket values. */
	aggregate<C extends string, const B extends Bucket<C> | readonly Bucket<C>[]>(
		model: Is<C, ReadableName>,
		args: Measures<C> & { by: B } & Paged
	): Eff<Page<AggRow<C, BucketField<B>>>, E>;
	/** A record's revisions, oldest first, or from an instant, a revision or just before an approval request. */
	history<C extends string>(
		model: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		options?: HistoryOptions<C>
	): Eff<readonly Revision<C>[], E>;
}
/**
 * The one read API as the workspace (write callbacks, `notify`, sync bodies, rule 15): the same shapes as `CallerQuery`,
 * answered with every stored row under no grant.
 */
export interface WorkspaceQuery {
	/** A read request (as the caller's), answered as the workspace: unscoped, the same declared outputs and layers. */
	query<const R extends ReadRequestBase>(request: ReadRequest<R>): Eff<ReadAnswer<R>>;
	/** The same layer map built at runtime, checked host-side; answered untyped. */
	query(request: DynamicRead): Eff<DynamicAnswer, ReadFailed>;
	/** Without `by`, one row over the whole model. */
	aggregate<C extends string>(
		model: Is<C, ReadableName>,
		args: Measures<C> & { by?: never }
	): Eff<AggRow<C>>;
	/** With `by`, a page of buckets (rule 9). */
	aggregate<C extends string, const B extends Bucket<C> | readonly Bucket<C>[]>(
		model: Is<C, ReadableName>,
		args: Measures<C> & { by: B } & Paged
	): Eff<Page<AggRow<C, BucketField<B>>>>;
}
/** What every server body knows of its moment: who it runs as, the instant, today and the zone (`todayIn` another zone). */
export interface Clock {
	readonly actor: Actor;
	now: Instant;
	today: PlainDate;
	tz: IanaZone;
	todayIn(zone: IanaZone): PlainDate;
}

// ── writes: trees typed from the model's write layers (decision 6: every write is a batch of them) ──
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
type OptionalOf<T, Cols extends string> = {
	[F in Cols]: OmittableOnInsert<T, F> extends true ? F : never;
}[Cols];
type ChildId<T, S> = Id<ManyRels<T>[S & keyof ManyRels<T>] & string>;
/** Required columns required, omittable or `filled` ones optional. */
type Values<T, Cols extends string, Opt> = {
	readonly [F in Exclude<Cols, Opt>]: Loose<ColumnValue<T, F>>;
} & {
	readonly [F in Cols & Opt]?: Loose<ColumnValue<T, F>>;
};
type CreateLayer<
	C,
	P extends string,
	T = PathModel<C, P>,
	Cols extends string = LayerColumn<C, 'create', P>
> = Values<T, Cols, OptionalOf<T, Cols> | LayerFilled<C, P>> & {
	readonly [S in SubLayer<WritePath<C, 'create'>, P>]?: readonly (
		| CreateLayer<C, `${P}.${S}`>
		// an existing row of a non-owned child relation is linked by its id
		| (S extends OwnedInverse<T> ? never : ChildId<T, S>)
	)[];
};
/**
 * One created row of `M` as a writer sends it and the policy's `check` judges it: the root's `create.columns` (required ones
 * required, `filled` ones optional) and each declared child layer as a list of child rows (or, for a non-owned relation,
 * ids of existing rows to link).
 */
export type CreateTree<M> = CreateLayer<M, M & string>;
type ChildCreate<
	C,
	Q extends string,
	T = PathModel<C, Q>,
	Cols extends string = LayerColumn<C, 'update', Q>
> = Values<T, Cols, OptionalOf<T, Cols>> & {
	readonly [S in SubLayer<WritePath<C, 'update'>, Q>]?: readonly ChildCreate<C, `${Q}.${S}`>[];
};
type ChildChanges<C, Q extends string, T, S, Child extends string = PathModel<C, Q> & string> = {
	readonly create?: readonly ChildCreate<C, Q>[];
	readonly update?: readonly { readonly target: Id<Child>; readonly set: UpdateLayer<C, Q> }[];
	readonly delete?: readonly Id<Child>[];
} & (S extends OwnedInverse<T>
	? {}
	: { readonly link?: readonly Id<Child>[]; readonly unlink?: readonly Id<Child>[] });
type UpdateLayer<C, P extends string, T = PathModel<C, P>> = {
	readonly [F in LayerColumn<C, 'update', P>]?: Loose<ColumnValue<T, F>>;
} & {
	readonly [S in SubLayer<WritePath<C, 'update'>, P>]?: ChildChanges<C, `${P}.${S}`, T, S>;
};
/**
 * The `set` of one updated row of `M`: the root's `update.columns`, all optional, and per declared child layer the child
 * rows it creates, updates (`{ target, set }`) and deletes (and, for a non-owned relation, links or unlinks), each with
 * that layer's update columns.
 */
export type UpdateTree<M> = UpdateLayer<M, M & string>;
type StoredLayer<
	C,
	V extends 'create' | 'update',
	P extends string,
	T = PathModel<C, P>
> = StoredRow<T> & {
	readonly [S in SubLayer<WritePath<C, V>, P>]: readonly StoredLayer<C, V, `${P}.${S}`>[];
};
/** The stored row of `M` with each child layer its `V` declares, as the update `check` sees it (`before`). */
export type StoredTree<M, V extends 'create' | 'update'> = StoredLayer<M, V, M & string>;
/** A create input of `C`: its create tree. */
export type Insert<C> = CreateTree<C>;
/** An update `set` of `C`: its update tree. */
export type Patch<C> = UpdateTree<C>;

export type Keyed<C> =
	NamesPart<'models'> extends {
		[P in C & string]: { key: readonly unknown[] } | { unique: readonly unknown[] };
	}
		? true
		: false;
// an upsert names its record by id (rule 28), so it needs both arms; an import matches the natural key (rule 30)
type Verbs<C, S = ExposureSpecOf<C>> =
	| (S extends { create: unknown }
			? | 'create'
				| (Keyed<C> extends true ? 'import' : never)
				| (S extends { update: unknown } ? 'upsert' : never)
			: never)
	| (S extends { update: unknown } ? 'update' : never)
	| (S extends { delete: unknown } ? 'delete' : never);
/** Every callable: a model's generated write verb (X-1, X-24). */
export type Callable = {
	[C in ModelName]: `${C}.${Verbs<C>}`;
}[ModelName];
/**
 * The input a generated write takes (`'<c>.create'`, `'<c>.update'`, …): always an array of rows (inserts, `{ target, set }`
 * or `{ target }`), so the model's write callback sees the whole batch.
 */
export type ActInput<N> = N extends `${infer C}.${infer V}`
	? V extends 'create'
		? readonly Insert<C>[]
		: V extends 'upsert'
			? readonly (Insert<C> | ({ id: Id<C> } & Patch<C>))[]
			: V extends 'import'
				? readonly Insert<C>[]
				: V extends 'update'
					? readonly { target: Id<C>; set: Patch<C> }[]
					: V extends 'delete'
						? readonly { target: Id<C> }[]
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
/** The output returned by a generated write; upserts and imports report their row resolutions. */
export type ActOutput<N> = N extends `${infer C}.${infer V}`
	? V extends 'upsert'
		? readonly (Id<C> | null)[]
		: V extends 'import'
			? ImportReport<C>
			: null
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
	[C in ModelName]: { readonly model: C; readonly id: Id<C>; readonly revision: number };
}[ModelName][];
/** Nested and erased rows retain their actual model, whose discriminator determines the id's brand. */
type WrittenOf<_N> = Written;
/**
 * The engine's own refusal codes (rule 32), beside an authored `refused`: grants, constraints, budgets, rate limits and stale requests.
 */
export type PlatformRefusal =
	| 'locked'
	| 'sourceChanged'
	/** The native transaction exhausted its fixed deadline. */
	| 'timeout'
	/** The selected database backend cannot enforce the native transaction contract. */
	| 'unsupported'
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
 * The write is in the database: `output` is the generated write's result, `records` every row written with its new revision.
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
	/** The write path `field` belongs to (a policy `deny`'s `at.path`); the root when absent. */
	path?: string;
	row?: number;
	rows?: readonly number[];
	/** A.2 L-BOLT-043: the write callback that refused (`'<model>.create'`, `'<model>.update'`, `'<model>.delete'`). */
	rule?: string;
	data?: { readonly requestId: RequestId };
};
/** The write lost a race: another write changed the named fields of these records since they were read. */
export type Conflict = {
	kind: 'conflict';
	records: readonly { model: ModelName; id: string; fields: readonly string[] }[];
};
/** The outcome could not be confirmed (a lost connection); `invocation` is the id to look the write up by. */
export type Unknown = { kind: 'unknown'; invocation: string };
/**
 * The act outlived the 60 s a person waits (compute model §3): the write continues in the background as run `run`; its
 * row reports the outcome. A page follows it with `bolt.runs('<callable>', { where: { id: { eq: run } }, limit: 1 })`
 * or `<RunStatus automation="<callable>" {run} />`.
 */
export type Running = { kind: 'running'; run: Id<'sys_run'> };
/**
 * Every result of a write (rule 32): `committed`, `pendingApproval`, `refused`, `conflict`, `unknown` or `running`, told
 * apart by `kind`.
 */
export type Outcome<O, N = string> =
	Committed<O, N> | PendingApproval<N> | Refused | Conflict | Unknown | Running;
/**
 * `ctx.act` in an automation: runs a callable with its typed input. It succeeds with a committed or held write
 * and fails with `ActRefused`, `ActConflict` or `ActUnknown`; `Effect.catchTag` recovers the one a body handles. It is
 * never `running`: the body already runs as server work, so its act waits for its own answer and never hands off.
 * @example
 * const { records } = yield* ctx.act('orders.create', [{ customer, lines: { create: [{ sku, qty: 1 }] } }]);
 */
type ManyCallable = Extract<Callable, `${string}.${'create' | 'update' | 'upsert' | 'delete'}`>;
/** The literal shape inferred for a batch before each callable validates its own input. */
export type ActBatch = readonly {
	readonly callable: string;
	readonly input: unknown;
	readonly observed?: Readonly<Record<string, number>>;
	readonly onConflict?: 'update' | 'keep';
}[];
/** A batch's inputs, correlated with each callable in its original tuple. */
export type ActManyInput<A extends ActBatch> = A & {
	readonly [K in keyof A]: {
		readonly callable: Is<A[K]['callable'], ManyCallable>;
		readonly input: NoInfer<ActInput<A[K]['callable']>>;
		readonly observed?: Readonly<Record<string, number>>;
	} & (A[K]['callable'] extends `${string}.upsert`
		? { readonly onConflict: 'update' | 'keep' }
		: { readonly onConflict?: never });
};
/** Each callable's output, in the same order as the batch. */
export type ActManyOutput<A extends ActBatch> = {
	readonly [K in keyof A]: ActOutput<A[K]['callable']>;
};
/** Calls a typed workspace callable, or commits several generated verbs together with `many`. */
export interface Act {
	/** A held write is a success. */
	<const N extends string>(
		callable: Is<N, Callable>,
		input: NoInfer<ActInput<N>>,
		...options: NoInfer<OptionsOf<N>>
	): Eff<Committed<ActOutput<N>, N> | PendingApproval<N>, ActRefused | ActConflict | ActUnknown>;
	/**
	 * Generated verbs (`create`, `update`, `upsert`, `delete`) over several models as ONE act: planned together (their
	 * reads one round trip per step), committed as one statement; the first that does not commit fails it. The acts are
	 * independent: none names a row another creates. Answers each act's output, in order.
	 * @example
	 * yield* ctx.act.many([{ callable: 'task.create', input: rows }, { callable: 'slip.update', input: holds }]);
	 */
	many<const A extends ActBatch>(
		acts: ActManyInput<A>
	): Eff<
		Committed<ActManyOutput<A>, A[number]['callable']> | PendingApproval<A[number]['callable']>,
		ActRefused | ActConflict | ActUnknown
	>;
	/** Dynamic generated-verb inputs are checked by the native decoder and commit atomically; outputs remain JSON. */
	checked(
		acts: readonly (
			| {
					readonly callable: Extract<ManyCallable, `${string}.upsert`>;
					readonly input: Json;
					readonly observed?: Readonly<Record<string, number>>;
					readonly onConflict: 'update' | 'keep';
			  }
			| {
					readonly callable: Exclude<ManyCallable, `${string}.upsert`>;
					readonly input: Json;
					readonly observed?: Readonly<Record<string, number>>;
					readonly onConflict?: never;
			  }
		)[]
	): Eff<
		Committed<readonly Json[], ManyCallable> | PendingApproval<ManyCallable>,
		ActRefused | ActConflict | ActUnknown
	>;
}

// ── contexts ──
// Contexts are interfaces with declared variance: measuring the variance of a generic alias over a large names index
// cost seconds per body (G1 scale fixture).
/** Server-rendered page loaders receive caller-scoped reads and a clock, with no write or facility authority. */
export interface PageReadContext extends Readonly<Clock>, CallerQuery<ReadFailed> {}

// ── policy checks (decision 3): one `check` per write verb, the root's policy only ──
/** Where a `deny` points: the batch row, the write path (the root when omitted) and a column of that path. */
export type DenyAt<M, V> = V extends 'create' | 'update'
	? | { readonly row?: number; readonly path?: M & string; readonly field?: LayerColumn<M, V, M> }
		| {
				[P in Exclude<WritePath<M, V>, M>]: {
					readonly row?: number;
					readonly path: P;
					readonly field?: LayerColumn<M, V, P>;
				};
		  }[Exclude<WritePath<M, V>, M>]
	: { readonly row?: number };
/** A policy check's reads: read requests as the workspace (unscoped), at most ten per call, as a write callback's. */
export interface PolicyReads {
	query<const R extends ReadRequestBase>(request: ReadRequest<R>): Eff<ReadAnswer<R>>;
}
/**
 * What a policy's write `check` sees: who writes (`actor`, `policies`), the clock, `db.query` (read requests as the
 * workspace, at most ten per call, whatever the batch size) and the three verdicts. It writes nothing and does no I/O;
 * it returns `allow()`, `deny(message, at?)` or `approve(flow => …)` (the approval `Flow` builder), nothing else.
 */
export interface PolicyCtx<
	in out M,
	in out V extends 'create' | 'update' | 'delete'
> extends Clock {
	readonly invocationId: string;
	readonly policies: readonly string[];
	readonly db: PolicyReads;
	/** The write executes directly. */
	allow(): Verdict;
	/** The whole batch is refused (rule 32) with `message`; `at` names the row, the write path and a column of it. */
	deny(message: string, at?: DenyAt<M, V>): Verdict;
	/** The batch is held for the approval flow `build` returns (steps, `if`/`else`, `supersededBy`). */
	approve(build: (flow: Flow) => Flow): Verdict;
}
/** A create `check`: the batch of create trees. */
export type CreateCheck<M> = (
	rows: readonly CreateTree<M>[],
	ctx: PolicyCtx<M, 'create'>
) => BodyReturn<Verdict>;
/** An update `check`: per row the stored tree (`before`) and its `set`. */
export type UpdateCheck<M> = (
	changes: readonly { readonly before: StoredTree<M, 'update'>; readonly set: UpdateTree<M> }[],
	ctx: PolicyCtx<M, 'update'>
) => BodyReturn<Verdict>;
/** A delete `check`: the stored rows the batch removes. */
export type DeleteCheck<M> = (
	rows: readonly StoredRow<M>[],
	ctx: PolicyCtx<M, 'delete'>
) => BodyReturn<Verdict>;

// ── write callbacks: `create.transform`, `update.transform`, `delete.check` ──
// A returned payload is not a fresh literal, so excess keys pass unseen: derived and system columns are named `never`.
type Underived<M, Writable = WritableField<M>> = {
	readonly [P in Exclude<keyof Columns<M>, Writable>]?: never;
};
/** Writable fields the verb's root layer leaves out: a callback derives them (`placed_at`, a total). */
type Unlisted<M, Cols, Fixed = never> = {
	readonly [P in Exclude<WritableField<M>, Cols | Fixed>]?: Loose<ColumnValue<M, P>>;
};
/**
 * One row `create.transform` receives and returns: its create tree (the root columns the writer sent, required ones
 * required, and the declared child layers), any other writable field it derives. Derived and system columns are `never`.
 */
export type CreateRow<M> = CreateTree<M> & Unlisted<M, LayerColumn<M, 'create', M>> & Underived<M>;
/**
 * One `set` `update.transform` receives and returns: its update tree (the root columns the writer changed and the child
 * layers' changes) and any other writable field it derives, all optional (never an owned child's parent key, rule 41).
 */
export type UpdateSet<M> = UpdateTree<M> &
	Unlisted<M, LayerColumn<M, 'update', M>, OwnedFk<M>> &
	Underived<M>;
/** The workspace reads of a write callback, and the act's own rows (`after`). */
interface WriteReads extends WorkspaceQuery {
	/** Stored rows matching `where` overlaid with this act's rows: what the model will hold once the act commits. */
	after<C extends string>(
		model: Is<C, ReadableName>,
		where: NoInfer<ModelWhere<C>>
	): Eff<readonly StoredRow<C>[]>;
	after<C extends string, const S extends { readonly [P in keyof StoredRow<C>]?: true } = {}>(
		model: Is<C, ReadableName>,
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
/**
 * What a write callback sees: the clock, the writer's policies, the workspace's reads in `db` (unmasked; `db.after` sees
 * this act's rows) and `refuse`. A callback reads at most twice per call, whatever the batch size: read for the whole
 * batch at once (`yield* ctx.db.query({ customers: …, prices: … })` is one read), never inside a loop over the rows
 * (`bolt check`: `write/read-in-loop`). It writes nothing itself: what it returns is written in the writer's one
 * transaction.
 */
export interface WriteCtx<in out M> extends Clock {
	readonly invocationId: string;
	readonly policies: readonly string[];
	readonly admin: boolean;
	/**
	 * Refuses the whole write (rule 32), `return yield* ctx.refuse(…)`: `field` names the field, `row` the index of the
	 * offending row in the batch the callback received.
	 */
	refuse(message: string, at?: { field?: WritableField<M>; row?: number }): Eff<never, Refusal>;
	db: WriteReads;
}

// ── notify ──
/**
 * What the model's `notify` receives after a commit: a write (`create`, `update` or `delete`, with each record
 * and its previous row) or an approval move (its step, the request's named steps, whether it is `done`, who asked and who
 * decides the step).
 */
export type NotifyEvent<M> =
	| {
			readonly kind: 'write';
			readonly action: 'create' | 'update' | 'delete';
			readonly records: readonly Row<M>[];
			readonly previous: readonly (Row<M> | null)[];
			readonly actor: Actor;
	  }
	| {
			readonly kind: 'approval';
			readonly move: 'request' | 'approve' | 'reject' | 'requestChanges' | 'resubmit' | 'supersede';
			readonly step: number;
			readonly steps: readonly ApprovalStep[];
			readonly done: boolean;
			readonly request: RequestId;
			readonly records: readonly Row<M>[];
			readonly requester: Id<'sys_user'> | null;
			readonly approvers: Pick<ApprovalStep, 'teams' | 'users'>;
	  };
/** What `notify` sees: the clock and the workspace's reads; no I/O (delivery and `via` channels are the platform's). */
export interface NotifyCtx extends Clock {
	readonly db: WorkspaceQuery;
}

// ── the names the page client (`page/page-bolt.ts`) shares with the `ctx` above ──
/** A key of `src/i18n/+messages.ts`. */
export type MessageKey = keyof NamesPart<'messages'> & string;
/** The names ui's views are typed by (`@norbital-ai/ui`'s `Workspace`); none until the workspace exposes a model. */
export type ViewNames = [keyof NamesPart<'exposures'>] extends [never]
	? never
	: {
			models: {
				[C in ModelName]: {
					row: ListRow<C>;
					record: Row<C>;
					insert: Insert<C>;
					where: Where<C>;
					orderBy: OrderBy<C>;
					/** Many-relation layers a view may show as a column (a table's multi-link cell). */
					many: SelectRel<C> & keyof ManyRels<C> & string;
				};
			};
			actions: { [N in Callable]: ActInput<N> };
			automations: { [A in AutomationName]: StartInput<A> };
		};
