// Field kinds and input kinds: one literal language for stored fields and every typed input (§3.3.2).
import type { CollectionName, CustomFieldName, CustomShape, NamesPart } from './names.ts';
import type { ModelWhere } from './where.ts';
import type {
	CurrencyCode, Decimal, DatePeriod, Duration, FileRef, Id, Instant, InstantPeriod, Json, MimePattern, Msg, Offset,
	PlainDate, PlainTime, Point, Seconds, Vector
} from './values.ts';

/** A `file` field's cap: at most 20 MiB (the stored-file cap; `bolt check` bounds the KiB form). */
export type FileSize = `${bigint}KiB` | `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20}MiB`;
/** `markdown`: the text is Markdown, rendered as prose; the others are checked on write (rule 68). */
/** How a text field is shown and edited: `cel` is a CEL expression, a wrapped code editor. */
export type TextFormat = 'email' | 'phone' | 'url' | 'zone' | 'markdown' | 'cel';
/** The unit a time field is picked in and snapped to (its start; weeks from Monday); the ui's pickers render it. */
export type DatePrecision = 'year' | 'month' | 'week' | 'day';
export type TimePrecision = 'hour' | 'minute';
export type InstantPrecision = DatePrecision | TimePrecision;
export type SeqPattern = `${string}{${string}}${string}`;
export type StateSpec = { to?: readonly string[]; edit?: 'all' | 'none' | readonly string[] };
/** Options every field kind takes: `optional`, `default`, `unique`, a `label` and `help` message, and `hidden`. */
export type FieldCommon = { optional?: true; default?: unknown; unique?: true; label?: Msg; help?: Msg; hidden?: true };

type StoredArm =
	| { kind: 'text'; format?: TextFormat; max?: number; many?: true }
	| { kind: 'int'; min?: number; max?: number }
	| { kind: 'decimal'; scale: number; precision?: number; min?: number; max?: number }
	/** `scale`: places kept beyond the currency's minor unit (a unit price at 4); the CHECK holds it instead of the minor unit. */
	| { kind: 'money'; currency?: string; scale?: number }
	| { kind: 'currency' } | { kind: 'bool' } | { kind: 'duration' }
	| { kind: 'date'; precision?: DatePrecision } | { kind: 'instant'; precision?: InstantPrecision } | { kind: 'time'; precision?: TimePrecision }
	| { kind: 'period'; of: 'date'; precision?: DatePrecision } | { kind: 'period'; of: 'instant'; precision?: InstantPrecision }
	| { kind: 'enum'; values: readonly string[]; many?: true }
	| { kind: 'state'; initial: string; states: { readonly [state: string]: StateSpec } }
	| { kind: 'seq'; pattern?: SeqPattern; per?: readonly string[] }
	| { kind: 'sum'; of: `${string}.${string}`; where?: { readonly [k: string]: unknown } }   // checked by `Verify`
	| { kind: 'count'; of: string; where?: { readonly [k: string]: unknown } }
	| { kind: 'json'; shape?: InputKind }
	| { kind: 'file'; accept: readonly MimePattern[]; max: FileSize; multiple?: true }
	| { kind: 'point' }
	| { kind: 'vector'; dim: number; metric: 'l2' | 'cosine' | 'ip' }
	| { kind: 'custom'; of: string; many?: true };
type InputArm =
	| { kind: 'number'; min?: number; max?: number }
	| { kind: 'id'; of: string; where?: object }
	| { kind: 'list'; of: InputKind; min?: number; max?: number }
	| { kind: 'object'; fields: InputFields }
	| { kind: 'union'; by: string; arms: { readonly [tag: string]: InputFields } }
	/** Untagged: a value of any scalar arm, decoded by kind (the first arm that fits), e.g. `bool | number | text`. */
	| { kind: 'union'; of: readonly ScalarKind[] }
	| { kind: 'record'; of: InputKind };

// Each arm flattened once into a plain object: a literal's contextual type is picked from this union by `kind`, and
// discriminating a union of intersections resolved every arm's intersection per literal.
type Flat<T> = T extends unknown ? { [K in keyof T]: T[K] } : never;
/**
 * A stored field's kind literal in a model (`{ kind: 'text' }`, `{ kind: 'money' }`, `{ kind: 'state', … }`, …) with its options.
 */
export type FieldKind = Flat<FieldCommon & StoredArm>;
/**
 * An input field's kind: every stored kind plus the input-only `number`, `id`, `list`, `object`, `union` and `record`.
 */
export type InputKind = Flat<FieldCommon & (StoredArm | InputArm)>;
/** A record of named input fields: a query's, action's, automation's or custom field's `input` shape. */
export type InputFields = { readonly [name: string]: InputKind };
/** The arms an untagged union may hold: scalars, so a value's kind names its arm. */
type ScalarKind = Flat<FieldCommon & Extract<StoredArm | { kind: 'number'; min?: number; max?: number },
	{ kind: 'bool' | 'int' | 'number' | 'decimal' | 'text' | 'enum' | 'date' | 'instant' | 'time' }>>;
/** A plain value literal of kind `K` (defaults, `Where` values). */
export type Value<K> = Literal<K>;
export type DerivedKind = 'seq' | 'sum' | 'count';

// ── values ──
type Base<K> =
	K extends { kind: 'text'; many: true } ? readonly string[]
	: K extends { kind: 'text' } ? string
	: K extends { kind: 'int' | 'count' | 'number' } ? number
	: K extends { kind: 'decimal' | 'money' | 'sum' } ? Decimal
	: K extends { kind: 'currency' } ? CurrencyCode
	: K extends { kind: 'bool' } ? boolean
	: K extends { kind: 'date' } ? PlainDate
	: K extends { kind: 'instant' } ? Instant
	: K extends { kind: 'time' } ? PlainTime
	: K extends { kind: 'duration' } ? Seconds
	: K extends { kind: 'period'; of: 'date' } ? DatePeriod
	: K extends { kind: 'period' } ? InstantPeriod
	: K extends { kind: 'enum'; values: readonly (infer V)[]; many: true } ? readonly V[]
	: K extends { kind: 'enum'; values: readonly (infer V)[] } ? V
	: K extends { kind: 'state'; states: infer S } ? keyof S & string
	: K extends { kind: 'seq'; pattern: string } ? string
	: K extends { kind: 'seq' } ? number
	: K extends { kind: 'json'; shape: infer S } ? ValueOf<S>
	: K extends { kind: 'json' } ? Json
	: K extends { kind: 'file'; multiple: true } ? readonly FileRef[]
	: K extends { kind: 'file' } ? FileRef
	: K extends { kind: 'point' } ? Point
	: K extends { kind: 'vector' } ? Vector
	: K extends { kind: 'custom'; of: infer F; many: true } ? readonly ValueOf<CustomShape<F>>[]
	: K extends { kind: 'custom'; of: infer F } ? ValueOf<CustomShape<F>>
	: K extends { kind: 'id'; of: infer C extends string } ? Id<C>
	: K extends { kind: 'list'; of: infer O } ? readonly ValueOf<O>[]
	: K extends { kind: 'object'; fields: infer F } ? InputOf<F>
	: K extends { kind: 'union'; of: readonly (infer O)[] } ? ValueOf<O>
	: K extends { kind: 'union'; by: infer B extends string; arms: infer A } ? { [T in keyof A]: Simplify<{ readonly [P in B]: T } & InputOf<A[T]>> }[keyof A]
	: K extends { kind: 'record'; of: infer O } ? { readonly [key: string]: ValueOf<O> }
	: never;
/** The TypeScript type of a value of kind `K`; `optional: true` admits null. */
export type ValueOf<K> = K extends { optional: true } ? Base<K> | null : Base<K>;
type OptionalKey<F, P extends keyof F> = F[P] extends { optional: true } ? P : F[P] extends { default: unknown } ? P : never;
type OptionalKeys<F> = { [P in keyof F]-?: OptionalKey<F, P> }[keyof F];
/** An object of kinds as a value: absent-or-null for `optional`, absent for a default. */
export type InputOf<F> = Simplify<{ readonly [P in Exclude<keyof F, OptionalKeys<F>>]: ValueOf<F[P]> } & { readonly [P in OptionalKeys<F>]?: ValueOf<F[P]> }>;
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

// ── literals a declaration may write for a kind (defaults, Where values): no runtime value is needed ──
export type DateLiteral = `${number}-${number}-${number}`;
export type Literal<K> =
	K extends { kind: 'decimal' | 'money' | 'sum' } ? Decimal | number | `${number}`
	: K extends { kind: 'date' } ? PlainDate | DateLiteral
	: K extends { kind: 'instant' } ? Instant | `${DateLiteral}T${string}`
	: K extends { kind: 'time' } ? PlainTime | `${number}:${number}`
	: K extends { kind: 'duration' } ? Seconds | Duration
	: K extends { kind: 'state' | 'enum' | 'text'; many: true } ? Base<K> extends readonly (infer V)[] ? V : never
	: Base<K>;
type DefaultOf<K> =
	K extends { kind: 'date' } ? Literal<K> | { today: Offset }
	: K extends { kind: 'instant' } ? Literal<K> | { now: Offset }
	: K extends { kind: 'enum' | 'text'; many: true } ? readonly Literal<K>[]
	// ponytail: a custom default is its value type, so a shape holding a branded value (date, decimal) needs a cast
	: K extends { kind: 'custom' } ? Base<K>
	: K extends { kind: 'period' | 'file' | 'point' | 'vector' | 'state' | DerivedKind } ? never
	: Literal<K>;

// ── exact-literal validation (rule 5): every options object is exact at every depth ──
type Fn = (...args: never[]) => unknown;
type Leaf = string | number | boolean | null | undefined;
/** A declaration's parameter: `T` checked by `V`, except while TS computes the literal's contextual type from the
 * constraint `Base` itself, where expanding `V` over every kind would cost ~200k instantiations per call. A literal that
 * satisfies `V` gets `unknown`, so the parameter is `T` alone: relating the fresh literal to `T & V` intersects every
 * array position with its spec, which TS compares member by member (~1k instantiations an array). A literal that fails
 * gets `T & V`, whose `never` keys and spec types point tsc at the offending line as before. */
export type Checked<Base, T, V> = Base extends T ? unknown : T extends V ? unknown : V;
/** `T` checked against spec `S`: keys `S` lacks become `never`, recursively; a union spec is matched arm by arm. Plain
 * values and arrays of them are left to their spec as is: there is nothing to be exact about. One alias per node. */
export type Exact<T, S> =
	T extends readonly unknown[]
		? T extends readonly Leaf[] ? S
		// a tuple spec is matched position by position, an array spec element by element
		: S extends readonly (infer E)[] ? { readonly [I in keyof T]: T[I] extends Leaf ? (number extends S['length'] ? E : S[I & keyof S]) : Exact<T[I], number extends S['length'] ? E : S[I & keyof S]> } : S
	: T extends Fn ? S
	: S extends readonly unknown[] ? S
	: S extends object ? ExactObject<T, S>
	: S;
// `keyof S` once per node, not once per key: the key union of an intersection spec (`Where`) is rebuilt on each read
type ExactObject<T, S, KS = keyof S> = { [K in keyof T]: K extends KS ? T[K] extends Leaf ? S[K & keyof S] : Exact<T[K], S[K & keyof S]> : never };

type Common<D> = { optional?: true; default?: D; unique?: true; label?: Msg; help?: Msg; hidden?: true };
type DerivedCommon = { unique?: true; label?: Msg; help?: Msg; hidden?: true };
// one table built once: `Extract` over the arms re-distributes for every literal
type Arms = { [A in StoredArm | InputArm as A['kind']]: A };
type ArmOf<K> = K extends keyof Arms ? Arms[K] : never;
type KindKey<T> = T extends { kind: infer K extends string } ? K : never;

/** The spec one input literal must satisfy (inputs, json shapes, custom shapes); pass it through `Exact`. */
export type ValidInput<T, Stored = false> =
	T extends { kind: 'object'; fields: infer F } ? { kind: 'object'; fields: ValidInputs<F, Stored> } & Common<never>
	: T extends { kind: 'list' | 'record'; of: infer O } ? Omit<ArmOf<KindKey<T>>, 'of'> & { of: ValidInput<O, Stored> } & Common<never>
	: T extends { kind: 'union'; of: infer O } ? { kind: 'union'; of: { [I in keyof O]: ValidInput<O[I], Stored> } } & Common<never>
	: T extends { kind: 'union'; arms: infer A } ? { kind: 'union'; by: string; arms: { [G in keyof A]: ValidInputs<A[G], Stored> } } & Common<never>
	: T extends { kind: 'json'; shape: infer S } ? { kind: 'json'; shape: ValidInput<S, Stored> } & Common<Json>
	: T extends { kind: 'id'; of: infer C } ? { kind: 'id'; of: CollectionName } & (Stored extends true ? {} : { where?: IdWhere<C> }) & Common<never>
	: T extends { kind: 'custom' } ? { kind: 'custom'; of: CustomFieldName; many?: true } & Common<DefaultOf<T>>
	: T extends { kind: 'enum'; values: readonly (infer V)[] } ? ArmOf<'enum'> & Common<T extends { many: true } ? readonly V[] : V>
	: T extends { kind: DerivedKind | 'state' } ? `error: '${KindKey<T>}' is a stored-only kind`
	: [ArmOf<KindKey<T>>] extends [never] ? InputKind
	: ArmOf<KindKey<T>> & Common<DefaultOf<T>>;
export type ValidInputs<F, Stored = false> = { [P in keyof F]: ValidInput<F[P], Stored> };
// An `id` input's picker filter is a Where over the target model, which never depends on a collection literal. Inside a
// stored `json` shape (`Stored`) an id takes no filter: a model literal must not read the relationships, which read it.
type IdWhere<C> = C extends string ? ModelWhere<C> : never;

/** The spec one stored field literal must satisfy, given its model's own field literals `F`. */
export type ValidField<T, F> =
	T extends { kind: 'state'; states: infer S } ? {
		kind: 'state'; initial: keyof S & string;
		// `edit` may also name an owned relationship's inverse: checked by `Verify`, not here
		states: { [K in keyof S]: { to?: readonly (keyof S & string)[]; edit?: 'all' | 'none' | readonly string[] } };
	} & DerivedCommon
	: T extends { kind: 'money' } ? { kind: 'money'; currency?: CurrencyCode | FieldsOfKind<F, 'currency'>; scale?: number } & Common<DefaultOf<T>> & MoneyCurrency<T>
	: T extends { kind: DerivedKind } ? ArmOf<KindKey<T>> & DerivedCommon
	: T extends { kind: 'json' } ? ValidInput<T, true>
	: T extends { kind: 'number' | 'id' | 'list' | 'object' | 'union' | 'record' } ? `error: '${KindKey<T>}' is an input-only kind`
	: ValidInput<T>;
type FieldsOfKind<F, K> = { [P in keyof F]: F[P] extends { kind: K } ? P : never }[keyof F] & string;
// X-8: a money field names its currency unless `+workspace.ts` sets one
type MoneyCurrency<T> = T extends { currency: string } ? unknown
	: NamesPart<'workspace'> extends { currency: string } ? unknown : { currency: 'error: money needs a currency (none in +workspace.ts)' };
