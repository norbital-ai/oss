// Field kinds and input kinds: one literal language for stored fields and every typed input (§3.3.2).
import type { ModelName, CustomFieldName, CustomShape, NamesPart, Row } from './names.ts';
import type { ModelWhere } from './where.ts';
import type {
	DatePrecision,
	TimePrecision,
	Precision as InstantPrecision,
	Where as KindWhere
} from '@norbital-ai/std/kind';
import type {
	CurrencyCode,
	Decimal,
	DatePeriod,
	Duration,
	FileRef,
	Id,
	Instant,
	InstantPeriod,
	Json,
	MimePattern,
	Msg,
	PlainDate,
	PlainTime,
	Point,
	Seconds,
	Vector
} from './values.ts';

/** A `file` field's cap: at most 20 MiB (the stored-file cap; `bolt check` bounds the KiB form). */
type FileSize =
	| `${bigint}KiB`
	| `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20}MiB`;
/** `markdown`: the text is Markdown, rendered as prose; the others are checked on write (rule 68). */
/**
 * How a text field is shown and edited: `cel` is a CEL expression, a wrapped code editor; `team` holds a team handle
 * declared in source (`+team.ts`), refused on write when undeclared.
 */
type TextFormat = 'email' | 'phone' | 'url' | 'zone' | 'markdown' | 'cel' | 'team';
/** The unit a time field is picked in and snapped to (its start; weeks from Monday); the ui's pickers render it. */
export type {
	DatePrecision,
	TimePrecision,
	Precision as InstantPrecision
} from '@norbital-ai/std/kind';
type SeqPattern = `${string}{${string}}${string}`;
type StateSpec = { to?: readonly string[]; edit?: 'all' | 'none' | readonly string[] };
/** Options every field kind takes: `optional`, `default`, `unique`, a `label` and `help` message, and `hidden`. */
export type FieldCommon = {
	optional?: true;
	default?: Json;
	unique?: true;
	label?: Msg;
	help?: Msg;
	hidden?: true;
};

type StoredArm =
	| { kind: 'text'; format?: TextFormat; max?: number; many?: true }
	| { kind: 'int'; min?: number; max?: number }
	| { kind: 'decimal'; scale: number; precision?: number; min?: number; max?: number }
	/** `scale`: places kept beyond the currency's minor unit (a unit price at 4); the CHECK holds it instead of the minor unit. */
	| { kind: 'money'; currency?: string; scale?: number }
	| { kind: 'currency' }
	| { kind: 'bool' }
	| { kind: 'duration' }
	| { kind: 'date'; precision?: DatePrecision }
	| { kind: 'instant'; precision?: InstantPrecision }
	| { kind: 'time'; precision?: TimePrecision }
	| { kind: 'period'; of: 'date'; precision?: DatePrecision }
	| { kind: 'period'; of: 'instant'; precision?: InstantPrecision }
	| {
			kind: 'enum';
			values: readonly string[];
			many?: true;
			/** The states one value may move to; a write naming another transition is refused. */
			transitions?: Readonly<Record<string, readonly string[]>>;
	  }
	| { kind: 'state'; initial: string; states: { readonly [state: string]: StateSpec } }
	| { kind: 'seq'; pattern?: SeqPattern; per?: readonly string[] }
	| { kind: 'sum'; of: `${string}.${string}`; where?: { readonly [k: string]: unknown } } // checked by `Verify`
	| { kind: 'count'; of: string; where?: { readonly [k: string]: unknown } }
	| { kind: 'json'; shape?: InputKind }
	/**
	 * `key`: the field of the list's object items that names each one; keys are distinct and non-empty, and a draft
	 * pointer addresses an item by its key instead of its index (`/leave/ANNUAL/days`).
	 */
	| { kind: 'list'; of: InputKind; min?: number; max?: number; key?: string }
	| { kind: 'object'; fields: InputFields; rest?: InputKind }
	| { kind: 'file'; accept: readonly MimePattern[]; max: FileSize; multiple?: true }
	| { kind: 'point' }
	| { kind: 'vector'; dim: number; metric: 'l2' | 'cosine' | 'ip' }
	| { kind: 'custom'; of: string; many?: true };
type InputArm =
	| { kind: 'number'; min?: number; max?: number }
	| { kind: 'id'; of: string; where?: KindWhere }
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
 * An input field's kind: every stored kind plus the input-only `number`, `id`, `union` and `record`.
 */
export type InputKind = Flat<FieldCommon & (StoredArm | InputArm)>;
/** A callable output may carry caller-readable rows without copying their model's fields. */
export type OutputKind =
	| InputKind
	| (FieldCommon &
			(
				| { kind: 'row'; of: string }
				| { kind: 'list'; of: OutputKind; min?: number; max?: number }
				| { kind: 'object'; fields: { readonly [name: string]: OutputKind }; rest?: OutputKind }
				| { kind: 'record'; of: OutputKind }
				| {
						kind: 'union';
						by: string;
						arms: { readonly [tag: string]: { readonly [name: string]: OutputKind } };
				  }
			));
/** A record of named input fields: a query's, action's, automation's or custom field's `input` shape. */
export type InputFields = { readonly [name: string]: InputKind };
/** The arms an untagged union may hold: scalars, so a value's kind names its arm. */
type ScalarKind = Flat<
	FieldCommon &
		Extract<
			StoredArm | { kind: 'number'; min?: number; max?: number },
			{
				kind: 'bool' | 'int' | 'number' | 'decimal' | 'text' | 'enum' | 'date' | 'instant' | 'time';
			}
		>
>;
/** A plain value literal of kind `K` (defaults, `Where` values). */
export type Value<K> = Literal<K>;
type DerivedKind = 'seq' | 'sum' | 'count';

// ── values ──
type Base<K> = K extends { kind: never }
	? FieldValue<K>
	: K extends { kind: 'row'; of: infer C extends string }
		? Row<C>
		: K extends { kind: 'id'; of: infer C extends string }
			? Id<C>
			: FieldValue<K>;
// Unchecked descriptors and unchecked kind properties follow different original branches.
type FieldValue<K> = K extends { kind: 'list' | 'object' | 'union' | 'record' }
	? K extends { kind: never }
		? PlainFieldValue<K>
		: (unknown extends K ? false : string extends KindKey<K> ? true : false) extends true
			? PlainFieldValue<K>
			: K extends { kind: 'list'; of: infer O }
				? readonly ValueOf<O>[]
				: K extends { kind: 'object'; fields: infer F }
					? K extends { rest: infer R }
						? InputOf<F> & { readonly [key: string]: ValueOf<R> | ValueOf<F[keyof F]> }
						: InputOf<F>
					: K extends { kind: 'union'; of: readonly (infer O)[] }
						? ValueOf<O>
						: K extends { kind: 'union'; by: infer B extends string; arms: infer A }
							? { [T in keyof A]: Simplify<{ readonly [P in B]: T } & InputOf<A[T]>> }[keyof A]
							: K extends { kind: 'record'; of: infer O }
								? { readonly [key: string]: ValueOf<O> }
								: never
	: PlainFieldValue<K>;
type PlainFieldValue<K> = K extends { kind: 'text'; many: true }
	? readonly string[]
	: K extends { kind: 'text' }
		? string
		: K extends { kind: 'state'; states: infer S }
			? keyof S & string
			: K extends { kind: 'int' | 'count' | 'number' }
				? number
				: K extends { kind: 'decimal' | 'money' | 'sum' }
					? Decimal
					: K extends { kind: 'currency' }
						? CurrencyCode
						: K extends { kind: 'bool' }
							? boolean
							: K extends { kind: 'date' }
								? PlainDate
								: K extends { kind: 'instant' }
									? Instant
									: K extends { kind: 'time' }
										? PlainTime
										: K extends { kind: 'duration' }
											? Seconds
											: K extends { kind: 'period'; of: 'date' }
												? DatePeriod
												: K extends { kind: 'period' }
													? InstantPeriod
													: K extends { kind: 'enum'; values: readonly (infer V)[]; many: true }
														? readonly V[]
														: K extends { kind: 'enum'; values: readonly (infer V)[] }
															? V
															: K extends { kind: 'seq'; pattern: string }
																? string
																: K extends { kind: 'seq' }
																	? number
																	: K extends { kind: 'json'; shape: infer S }
																		? ValueOf<S>
																		: K extends { kind: 'json' }
																			? Json
																			: K extends { kind: 'file'; multiple: true }
																				? readonly FileRef[]
																				: K extends { kind: 'file' }
																					? FileRef
																					: K extends { kind: 'point' }
																						? Point
																						: K extends { kind: 'vector' }
																							? Vector
																							: K extends {
																										kind: 'custom';
																										of: infer F;
																										many: true;
																								  }
																								? readonly ValueOf<CustomShape<F>>[]
																								: K extends { kind: 'custom'; of: infer F }
																									? ValueOf<CustomShape<F>>
																									: never;
/** The TypeScript type of a value of kind `K`; `optional: true` admits null. */
export type ValueOf<K> = K extends { optional: true } ? Base<K> | null : Base<K>;
type OptionalKeys<F> = {
	[P in keyof F]-?: F[P] extends { optional: true }
		? P
		: F[P] extends { default: unknown }
			? P
			: never;
}[keyof F];
/** An object of kinds as a value: absent-or-null for `optional`, absent for a default. */
export type InputOf<F> = InputOfFields<F>;
type InputOfFields<F, Optional extends keyof F = OptionalKeys<F>> = Simplify<
	{ readonly [P in Exclude<keyof F, Optional>]: ValueOf<F[P]> } & {
		readonly [P in Optional]?: ValueOf<F[P]>;
	}
>;
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

// ── literals a declaration may write for a kind (defaults, Where values): no runtime value is needed ──
export type DateLiteral = `${number}-${number}-${number}`;
export type Literal<K> = K extends { kind: 'decimal' | 'money' | 'sum' }
	? Decimal | number | `${number}`
	: K extends { kind: 'date' }
		? PlainDate | DateLiteral
		: K extends { kind: 'instant' }
			? Instant | `${DateLiteral}T${string}`
			: K extends { kind: 'time' }
				? PlainTime | `${number}:${number}`
				: K extends { kind: 'duration' }
					? Seconds | Duration
					: K extends { kind: 'state' | 'enum' | 'text'; many: true }
						? Base<K> extends readonly (infer V)[]
							? V
							: never
						: Base<K>;
/** A clock default's shift: one span, whole days or weeks of `today`, also minutes or hours of `now`. */
type Shift<U extends string> = '' | ` ${'+' | '-'} ${U}(${number})`;
type DefaultOf<K> = K extends { kind: 'date' }
	? Literal<K> | { var: `today${Shift<'days' | 'weeks'>}` }
	: K extends { kind: 'instant' }
		? Literal<K> | { var: `now${Shift<'minutes' | 'hours' | 'days' | 'weeks'>}` }
		: K extends { kind: 'enum' | 'text'; many: true }
			? readonly Literal<K>[]
			: // ponytail: a custom default is its value type, so a shape holding a branded value (date, decimal) needs a cast
				K extends { kind: 'custom' }
				? Base<K>
				: K extends { kind: 'period' | 'file' | 'point' | 'vector' | 'state' | DerivedKind }
					? never
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
interface SpecSlot<S, K> {
	readonly value: K extends keyof S ? S[K] : never;
}
/** `T` checked against spec `S`: keys `S` lacks become `never`, recursively; a union spec is matched arm by arm. Plain
 * values and arrays of them are left to their spec as is: there is nothing to be exact about. Members recurse through Exact. */
export type Exact<T, S> = ExactResult<T, S>['value'];
interface ExactResult<T, S> {
	readonly value: T extends readonly unknown[]
		? T extends readonly Leaf[]
			? S
			: S extends readonly unknown[]
				? number extends S['length']
					? { readonly [I in keyof T]: Exact<T[I], S[number]> }
					: { readonly [I in keyof T]: Exact<T[I], S[I & keyof S]> }
				: S
		: T extends Leaf | Fn
			? S
			: S extends object
				? S extends readonly unknown[]
					? S
					: { [K in keyof T]: Exact<T[K], SpecSlot<S, K>['value']> }
				: S;
}

type Common<D> = {
	optional?: true;
	default?: D;
	unique?: true;
	label?: Msg;
	help?: Msg;
	hidden?: true;
};
type DerivedCommon = { unique?: true; label?: Msg; help?: Msg; hidden?: true };
// one table built once: `Extract` over the arms re-distributes for every literal
type Arms = { [A in StoredArm | InputArm as A['kind']]: A };
type ArmOf<K> = K extends keyof Arms ? Arms[K] : never;
// Scalar options share a spec; defaults depend on the literal only for the shapes handled below.
type InputSpecs = { [K in keyof Arms]: Arms[K] & Common<DefaultOf<{ kind: K }>> };
type InputSpec<T, K = KindKey<T>> = K extends keyof Arms
	? T extends { kind: K }
		? InputSpecs[K]
		: Arms[K] & Common<DefaultOf<T>>
	: never;
type KindKey<T> = T extends { kind: infer K extends string } ? K : never;

type ScalarInput = Exclude<
	keyof Arms,
	'object' | 'list' | 'record' | 'union' | 'json' | 'id' | 'custom' | 'enum' | DerivedKind | 'state'
>;
/** The spec one input literal must satisfy (inputs, json shapes, custom shapes); pass it through `Exact`. */
export type ValidInput<T, Stored = false> = T extends { kind: infer K extends ScalarInput }
	? T extends { kind: never }
		? InputOptions<T, Stored>
		: T extends { kind: 'text'; many: true }
			? ArmOf<'text'> & Common<readonly string[]>
			: InputSpec<T, unknown extends T ? KindKey<T> : K>
	: InputOptions<T, Stored>;
type InputOptions<T, Stored> = T extends { kind: 'object'; fields: infer F }
	? { kind: 'object'; fields: ValidInputs<F, Stored> } & (T extends { rest: infer R }
			? { rest: ValidInput<R, Stored> }
			: { rest?: InputKind }) &
			Common<never>
	: T extends { kind: 'list' | 'record'; of: infer O }
		? Omit<ArmOf<KindKey<T>>, 'of'> & { of: ValidInput<O, Stored> } & Common<never>
		: T extends { kind: 'union'; of: infer O }
			? { kind: 'union'; of: { [I in keyof O]: ValidInput<O[I], Stored> } } & Common<never>
			: T extends { kind: 'union'; arms: infer A }
				? {
						kind: 'union';
						by: string;
						arms: { [G in keyof A]: ValidInputs<A[G], Stored> };
					} & Common<never>
				: T extends { kind: 'json'; shape: infer S }
					? { kind: 'json'; shape: ValidInput<S, Stored> } & Common<Json>
					: T extends { kind: 'id'; of: infer C }
						? { kind: 'id'; of: ModelName } & (Stored extends true ? {} : { where?: IdWhere<C> }) &
								Common<never>
						: T extends { kind: 'custom' }
							? { kind: 'custom'; of: CustomFieldName; many?: true } & Common<DefaultOf<T>>
							: T extends { kind: 'enum'; values: readonly (infer V)[] }
								? ArmOf<'enum'> & Common<T extends { many: true } ? readonly V[] : V>
								: T extends { kind: DerivedKind | 'state' }
									? `error: '${KindKey<T>}' is a stored-only kind`
									: [ArmOf<KindKey<T>>] extends [never]
										? InputKind
										: InputSpec<T>;
export type ValidInputs<F, Stored = false> = { [P in keyof F]: ValidInput<F[P], Stored> };
/** Output validation follows nested values and resolves a row's model name from the generated catalogue. */
export type ValidOutput<T> = T extends { kind: 'row' }
	? { kind: 'row'; of: ModelName } & Common<never>
	: T extends { kind: 'list' | 'record'; of: infer O }
		? Omit<T, 'of'> & { of: ValidOutput<O> }
		: T extends { kind: 'object'; fields: infer F }
			? Omit<T, 'fields' | 'rest'> & {
					fields: { [P in keyof F]: ValidOutput<F[P]> };
				} & (T extends { rest: infer R } ? { rest: ValidOutput<R> } : {})
			: T extends { kind: 'union'; arms: infer A }
				? Omit<T, 'arms'> & {
						arms: { [G in keyof A]: { [P in keyof A[G]]: ValidOutput<A[G][P]> } };
					}
				: ValidInput<T>;
// An `id` input's picker filter is a Where over the target model. Inside a stored `json` shape (`Stored`) an id takes no
// filter.
type IdWhere<C> = C extends string ? ModelWhere<C> : never;

/** The spec one stored field literal must satisfy, given its model's own field literals `F`. */
export type ValidField<T, F> = T extends {
	kind:
		| 'state'
		| 'money'
		| DerivedKind
		| 'json'
		| 'number'
		| 'id'
		| 'list'
		| 'object'
		| 'union'
		| 'record';
}
	? T extends { kind: 'state'; states: infer S }
		? {
				kind: 'state';
				initial: keyof S & string;
				// `edit` may also name an owned relationship's inverse: checked by `Verify`, not here
				states: StateTransitions<S>;
			} & DerivedCommon
		: T extends { kind: 'money' }
			? {
					kind: 'money';
					currency?: CurrencyCode | FieldsOfKind<F, 'currency'>;
					scale?: number;
				} & Common<DefaultOf<T>> &
					MoneyCurrency<T>
			: T extends { kind: DerivedKind }
				? ArmOf<KindKey<T>> & DerivedCommon
				: T extends { kind: 'json' | 'list' | 'object' }
					? ValidInput<T, true>
					: T extends { kind: 'number' | 'id' | 'union' | 'record' }
						? `error: '${KindKey<T>}' is an input-only kind`
						: ValidInput<T>
	: ValidInput<T>;
/** String keys whose values fit a specification, shared by declaration field and remote-record checks. */
export type KeyFor<R, V> = { [K in keyof R]: R[K] extends V ? K : never }[keyof R] & string;
type FieldsOfKind<F, K> = KeyFor<F, { kind: K }>;
// X-8: a money field names its currency unless `+workspace.ts` sets one
type MoneyCurrency<T> = T extends { currency: string }
	? unknown
	: NamesPart<'workspace'> extends { currency: string }
		? unknown
		: { currency: 'error: money needs a currency (none in +workspace.ts)' };

type StateTransitions<S> = { [K in keyof S]: StateTransition<keyof S & string> };
type StateTransition<Keys> = { to?: readonly Keys[]; edit?: 'all' | 'none' | readonly string[] };
