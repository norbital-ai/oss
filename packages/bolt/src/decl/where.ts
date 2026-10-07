// The one predicate language (K3, §3.3.9): reads, grants, `check`, approval matches, triggers and live routing.
import type { Literal } from './fields.ts';
import type {
	CollectionName, Columns, ManyRels, OneRels, OneTarget, PolicyName, ReadField, ReadRelation, RelTarget, TargetName
} from './names.ts';
import type { Json, Offset, Point } from './values.ts';

/** A calendar unit: `{ startOf }` is the first day of the unit containing today, in the workspace zone (weeks start Monday). */
export type CalendarUnit = 'week' | 'month' | 'quarter' | 'year';
/** A calendar-relative date, moved by `shift` whole units: "last month" is `{ startOf: 'month', shift: -1 }`. */
export type StartOf = { startOf: CalendarUnit; shift?: number };
/** A typed operand literal; which ones a position admits depends on the value's kind. */
export type Operand =
	| { field: string } | { param: string } | { now: Offset } | { today: Offset } | StartOf
	| { actor: 'id' | 'email' | 'phone' | 'teams' | 'teamTree' | 'party' | 'visitor' | { scopes: PolicyName } };
/** Rule 11a caps: `and`/`or`/`not` and relation nesting together, and each list's items. */
export const WHERE_MAX_DEPTH = 16, WHERE_MAX_LIST = 1_000, ORDER_MAX_KEYS = 4;
/** A geographic area a `point` filter tests: a polygon, or a bounding box of two corners. */
export type Shape = { readonly polygon: readonly Point[] } | { readonly bbox: readonly [Point, Point] };

type NumKind = 'int' | 'decimal' | 'money' | 'sum' | 'count' | 'number';
/** Kinds that compare with each other through a `{ field }` operand. */
type Family<K> = K extends { kind: NumKind } ? 'num' : K extends { kind: 'text' | 'enum' | 'state' | 'currency' } ? 'text'
	: K extends { kind: 'seq'; pattern: string } ? 'text' : K extends { kind: 'seq' } ? 'num'
	: K extends { kind: 'id'; of: infer T } ? `id:${T & string}` : K extends { kind: infer X extends string } ? X : never;
type SameFamily<M, K> = { [P in keyof Columns<M> & string]: Family<Columns<M>[P]> extends Family<K> ? P : never }[keyof Columns<M> & string];
type Ordered = { kind: NumKind | 'date' | 'instant' | 'time' | 'duration' | 'text' | 'seq' };

// Operands a value position admits, by kind; S = static (check, unique, relationship `where`): values and fields only.
type Dyn<K, S> = S extends true ? never
	: { param: string }
	| (K extends { kind: 'date' } ? { today: Offset } | StartOf : never)
	| (K extends { kind: 'instant' } ? { now: Offset } | StartOf : never)
	| (K extends { kind: 'text'; format: 'email' } ? { actor: 'email' } : never)
	| (K extends { kind: 'text'; format: 'phone' } ? { actor: 'phone' } : never)
	/** The anonymous identity (`__bolt_v`): guest-owned rows on a text field, scoped per browser. */
	| (K extends { kind: 'text' } ? { actor: 'visitor' } : never)
	| (K extends { kind: 'id'; of: 'sys_user' } ? { actor: 'id' } : never)
	| (K extends { kind: 'id' } ? { actor: 'party' } : never);
type DynList<K, S> = S extends true ? never
	: { param: string } | (K extends { kind: 'id' } ? { actor: { scopes: PolicyName } } : never)
	| (K extends { kind: 'id'; of: 'sys_team' } ? { actor: 'teams' | 'teamTree' } : never);
type Val<M, K, S> = Literal<K> | Dyn<K, S> | ([M] extends [never] ? never : { field: SameFamily<M, K> });
type ScalarOps<M, K, S> = { eq?: Val<M, K, S>; ne?: Val<M, K, S>; in?: readonly Literal<K>[] | DynList<K, S>;
	nin?: readonly Literal<K>[] | DynList<K, S>; isNull?: boolean }
	& (K extends Ordered ? { lt?: Val<M, K, S>; lte?: Val<M, K, S>; gt?: Val<M, K, S>; gte?: Val<M, K, S> } : {})
	& (K extends { kind: 'text' } ? { like?: string } : {});
type PeriodLit<K> = K extends { of: 'date' } ? Literal<{ kind: 'date' }> : Literal<{ kind: 'instant' }>;
type End<K, S> = PeriodLit<K> | Dyn<{ kind: K extends { of: 'date' } ? 'date' : 'instant' }, S>;
/** A period argument of `overlaps`/`within`: a literal, or ends relative to today ("overlaps this month"). */
type PeriodArg<K, S> = K extends { of: 'date' } ? { from: End<K, S>; to: End<K, S> | null } : { start: End<K, S>; end: End<K, S> | null };
/** The operators of one column, chosen by its kind. */
export type Ops<M, K, S = false> =
	K extends { kind: 'text' | 'enum'; many: true } ? { has?: Literal<K>; hasAny?: readonly Literal<K>[]; hasAll?: readonly Literal<K>[]; isEmpty?: boolean }
	: K extends { kind: 'period' } ? { contains?: PeriodLit<K> | Dyn<{ kind: K extends { of: 'date' } ? 'date' : 'instant' }, S>;
		overlaps?: PeriodArg<K, S>; within?: PeriodArg<K, S>; isNull?: boolean }
	: K extends { kind: 'point' } ? { near?: readonly [Point, number]; within?: Shape; isNull?: boolean }
	: K extends { kind: 'json' } ? { isNull?: boolean; contains?: Json; /** A json list with no items (or null); `false`: a non-empty list. */ isEmpty?: boolean }
	: K extends { kind: 'file' | 'vector' | 'custom' } ? { isNull?: boolean }
	: ScalarOps<M, K, S>;

type IdOps<T extends string, S> = ScalarOps<never, { kind: 'id'; of: T }, S>;

// X = exposure: a collection name, or 'model' for an unexposed model-level predicate.
type Visible<M, X, P> = X extends 'model' ? P : P & ReadField<M>;
type Crossable<M, X, R> = X extends 'model' ? R : R & ReadRelation<M>;
type Next<T, X> = X extends 'model' ? ModelWhere<T> : Where<T>;
type RefWhere<M, R, X> = OneTarget<M, R> extends infer T extends string
	? [T] extends [TargetName] ? IsPoly<T> extends true ? { [A in T]?: IdOps<A, false> | { is: Next<A, X> } } : never : never
	: never;
type IsPoly<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
type OneRelWhere<M, R, X> = [RefWhere<M, R, X>] extends [never]
	? (R extends Visible<M, X, R> ? IdOps<OneTarget<M, R>, false> : never) | (R extends Crossable<M, X, R> ? { is: Next<OneTarget<M, R>, X> } : never)
	: RefWhere<M, R, X>;
type CmpOps<V> = { eq?: V; ne?: V; lt?: V; lte?: V; gt?: V; gte?: V };
type Summable = { kind: 'int' | 'decimal' | 'money' | 'duration' };
/** Child fields a child aggregate may name: `sum`/`avg` numeric or duration, `min`/`max` also dates and instants. */
type AggOf<T, X, K> = { [P in Visible<T, X, keyof Columns<T> & string>]: Columns<T>[P] extends K ? { of: P } & CmpOps<Literal<Columns<T>[P]>> : never }[Visible<T, X, keyof Columns<T> & string>];
type ManyWhere<T, X> = { some?: Next<T, X>; none?: Next<T, X>; every?: Next<T, X>; count?: CmpOps<number>;
	sum?: AggOf<T, X, Summable>; avg?: AggOf<T, X, Summable>;
	min?: AggOf<T, X, Summable | { kind: 'date' | 'instant' }>; max?: AggOf<T, X, Summable | { kind: 'date' | 'instant' }> };

type WhereOver<M, X> =
	{ [P in Visible<M, X, keyof Columns<M> & string>]?: Ops<M, Columns<M>[P]> }
	// no `as` filter: it re-evaluated every relation's predicate on each read; a relation a caller cannot use is `never`
	& { [R in keyof OneRels<M> & string]?: OneRelWhere<M, R, X> }
	& { [R in Crossable<M, X, keyof ManyRels<M> & string>]?: ManyWhere<RelTarget<M, R>, X> }
	// inline, not an alias applied to itself: a type argument at the top level is resolved eagerly
	& { and?: readonly WhereOver<M, X>[]; or?: readonly WhereOver<M, X>[]; not?: WhereOver<M, X> };

// Conditional on the name: while a call is inferred, its literal is typed against the generic `Where<C>`, whose
// constraint is then `never`, which is cheap; expanding the generic predicate for every nested literal of every call
// cost ~0.5 ms a read (G1 scale fixture). The applicability check that follows types the literal against the
// instantiated `Where<'orders'>`. (A mapped index of every collection's predicate was slower still.)
/** A predicate over collection `C`: only its exposed fields and relations exist (rule 10). */
export type Where<C> = C extends CollectionName ? WhereOver<C, C> : never;
/** A predicate over a model with no exposure filter (an `id` input's picker filter). */
export type ModelWhere<M> = M extends TargetName ? WhereOver<M, 'model'> : never;
/** An own-row predicate with static operands only (`check`, `unique.where`, `noOverlap.where`, relationship `where`).
 * `Fk = false` leaves FK columns out: a relationship's own `where` cannot read the relationships it is declaring. */
export type StaticWhere<M, Fk = true> = { [P in keyof Columns<M> & string]?: Ops<M, Columns<M>[P], true> }
	& (Fk extends true ? { [R in keyof OneRels<M> & string]?: IdOps<OneTarget<M, R>, true> } : {})
	& { and?: readonly StaticWhere<M, Fk>[]; or?: readonly StaticWhere<M, Fk>[]; not?: StaticWhere<M, Fk> };

type Unsortable = { kind: 'json' | 'file' | 'custom' | 'vector' | 'point' | 'period' } | { many: true };
/** Fields a read may order by: exposed, ordered kinds, and `created_at`/`updated_at` (§3.3.9); FKs order by id. */
export type Sortable<C> = C extends CollectionName
	? { [P in ReadField<C> & keyof Columns<C> & string]: Columns<C>[P] extends Unsortable ? never : P extends 'id' | 'revision' | 'approval_id' | 'created_by' | 'updated_by' ? never : P }[ReadField<C> & keyof Columns<C> & string]
		| { [R in ReadField<C> & keyof OneRels<C> & string]: [OneTarget<C, R>] extends [TargetName] ? IsPoly<OneTarget<C, R>> extends true ? never : R : never }[ReadField<C> & keyof OneRels<C> & string]
	: never;
/** One-relations a sort may cross: crossable, into one collection (not an arc). */
type SortHop<C> = C extends CollectionName
	? { [R in ReadRelation<C> & keyof OneRels<C> & string]: [OneTarget<C, R>] extends [CollectionName] ? IsPoly<OneTarget<C, R>> extends true ? never : R : never }[ReadRelation<C> & keyof OneRels<C> & string]
	: never;
type Dir = 'asc' | 'desc';
type Prev = [never, 0, 1];
/** Each key's value at one level: a direction, and through a hop (`D` left) one key of the target's level. */
/** Point fields a read may order by distance from a point, nearest first: `{ location: { near: { lat, lng } } }`. */
type PointField<C> = C extends CollectionName
	? { [P in ReadField<C> & keyof Columns<C> & string]: Columns<C>[P] extends { kind: 'point' } ? P : never }[ReadField<C> & keyof Columns<C> & string]
	: never;
type SortLevel<C, D extends 0 | 1 | 2> = { [K in Sortable<C> | PointField<C> | ([D] extends [0] ? never : SortHop<C>)]:
	(K extends Sortable<C> ? Dir : never) | (K extends PointField<C> ? { near: Point } : never)
	| ([D] extends [0] ? never : K extends SortHop<C> ? OneKey<SortLevel<OneTarget<C, K>, Prev[D]>> : never) };
/** Exactly one key of `L`. */
type OneKey<L> = { [F in keyof L]: { [K in F]: L[F] } & { [K in Exclude<keyof L, F>]?: never } }[keyof L];
/** A sort key: a field (ascending), `{ field: dir }`, or a related field through at most two one-relations
 * (`{ account: { name: 'asc' } }`); the target field must be `Sortable` on its collection (and, at run time, unmasked). */
export type SortKey<C> = Sortable<C> | OneKey<SortLevel<C, 2>>;
/** Up to `ORDER_MAX_KEYS` keys, each once, then `id` (rule 11); nulls last ascending, first descending. */
export type OrderBy<C> = SortKey<C> | readonly SortKey<C>[];
