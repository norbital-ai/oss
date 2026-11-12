// What server bodies see (§3.4) and the write shapes they call with (X-24): rows, the one read API `query`, `act`,
// outcomes, and each body's ctx. Every ctx member answers an Effect with typed failures (D8): bodies are generators that
// `yield*` them. Pages read through the same `query` (`page/page-bolt.ts`).
import type { Effect } from 'effect';
import type { Cursor } from '@norbital-ai/store';
import type { Value } from '@norbital-ai/std/kind';
import type { REFUSAL_CODES } from '../protocol/schema.ts';
import type { Actor } from './access/actor.ts';
import type { ApprovalFlow, Verdict } from './access/policy.ts';
import type { ActConflict, ActRefused, ReadFailed, Refusal } from './errors.ts';
import type { ActUnknown } from './errors/act.ts';
import type { Checked, DateLiteral, Exact, InputOf, Simplify } from './fields.ts';
import type {
	AuthoredModelName,
	AutomationName,
	Columns,
	ColumnValue,
	ExposureSpecOf,
	HasSemantic,
	HeavyField,
	IndexInput,
	IndexName,
	Is,
	LayerColumn,
	LayerField,
	LayerFilled,
	ManyRels,
	ModelName,
	NamesPart,
	OmittableOnInsert,
	OneRels,
	OutputName,
	OwnedFk,
	OwnedInverse,
	PathModel,
	ReadableName,
	ReadField,
	ReadPath,
	RootOf,
	Row,
	RowState,
	StoredRow,
	SystemModelName,
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
/** A model's import key as values; exists only where the model declares `key` (§3.3.9). */
export type KeyValues<C> =
	NamesPart<'models'> extends { [P in C & string]: { key: readonly (infer K)[] } }
		? { readonly [P in K & string]: ColumnValue<C, P> }
		: never;
/** Historical evidence retains its schema version and archived wire values (rule 17). */
export type Revision = typeof import('../protocol/record-contracts.ts').HistoryRevisionSchema.Type;
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
	ReadField<C, O> | { [U in Unit]: { readonly [P in U]: ReadField<C, O> } }[Unit];
type BucketOf<B> = B extends string
	? B
	: B extends { readonly [unit: string]: infer F }
		? F
		: never;
/** The fields a `by` buckets on: a bucket's own field, or the field a calendar unit truncates. */
export type BucketField<B> = B extends readonly (infer X)[] ? BucketOf<X> : BucketOf<B>;
/** Scalar numeric columns, limited to the fields this read layer exposes. */
type NumericColumns<C, F extends string> = {
	[P in F & keyof Columns<C>]: Columns<C>[P] extends {
		kind: 'int' | 'number' | 'decimal' | 'money' | 'sum' | 'count';
	}
		? Columns<C>[P] extends { many: true } ? never : P
		: never;
}[F & keyof Columns<C>] &
	string;
/** Readable fields `sum` and `avg` measure. */
type NumericField<C, O = 'default'> = NumericColumns<C, ReadField<C, O> & string>;
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
export type AggRow<C, By = never, O = 'default'> = AggregateRow<C, ReadField<C, O> & string, By>;
type BucketValue<C, B, K> = B extends readonly (infer Item)[] ? BucketValue<C, Item, K>
	: B extends { readonly [unit: string]: K } ? PlainDate | Extract<ColumnValue<C, K>, null>
		: B extends K ? ColumnValue<C, K> : never;
type AggregateRow<C, F extends string, By = never> = ([By] extends [never]
	? { readonly count?: number }
	: { readonly key: { readonly [K in BucketField<By> & F]: BucketValue<C, By, K> }; readonly count: number }) & {
	readonly sum?: { readonly [K in NumericColumns<C, F>]?: Decimal | null };
	readonly avg?: { readonly [K in NumericColumns<C, F>]?: Decimal | null };
	readonly min?: { readonly [K in F]?: ColumnValue<C, K> | null };
	readonly max?: { readonly [K in F]?: ColumnValue<C, K> | null };
};
/** Where a record's `history` ends: an instant, a revision, or just before an approval request. */
export type HistoryOptions<C = string> = {
	at?: { instant: Instant } | { revision: number } | { before: RequestId };
	/** The read output whose fields each revision shows (`default` when absent); the caller must hold it. */
	output?: OutputName<C>;
};

// ── read requests (decisions 1, 4, 7, 8): one layer map for pages, `ctx.query`, policies and the agent ──
// A request names models at its root, with one nested node per declared relation. Each model is a root once. Every list (a root page or a nested
// many-layer) defaults to `limit` 10,000 (the host cap) and the root's default order; only a root pages (`after`, `next`).
// JSON only: the same value crosses the page wire, `ctx.query` and the agent tool (`protocol/read-request.ts`).
type Dir = 'asc' | 'desc';
/** A deeper layer's order: its exposed fields, ascending, or `{ field: dir }`; up to four keys, then `id`. */
type LayerOrderBy<F extends string> =
	F | { readonly [K in F]?: Dir } | readonly (F | { readonly [K in F]?: Dir })[];
/** What a layer `aggregate` measures over the layer's rows (per parent row on a nested layer), bucketed `by` fields. */
type LayerAggregate<C, P, O = 'default'> = {
	count?: true;
	sum?: readonly NoInfer<NumericColumns<PathModel<C, P>, LayerField<C, P, O> & string>>[];
	avg?: readonly NoInfer<NumericColumns<PathModel<C, P>, LayerField<C, P, O> & string>>[];
	min?: readonly LayerField<C, P, O>[];
	max?: readonly LayerField<C, P, O>[];
	by?: LayerField<C, P, O> | readonly LayerField<C, P, O>[];
};
/**
 * A root layer of `C`: the read `output` it answers (`default` when absent), its filter, fields, order and page, a text
 * or index search, an aggregate, and `as_of`.
 */
type RootRequest<C, O = 'default'> = {
	/** The model's named read output: its fixed fields and layers. The caller's policies grant it and filter its rows. */
	output?: OutputName<C>;
	where?: Where<C, O>;
	fields?: readonly ReadField<C, O>[];
	order_by?: OrderBy<C, O>;
	/** 1 to 10,000 (the default). */
	limit?: number;
	after?: Cursor;
	search?: string | IndexSearch<C>;
	aggregate?: Omit<Measures<C, O>, 'where'> & { by?: Bucket<C, O> | readonly Bucket<C, O>[] };
	/** An ISO instant: the root and its layers as they stood then (folded from history). */
	as_of?: string;
};
/** A deeper layer `P` of `C`'s output `O`: `where` filters that layer's rows (a list) or nulls it (a ref), never removing the root. */
type LayerRequest<C, P, O = 'default'> = {
	where?: LayerWhere<C, P, O>;
	fields?: readonly LayerField<C, P, O>[];
	order_by?: LayerOrderBy<LayerField<C, P, O> & string>;
	/** 1 to 10,000 (the default) rows per parent row. */
	limit?: number;
	search?: string;
	aggregate?: LayerAggregate<C, P, O>;
};
/** The general shape a read request literal is inferred against (the constraint, not the check); JSON only, so a function is never a `where`. */
type ReadNodeBase = {
	readonly output?: string;
	readonly where?: { readonly [key: string]: unknown };
	readonly fields?: readonly string[];
	readonly order_by?: unknown;
	readonly limit?: number;
	readonly after?: Cursor;
	readonly search?: unknown;
	readonly aggregate?: object;
	readonly as_of?: string;
	readonly [relation: string]: unknown;
};
export type ReadRequestBase = Readonly<Record<string, ReadNodeBase>>;
type ReadOption = 'output' | 'where' | 'fields' | 'order_by' | 'limit' | 'after' | 'search' | 'aggregate' | 'as_of';
/** The output root `C` of request `R` names (`default` when it names none). */
export type OutputOf<R, C> = C extends keyof R
	? R[C] extends { output: infer O extends string }
		? O
		: 'default'
	: 'default';
type RequestChildren<C, P extends string, Node, O> = {
	[Relation in Exclude<keyof Node, ReadOption>]: Relation extends string
		? `${P}.${Relation}` extends ReadPath<C, O>
			? LayerRequest<C, `${P}.${Relation}`, O> & RequestChildren<C, `${P}.${Relation}`, Node[Relation], O>
			: `error: '${P}.${Relation}' is not a read layer this output declares`
		: never;
};
/** Each root and nested relation is checked against its selected output. */
type RequestSpec<R> = {
	[C in keyof R]: C extends ReadableName
		? RootRequest<C, OutputOf<R, C>> & RequestChildren<C, C, R[C], OutputOf<R, C>>
		: `error: '${C & string}' is no read root`;
};
/** A read request literal, checked exactly: an unknown key, path, field or option fails to type-check. */
export type ReadRequest<R> = R & NoInfer<Checked<ReadRequestBase, R, Exact<R, RequestSpec<R>>>>;
type At<R, P> = P extends `${infer Head}.${infer Tail}`
	? Head extends keyof R ? At<R[Head], Tail> : {}
	: P extends keyof R ? R[P] : {};
type LayerPick<C, P, R> =
	At<R, P> extends { fields: readonly (infer F)[] }
		? F & string
		: LayerField<C, P, OutputOf<R, RootOf<P>>>;
/** A layer aggregate row; grouped (`by`), each bucket carries its `key` and row `count`. */
type LayerAggRow<C, P, O, By = never> = AggregateRow<PathModel<C, P>, LayerField<C, P, O> & string, By>;
type SubAnswer<C, Q extends string, R, T, S> = S extends keyof OneRels<T>
	? LayerRow<C, Q, R> | null
	: At<R, Q> extends { aggregate: infer A }
		? A extends { by: infer By }
			? readonly LayerAggRow<C, Q, OutputOf<R, C>, By>[]
			: LayerAggRow<C, Q, OutputOf<R, C>>
		: readonly LayerRow<C, Q, R>[];
/**
 * One row of layer `P` of the root's output: `id`, its picked fields (all the output exposes there without `fields`),
 * and each named sub-layer under its relation name in place of the FK (a ref: the row or `null`; a many-relation: its
 * rows).
 */
type LayerRow<
	C,
	P extends string,
	R,
	T = PathModel<C, P>,
	S extends string = Exclude<keyof At<R, P>, ReadOption> & string
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
			? Page<AggRow<C, B, OutputOf<R, C>>>
			: AggRow<C, never, OutputOf<R, C>>
		: At<R, C> extends { search: object }
			? Page<RootRow<C, R> & { readonly $distance: number }>
			: Page<RootRow<C, R>> & { readonly total: number };
type DynamicReadRow = { readonly id: string; readonly [field: string]: Value };
type DynamicMeasures = {
	readonly count?: number;
	readonly sum?: { readonly [field: string]: Decimal | null };
	readonly avg?: { readonly [field: string]: Decimal | null };
	readonly min?: { readonly [field: string]: Value };
	readonly max?: { readonly [field: string]: Value };
};
type DynamicBucketRow = DynamicMeasures & {
	readonly key: { readonly [field: string]: Value };
	readonly count: number;
};
/**
 * A runtime-built read request's answer (`dynamic_read`): per root, ordinary rows with their total, nearest rows with
 * their distance, an aggregate's measures, or a page of aggregate buckets. Fields keep their decoded rich values;
 * a dynamic request carries no literal field names or result-shape guarantee, so inspect its root before using it.
 */
export type DynamicAnswer = {
	readonly [root: string]:
		| (Page<DynamicReadRow> & { readonly total: number })
		| Page<DynamicReadRow & { readonly $distance: number }>
		| DynamicMeasures
		| Page<DynamicBucketRow>;
};
/** A read request's answer: per root, a page of layer rows (or its aggregate), typed from its output's named layers. */
export type ReadAnswer<R> = {
	readonly [C in keyof R & string]: RootAnswer<C, R>;
};

/**
 * The one read API as the caller (queries, automations under their policies, page loaders): each root reads one named
 * output, the rows its granting policies admit. Pages call the same `query` on `bolt` (`PageBolt`); every read is one
 * read request (a layer map).
 */
export interface CallerQuery {
	/**
	 * A read request: a layer map of roots (models with `read`) and the layers of the output each names, in one crossing
	 * and ONE statement, under the caller's authority: each root's policies granting that output alone filter it and
	 * its layers.
	 * @param request Roots and declared relationship layers, with output, fields, filters, ordering and pagination per layer.
	 * @returns An Effect containing each root's typed page or aggregate. A page's rows are only that page; follow its cursor for more.
	 * @see ReadRequest
	 * @see ReadAnswer
	 * @example
	 * const { orders, commercial_settings } = yield* ctx.query({
	 *   orders: { where: { status: { eq: 'issued' } }, fields: ['number', 'total'], limit: 100,
	 *     lines: { where: { quantity: { gt: 0 } }, fields: ['quantity', 'net'] } },
	 *   commercial_settings: { limit: 1 }
	 * });
	 */
	query<const R extends ReadRequestBase>(request: ReadRequest<R>): Eff<ReadAnswer<R>, ReadFailed>;
	/**
	 * The same layer map built at runtime (a rule engine's reads), made by `dynamic_read` from `@norbital-ai/bolt/protocol`:
	 * checked host-side against the declarations exactly as the literal form is, answered untyped.
	 */
	query(request: DynamicRead): Eff<DynamicAnswer, ReadFailed>;
	/** A record's revisions, oldest first, up to an instant, a revision or just before an approval request. */
	history<C extends string>(
		model: Is<C, ReadableName>,
		id: NoInfer<Id<C>>,
		options?: HistoryOptions<C>
	): Eff<readonly Revision[], ReadFailed>;
}
/**
 * The one read API as the workspace (policy/model callbacks and sync bodies, rule 15): the same shapes as `CallerQuery`,
 * answered with every stored row under no grant.
 */
export type WorkspaceQuery = Pick<CallerQuery, 'query'>;
/** What every server body knows of its moment: who it runs as, the instant, today and the zone (`today_in` another zone). */
export interface Clock {
	readonly actor: Actor;
	now: Instant;
	today: PlainDate;
	tz: IanaZone;
	today_in(zone: IanaZone): PlainDate;
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
		| (S extends OwnedInverse<T> ? never : WriteTarget<ManyRels<T>[S & keyof ManyRels<T>] & string>)
	)[];
};
/**
 * One created row of `M` as a writer sends it and the policy's `verdict` judges it: the root's `create.columns` (required ones
 * required, `filled` ones optional) and each declared child layer as a list of child rows (or, for a non-owned relation,
 * existing rows to link).
 */
export type CreateInput<M> = CreateLayer<M, M & string>;
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
	readonly update?: readonly { readonly target: WriteTarget<Child>; readonly set: UpdateLayer<C, Q> }[];
	readonly delete?: readonly WriteTarget<Child>[];
} & (S extends OwnedInverse<T>
	? {}
	: { readonly link?: readonly WriteTarget<Child>[]; readonly unlink?: readonly WriteTarget<Child>[] });
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
export type UpdateInput<M> = UpdateLayer<M, M & string>;
type StoredLayer<
	C,
	V extends 'create' | 'update',
	P extends string,
	T = PathModel<C, P>
> = StoredRow<T> & {
	readonly [S in SubLayer<WritePath<C, V>, P>]: readonly StoredLayer<C, V, `${P}.${S}`>[];
};
/** The stored row of `M` with each child layer its `V` declares, as update verdicts and transforms see it (`before`). */
export type StoredTree<M, V extends 'create' | 'update'> = StoredLayer<M, V, M & string>;
type ProposedChild<C, V extends 'create' | 'update', P extends string, T = PathModel<C, P>> =
	(StoredRow<T> | (Omit<V extends 'create' ? CreateLayer<C, P> : ChildCreate<C, P>, SubLayer<WritePath<C, V>, P>> & {
		readonly id: Id<T & string>;
	})) & ProposedChildren<C, V, P>;
type ProposedChildren<C, V extends 'create' | 'update', P extends string> = {
	readonly [S in SubLayer<WritePath<C, V>, P>]: readonly ProposedChild<C, V, `${P}.${S}`>[];
};
/** A proposed update keeps the stored root; a new child has its input and known id, without invented stored metadata. */
export type ProposedTree<M> = StoredRow<M> & ProposedChildren<M, 'update', M & string>;

export type Keyed<C> =
	NamesPart<'models'> extends {
		[P in C & string]: { key: readonly unknown[] };
	}
		? true
		: false;
// An import matches records by the declared import key (rule 30).
type Verbs<C, S = ExposureSpecOf<C>> =
	| (S extends { create: unknown }
			? | 'create'
				| (Keyed<C> extends true ? 'import' : never)
			: never)
	| (S extends { update: unknown } ? 'update' : never)
	| (S extends { delete: unknown } ? 'delete' : never);
/** Every callable: a model's generated write verb (X-1, X-24). */
export type Callable = {
	[C in ModelName]: `${C}.${Verbs<C>}`;
}[ModelName];
/**
 * The input of a generated model write. Always a batch: create takes insert trees, update takes
 * `{ target, set }` entries and delete takes `{ target }`.
 * Import takes `{ rows, on_conflict, on_missing?, prune?, dry_run? }`: one atomic act matching rows by the model's key;
 * `dry_run` runs every callback and writes nothing.
 * Fields and child layers come from the model's write exposure, not its read output or complete storage schema.
 * Optional/defaulted insert fields may be omitted; update patches contain only the fields being changed.
 * An unknown verb resolves to `never`. Regenerate workspace names after changing declarations before inspecting this type.
 * @example
 * type CreateOrders = ActInput<'orders.create'>;
 * type UpdateOrders = ActInput<'orders.update'>;
 * @see Callable
 * @see ActOutput
 */
export type ActInput<N> = N extends `${infer C}.${infer V}`
	? V extends 'create'
		? readonly CreateInput<C>[]
		: V extends 'import'
			? ImportInput<C>
			: V extends 'update'
				? readonly { target: WriteTarget<C>; set: UpdateInput<C> }[]
				: V extends 'delete'
					? readonly { target: WriteTarget<C> }[]
					: never
	: never;
/** An import's rows and how it meets the stored rows its key matches (rule 30). */
export type ImportInput<C> = {
	readonly rows: readonly CreateInput<C>[];
	/** `refuse` refuses a row already on file. */
	readonly on_conflict: 'update' | 'keep' | 'refuse';
	/** `skip` only updates rows already on file. */
	readonly on_missing?: 'create' | 'skip';
	/** Deletes the caller-readable rows inside this predicate whose key the import does not name. */
	readonly prune?: Where<C>;
	readonly dry_run?: true;
};
/** An import reports every row's resolution. */
export type ImportReport<C> = {
	readonly rows: readonly {
		readonly index: number | null;
		readonly id: Id<C & string> | null;
		readonly action: 'created' | 'updated' | 'kept' | 'skipped' | 'deleted';
	}[];
};
/**
 * The output inside a successful generated write receipt: create/update/delete return `null`;
 * import returns a per-row resolution report. Written ids and revisions are
 * on the receipt's `records`; this type is not the whole receipt and does not imply that approval has completed.
 * @example
 * type ImportResult = ActOutput<'orders.import'>;
 * @see ActInput
 * @see Committed
 * @see PendingApproval
 */
export type ActOutput<N> = N extends `${infer C}.${infer V}`
	? V extends 'import' ? ImportReport<C> : V extends 'create' | 'update' | 'delete' | 'erase' ? null : never
	: never;
/** A selected row carries the revision checked by its write. Versionless system records carry their id. */
export type WriteTarget<C extends string> = { readonly id: Id<C> } & (C extends SystemModelName
	? { readonly revision?: number }
	: { readonly revision: number });
/** Explicit idempotency for one atomic write. Import conflict policy belongs to its input. */
export type ActOptions = {
	readonly key?: string;
};
export type ActMap = Readonly<Record<string, unknown>>;
export type ActMapInput<A extends ActMap> = A & {
	readonly [N in keyof A]: N extends Callable ? NoInfer<ActInput<N>> : never;
};
export type ActMapOutput<A extends ActMap> = {
	readonly [N in keyof A]: ActOutput<N>;
};
// ── outcomes (rule 32, §3.3.9) ──
type Stored = AuthoredModelName | SystemModelName;
/** Nested and erased rows retain their actual stored model, whose discriminator determines the id's brand. */
type Written = readonly {
	[C in Stored]: { readonly model: C; readonly id: Id<C>; readonly revision: number };
}[Stored][];
/**
 * The engine's own refusal codes (rule 32), beside an authored `refused`: grants, constraints, budgets, rate limits and stale requests.
 */
export type PlatformRefusal = Exclude<(typeof REFUSAL_CODES)[number], 'refused'>;
/**
 * The write is in the database: `output` is the generated write's result, `records` every row the act wrote itself (its
 * nested rows and erasures included, cascades and derived rollups not) with its new revision.
 */
export type Committed<O> = { kind: 'committed'; output: O; records: Written };
/** The write is held for approval (§3.8): `request_id` names the approval request, `records` the held rows. */
export type PendingApproval = {
	kind: 'pending_approval';
	request_id: RequestId;
	records: Written;
};
/**
 * The write was refused: `code` is `refused` for an authored refusal or a platform code, with the message and the field or rows it names.
 */
export type Refused = {
	kind: 'refused';
	code: 'refused' | PlatformRefusal;
	/** The text a person reads: an authored refusal's catalogue message with its values filled. */
	message: string;
	/** An authored refusal's catalogue key and placeholder values. */
	key?: string;
	values?: { readonly [name: string]: string | number };
	field?: string;
	row?: number;
	rows?: readonly number[];
	/** A.2 L-BOLT-043: the write callback that refused (`'<model>.create'`, `'<model>.update'`, `'<model>.delete'`). */
	rule?: string;
	data?: { readonly request_id: RequestId };
};
/** The write lost a race: another write changed these records since they were read. */
export type Conflict = {
	kind: 'conflict';
	records: readonly { [C in Stored]: { readonly model: C; readonly id: Id<C> } }[Stored][];
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
 * Every result of a write (rule 32): `committed`, `pending_approval`, `refused`, `conflict`, `unknown` or `running`, told
 * apart by `kind`.
 */
export type Outcome<O> =
	Committed<O> | PendingApproval | Refused | Conflict | Unknown | Running;
/** One map of generated writes, planned together and committed as one statement. */
export interface Act {
	<const A extends ActMap>(
		acts: ActMapInput<A>,
		options?: ActOptions
	): Eff<Committed<ActMapOutput<A>> | PendingApproval, ActRefused | ActConflict | ActUnknown>;
	/** A runtime-indexed map is checked at the native boundary. */
	<const A extends Readonly<Record<string, Json>>>(
		acts: string extends keyof A ? A : never,
		options?: ActOptions
	): Eff<Committed<Readonly<Record<string, Json>>> | PendingApproval, ActRefused | ActConflict | ActUnknown>;
}

// ── contexts ──
// Contexts are interfaces with declared variance: measuring the variance of a generic alias over a large names index
// cost seconds per body (G1 scale fixture).
// ── policy verdicts (decision 3): one per write verb, the root's policy only ──
/** Where a refusal points: the offending row's index in the batch and, on create and update, a root column. */
type DenyAt<M, V> = V extends 'create' | 'update'
	? { readonly row?: number; readonly field?: LayerColumn<M, V, M> }
	: { readonly row?: number };
/**
 * What a policy's write `verdict` sees: who writes (`actor`, `policies`), the clock, `query` (read requests as the
 * workspace, at most ten per call, whatever the batch size) and the three verdicts. It writes nothing and does no I/O;
 * it returns `allow()` or `approve(flow)`, or stops with `refuse(message_key, at?)`.
 */
export interface PolicyCtx<
	in out M,
	in out V extends 'create' | 'update' | 'delete'
> extends Clock {
	readonly invocation_id: string;
	readonly policies: readonly string[];
	readonly query: WorkspaceQuery['query'];
	/** The write executes directly. */
	allow(): Verdict;
	/**
	 * The whole batch is refused (rule 32) with a catalogue key; `at` names the row and a root column of it, and the
	 * message's `{placeholder}` `values`.
	 */
	refuse<K extends MessageKey>(message: K, ...at: RefuseAt<K, DenyAt<M, V>>): Eff<never, Refusal>;
	/** The batch is held for the declared approval steps and optional superseding teams. */
	approve(flow: ApprovalFlow): Verdict;
}
/** A create verdict receives the same change shape as its model transform. */
export type CreateVerdict<M> = (
	changes: readonly Change<null, CreateInput<M>, CreatedRow<M>>[],
	ctx: PolicyCtx<M, 'create'>
) => BodyReturn<Verdict>;
/** An update verdict receives the stored tree, submitted set and resulting tree. */
export type UpdateVerdict<M> = (
	changes: readonly Change<StoredTree<M, 'update'>, UpdateInput<M>, ProposedTree<M>>[],
	ctx: PolicyCtx<M, 'update'>
) => BodyReturn<Verdict>;
/** A delete verdict receives each removed row with an empty set and null after value. */
export type DeleteVerdict<M> = (
	changes: readonly Change<StoredRow<M>, Readonly<Record<string, never>>, null>[],
	ctx: PolicyCtx<M, 'delete'>
) => BodyReturn<Verdict>;

// ── write callbacks: `create.transform`, `update.transform` ──
// A returned payload is not a fresh literal, so excess keys pass unseen: derived and system columns are named `never`.
type Underived<M, Writable = WritableField<M>> = {
	readonly [P in Exclude<keyof Columns<M>, Writable>]?: never;
};
/** Writable fields the verb's root layer leaves out: a callback derives them (`placed_at`, a total). */
type Unlisted<M, Cols, Fixed = never> = {
	readonly [P in Exclude<WritableField<M>, Cols | Fixed>]?: Loose<ColumnValue<M, P>>;
};
/**
 * One create set: its create tree (the root columns the writer sent, required ones
 * required, and the declared child layers), any other writable field it derives. Derived and system columns are `never`;
 * the `id` is the act's own (the transform reads it, `CreatedRow`).
 */
export type CreateSet<M> = CreateInput<M> &
	Unlisted<M, LayerColumn<M, 'create', M>> &
	Underived<M, WritableField<M> | 'id'>;
/** A proposed create: writable values, its known id and actual child lists; generated columns wait for the commit. */
export type CreatedRow<M> = Omit<CreateSet<M>, SubLayer<WritePath<M, 'create'>, M & string>> & {
	readonly id: Id<M & string>;
} & ProposedChildren<M, 'create', M & string>;
/**
 * One `set` `update.transform` receives and returns: its update tree (the root columns the writer changed and the child
 * layers' changes) and any other writable field it derives, all optional (never an owned child's parent key, rule 41).
 */
export type UpdateSet<M> = UpdateInput<M> &
	Unlisted<M, LayerColumn<M, 'update', M>, OwnedFk<M>> &
	Underived<M>;
/** The same row change in every model hook. `changed` compares stored values, including nested values. */
export type Change<Before, Set, After> = {
	readonly before: Before;
	readonly set: Set;
	readonly after: After;
	changed(...fields: readonly ((keyof NonNullable<Before> | keyof Set | keyof NonNullable<After>) & string)[]): boolean;
};
/**
 * Rows of other models a write callback carries into its own commit: creates, and updates naming the revision they read
 * (a newer one is a conflict). They run their own model's callbacks (`ctx.carried_by` names the carrier), the root write's
 * grant admits them, and they commit with it or not at all.
 */
export type CarriedWrites = {
	readonly [N in AuthoredModelName]?: {
		readonly create?: readonly CreateSet<N>[];
		readonly update?: readonly {
			readonly target: WriteTarget<N>;
			readonly set: UpdateSet<N>;
		}[];
	};
};
/**
 * What a write carries: `with`, part of the write (held with it, rolled back with it, like owned children); and
 * `on_approved`, what follows once it is approved: at once when no approval holds it, else in the approving decision's
 * one commit (the decision asks the callback again, `ctx.approving`), never when it is rejected.
 */
export type Carried = { readonly with?: CarriedWrites; readonly on_approved?: CarriedWrites };
/** What create/update transforms return: their sets in order, optionally with carried writes. */
export type TransformAnswer<R> = readonly R[] | ({ readonly sets: readonly R[] } & Carried);
/** The workspace reads of a write callback, and the act's own rows (`after`). */
interface ProspectiveQuery {
	/** Stored rows matching `where` overlaid with this act's rows: what the model will hold once the act commits. */
	after<C extends string>(
		model: Is<C, ReadableName>,
		where: NoInfer<ModelWhere<C>>
	): Eff<readonly StoredRow<C>[], ReadFailed>;
	after<C extends string, const S extends { readonly [P in keyof StoredRow<C>]?: true } = {}>(
		model: Is<C, ReadableName>,
		where: NoInfer<ModelWhere<C>>,
		query: { select?: S; order_by?: NoInfer<OrderBy<C>> } & Paged
	): Eff<
		Page<
			[keyof S] extends [never]
				? StoredRow<C>
				: Pick<StoredRow<C>, (keyof S | 'id') & keyof StoredRow<C>>
		>,
		ReadFailed
	>;
}
/**
 * What a write callback sees: the clock, the writer's policies, the workspace reads (unmasked; `query.after` sees
 * this act's rows) and `refuse`. A callback reads at most 10 times per call, whatever the batch size: read for the whole
 * batch at once (`yield* ctx.query({ customers: …, prices: … })` is one read), never inside a loop over the rows.
 * It writes nothing itself: what it returns is written in the writer's one transaction.
 */
export interface WriteCtx<in out M> extends Clock, WorkspaceQuery {
	readonly invocation_id: string;
	readonly policies: readonly string[];
	readonly admin: boolean;
	/** The model whose write carries these rows (its `with` or `on_approved`), or `null` for rows written directly. */
	readonly carried_by: AuthoredModelName | null;
	/**
	 * `true` when the decision that approves a held write asks again: the rows are the records as they now stand (an
	 * update's `{ before: row, set: {}, after: row }`), and only the answer's `on_approved` is written, in the
	 * decision's commit. A refusal refuses the approval.
	 */
	readonly approving: boolean;
	/**
	 * Refuses the whole write (rule 32), `return yield* ctx.refuse(…)`, with a catalogue key: `field` names the field,
	 * `row` the index of the offending row in the batch the callback received, `values` the message's placeholders.
	 */
	refuse<K extends MessageKey>(
		message: K,
		...at: RefuseAt<K, { field?: WritableField<M>; row?: number }>
	): Eff<never, Refusal>;
	query: WorkspaceQuery['query'] & ProspectiveQuery;
}

// ── the names the page client (`page/page-bolt.ts`) shares with the `ctx` above ──
/** A key of `src/i18n/+messages.ts`. */
export type MessageKey = keyof NamesPart<'messages'> & string;
type Placeholders<S> = S extends `${string}{${infer P}}${infer R}` ? P | Placeholders<R> : never;
/** The `{placeholder}` values of a catalogue message, named by its base (`+messages.ts`) text. */
export type MessageValues<K extends MessageKey> = {
	readonly [P in Placeholders<NamesPart<'messages'>[K]>]: string | number;
};
/**
 * `ctx.refuse`'s second argument: where (`At`) and, when the message has placeholders, exactly their `values`
 * (then required); a message without placeholders takes none.
 */
export type RefuseAt<K extends MessageKey, At> = [Placeholders<NamesPart<'messages'>[K]>] extends [never]
	? [at?: At]
	: [at: At & { readonly values: MessageValues<K> }];
/** The names ui's views are typed by (`@norbital-ai/ui`'s `Workspace`); none until the workspace exposes a model. */
export type ViewNames = [keyof NamesPart<'exposures'>] extends [never]
	? never
	: {
			models: {
				[C in ModelName]: {
					row: ListRow<C>;
					record: Row<C>;
					insert: CreateInput<C>;
					where: Where<C>;
					order_by: OrderBy<C>;
					/** Many-relation layers a view may show as a column (a table's multi-link cell). */
					many: SelectRel<C> & keyof ManyRels<C> & string;
				};
			};
			actions: { [N in Callable]: ActInput<N> };
			automations: { [A in AutomationName]: StartInput<A> };
		};
