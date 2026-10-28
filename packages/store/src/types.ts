// The type machine: every type a store call takes or answers, computed from the schema's own type `S` (`typeof` a
// `schema(…)` value) — a host's literal schema, or the one a Bolt workspace compiles. Nothing is registered globally.
//
// Cost (F28, `bolt/src/decl/where.ts`): a schema's index (`Index<S>`) is one mapped type over its tables, so each
// table's columns, refs and inverses are computed once per schema and then read by indexed access. Positions that take
// a literal (`where`, `select`, `with`) are plain object types over a known table, so an unknown key is an excess
// property, and TS checks a fresh literal against the instantiated type, not a constraint over every table.
import type { Decimal, Duration, Instant, PlainDate } from './values.ts';
import type {
	DatePeriod,
	FileRef,
	Id,
	InstantPeriod,
	Json,
	PlainTime,
	Point,
	RecordRef,
	Seconds,
	Shape,
	Vector
} from './values.ts';

// ── schema shape ──
/** What a kind literal is to the type machine: its `kind` and options. */
type Kind = { readonly kind: string };
type Table = {
	readonly fields: { readonly [field: string]: Kind };
	readonly key?: unknown;
	readonly audit?: true;
	readonly computed?: { readonly [field: string]: { readonly kind: string } };
	readonly through?: {
		readonly [name: string]: { readonly table: string; readonly from: string; readonly to: string };
	};
};
/** Any schema value's type: what `schema(…)` returns. */
export type AnySchema = { readonly tables: { readonly [table: string]: Table } };
export type TableName<S extends AnySchema> = keyof S['tables'] & string;
type Spec<S extends AnySchema, T> = T extends TableName<S> ? S['tables'][T] : never;
type KeyKind<S extends AnySchema, T> =
	Spec<S, T> extends { key: readonly [infer K, ...infer Rest] }
		? Rest extends []
			? Spec<S, T>['fields'][K & keyof Spec<S, T>['fields']]
			: never
		: Spec<S, T> extends { key: 'identity' }
			? { kind: 'int' }
			: Spec<S, T> extends { key: 'text' }
				? { kind: 'text' }
				: { kind: 'id'; of: T };
type RefBase<S extends AnySchema, K> = K extends { to: infer To }
	? IsUnion<Targets<To>> extends true
		? {
				[T in Targets<To>]: { readonly model: T; readonly id: ValueOf<KeyKind<S, T>> };
			}[Targets<To>]
		: ValueOf<KeyKind<S, Targets<To>>>
	: never;
type FieldValue<S extends AnySchema, K> = K extends { kind: 'ref' }
	? RefBase<S, K> | (K extends { optional: true } ? null : never)
	: ValueOf<K>;

// ── values ──
export type Simplify<T> = { [K in keyof T]: T[K] } & {};
type Targets<To> = To extends readonly (infer A extends string)[]
	? A
	: To extends string
		? To
		: never;
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;
/** An object of kinds as a value: optional and defaulted members may be absent or null. */
export type ValueOfFields<F> = Simplify<
	{
		readonly [
			P in keyof F as F[P] extends { optional: true } | { default: unknown } ? never : P
		]: ValueOf<F[P]>;
	} & {
		readonly [P in keyof F as F[P] extends { optional: true } | { default: unknown } ? P : never]?:
			ValueOf<F[P]> | (F[P] extends { default: unknown } ? null : never);
	}
>;
/** Each kind's value, by name: an interface, so each member is computed only when one kind is read (constant depth). */
interface Values<K> {
	text: K extends { many: true } ? readonly string[] : string;
	currency: string;
	int: number;
	count: number;
	number: number;
	decimal: Decimal;
	money: Decimal;
	sum: Decimal;
	bool: boolean;
	date: PlainDate;
	instant: Instant;
	time: PlainTime;
	duration: Seconds;
	period: K extends { of: 'date' } ? DatePeriod : InstantPeriod;
	enum: K extends { values: readonly (infer V)[] }
		? K extends { many: true }
			? readonly V[]
			: V
		: string;
	state: K extends { states: infer S } ? keyof S & string : string;
	seq: K extends { pattern: string } ? string : number;
	id: K extends { of: infer T extends string } ? Id<T> : string;
	ref: K extends { to: infer To }
		? IsUnion<Targets<To>> extends true
			? RecordRef<Targets<To>>
			: Id<Targets<To>>
		: string;
	json: K extends { shape: infer S } ? ValueOf<S> : Json;
	list: K extends { of: infer O } ? readonly ValueOf<O>[] : readonly Json[];
	object: K extends { fields: infer F }
		? ValueOfFields<F> &
				(K extends { rest: infer R }
					? // A TypeScript index signature includes named fields, so a dynamic key may hold either value kind.
						{ readonly [key: string]: ValueOf<R> | ValueOfFields<F>[keyof ValueOfFields<F>] }
					: {})
		: { readonly [key: string]: Json };
	union: K extends { by: infer B extends string; arms: infer A }
		? { [G in keyof A]: Simplify<{ readonly [P in B]: G } & ValueOfFields<A[G]>> }[keyof A]
		: K extends { of: readonly (infer O)[] }
			? ValueOf<O>
			: Json;
	record: K extends { of: infer O }
		? { readonly [key: string]: ValueOf<O> }
		: { readonly [key: string]: Json };
	file: K extends { multiple: true } ? readonly FileRef[] : FileRef;
	point: Point;
	vector: Vector;
	custom: K extends { many: true } ? readonly Json[] : Json;
}
type Base<K> = K extends { kind: infer N extends keyof Values<K> } ? Values<K>[N] : Json;
/** The TypeScript value of a kind; `optional: true` admits null. */
export type ValueOf<K> = K extends { optional: true } ? Base<K> | null : Base<K>;
/** What a write may send for a value: its own type, or the literal a decoder takes for it (ISO text, decimal text). */
export type Loose<V> = V extends Decimal
	? Decimal | number | `${number}`
	: V extends PlainDate
		? PlainDate | `${number}-${number}-${number}`
		: V extends Instant
			? Instant | `${number}-${number}-${number}T${string}`
			: V extends DatePeriod
				? { readonly from: Loose<PlainDate>; readonly to: Loose<PlainDate> | null }
				: V extends InstantPeriod
					? { readonly start: Loose<Instant>; readonly end: Loose<Instant> | null }
					: V extends PlainTime
						? PlainTime | `${number}:${number}`
						: V extends readonly (infer E)[]
							? readonly Loose<E>[]
							: V extends { readonly [key: string]: unknown }
								? { readonly [K in keyof V]: Loose<V[K]> }
								: V;

// ── the index: each table's columns, refs and many-relations, computed once per schema ──
type Audit = {
	revision: { kind: 'int' };
	created_at: { kind: 'instant' };
	created_by: { kind: 'text'; optional: true };
	updated_at: { kind: 'instant' };
	updated_by: { kind: 'text'; optional: true };
};
type KeyColumns<T extends string, Sp> = Sp extends { key: readonly string[] }
	? {}
	: Sp extends { key: 'identity' }
		? { id: { kind: 'int' } }
		: Sp extends { key: 'text' }
			? { id: { kind: 'text' } }
			: { id: { kind: 'id'; of: T } };
type ComputedColumns<Sp> = Sp extends { computed: infer C }
	? { [P in keyof C]: C[P] extends { kind: infer K } ? { kind: K; optional: true } : never }
	: {};
type OwnColumns<Sp> = Sp extends { fields: infer F }
	? { [P in keyof F as F[P] extends { kind: 'ref' } ? never : P]: F[P] }
	: {};
type StoredColumns<Sp> = {
	[
		P in keyof OwnColumns<Sp> as OwnColumns<Sp>[P] extends { kind: 'seq' | 'sum' | 'count' }
			? never
			: P
	]: OwnColumns<Sp>[P];
};
type RefsOf<Sp> = Sp extends { fields: infer F }
	? { [P in keyof F as F[P] extends { kind: 'ref' } ? P : never]: F[P] }
	: {};
/** `[inverse name, child table, child's ref field]` for every ref of any table pointing at `T` with an inverse. */
type Inverses<S extends AnySchema, T> = {
	[X in TableName<S>]: {
		[F in keyof S['tables'][X]['fields']]: S['tables'][X]['fields'][F] extends {
			kind: 'ref';
			to: infer To;
			inverse: infer I extends string;
		}
			? T extends Targets<To>
				? [I, X]
				: never
			: never;
	}[keyof S['tables'][X]['fields']];
}[TableName<S>];
type ThroughOf<S extends AnySchema, Sp> = Sp extends { through: infer M }
	? {
			[N in keyof M]: M[N] extends { table: infer J extends TableName<S>; to: infer R }
				? S['tables'][J]['fields'][R & keyof S['tables'][J]['fields']] extends { to: infer To }
					? Targets<To>
					: never
				: never;
		}
	: {};
type TableIndex<S extends AnySchema, T extends TableName<S>, Sp = S['tables'][T]> = {
	columns: OwnColumns<Sp> &
		ComputedColumns<Sp> &
		KeyColumns<T, Sp> &
		(Sp extends { audit: true } ? Audit : {});
	stored: StoredColumns<Sp> & KeyColumns<T, Sp> & (Sp extends { audit: true } ? Audit : {});
	refs: RefsOf<Sp>;
	many: { [P in Inverses<S, T> as P[0]]: P[1] } & ThroughOf<S, Sp>;
};
/** A schema's index: a mapped type's property is instantiated once and kept. */
type Index<S extends AnySchema> = { [T in TableName<S>]: TableIndex<S, T> };
type Ix<S extends AnySchema, T> = T extends TableName<S> ? Index<S>[T] : never;
export type Columns<S extends AnySchema, T> = Ix<S, T>['columns'];
export type Refs<S extends AnySchema, T> = Ix<S, T>['refs'];
export type Many<S extends AnySchema, T> = Ix<S, T>['many'];
export type ColumnName<S extends AnySchema, T> = keyof Columns<S, T> & string;
export type RefName<S extends AnySchema, T> = keyof Refs<S, T> & string;
export type ManyName<S extends AnySchema, T> = keyof Many<S, T> & string;
/** The table a one- or many-relation reaches. */
type OneTarget<S extends AnySchema, T, R> = Refs<S, T>[R & keyof Refs<S, T>] extends {
	to: infer To;
}
	? Targets<To>
	: never;
type ManyTarget<S extends AnySchema, T, R> = Many<S, T>[R & keyof Many<S, T>] & string;

// ── rows ──
type ColumnValues<S extends AnySchema, T, P> = {
	readonly [K in P & keyof Columns<S, T>]: ValueOf<Columns<S, T>[K]>;
} & { readonly [K in P & keyof Refs<S, T>]: FieldValue<S, Refs<S, T>[K]> };
type Stored<S extends AnySchema, T> = keyof Ix<S, T>['stored'] | RefName<S, T>;
type KeyName<S extends AnySchema, T> =
	Spec<S, T> extends { key: readonly (infer K extends string)[] } ? K : 'id';
/** A one-relation's arm: its select and its own relations. */
type OneArm<S extends AnySchema, X> = {
	readonly select?: Select<S, X>;
	readonly with?: With<S, X>;
};
type PolyArm<S extends AnySchema, X extends string> =
	| (OneArm<S, X> & { readonly [A in X]?: never })
	| ({ readonly select?: never; readonly with?: never } & {
			readonly [A in X]?: true | OneArm<S, A>;
	  });
/** A many-relation's arm: its select, relations, filter, order and page (every list is bounded). */
type ManyArm<S extends AnySchema, X> = OneArm<S, X> & {
	readonly where?: Where<S, X>;
	readonly orderBy?: OrderBy<S, X>;
} & (
		| { readonly limit: number; readonly all?: never }
		| { readonly all: true; readonly limit?: never }
	);
/** A `select`: fields to read as `true` (the key always comes). */
export type Select<S extends AnySchema, T> = {
	readonly [P in ColumnName<S, T> | RefName<S, T>]?: true;
};
/** A `with`: relations to read beside the row, each one statement-deep: no N+1, every list bounded. */
export type With<S extends AnySchema, T> = {
	readonly [R in RefName<S, T>]?:
		| true
		| (IsUnion<OneTarget<S, T, R>> extends true
				? PolyArm<S, OneTarget<S, T, R>>
				: OneArm<S, OneTarget<S, T, R>>);
} & { readonly [R in ManyName<S, T>]?: ManyArm<S, ManyTarget<S, T, R>> };
type ArmOf<A> = A extends true ? {} : A;
type SelectedOf<Q> = Q extends { select: infer Sel } ? keyof Sel : never;
type WithOf<Q> = Q extends { with: infer W } ? W : {};
/** A polymorphic relation's row: whichever target it holds, tagged with its `model`. */
type TargetArm<A, X> = X extends keyof A
	? ArmOf<A[X]>
	: A extends { select: unknown } | { with: unknown }
		? A
		: {};
type Tagged<S extends AnySchema, X, A> = X extends string
	? {
			readonly [P in RowKey<S, X, TargetArm<A, X>> | 'model']: P extends 'model'
				? X
				: RowValue<S, X, TargetArm<A, X>, P>;
		}
	: never;
type RelValue<S extends AnySchema, T, R, A> =
	R extends RefName<S, T>
		? | (IsUnion<OneTarget<S, T, R>> extends true
					? Tagged<S, OneTarget<S, T, R>, A>
					: Row<S, OneTarget<S, T, R>, ArmOf<A>>)
			| (Refs<S, T>[R] extends { optional: true } ? null : never)
		: R extends ManyName<S, T>
			? readonly Row<S, ManyTarget<S, T, R>, ArmOf<A>>[]
			: never;
type RowKey<S extends AnySchema, T, Q> =
	| KeyName<S, T>
	| ([SelectedOf<Q>] extends [never]
			? Stored<S, T>
			: SelectedOf<Q> & (ColumnName<S, T> | RefName<S, T>))
	| (keyof WithOf<Q> & string);
type RowValue<S extends AnySchema, T, Q, P> = P extends keyof WithOf<Q>
	? RelValue<S, T, P, WithOf<Q>[P]>
	: P extends keyof Refs<S, T>
		? FieldValue<S, Refs<S, T>[P]>
		: P extends keyof Columns<S, T>
			? ValueOf<Columns<S, T>[P]>
			: never;
/**
 * A row of table `T` as a read `Q` answers it: the key, then the selected fields (without `select`, the stored row:
 * every field, ref and audit column, no computed or derived ones), then each relation `with` names. One mapped type
 * over its keys: a nested read stays shallow to the checker.
 */
export type Row<S extends AnySchema, T, Q = {}> = {
	readonly [P in RowKey<S, T, Q>]: RowValue<S, T, Q, P>;
};
/** Explicit joins for host-owned catalogues whose relationship is a lookup rather than a foreign key. */
export type JoinOn<S extends AnySchema, From, To> = {
	readonly [P in ColumnName<S, From>]?: {
		[Q in ColumnName<S, To>]: NonNullable<ValueOf<Columns<S, From>[P]>> extends NonNullable<
			ValueOf<Columns<S, To>[Q]>
		>
			? Q
			: never;
	}[ColumnName<S, To>];
};
export type Absent<S extends AnySchema, From> = {
	[To in TableName<S>]: {
		readonly table: To;
		readonly on: JoinOn<S, From, To>;
		readonly where?: Where<S, To>;
	};
}[TableName<S>];
/** Scalar values selected across declared sources in a native UNION. */
export type ValueSource<S extends AnySchema> = {
	[T in TableName<S>]: {
		[P in ColumnName<S, T>]: { readonly table: T; readonly field: P; readonly where?: Where<S, T> };
	}[ColumnName<S, T>];
}[TableName<S>];
export type SourceValue<S extends AnySchema, Q> = Q extends { table: infer T; field: infer P }
	? P extends keyof Columns<S, T>
		? ValueOf<Columns<S, T>[P]>
		: never
	: never;
type ColumnsOfKind<S extends AnySchema, T, K extends string> = {
	[P in ColumnName<S, T>]: Columns<S, T>[P] extends { kind: K } ? P : never;
}[ColumnName<S, T>];
export type RollupQuery<S extends AnySchema, T, By extends readonly Sortable<S, T>[]> = {
	readonly by: By;
	readonly time: ColumnsOfKind<S, T, 'instant'>;
	readonly value: ColumnsOfKind<S, T, 'number'>;
	readonly where?: Where<S, T>;
	/** Combine independent writers by sum, or one shared reading by max, before summarizing time. */
	readonly combine?: 'sum' | 'max';
} & (
	| { readonly stepMillis?: number; readonly latestPer?: never; readonly carry?: never }
	| {
			readonly latestPer: readonly Sortable<S, T>[];
			readonly stepMillis?: never;
			readonly carry?: {
				readonly from: Instant;
				readonly until: Instant;
				readonly stepMillis: number;
			};
	  }
);
export type RollupRow<
	S extends AnySchema,
	T,
	By extends readonly string[],
	At extends number | null = number | null
> = {
	readonly key: { readonly [P in By[number] & keyof Columns<S, T>]: ValueOf<Columns<S, T>[P]> };
	readonly at: At;
	readonly peak: number;
	readonly total: number;
	readonly latest: number;
};
export type RollupResult<S extends AnySchema, T, Q> = Q extends {
	readonly by: infer By extends readonly string[];
}
	? RollupRow<
			S,
			T,
			By,
			Q extends { readonly stepMillis: number } | { readonly carry: object } ? number : null
		>
	: never;

// ── writes ──
type Omittable<K> = K extends
	{ optional: true } | { default: unknown } | { kind: 'state'; initial: string }
	? true
	: false;
type Derived = { kind: 'seq' | 'sum' | 'count' };
type Writable<S extends AnySchema, T> =
	| {
			[P in keyof OwnColumns<Spec<S, T>>]: OwnColumns<Spec<S, T>>[P] extends Derived ? never : P;
	  }[keyof OwnColumns<Spec<S, T>>]
	| RefName<S, T>;
type Kinds<S extends AnySchema, T> = Columns<S, T> & Refs<S, T>;
type NewValue<S extends AnySchema, K, InitialOnly extends boolean> = InitialOnly extends true
	? K extends { kind: 'state'; initial: infer Initial extends string }
		? Initial
		: FieldValue<S, K>
	: FieldValue<S, K>;
type NewRow<S extends AnySchema, T, InitialOnly extends boolean> = Simplify<
	{
		readonly [
			P in Writable<S, T> & keyof Kinds<S, T> as Omittable<Kinds<S, T>[P]> extends true ? never : P
		]: Loose<NewValue<S, Kinds<S, T>[P], InitialOnly>>;
	} & {
		readonly [
			P in Writable<S, T> & keyof Kinds<S, T> as Omittable<Kinds<S, T>[P]> extends true ? P : never
		]?: Loose<NewValue<S, Kinds<S, T>[P], InitialOnly>>;
	} & (Spec<S, T> extends { key: readonly string[] }
			? {}
			: Spec<S, T> extends { key: 'text' }
				? { readonly id: string }
				: { readonly id?: ValueOf<Columns<S, T>['id' & keyof Columns<S, T>]> })
>;
/** A row a `create` sends: defaulted fields may be omitted, and a state begins at its declared initial value. */
export type Insert<S extends AnySchema, T> = NewRow<S, T, true>;
/** An upsert candidate; stateful tables require keep-only conflicts and validate each possible insert's initial state. */
export type Upsert<S extends AnySchema, T> = NewRow<S, T, false>;
/** A partial value of an object, at any depth: what `$patch` merges. */
export type Partial_<V> = V extends readonly unknown[]
	? V
	: V extends { readonly [key: string]: unknown }
		? { readonly [K in keyof V]?: Partial_<V[K]> }
		: V;
/** An atomic change of an inline value: an object merged at its paths, a list's items appended or removed. */
export type Change<K> = K extends { kind: 'json'; shape: infer Sh }
	? Change<Sh>
	: K extends { kind: 'json' }
		? { readonly $patch: { readonly [key: string]: Json } }
		: K extends { kind: 'object' | 'record' }
			? { readonly $patch: Loose<Partial_<NonNullable<ValueOf<K>>>> }
			: K extends { kind: 'list'; of: infer O }
				? | { readonly $append: readonly Loose<ValueOf<O>>[] }
					| { readonly $remove: readonly Loose<ValueOf<O>>[] }
				: never;
/** What an `update` sets: any writable field, an inline value whole or changed in place. */
export type Patch<S extends AnySchema, T> = Simplify<{
	readonly [P in Writable<S, T> & keyof Kinds<S, T>]?:
		Loose<FieldValue<S, Kinds<S, T>[P]>> | Change<Kinds<S, T>[P]>;
}>;
/** A declared instant field that may take the database clock; keys and managed audit fields stay guarded. */
export type ClockColumn<S extends AnySchema, T> = Exclude<
	{
		[P in keyof OwnColumns<Spec<S, T>>]: OwnColumns<Spec<S, T>>[P] extends { kind: 'instant' }
			? P
			: never;
	}[keyof OwnColumns<Spec<S, T>>],
	KeyName<S, T> | (Spec<S, T> extends { audit: true } ? keyof Audit : never)
> &
	string;
/** Mutable numeric fields whose incoming values may be accumulated by an upsert. */
export type NumericColumn<S extends AnySchema, T> = Exclude<
	{
		[P in Writable<S, T> & keyof Kinds<S, T>]: Kinds<S, T>[P] extends {
			kind: 'int' | 'number' | 'decimal' | 'money';
		}
			? P
			: never;
	}[Writable<S, T> & keyof Kinds<S, T>],
	KeyName<S, T>
> &
	string;
export type ScalarColumn<S extends AnySchema, T> = {
	[P in Writable<S, T> & keyof Kinds<S, T>]: Kinds<S, T>[P] extends {
		kind:
			| 'int'
			| 'number'
			| 'decimal'
			| 'money'
			| 'text'
			| 'bool'
			| 'date'
			| 'instant'
			| 'enum'
			| 'time';
	}
		? P
		: never;
}[Writable<S, T> & keyof Kinds<S, T>] &
	string;
/** Per-row scalar assignments in one set-based, key-fenced update. */
export type BulkPatch<S extends AnySchema, T> = {
	readonly [P in Exclude<ScalarColumn<S, T>, KeyName<S, T>> & keyof Kinds<S, T>]?: Loose<
		FieldValue<S, Kinds<S, T>[P]>
	>;
};
/** A row's key: its `id`, or its key fields. */
export type Key<S extends AnySchema, T> = Simplify<ColumnValues<S, T, KeyName<S, T>>>;

// ── where ──
/**
 * The operands a value position admits beside literals, as a type-level function of the position's kind: `Plain`
 * admits none; a host adds its own (Bolt's `{ var }` …) by extending `Operands`.
 */
export interface Operands {
	readonly kind: unknown;
	readonly operand: unknown;
}
export interface Plain extends Operands {
	readonly operand: never;
}
type OperandOf<X extends Operands, K> = (X & { readonly kind: K })['operand'];
type NumKind = { kind: 'int' | 'decimal' | 'money' | 'sum' | 'count' | 'number' | 'duration' };
type Ordered = NumKind | { kind: 'date' | 'instant' | 'time' | 'text' | 'seq' };
/** A literal a predicate compares with: a kind's value, or what decodes to one. */
export type Literal<K> = K extends { kind: 'decimal' | 'money' | 'sum' }
	? Decimal | number | `${number}`
	: K extends { kind: 'date' }
		? PlainDate | `${number}-${number}-${number}`
		: K extends { kind: 'instant' }
			? Instant | `${number}-${number}-${number}T${string}`
			: K extends { kind: 'duration' }
				? Seconds | number
				: K extends { kind: 'enum'; values: readonly (infer V)[] }
					? V
					: K extends { kind: 'text'; many: true }
						? string
						: Base<K>;
type Val<K, X extends Operands> = Literal<K> | OperandOf<X, K>;
type ScalarOps<K, X extends Operands> = {
	readonly eq?: Val<K, X>;
	readonly ne?: Val<K, X>;
	readonly in?: readonly Literal<K>[];
	readonly nin?: readonly Literal<K>[];
	readonly isNull?: boolean;
} & (K extends Ordered
	? {
			readonly lt?: Val<K, X>;
			readonly lte?: Val<K, X>;
			readonly gt?: Val<K, X>;
			readonly gte?: Val<K, X>;
		}
	: {}) &
	(K extends { kind: 'text' } ? { readonly like?: string } : {});
type PeriodArg<K> = K extends { of: 'date' }
	? { readonly from: Literal<{ kind: 'date' }>; readonly to: Literal<{ kind: 'date' }> | null }
	: {
			readonly start: Literal<{ kind: 'instant' }>;
			readonly end: Literal<{ kind: 'instant' }> | null;
		};
/**
 * A predicate inside an inline value, by its shape: an object's fields by name, a list's items quantified, a scalar by
 * its kind's operators; the whole value by containment (`@>`).
 */
export type ShapeWhere<K, X extends Operands = Plain> = K extends { kind: 'json'; shape: infer Sh }
	? ShapeWhere<Sh, X>
	: K extends { kind: 'object'; fields: infer F }
		? { readonly [P in keyof F]?: ShapeWhere<F[P], X> } & {
				readonly contains?: Json;
				readonly isNull?: boolean;
			}
		: K extends { kind: 'list'; of: infer O }
			? {
					readonly some?: ShapeWhere<O, X>;
					readonly every?: ShapeWhere<O, X>;
					readonly none?: ShapeWhere<O, X>;
					readonly isEmpty?: boolean;
					readonly contains?: Json;
				}
			: K extends { kind: 'record' | 'union' | 'json' | 'custom' }
				? { readonly contains?: Json; readonly isNull?: boolean; readonly isEmpty?: boolean }
				: ScalarKindOps<K, X>;
/** Operators without an inline-shape branch, so shape traversal only recurses into an actual child kind. */
type ScalarKindOps<K, X extends Operands> = K extends { kind: 'text' | 'enum'; many: true }
	? {
			readonly has?: Literal<K>;
			readonly hasAny?: readonly Literal<K>[];
			readonly hasAll?: readonly Literal<K>[];
			readonly isEmpty?: boolean;
		}
	: K extends { kind: 'period' }
		? {
				readonly contains?: Literal<{ kind: K extends { of: 'date' } ? 'date' : 'instant' }>;
				readonly overlaps?: PeriodArg<K>;
				readonly within?: PeriodArg<K>;
				readonly isNull?: boolean;
			}
		: K extends { kind: 'point' }
			? {
					readonly near?: readonly [Point, number];
					readonly within?: Shape;
					readonly isNull?: boolean;
				}
			: K extends { kind: 'file' | 'vector' }
				? { readonly isNull?: boolean }
				: ScalarOps<K, X>;
/** The operators of one column, chosen by its kind. */
export type Ops<K, X extends Operands = Plain> = K extends {
	kind: 'json' | 'list' | 'object' | 'record' | 'union' | 'custom';
}
	? ShapeWhere<K, X>
	: ScalarKindOps<K, X>;
type RefOps<K, X extends Operands> = Pick<ScalarOps<K, X>, 'eq' | 'ne' | 'in' | 'nin' | 'isNull'>;
type RefWhere<S extends AnySchema, T, R, X extends Operands> =
	IsUnion<OneTarget<S, T, R>> extends true
		? {
				readonly [A in OneTarget<S, T, R>]?:
					RefOps<KeyKind<S, A>, X> | { readonly is: Where<S, A, X> };
			}
		: RefOps<KeyKind<S, OneTarget<S, T, R>>, X> | { readonly is: Where<S, OneTarget<S, T, R>, X> };
type CmpOps<V> = {
	readonly eq?: V;
	readonly ne?: V;
	readonly lt?: V;
	readonly lte?: V;
	readonly gt?: V;
	readonly gte?: V;
};
type AggOf<S extends AnySchema, C> = {
	[P in ColumnName<S, C>]: Columns<S, C>[P] extends NumKind | { kind: 'date' | 'instant' }
		? { readonly of: P } & CmpOps<Literal<Columns<S, C>[P]>>
		: never;
}[ColumnName<S, C>];
type ManyWhere<S extends AnySchema, C, X extends Operands> = {
	readonly some?: Where<S, C, X>;
	readonly none?: Where<S, C, X>;
	readonly every?: Where<S, C, X>;
	readonly count?: CmpOps<number>;
	readonly sum?: AggOf<S, C>;
	readonly avg?: AggOf<S, C>;
	readonly min?: AggOf<S, C>;
	readonly max?: AggOf<S, C>;
};
/**
 * A predicate over table `T`: its columns by their kind's operators, its refs by id or `{ is }`, its many-relations
 * quantified, combined by `and`/`or`/`not`. A key it does not list is an error (`some` on a to-one relation, say).
 */
export type Where<S extends AnySchema, T, X extends Operands = Plain> = {
	readonly [P in keyof Columns<S, T>]?: Ops<Columns<S, T>[P], X> &
		(Columns<S, T>[P] extends { kind: 'text' }
			? { readonly folded?: string; readonly digits?: string }
			: Columns<S, T>[P] extends { kind: 'instant' }
				? { readonly olderThan?: Duration }
				: {});
} & {
	readonly [R in RefName<S, T>]?: RefWhere<S, T, R, X>;
} & {
	readonly [R in ManyName<S, T>]?: ManyWhere<S, ManyTarget<S, T, R>, X>;
} & {
	readonly and?: readonly Where<S, T, X>[];
	readonly or?: readonly Where<S, T, X>[];
	readonly not?: Where<S, T, X>;
};

// ── order ──
type Unsortable =
	| { kind: 'json' | 'file' | 'custom' | 'vector' | 'point' | 'period' | 'list' | 'object' }
	| { many: true };
export type Sortable<S extends AnySchema, T> = {
	[P in ColumnName<S, T>]: Columns<S, T>[P] extends Unsortable ? never : P;
}[ColumnName<S, T>];
type Dir = 'asc' | 'desc';
export type ColumnOrder<S extends AnySchema, T> =
	| Sortable<S, T>
	| { [P in Sortable<S, T>]: { readonly [K in P]: Dir } }[Sortable<S, T>]
	| readonly (
			Sortable<S, T> | { [P in Sortable<S, T>]: { readonly [K in P]: Dir } }[Sortable<S, T>]
	  )[];
/** An object field's scalar members: an inline value sorts by a path into it. */
type InlinePath<
	K,
	Prefix extends string,
	Depth extends readonly unknown[] = []
> = Depth['length'] extends 8
	? never
	: K extends { kind: 'json'; shape: infer Sh }
		? InlinePath<Sh, Prefix, Depth>
		: K extends { kind: 'object'; fields: infer F }
			? { [P in keyof F & string]: InlinePath<F[P], `${Prefix}.${P}`, [...Depth, 0]> }[keyof F &
					string]
			: K extends Unsortable | { kind: 'json' | 'record' | 'union' }
				? never
				: Prefix;
type InlinePaths<S extends AnySchema, T> = {
	[P in ColumnName<S, T>]: Columns<S, T>[P] extends { kind: 'object' | 'json' }
		? InlinePath<Columns<S, T>[P], P>
		: never;
}[ColumnName<S, T>];
/**
 * A sort key: a field (ascending), `{ field: dir }`, or `{ 'inline.path': dir }` into an object field; the key's columns
 * always end the order (a total order).
 */
export type SortKey<S extends AnySchema, T> =
	| Sortable<S, T>
	| { [P in Sortable<S, T> | InlinePaths<S, T>]: { readonly [K in P]: Dir } }[
			Sortable<S, T> | InlinePaths<S, T>];
export type OrderBy<S extends AnySchema, T> = SortKey<S, T> | readonly SortKey<S, T>[];

// ── reads ──
/** Every read states a page: a `limit` (with the cursor a page gave back), or everything. */
export type Paged =
	| { readonly limit: number; readonly after?: string; readonly all?: never }
	| { readonly all: true; readonly limit?: never; readonly after?: never };
/** One page of rows, and the cursor to the next, `null` on the last. */
export type Page<R> = { readonly rows: readonly R[]; readonly next: string | null };
/** A read of `T`: the shapes Bolt's `ctx.read` takes, with relations under `with`. */
export type ReadQuery<S extends AnySchema, T, X extends Operands = Plain> = {
	readonly where?: Where<S, T, X>;
	readonly select?: Select<S, T>;
	readonly with?: With<S, T>;
	readonly orderBy?: OrderBy<S, T>;
} & Paged;

// ── aggregates ──
type ExtremeKind =
	NumKind | { kind: 'text' | 'enum' | 'state' | 'currency' | 'date' | 'instant' | 'time' | 'seq' };
/** Scalar columns, or columns reached through at most two non-polymorphic refs. */
type AggregatePath<S extends AnySchema, T, K, Depth extends readonly unknown[] = []> =
	| {
			[P in ColumnName<S, T>]: Columns<S, T>[P] extends K
				? Columns<S, T>[P] extends { many: true }
					? never
					: P
				: never;
	  }[ColumnName<S, T>]
	| (Depth['length'] extends 2
			? never
			: {
					[R in RefName<S, T>]: IsUnion<OneTarget<S, T, R>> extends true
						? never
						: `${R}.${AggregatePath<S, OneTarget<S, T, R>, K, [...Depth, 0]> & string}`;
				}[RefName<S, T>]);
type AtPath<S extends AnySchema, T, P> = P extends `${infer R}.${infer Tail}`
	? AtPath<S, OneTarget<S, T, R>, Tail>
	: Columns<S, T>[P & keyof Columns<S, T>];
type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year';
type AggregateBucket<S extends AnySchema, T> =
	| AggregatePath<S, T, ExtremeKind>
	| {
			[U in Unit]: { readonly [K in U]: AggregatePath<S, T, { kind: 'date' | 'instant' }> };
	  }[Unit];
type AggregateCore<S extends AnySchema, T> = {
	readonly where?: Where<S, T>;
	readonly count?: true;
	readonly sum?: readonly AggregatePath<S, T, NumKind>[];
	readonly avg?: readonly AggregatePath<S, T, NumKind>[];
	readonly min?: readonly AggregatePath<S, T, ExtremeKind>[];
	readonly max?: readonly AggregatePath<S, T, ExtremeKind>[];
};
/** Grouped aggregates state a page, like a row read. */
export type AggregateQuery<S extends AnySchema, T> = AggregateCore<S, T> &
	(
		| { readonly by?: never; readonly limit?: never; readonly after?: never; readonly all?: never }
		| ({ readonly by: AggregateBucket<S, T> | readonly AggregateBucket<S, T>[] } & Paged)
	);
type Metric<S extends AnySchema, T, Q, Fn extends string> = Q extends {
	readonly [K in Fn]: readonly (infer F extends string)[];
}
	? {
			readonly [K in Fn]: {
				readonly [P in F]: Fn extends 'sum' | 'avg'
					? Decimal | null
					: ValueOf<AtPath<S, T, P>> | null;
			};
		}
	: {};
type Buckets<Q> = Q extends { by: infer B } ? (B extends readonly (infer E)[] ? E : B) : never;
type BucketField<B> = B extends string ? B : B[keyof B];
/** Exactly the metrics the query asks for; nullable metrics account for an empty input. */
export type AggregateRow<S extends AnySchema, T, Q> = Simplify<
	(Q extends { count: true } ? { readonly count: number } : {}) &
		Metric<S, T, Q, 'sum'> &
		Metric<S, T, Q, 'avg'> &
		Metric<S, T, Q, 'min'> &
		Metric<S, T, Q, 'max'> &
		(Q extends { by: unknown }
			? {
					readonly key: {
						readonly [B in Buckets<Q> as BucketField<B> & string]: B extends string
							? ValueOf<AtPath<S, T, B>> | null
							: PlainDate | null;
					};
				}
			: {})
>;
export type AggregateResult<S extends AnySchema, T, Q> = Q extends { by: unknown }
	? Page<AggregateRow<S, T, Q>>
	: AggregateRow<S, T, Q>;
