// The one predicate language (K3, §3.3.9): reads, grants, `check`, ref `where`, triggers and live routing. A read compares
// against values it is given: the time variables (`{ var: 'today' | 'now' }`) are edge spellings materialized before a
// read (a page passes `bolt.clock(unit)`'s values, server code `ctx.today`).
import type { Literal } from './fields.ts';
import type {
	ModelName,
	Columns,
	IsUnion,
	LayerField,
	LayerRelation,
	ManyRels,
	OneRels,
	OneTarget,
	PathModel,
	PolicyName,
	ReadField,
	ReadRelation,
	RelTarget,
	RootOf,
	TargetName
} from './names.ts';
import type { Json, Point } from './values.ts';

/** A typed operand literal; which ones a position admits depends on the value's kind. */
export type Operand =
	| { field: string }
	| {
			var:
				| 'requestor.id'
				| 'requestor.email'
				| 'requestor.phone'
				| 'requestor.teams'
				| 'requestor.teamTree'
				| 'requestor.party'
				| 'requestor.visitor'
				| 'requestor.instance'
				| `requestor.scopes.${PolicyName}`;
	  };
/** Rule 11a caps: `and`/`or`/`not` and relation nesting together, and each list's items. */
export const WHERE_MAX_DEPTH = 16,
	WHERE_MAX_LIST = 1_000,
	ORDER_MAX_KEYS = 4;
/** A geographic area a `point` filter tests: a polygon, or a bounding box of two corners. */
export type Shape =
	{ readonly polygon: readonly Point[] } | { readonly bbox: readonly [Point, Point] };

type NumKind = 'int' | 'decimal' | 'money' | 'sum' | 'count' | 'number';
/** Kinds that compare with each other through a `{ field }` operand. */
type Family<K> = K extends { kind: NumKind }
	? 'num'
	: K extends { kind: 'text' | 'enum' | 'state' | 'currency' }
		? 'text'
		: K extends { kind: 'seq'; pattern: string }
			? 'text'
			: K extends { kind: 'seq' }
				? 'num'
				: K extends { kind: 'id'; of: infer T }
					? `id:${T & string}`
					: K extends { kind: infer X extends string }
						? X
						: never;
type SameFamily<M, K> = {
	[P in keyof Columns<M> & string]: Family<Columns<M>[P]> extends Family<K> ? P : never;
}[keyof Columns<M> & string];
// Numeric kinds have two literal types but otherwise identical operators and operands.
type NumericKind<K> = K extends { kind: 'decimal' | 'money' | 'sum' }
	? { kind: 'decimal' }
	: K extends { kind: 'int' | 'number' | 'count' }
		? { kind: 'number' }
		: K;
type Ordered = { kind: NumKind | 'date' | 'instant' | 'time' | 'duration' | 'text' | 'seq' };

// Operands a value position admits, by kind; S = static (check, unique, ref `where`): values and fields only.
type Dyn<K, S> = S extends true
	? never
	: | (K extends { kind: 'text'; format: 'email' } ? { var: 'requestor.email' } : never)
		| (K extends { kind: 'text'; format: 'phone' } ? { var: 'requestor.phone' } : never)
		/** The anonymous identity (`__Secure-bolt-visitor`): guest-owned rows on a text field, scoped per browser. */
		| (K extends { kind: 'text' } ? { var: 'requestor.visitor' } : never)
		| (K extends { kind: 'id'; of: 'sys_user' } ? { var: 'requestor.id' } : never)
		/** The instance an envoy turn arrived on, or a sync body runs for; null for every other requestor. */
		| (K extends { kind: 'id'; of: 'sys_integration' } ? { var: 'requestor.instance' } : never)
		| (K extends { kind: 'id' } ? { var: 'requestor.party' } : never);
type DynList<K, S> = S extends true
	? never
	: | (K extends { kind: 'id' } ? { var: `requestor.scopes.${PolicyName}` } : never)
		| (K extends { kind: 'text'; format: 'team' }
				? { var: 'requestor.teams' | 'requestor.teamTree' }
				: never);
interface ValOf<M, K, S> {
	readonly value:
		Literal<K> | Dyn<K, S> | ([M] extends [never] ? never : { field: SameFamily<M, K> });
}
type Val<M, K, S> = ValOf<M, K, S>['value'];
type ScalarOps<M, K, S> = {
	eq?: Val<M, K, S>;
	ne?: Val<M, K, S>;
	in?: readonly Literal<K>[] | DynList<K, S>;
	nin?: readonly Literal<K>[] | DynList<K, S>;
	isNull?: boolean;
} & (K extends Ordered
	? { lt?: Val<M, K, S>; lte?: Val<M, K, S>; gt?: Val<M, K, S>; gte?: Val<M, K, S> }
	: {}) &
	(K extends { kind: 'text' } ? { like?: string } : {});
type PeriodLit<K> = K extends { of: 'date' }
	? Literal<{ kind: 'date' }>
	: Literal<{ kind: 'instant' }>;
type End<K, S> = PeriodLit<K> | Dyn<{ kind: K extends { of: 'date' } ? 'date' : 'instant' }, S>;
/** A period argument of `overlaps`/`within`: its ends as literals or parameters. */
type PeriodArg<K, S> = K extends { of: 'date' }
	? { from: End<K, S>; to: End<K, S> | null }
	: { start: End<K, S>; end: End<K, S> | null };
/** The operators of one column, chosen by its kind. */
export type Ops<M, K, S = false> = K extends { kind: 'text' | 'enum'; many: true }
	? {
			has?: Literal<K>;
			hasAny?: readonly Literal<K>[];
			hasAll?: readonly Literal<K>[];
			isEmpty?: boolean;
		}
	: K extends { kind: 'period' | 'point' | 'json' | 'file' | 'vector' | 'custom' }
		? K extends { kind: 'period' }
			? {
					contains?: PeriodLit<K> | Dyn<{ kind: K extends { of: 'date' } ? 'date' : 'instant' }, S>;
					overlaps?: PeriodArg<K, S>;
					within?: PeriodArg<K, S>;
					isNull?: boolean;
				}
			: K extends { kind: 'point' }
				? { near?: readonly [Point, number]; within?: Shape; isNull?: boolean }
				: K extends { kind: 'json' }
					? {
							isNull?: boolean;
							contains?: Json;
							/** A json list with no items (or null); `false`: a non-empty list. */ isEmpty?: boolean;
						}
					: K extends { kind: 'file' | 'vector' | 'custom' }
						? { isNull?: boolean }
						: ScalarOps<M, NumericKind<K>, S>
		: ScalarOps<M, NumericKind<K>, S>;

type IdOps<T extends string, S> = ScalarOps<never, { kind: 'id'; of: T }, S>;

// X = exposure: a model name (its root layer), a layer path (`'orders.lines'`: that layer's fields), or 'model' for
// an unexposed model-level predicate. A hop crosses only a layer X declares and lands in that layer (`'<X>.<rel>'`).
type Visible<M, X, P> = X extends 'model'
	? P
	: P & (X extends M ? ReadField<M> : LayerField<RootOf<X>, X>);
type Crossable<M, X, R> = X extends 'model' ? R : R & LayerRelation<X>;
/** The exposure a hop through `R` lands in: the layer `X` declares at `'<X>.<R>'`, or none for a model predicate. */
type Hop<X, R> = X extends 'model' ? 'model' : `${X & string}.${R & string}`;
type Next<T, X, R> = X extends 'model' ? ModelWhere<T> : WhereOver<T, Hop<X, R>>;
type RefWhere<M, R, X> =
	OneTarget<M, R> extends infer T extends string
		? [T] extends [TargetName]
			? IsUnion<T> extends true
				? { [A in T]?: IdOps<A, false> | { is: Next<A, X, R> } }
				: never
			: never
		: never;
type OneRelWhere<M, R, X> = [RefWhere<M, R, X>] extends [never]
	? | (R extends Visible<M, X, R> ? IdOps<OneTarget<M, R>, false> : never)
		| (R extends Crossable<M, X, R> ? { is: Next<OneTarget<M, R>, X, R> } : never)
	: RefWhere<M, R, X>;
type CmpOps<V> = { eq?: V; ne?: V; lt?: V; lte?: V; gt?: V; gte?: V };
type Summable = { kind: 'int' | 'decimal' | 'money' | 'duration' };
/** Child fields a child aggregate may name: `sum`/`avg` numeric or duration, `min`/`max` also dates and instants. */
type AggOf<T, X, K> = {
	[P in Visible<T, X, keyof Columns<T> & string>]: Columns<T>[P] extends K
		? { of: P } & CmpOps<Literal<Columns<T>[P]>>
		: never;
}[Visible<T, X, keyof Columns<T> & string>];
type ManyWhere<T, X, R> = {
	some?: Next<T, X, R>;
	none?: Next<T, X, R>;
	every?: Next<T, X, R>;
	count?: CmpOps<number>;
	sum?: AggOf<T, Hop<X, R>, Summable>;
	avg?: AggOf<T, Hop<X, R>, Summable>;
	min?: AggOf<T, Hop<X, R>, Summable | { kind: 'date' | 'instant' }>;
	max?: AggOf<T, Hop<X, R>, Summable | { kind: 'date' | 'instant' }>;
};

type WhereOver<M, X> = {
	[P in Visible<M, X, keyof Columns<M> & string>]?: Ops<M, Columns<M>[P]>;
} & { [R in keyof OneRels<M> & string]?: OneRelWhere<M, R, X> } & {
	// no `as` filter: it re-evaluated every relation's predicate on each read; a relation a caller cannot use is `never`
	[R in Crossable<M, X, keyof ManyRels<M> & string>]?: ManyWhere<RelTarget<M, R>, X, R>;
} & {
	// inline, not an alias applied to itself: a type argument at the top level is resolved eagerly
	and?: readonly WhereOver<M, X>[];
	or?: readonly WhereOver<M, X>[];
	not?: WhereOver<M, X>;
} & { $search?: string; $similar?: string | { to: string; top?: number } }; // `search.text`: every word, fuzzily; `search.semantic`: the nearest in meaning and every row nearly as near (at most `top`, default 20)

// Conditional on the name: while a call is inferred, its literal is typed against the generic `Where<C>`, and expanding
// that predicate for every nested literal of every call cost ~0.5 ms a read (G1 scale fixture). The `[C] extends
// [infer D]` wrapper keeps the generic form's constraint from being `Where<constraint of C>`: under a template helper's
// `C extends ReadableName` that is every model's predicate at once, 0.3 s a call (F28); `D` still distributes over
// a union of names. The applicability check that follows types the literal against the instantiated `Where<'orders'>`.
// (A mapped index of every model's predicate was slower still.)
/** A predicate over model `C`: only its exposed fields and relations exist (rule 10). */
export type Where<C> = [C] extends [infer D]
	? D extends ModelName
		? WhereOver<D, D>
		: never
	: never;
/** A predicate over layer `P` of `C`'s read declaration: only the fields that layer exposes (the root: `Where<C>`). */
export type LayerWhere<C, P> = [PathModel<C, P>] extends [infer T]
	? T extends TargetName
		? WhereOver<T, P>
		: never
	: never;
/** A predicate over a model with no exposure filter (an `id` input's picker filter). */
export type ModelWhere<M> = [M] extends [infer D]
	? D extends TargetName
		? WhereOver<D, 'model'>
		: never
	: never;
/** An own-row predicate with static operands only (`check`, `unique.where`, `noOverlap.where`, a ref field's `where`).
 * `Fk = false` leaves FK columns out: a ref's `where` filters its target by the target's own fields. */
export type StaticWhere<M, Fk = true> = {
	[P in keyof Columns<M> & string]?: Ops<M, Columns<M>[P], true>;
} & (Fk extends true ? { [R in keyof OneRels<M> & string]?: IdOps<OneTarget<M, R>, true> } : {}) & {
		and?: readonly StaticWhere<M, Fk>[];
		or?: readonly StaticWhere<M, Fk>[];
		not?: StaticWhere<M, Fk>;
	};

type Unsortable =
	{ kind: 'json' | 'file' | 'custom' | 'vector' | 'point' | 'period' } | { many: true };
/** Fields a read may order by: exposed, ordered kinds, and `created_at`/`updated_at` (§3.3.9); FKs order by id. */
export type Sortable<C> = C extends ModelName
	? | {
				[P in ReadField<C> & keyof Columns<C> & string]: Columns<C>[P] extends Unsortable
					? never
					: P extends 'id' | 'revision' | 'created_by' | 'updated_by'
						? never
						: P;
		  }[ReadField<C> & keyof Columns<C> & string]
		| {
				[R in ReadField<C> & keyof OneRels<C> & string]: [OneTarget<C, R>] extends [TargetName]
					? IsUnion<OneTarget<C, R>> extends true
						? never
						: R
					: never;
		  }[ReadField<C> & keyof OneRels<C> & string]
	: never;
/** One-relations a sort may cross: crossable, into one model (not an arc). */
type SortHop<C> = C extends ModelName
	? {
			[R in ReadRelation<C> & keyof OneRels<C> & string]: [OneTarget<C, R>] extends [ModelName]
				? IsUnion<OneTarget<C, R>> extends true
					? never
					: R
				: never;
		}[ReadRelation<C> & keyof OneRels<C> & string]
	: never;
type Dir = 'asc' | 'desc';
type Prev = [never, 0, 1];
/** Each key's value at one level: a direction, and through a hop (`D` left) one key of the target's level. */
/** Point fields a read may order by distance from a point, nearest first: `{ location: { near: { lat, lng } } }`. */
type PointField<C> = C extends ModelName
	? {
			[P in ReadField<C> & keyof Columns<C> & string]: Columns<C>[P] extends { kind: 'point' }
				? P
				: never;
		}[ReadField<C> & keyof Columns<C> & string]
	: never;
type SortLevel<C, D extends 0 | 1 | 2> = {
	[K in Sortable<C> | PointField<C> | ([D] extends [0] ? never : SortHop<C>)]:
		| (K extends Sortable<C> ? Dir : never)
		| (K extends PointField<C> ? { near: Point } : never)
		| ([D] extends [0]
				? never
				: K extends SortHop<C>
					? OneKey<SortLevel<OneTarget<C, K>, Prev[D]>>
					: never);
};
/** Exactly one key of `L`. */
type OneKey<L> = {
	[F in keyof L]: { [K in F]: L[F] } & { [K in Exclude<keyof L, F>]?: never };
}[keyof L];
/** A sort key: a field (ascending), `{ field: dir }`, or a related field through at most two one-relations
 * (`{ account: { name: 'asc' } }`); the target field must be `Sortable` on its model (and, at run time, unmasked). */
export type SortKey<C> = Sortable<C> | OneKey<SortLevel<C, 2>>;
/** Up to `ORDER_MAX_KEYS` keys, each once, then `id` (rule 11); nulls last ascending, first descending. */
export type OrderBy<C> = SortKey<C> | readonly SortKey<C>[];
