// A model declaration (§1, §2): one entity in `src/data/model/<name>/+model.ts`: what it stores (fields, `ref` fields,
// keys, checks, computed fields, search), what callers see and send (`outputs`, `create`, `update`, `delete`), and its code
// (write callbacks, search indexes, `notify`, syncs), every callback inside the literal. The data part is
// checked against the literal itself; each body is typed from the generated names by the model's `name`, never from the
// literal, so no type reads its own file. Cross-model names (an inverse, a roll-up, a FK in `record_label`) are checked by `Verify`.
// `splitModel` turns a literal into the engine's three manifest parts: storage, relationships, exposure; `layerModels`
// resolves each declared layer path (`'orders.lines.product'`) to the model behind it.
import type { CatalogExposure } from '@norbital-ai/store';
import { Schema } from 'effect';
import { attached, type Body } from './body.ts';
import type {
	BodyReturn,
	Carried,
	CreatedRow,
	CreateTransformRow,
	NotifyCtx,
	NotifyEvent,
	TransformAnswer,
	UpdateTransformSet,
	WriteCtx
} from './ctx.ts';
import type {
	Checked,
	Exact,
	FieldKind,
	InputFields,
	InputOf,
	KeyFor as OfKind,
	Literal,
	ValidField,
	ValidInputs
} from './fields.ts';
import type {
	ColumnName,
	IndexInput,
	IndexName,
	IntegrationName,
	OneRels,
	RelationshipSpec,
	Row,
	StoredRow,
	SyncName,
	TargetName,
	TargetsOf
} from './names.ts';
import type { MediaType } from './media-types.ts';
import type { EffectCtx } from './runtime/automation.ts';
import type { Notice } from './runtime/facilities.ts';
import type { EmbeddingModelName } from './runtime/names.ts';
import type { BuiltinParser, FileSync, RemoteSync } from './runtime/sync.ts';
import type { Duration, IconName, Json, Vector } from './values.ts';
import type { StaticWhere, Where } from './where.ts';

/** The kinds a computed field's expression may produce. */
export type ComputedKind = 'text' | 'int' | 'decimal' | 'money' | 'bool' | 'date' | 'instant';
type ComputedField = {
	readonly kind: ComputedKind;
	readonly computed: Expr;
	readonly scale?: number;
};
type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year';
type E = Expr;
/** A computed expression: an operator tree over the model's own fields (§3.3.2, rule 3). */
export type Expr =
	| { field: string }
	| number
	| string
	| boolean
	| { plus: readonly [E, E] }
	| { minus: readonly [E, E] }
	| { times: readonly [E, E] }
	| { div: readonly [E, E] }
	| { round: readonly [E, number] }
	| { concat: readonly E[] }
	| { plusDays: readonly [E, E] }
	| { startOf: readonly [E, Unit] }
	| { text: E }
	| { lower: E }
	| { upper: E }
	| { trim: E }
	| { substring: readonly [E, E] | readonly [E, E, E] }
	| { regexReplace: readonly [E, string, string] }
	/** A json field's member as text (`party->>'id'`). */
	| { jsonText: readonly [E, string] }
	| { eq: readonly [E, E] }
	| { ne: readonly [E, E] }
	| { gt: readonly [E, E] }
	| { gte: readonly [E, E] }
	| { lt: readonly [E, E] }
	| { lte: readonly [E, E] }
	| { and: readonly E[] }
	| { or: readonly E[] }
	| { not: E }
	| { when: readonly [E, E, E] }
	| { coalesce: readonly E[] };

type AnyNullable<Xs, F, C, Seen> = Xs extends readonly unknown[]
	? true extends NullableOfExpr<Xs[number], F, C, Seen>
		? true
		: false
	: true;
type AllNullable<Xs, F, C, Seen> = Xs extends readonly [infer H, ...infer T]
	? [NullableOfExpr<H, F, C, Seen>] extends [false]
		? false
		: AllNullable<T, F, C, Seen>
	: true;
type ContainsLiteral<Xs, V> = Xs extends readonly [infer H, ...infer T]
	? [H] extends [V]
		? true
		: ContainsLiteral<T, V>
	: false;
type OptionalField<K> = K extends { optional?: infer O } ? (true extends O ? true : false) : false;

/** Whether an expression can produce SQL NULL. Unknown trees and computed cycles remain nullable. */
export type NullableOfExpr<X, F, C = {}, Seen = never> = Expr extends X
	? true
	: X extends string | number | boolean
		? false
		: X extends { field: infer N }
			? N extends keyof C
				? N extends Seen
					? true
					: C[N] extends { expr: infer A }
						? NullableOfExpr<A, F, C, Seen | N>
						: true
				: N extends keyof F
					? OptionalField<F[N]>
					: true
			: NullableOperation<X, F, C, Seen>;

// Keep the same operator precedence as KindOfExpr and generated SQL, including structural trees with extra keys.
type NullableOperation<X, F, C, Seen> = X extends { plus: infer Args }
	? AnyNullable<Args, F, C, Seen>
	: X extends { minus: infer Args }
		? AnyNullable<Args, F, C, Seen>
		: X extends { times: infer Args }
			? AnyNullable<Args, F, C, Seen>
			: X extends { div: readonly [infer A, infer B] }
				? B extends number
					? number extends B
						? true
						: 0 extends B
							? true
							: NullableOfExpr<A, F, C, Seen>
					: true
				: X extends { round: readonly [infer A, number] }
					? NullableOfExpr<A, F, C, Seen>
					: X extends { concat: readonly unknown[] }
						? false
						: X extends { plusDays: infer Args }
							? AnyNullable<Args, F, C, Seen>
							: X extends { startOf: readonly [infer A, Unit] }
								? NullableOfExpr<A, F, C, Seen>
								: X extends { text: infer A }
									? NullableOfExpr<A, F, C, Seen>
									: X extends { lower: infer A }
										? NullableOfExpr<A, F, C, Seen>
										: X extends { upper: infer A }
											? NullableOfExpr<A, F, C, Seen>
											: X extends { trim: infer A }
												? NullableOfExpr<A, F, C, Seen>
												: X extends { substring: infer Args }
													? AnyNullable<Args, F, C, Seen>
													: X extends { regexReplace: readonly [infer A, string, string] }
														? NullableOfExpr<A, F, C, Seen>
														: X extends { jsonText: readonly unknown[] }
															? true
															: X extends { eq: infer Args }
																? AnyNullable<Args, F, C, Seen>
																: X extends { ne: infer Args }
																	? AnyNullable<Args, F, C, Seen>
																	: X extends { gt: infer Args }
																		? AnyNullable<Args, F, C, Seen>
																		: X extends { gte: infer Args }
																			? AnyNullable<Args, F, C, Seen>
																			: X extends { lt: infer Args }
																				? AnyNullable<Args, F, C, Seen>
																				: X extends { lte: infer Args }
																					? AnyNullable<Args, F, C, Seen>
																					: X extends { and: infer Args }
																						? ContainsLiteral<Args, false> extends true
																							? false
																							: AnyNullable<Args, F, C, Seen>
																						: X extends { or: infer Args }
																							? ContainsLiteral<Args, true> extends true
																								? false
																								: AnyNullable<Args, F, C, Seen>
																							: X extends { not: infer A }
																								? NullableOfExpr<A, F, C, Seen>
																								: X extends {
																											when: readonly [
																												infer Condition,
																												infer A,
																												infer B
																											];
																									  }
																									? [Condition] extends [true]
																										? NullableOfExpr<A, F, C, Seen>
																										: [Condition] extends [false]
																											? NullableOfExpr<B, F, C, Seen>
																											: AnyNullable<readonly [A, B], F, C, Seen>
																									: X extends { coalesce: infer Args }
																										? AllNullable<Args, F, C, Seen>
																										: true;

/** The same NULL guarantees as NullableOfExpr, over the declared expression used by generated SQL. */
export function nullableOfExpr(
	expr: Expr,
	model: {
		readonly fields: {
			readonly [name: string]: { readonly kind: string; readonly optional?: true };
		};
		readonly computed?: { readonly [name: string]: { readonly expr: Expr } };
	}
): boolean {
	const visit = (x: Expr, seen: ReadonlySet<string>): boolean => {
		if (typeof x !== 'object') return false;
		const nullable = (value: Expr) => visit(value, seen);
		if ('field' in x) {
			const computed = model.computed?.[x.field];
			if (computed !== undefined)
				return seen.has(x.field) || visit(computed.expr, new Set([...seen, x.field]));
			const field = model.fields[x.field];
			return field === undefined || field.optional === true;
		}
		if ('plus' in x) return x.plus.some(nullable);
		if ('minus' in x) return x.minus.some(nullable);
		if ('times' in x) return x.times.some(nullable);
		if ('div' in x) return typeof x.div[1] !== 'number' || x.div[1] === 0 || nullable(x.div[0]);
		if ('round' in x) return nullable(x.round[0]);
		if ('concat' in x) return false;
		if ('plusDays' in x) return x.plusDays.some(nullable);
		if ('startOf' in x) return nullable(x.startOf[0]);
		if ('text' in x) return nullable(x.text);
		if ('lower' in x) return nullable(x.lower);
		if ('upper' in x) return nullable(x.upper);
		if ('trim' in x) return nullable(x.trim);
		if ('substring' in x) return x.substring.some(nullable);
		if ('regexReplace' in x) return nullable(x.regexReplace[0]);
		if ('jsonText' in x) return true;
		if ('eq' in x) return x.eq.some(nullable);
		if ('ne' in x) return x.ne.some(nullable);
		if ('gt' in x) return x.gt.some(nullable);
		if ('gte' in x) return x.gte.some(nullable);
		if ('lt' in x) return x.lt.some(nullable);
		if ('lte' in x) return x.lte.some(nullable);
		if ('and' in x) return !x.and.includes(false) && x.and.some(nullable);
		if ('or' in x) return !x.or.includes(true) && x.or.some(nullable);
		if ('not' in x) return nullable(x.not);
		if ('when' in x)
			return x.when[0] === true
				? nullable(x.when[1])
				: x.when[0] === false
					? nullable(x.when[2])
					: nullable(x.when[1]) || nullable(x.when[2]);
		return x.coalesce.every(nullable);
	};
	return visit(expr, new Set());
}

// ── the result kind of a tree, or an `error: …` message naming the problem ──
type Err = `error: ${string}`;
type Num = 'int' | 'decimal' | 'money';
type FieldKindName<K> = K extends { kind: 'sum' | 'count' | 'seq' | 'state' | 'currency' }
	? K extends { kind: 'sum' }
		? 'decimal'
		: K extends { kind: 'count' }
			? 'int'
			: K extends { kind: 'seq'; pattern: string }
				? 'text'
				: K extends { kind: 'seq' }
					? 'int'
					: K extends { kind: 'state' | 'currency' }
						? 'enum'
						: K extends { kind: infer X }
							? X
							: never
	: K extends { kind: infer X }
		? X
		: never;
type Promote<A, B> = A extends 'money'
	? 'money'
	: B extends 'money'
		? 'money'
		: A extends 'decimal'
			? 'decimal'
			: B extends 'decimal'
				? 'decimal'
				: 'int';
type Two<A, B, R> = A extends Err ? A : B extends Err ? B : R;
type All<Ks, K, R, Msg extends string> = Ks extends readonly [infer H, ...infer T]
	? H extends Err
		? H
		: H extends K
			? All<T, K, R, Msg>
			: `error: ${Msg}`
	: R;
type Unify<A, B> = Two<
	A,
	B,
	A extends B
		? A
		: A extends Num
			? B extends Num
				? Promote<A, B>
				: `error: when/coalesce arms differ (${A & string}, ${B & string})`
			: A extends 'enum' | 'text'
				? B extends 'enum' | 'text'
					? 'text'
					: `error: when/coalesce arms differ (${A & string}, ${B & string})`
				: `error: when/coalesce arms differ (${A & string}, ${B & string})`
>;
type UnifyAll<Ks> = Ks extends readonly [infer H, infer N, ...infer T]
	? UnifyAll<[Unify<H, N>, ...T]>
	: Ks extends readonly [infer H]
		? H
		: 'error: empty';
type Kinds<Xs, F> = { [I in keyof Xs]: KindOfExpr<Xs[I], F> };
type Comparable<A, B> = Two<
	A,
	B,
	A extends Num
		? B extends Num
			? 'bool'
			: `error: cannot compare ${A} with ${B & string}`
		: A extends 'enum' | 'text'
			? B extends 'enum' | 'text'
				? 'bool'
				: `error: cannot compare ${A} with ${B & string}`
			: A extends B
				? 'bool'
				: `error: cannot compare ${A & string} with ${B & string}`
>;
type Arith<Op extends string, A, B> = Two<
	A,
	B,
	A extends Num
		? B extends Num
			? Op extends 'times'
				? A extends 'money'
					? B extends 'money'
						? 'error: money times money'
						: 'money'
					: Promote<A, B>
				: Op extends 'div'
					? A extends 'money'
						? B extends 'money'
							? 'decimal'
							: 'money'
						: B extends 'money'
							? 'error: division by money'
							: 'decimal'
					: Promote<A, B>
			: `error: ${Op} needs numbers`
		: `error: ${Op} needs numbers`
>;
type Text1<A, Op extends string> = A extends Err
	? A
	: A extends 'text'
		? 'text'
		: `error: ${Op} needs text`;
/** The kind an expression evaluates to over fields `F`. */
export type KindOfExpr<X, F> = X extends number
	? `${X}` extends `${string}.${string}`
		? 'decimal'
		: 'int'
	: X extends string
		? 'text'
		: X extends boolean
			? 'bool'
			: X extends { field: infer N }
				? N extends keyof F
					? FieldKindName<F[N]>
					: `error: unknown field '${N & string}'`
				: X extends { plus: readonly [infer A, infer B] }
					? Arith<'plus', KindOfExpr<A, F>, KindOfExpr<B, F>>
					: X extends { minus: readonly [infer A, infer B] }
						? Arith<'minus', KindOfExpr<A, F>, KindOfExpr<B, F>>
						: X extends { times: readonly [infer A, infer B] }
							? Arith<'times', KindOfExpr<A, F>, KindOfExpr<B, F>>
							: X extends { div: readonly [infer A, infer B] }
								? Arith<'div', KindOfExpr<A, F>, KindOfExpr<B, F>>
								: X extends { round: readonly [infer A, number] }
									? KindOfExpr<A, F> extends infer K
										? K extends Err | Num
											? K
											: 'error: round needs a number'
										: never
									: X extends { concat: infer Xs }
										? All<
												Kinds<Xs, F>,
												'text' | 'enum',
												'text',
												'concat needs text (cast with `text`)'
											>
										: X extends { plusDays: readonly [infer A, infer B] }
											? Two<
													KindOfExpr<A, F>,
													KindOfExpr<B, F>,
													KindOfExpr<A, F> extends 'date'
														? KindOfExpr<B, F> extends 'int'
															? 'date'
															: 'error: plusDays needs an int'
														: 'error: plusDays needs a date'
												>
											: X extends { startOf: readonly [infer A, Unit] }
												? KindOfExpr<A, F> extends infer K
													? K extends Err | 'date' | 'instant'
														? K
														: 'error: startOf needs a date or an instant'
													: never
												: X extends { text: infer A }
													? KindOfExpr<A, F> extends infer K
														? K extends Err
															? K
															: K extends Num | 'text' | 'enum' | 'date'
																? 'text'
																: `error: text cannot cast ${K & string}`
														: never
													: X extends { lower: infer A }
														? Text1<KindOfExpr<A, F>, 'lower'>
														: X extends { upper: infer A }
															? Text1<KindOfExpr<A, F>, 'upper'>
															: X extends { trim: infer A }
																? Text1<KindOfExpr<A, F>, 'trim'>
																: X extends { substring: readonly [infer A, ...unknown[]] }
																	? Text1<KindOfExpr<A, F>, 'substring'>
																	: X extends { regexReplace: readonly [infer A, string, string] }
																		? Text1<KindOfExpr<A, F>, 'regexReplace'>
																		: X extends { jsonText: readonly [infer A, string] }
																			? KindOfExpr<A, F> extends infer K
																				? K extends Err
																					? K
																					: K extends 'json'
																						? 'text'
																						: 'error: jsonText needs a json field'
																				: never
																			: X extends
																						| { eq: readonly [infer A, infer B] }
																						| { ne: readonly [infer A, infer B] }
																				? Comparable<KindOfExpr<A, F>, KindOfExpr<B, F>>
																				: X extends
																							| { gt: readonly [infer A, infer B] }
																							| { gte: readonly [infer A, infer B] }
																							| { lt: readonly [infer A, infer B] }
																							| { lte: readonly [infer A, infer B] }
																					? Comparable<KindOfExpr<A, F>, KindOfExpr<B, F>>
																					: X extends { and: infer Xs } | { or: infer Xs }
																						? All<
																								Kinds<Xs, F>,
																								'bool',
																								'bool',
																								'and/or need booleans'
																							>
																						: X extends { not: infer A }
																							? KindOfExpr<A, F> extends infer K
																								? K extends Err
																									? K
																									: K extends 'bool'
																										? 'bool'
																										: 'error: not needs a boolean'
																								: never
																							: X extends {
																										when: readonly [infer C, infer A, infer B];
																								  }
																								? KindOfExpr<C, F> extends infer K
																									? K extends Err
																										? K
																										: K extends 'bool'
																											? Unify<KindOfExpr<A, F>, KindOfExpr<B, F>>
																											: 'error: when needs a boolean condition'
																									: never
																								: X extends { coalesce: infer Xs }
																									? UnifyAll<Kinds<Xs, F>>
																									: 'error: unknown operator';

// ── storage: positions checked against the literal's own fields ──
type NonBtree =
	| { kind: 'json' | 'file' | 'point' | 'vector' | 'period' | 'custom' | 'sum' | 'count' }
	| { many: true };
type ColRef<F, N, Keys extends keyof F = keyof F> = N extends Keys
	? F[N] extends NonBtree
		? `error: '${N & string}' is not an indexable field`
		: N
	: N;
type ColRefs<F, L> = { readonly [I in keyof L]: ColRef<F, L[I]> };
type SystemColumn = 'id' | 'revision' | 'created_at' | 'created_by' | 'updated_at' | 'updated_by';
// a system table (`table`) carries no engine columns but its key, so those names are its own fields
type ReservedIn<M> = M extends { table: object } ? 'id' : SystemColumn;
type Loose = { readonly [k: string]: unknown };
/** An own-row predicate at the model literal: own fields typed, other names (FKs) left to `Verify`. */
type OwnWhere<F> = { [P in keyof F]?: OwnOps<F, F[P]> } & {
	and?: readonly OwnWhere<F>[];
	or?: readonly OwnWhere<F>[];
	not?: OwnWhere<F>;
} & Loose;
type OwnVal<F, K> = Literal<K> | { field: OfKind<F, { kind: KindGroup<K> }> };
type KindGroup<K> = K extends { kind: 'int' | 'decimal' | 'money' | 'sum' | 'count' }
	? 'int' | 'decimal' | 'money' | 'sum' | 'count'
	: K extends { kind: infer X }
		? X
		: never;
type OwnOps<F, K> = {
	eq?: OwnVal<F, K>;
	ne?: OwnVal<F, K>;
	in?: readonly Literal<K>[];
	nin?: readonly Literal<K>[];
	is_null?: boolean;
	lt?: OwnVal<F, K>;
	lte?: OwnVal<F, K>;
	gt?: OwnVal<F, K>;
	gte?: OwnVal<F, K>;
	like?: string;
};
type ComputedSpec<F, C, Keys, Combined = F & C> = {
	[P in keyof C]: P extends Keys
		? `error: '${P & string}' is already a field`
		: C[P] extends { kind: infer K; expr: infer X }
			? KindOfExpr<X, Combined> extends infer R
				? // `unknown`, not the tree: a tree checked against itself was a full `Exact` walk that could refuse nothing
					R extends K
					? { kind: ComputedKind; scale?: number; expr: unknown }
					: {
							kind: ComputedKind;
							scale?: number;
							expr: R extends Err ? R : `error: expr is ${R & string}, declared ${K & string}`;
						}
				: never
			: never;
};
type DeclaredFields<M> = M extends { fields: infer F } ? F : {};
type FieldsIn<M> = {
	[
		P in keyof DeclaredFields<M> as DeclaredFields<M>[P] extends { computed: unknown } ? never : P
	]: DeclaredFields<M>[P];
};
type ComputedIn<M> = {
	[
		P in keyof DeclaredFields<M> as DeclaredFields<M>[P] extends { computed: unknown } ? P : never
	]: DeclaredFields<M>[P] extends { kind: infer K; computed: infer X }
		? { kind: K; expr: X } & (DeclaredFields<M>[P] extends { scale: infer S } ? { scale: S } : {})
		: never;
};
type ComputedFields<F, C, Keys, Rules = ComputedSpec<F, C, Keys>> = {
	[P in keyof Rules]: Rules[P] extends { expr: infer X }
		? Omit<Rules[P], 'expr'> & { computed: X }
		: Rules[P];
};
/** The literal's stored fields without its refs: what kinds, defaults and own-row predicates are checked against. */
type OwnFields<F> = {
	[
		P in keyof F as F[P] extends { kind: 'ref'; many: true }
			? P
			: F[P] extends { kind: 'ref' }
				? never
				: P
	]: F[P];
};

// ── ref fields ──
type GrantKey = 'outputs' | 'create' | 'update' | 'delete';
// A second inverse of one name on one target is `Verify`'s (`DuplicateInverse`): a pairwise check here cost O(n²).
type InverseSpec<I, T> = I extends GrantKey
	? `error: inverse '${I}' is a grant key`
	: T extends TargetName
		? I extends ColumnName<T>
			? `error: inverse '${I & string}' is already a field of ${T & string}`
			: I extends keyof OneRels<T>
				? `error: inverse '${I & string}' is already a ref of ${T & string}`
				: string
		: string;
interface RefFor<R, T = TargetsOf<R>> {
	many?: true;
	min_items?: number;
	max_items?: number;
	kind: 'ref';
	to: TargetName | readonly [TargetName, TargetName, ...TargetName[]];
	inverse?: R extends { inverse: infer I } ? InverseSpec<I, T> : string;
	optional?: true;
	owned?: true;
	default?: {
		var: [T] extends ['sys_user'] ? 'requestor.id' | 'requestor.party' : 'requestor.party';
	};
	// `owned` implies cascade; `set_null` needs an optional ref (rule 4)
	on_delete?: R extends { owned: true }
		? 'cascade'
		: R extends { optional: true }
			? 'restrict' | 'cascade' | 'set_null'
			: 'restrict' | 'cascade';
	// an FK to an instance is pinned to one definition, and then holds that definition's `InstanceId`
	where?: [T] extends ['sys_integration']
		? { integration: { eq: IntegrationName } }
		: [T] extends [TargetName]
			? StaticWhere<T, false>
			: never;
}
/**
 * A `ref` field: a foreign key on this model pointing `to` another model (or, as a tuple, to one of several: a polymorphic
 * arc), optionally named back from the target as the many-relation `inverse`. A many-to-many is a model with two refs.
 */
export type RefField = {
	many?: true;
	min_items?: number;
	max_items?: number;
	kind: 'ref';
	/** The target model, or two or more for an arc (the value is then a `RecordRef`). */
	to: string | readonly string[];
	/** The many-relation on the target that lists this model's rows (`customer.orders`). */
	inverse?: string;
	optional?: true;
	/** Composition: the child is written through its parent's write layers and deleted with it; its key never changes (rule 41). */
	owned?: true;
	/** What deleting the target does: refuse (`restrict`, default), delete this row (`cascade`), or clear the ref (`set_null`). */
	on_delete?: 'restrict' | 'cascade' | 'set_null';
	/** Which target rows the ref may name: a static predicate over the target's own fields (`{ integration: { eq } }` for an instance). */
	where?: object;
	/** Filled from the writer when omitted: their member id (`sys_user` refs) or their party. */
	default?: { var: 'requestor.id' | 'requestor.party' };
};

// ── exposure: what callers read and send, as layer maps ──
/**
 * Layer maps (decision 1): a flat object keyed by path in the read or write tree. `'<model>'` is the root layer,
 * `'<model>.<rel>'` a layer under it, one relation (a ref, an inverse many-relation or an owned child) per segment, at most
 * `LAYER_MAX_DEPTH` segments. A layer's parent path is declared too. The literal types the root's own fields; a deeper
 * layer's names are proved by `bolt check` (`model/layer`), which resolves each path to the model behind it.
 */
export const LAYER_MAX_DEPTH = 5;
type Writable<F> = {
	[P in keyof F]: F[P] extends { kind: 'seq' | 'sum' | 'count' } ? never : P;
}[keyof F] &
	string;
type OwnedRef<F> = OfKind<F, { kind: 'ref'; owned: true }>;
type Exposed<S, X> = S extends { outputs: { default: unknown } }
	? X
	: 'error: a model without outputs.default is not exposed: declare it first';
/** One `attaches` target: an optional ref of another model that points back at this model. */
type AttachTarget<K> = {
	[M in TargetName]: {
		[F in keyof OneRels<M>]: OneRels<M>[F] extends { optional: true }
			? K extends TargetsOf<OneRels<M>[F]>
				? { readonly model: M; readonly field: F }
				: never
			: never;
	}[keyof OneRels<M>];
}[TargetName];
/** The literal's layer paths below its root `K`. */
type Below<K, L> = { [P in keyof L]: P extends `${K & string}.${string}` ? P : never }[keyof L];
/** A layer map over the literal `L`: the root `K` takes `Root`, each deeper path `Deep`; any other key is refused. */
type Layers<K, L, Root, Deep> = { [P in K & string]: Root } & { [P in Below<K, L>]: Deep };
type LayersOf<S, V extends string, X extends string> = S extends { [P in V]: { [Q in X]: infer L } }
	? L
	: {};
interface CreateFor<K, S, F> {
	/** The columns a writer sends, per layer: the root's own, and each child layer's (a many-relation's rows). */
	columns: Layers<K, LayersOf<S, 'create', 'columns'>, readonly Writable<F>[], readonly string[]>;
	/** Columns the `transform` fills when the writer omits them, per layer. */
	filled?: Partial<
		Layers<K, LayersOf<S, 'create', 'filled'>, readonly Writable<F>[], readonly string[]>
	>;
	transform?: unknown;
}
interface UpdateFor<K, S, F> {
	/** The columns a writer changes, per layer; a child layer's rows are created, updated, deleted, linked or unlinked. */
	columns: Layers<
		K,
		LayersOf<S, 'update', 'columns'>,
		readonly Exclude<Writable<F>, OwnedRef<F>>[],
		readonly string[]
	>;
	transform?: unknown;
}
type OutputFields<Field extends string = string> = 'all' | readonly Field[];
/** A model output names its fields, then one nested output per related model. */
type ReadOutput = {
	readonly fields: OutputFields;
	readonly [relation: string]: OutputFields | ReadOutput;
};
type OutputFor<L, Field extends string> = { readonly fields: OutputFields<Field> } & {
	readonly [R in Exclude<keyof L, 'fields'>]: OutputFor<L[R], string>;
};
type OutputsFor<O, F, C> = {
	readonly [N in keyof O]: OutputFor<O[N], (keyof F | keyof C) & string>;
};
type Part<S, K extends string> = S extends { [P in K]: infer V } ? V : {};

const ConstraintData = /* @__PURE__ */ (() => {
	const where = Schema.Record(Schema.String, Schema.Json);
	const optionalWhere = Schema.optionalKey(where);
	const fields = Schema.Array(Schema.String);
	return Schema.Record(
		Schema.String,
		Schema.Union([
			Schema.Struct({ unique: Schema.NonEmptyArray(Schema.String), where: optionalWhere }),
			Schema.Struct({ check: where }),
			Schema.Struct({ no_overlap: Schema.String, per: fields, where: optionalWhere }),
			Schema.Struct({ locked: where, except: Schema.optionalKey(fields) })
		])
	);
})();
type Constraint = (typeof ConstraintData.Type)[string];
const decodeConstraints = /* @__PURE__ */ Schema.decodeUnknownSync(ConstraintData, {
	onExcessProperty: 'error'
});
type ConstraintFor<Rule, F, All> = Rule extends { unique: infer Columns }
	? { unique: ColRefs<F, Columns>; where?: OwnWhere<All> }
	: Rule extends { check: unknown }
		? { check: OwnWhere<All> }
		: Rule extends { no_overlap: string; per: infer Columns }
			? {
					no_overlap: OfKind<F, { kind: 'period' }>;
					per: ColRefs<F, Columns>;
					where?: OwnWhere<All>;
				}
			: { locked: OwnWhere<All>; except?: readonly string[] };

// ── search indexes ──
type InputPart<X> = X extends { input: unknown } ? ValidInputs<X['input']> : never;
type Candidates = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
type Metric = 'l2' | 'cosine' | 'ip';
type SemanticIndex = { fields: readonly string[]; model: EmbeddingModelName; dim: number };
type NativeIndex = {
	on: readonly (string | { lower: string })[];
	unique?: true;
	where?: object;
};
type CustomIndex = {
	description: string;
	dim: number;
	metric: Metric;
	vector: unknown;
	input: InputFields;
	probe: unknown;
	rerank?: unknown;
	candidates?: Candidates;
};
type IndexLiteral =
	NativeIndex | { text: readonly string[] } | { semantic: SemanticIndex } | CustomIndex;
type IndexedColumns<F, On> = {
	[I in keyof On]: On[I] extends { lower: unknown }
		? { lower: OfKind<F, { kind: 'text' }> }
		: ColRef<F, On[I]>;
};
type IndexesFor<F, X> = {
	[I in keyof X]: X[I] extends { on: infer On }
		? { on: IndexedColumns<F, On>; unique?: true; where?: OwnWhere<F> }
		: X[I] extends { text: unknown }
			? {
					text: readonly (
						| OfKind<F, { kind: 'text' | 'enum' } | { kind: 'seq'; pattern: string }>
						| OfKind<F, { kind: 'ref' }>
					)[];
				}
			: X[I] extends { semantic: unknown }
				? {
						semantic: {
							fields: readonly OfKind<F, { kind: 'text' | 'file' }>[];
							model: EmbeddingModelName;
							dim: number;
						};
					}
				: I extends 'semantic'
					? "error: 'semantic' is reserved for semantic search"
					: CustomIndexFor<F, X[I]>;
};
interface CustomIndexFor<F, X> {
	description: string;
	dim: number;
	metric: Metric;
	vector: X extends { vector: string } ? OfKind<F, { kind: 'vector' }> : unknown;
	input: InputPart<X>;
	probe: unknown;
	rerank?: unknown;
	candidates?: Candidates;
}

// ── syncs: the data (`read`, `write` and a custom `parse` are bodies, typed by name) ──
type Inputs<X, K extends string> = X extends { [P in K]: infer F } ? ValidInputs<F> : never;
type Parser =
	BuiltinParser | { type: MediaType; extensions: readonly `.${string}`[]; parse: unknown };
/**
 * One model sync. `with: 'file'` adds the native Import, Download template and Export toolbar actions from its
 * `parser`/`read`/`write`; a remote sync names an integration and runs on `every`. `context` is input, never authority;
 * only returned source fields change. Declared here, run by `ctx.sync` or the sync's schedule, never by a page script.
 */
interface SyncFor<X> {
	with: 'file' | IntegrationName;
	parser?: readonly Parser[];
	schema?: Inputs<X, 'schema'>;
	context?: Inputs<X, 'context'>;
	every?: Duration;
	partitions?: string;
	read?: unknown;
	write?: unknown;
}

interface ModelFor<
	K,
	S,
	F = FieldsIn<S>,
	C = ComputedIn<S>,
	Own = OwnFields<F>,
	CK = { [P in keyof C]: { kind: C[P] extends { kind: infer X } ? X : never } },
	All = Own & CK,
	ReservedKeys = ReservedIn<S>
> {
	description: string;
	was?: string;
	icon?: IconName;
	/** Optional pure CEL identifier over `record`; shared by record views, live approval references and automatic text search. */
	record_label?: string;
	fields: {
		[P in keyof F]: P extends ReservedKeys
			? `error: '${P & string}' is a system column`
			: F[P] extends { kind: 'ref' }
				? RefFor<F[P]>
				: ValidField<F[P], Own>;
	} & ComputedFields<Own, C, keyof F | SystemColumn>;
	key?: S extends { key: infer L } ? ColRefs<F & CK, L> : never;
	constraints?: {
		[R in keyof Part<S, 'constraints'>]: ConstraintFor<Part<S, 'constraints'>[R], F & CK, All>;
	};
	indexes?: IndexesFor<F & CK, Part<S, 'indexes'>>;
	table?: {
		primary: 'text' | 'uuid' | 'identity' | { field: keyof Own & string };
		identity?: OfKind<Own, { kind: 'int' }>;
	};
	outputs?: OutputsFor<Part<S, 'outputs'>, F, C>;
	create?: Exposed<S, CreateFor<K, S, F>>;
	update?: Exposed<S, UpdateFor<K, S, F>>;
	/** Create-payload layers that set an existing row's optional ref to the new row, in the same commit. */
	attaches?: Exposed<S, { readonly [A in keyof Part<S, 'attaches'>]: AttachTarget<K> }>;
	delete?: Exposed<S, { check?: unknown }>;
	notify?: Exposed<S, unknown>;
	effect?: Exposed<S, { created?: unknown; updated?: unknown; deleted?: unknown }>;
	syncs?: Exposed<S, { [N in keyof Part<S, 'syncs'>]: SyncFor<Part<S, 'syncs'>[N]> }>;
}

// ── bodies: typed from the generated names by the model's name, never from the literal ──
type IndexMetadata = Pick<CustomIndex, 'description' | 'dim' | 'metric' | 'input' | 'candidates'>;
interface IndexBodies<K, Q> extends IndexMetadata {
	/** Pure: the row's vector, `null` to leave it out of the index; or the name of a `vector` field an automation fills. */
	vector?: ((row: StoredRow<K>) => Vector | null) | string;
	/** Pure: the probe vector for a search input, and a `where` applied inside the index scan. */
	probe?: (input: Q) => { vector: Vector; where?: Where<K> };
	/** Pure: an exact score over the candidate page, ascending; `undefined` keeps index order. Runs as the platform: rows are stored, unmasked. */
	rerank?: (input: Q, row: StoredRow<K>) => number | undefined;
}
interface BodiesFor<K> {
	create?: {
		/**
		 * Runs for every row created in this model, by every path, before it is written: a page or Form, the agent, and
		 * `ctx.act` in an automation; a sync's `read` and a file import; an upsert's creates; and a child created
		 * through its parent's write layers, after the parent's own callback, in the same statement. One call per batch (up
		 * to 1,000 rows), never per row: each row carries the `id` it will have; returns the rows to insert with derived
		 * values filled, or refuses. It may instead return `{ rows, with, onApproved }`, carrying rows of other models in the
		 * same commit (`Carried`). Seed packs (restored data) and derived roll-ups do not run it.
		 */
		transform?: (
			rows: readonly CreatedRow<K>[],
			ctx: WriteCtx<K>
		) => BodyReturn<TransformAnswer<CreateTransformRow<K>>>;
	};
	update?: {
		/**
		 * Runs for every row updated in this model, by every path, before it is written: a page or Form, the agent, and
		 * `ctx.act` in an automation; a sync's `read` and a file import; an upsert's updates; a bulk edit; an
		 * approval resubmit (the requester's save) and a per-record restore; a link or unlink of a child (an update of that
		 * child); and a child updated through its parent's write layers, after the parent's own callback. Receives `{ before, set }`
		 * per row (the stored row and the change) and returns the sets to write, in order, or refuses. Seed packs and
		 * derived roll-ups do not run it; nor does an upsert that keeps a matched row (`on_conflict: 'keep'`).
		 */
		transform?: (
			changes: readonly { readonly before: StoredRow<K>; readonly set: UpdateTransformSet<K> }[],
			ctx: WriteCtx<K>
		) => BodyReturn<TransformAnswer<UpdateTransformSet<K>>>;
	};
	delete?: {
		/**
		 * Runs before every row of this model is deleted, by every path: a page, the agent, and `ctx.act` in an automation;
		 * a sync's `read` and a file import's prune; and a child deleted through its parent's write layers. Receives
		 * the stored rows and may refuse, or return `{ with, onApproved }` rows of other models that commit with the delete.
		 * Seed packs and derived roll-ups do not run it.
		 */
		check?: (rows: readonly StoredRow<K>[], ctx: WriteCtx<K>) => BodyReturn<void | Carried>;
	};
	/**
	 * Runs after the commit for every write and approval event of this model (the event says which) and returns the notices
	 * to send: who (`to`), what (`title`, `description`), how (`via` conversation connections; the inbox always), files.
	 * It reads as the workspace and does no I/O, so a notification never delays or fails a write.
	 */
	notify?: (event: NotifyEvent<K>, ctx: NotifyCtx) => BodyReturn<readonly Notice[]>;
	/**
	 * Runs after the commit, once per committed batch of each verb, as a durable run (`<model>.effect.<verb>`: queued,
	 * retried on a transient failure, shown in the Command center's runs). It holds no policy of its own: it runs with the
	 * writer's authority — the member, envoy, visitor, or automation run (its declared policies) whose write committed —
	 * and its rows are the root fields of the writer's output of the model (`default` when it holds it, else the first
	 * named output it holds). Writes it makes run effects in turn, at most 8 deep. Never rate limited. It also runs for a
	 * write an approval only holds, and again, as the approver, for the restore when that approval is rejected: nothing
	 * irreversible (a mail, a payment) belongs here unless it checks the row's state first.
	 */
	effect?: {
		/** The created rows. */
		created?: (rows: readonly Row<K>[], ctx: EffectCtx) => BodyReturn<void>;
		/** Each updated row before and after the write; only writes that change a stored field. */
		updated?: (
			changes: readonly { readonly before: Row<K>; readonly after: Row<K> }[],
			ctx: EffectCtx
		) => BodyReturn<void>;
		/** The deleted rows as they were stored. */
		deleted?: (rows: readonly Row<K>[], ctx: EffectCtx) => BodyReturn<void>;
	};
	indexes?: { [I in IndexName<K>]?: IndexBodies<K, InputOf<IndexInput<K, I>>> };
	syncs?: { [Sy in SyncName<K>]?: FileSync<K, Sy> | RemoteSync<K, Sy> };
}

// ── the general literal, and the engine's parts ──
/** A read layer map as the engine holds it: per path, the fields the layer exposes (`'all'`: every field). */
export type ReadLayers = CatalogExposure['outputs']['default'];
/** A write layer map as the engine holds it: per path, the columns a writer may send. */
export type LayerColumns = { readonly [path: string]: readonly string[] };
/** A model literal as `model()` takes it in general: bodies are functions, or the `true` the check serializer writes. */
export type ModelLiteral = {
	/** What a record is, for people and the agent. */
	description: string;
	/** The previous model name: a schema migration renames its table instead of replacing it. */
	was?: string;
	/** The model's icon (an Iconify name). */
	icon?: IconName;
	/** Optional CEL over `record` returning its human-readable identifier, e.g. `record.code + ' · ' + record.name`.
	 * Reused implicitly by RecordShell titles, table/list titles, pickers, references and scoped search results.
	 * The engine materializes it as generated text and includes it in the model's GIN text index automatically;
	 * `search.text` adds other searchable fields. It recalculates on writes, including sequence and computed values.
	 * Approval requests search and display it through their existing target reference, without copying the value. Use own stored/computed fields
	 * or nested inline values; cross-record lookups, clocks and authority are excluded so the index remains correct.
	 * Use conditionals for optional fields. Explicit authored title/cell overrides still win.
	 * If omitted, consumers use the record id (UUID); text search still needs explicit `search.text`.
	 */
	record_label?: string;

	/** The stored fields, `ref` fields included. Every row also carries the system columns (see `ModelSpec.fields`). */
	fields: {
		readonly [name: string]: Exclude<FieldKind, { kind: 'ref' }> | RefField | ComputedField;
	};
	key?: readonly string[];
	/** Named unique, check, period exclusion and write-lock rules. */
	constraints?: Readonly<Record<string, Constraint>>;
	/** Named physical, text, semantic and custom-vector indexes. */
	indexes?: Readonly<Record<string, IndexLiteral>>;
	table?: TableSpec;
	/** A default read output and optional named outputs. A policy grants an output and scopes its rows. */
	outputs?: { readonly default: ReadOutput; readonly [output: string]: ReadOutput };
	/** The generated `create`: per layer the columns a writer sends and those its `transform` fills (`filled`). */
	create?: { columns: LayerColumns; filled?: LayerColumns; transform?: unknown };
	/** The generated `update`: per layer the columns a writer changes, and its `transform`. */
	update?: { columns: LayerColumns; transform?: unknown };
	/** The generated `delete`, with an optional `check`. */
	delete?: { check?: unknown };
	/**
	 * Write-only attach layers: the parent's create payload names existing rows of another model by id, and the engine sets
	 * the named foreign key in the same commit. Each row's ref must be optional and still empty, or the write is refused.
	 * No inverse is declared on the child model and no read layer is exposed.
	 */
	attaches?: {
		readonly [layer: string]: { readonly model: string; readonly field: string };
	};
	/** The notices each write and approval event sends. */
	notify?: unknown;
	/** The work after each committed write, as the writer: `function* (rows, ctx)`, its parameters typed by the model, `updated` taking `{ before, after }` changes; `t.runDue()` runs it in a test. */
	effect?: { created?: unknown; updated?: unknown; deleted?: unknown };
	/** How rows are exchanged with a file or another system: `read` brings rows in, `write` sends changes out. */
	syncs?: {
		readonly [sync: string]: {
			with: string;
			parser?: readonly (
				string | { type: string; extensions: readonly string[]; parse: unknown }
			)[];
			schema?: InputFields;
			context?: InputFields;
			every?: string;
			partitions?: string;
			read?: unknown;
			write?: unknown;
		};
	};
};

/**
 * A system table's physical row: the built-in layer's models only (`src/system/**`; a workspace model that sets it is
 * refused, `load/system-only`). Its primary key, a database-numbered field, and the indexes the model options cannot state
 * (a lowercased column, a plain partial index). A system row carries no engine columns beyond its key: `revision`,
 * `created_at` and the like are its own fields, and its uniques are plain (an `on conflict` arbiter), not deferrable.
 */
export type TableSpec = {
	/** An `id` column of this type (`identity`: a bigint the database numbers), or the field that is the key. */
	primary: 'text' | 'uuid' | 'identity' | { field: string };
	/** An `int` field the database numbers (`bigint generated by default as identity`): a transcript's order. */
	identity?: string;
};
/**
 * One custom search index as the engine keeps it: a hidden vector column (`dim`, `metric`) with an HNSW index, filled by
 * the guest's `vector` on every committed write, or read from the `vector` field `field`; `input` is the probe's form,
 * `candidates` the page multiple `rerank` (when `rerank`) re-scores.
 */
export type SearchIndexSpec = {
	description: string;
	dim: number;
	metric: Metric;
	field?: string;
	input: InputFields;
	candidates?: Candidates;
	rerank?: true;
};
/** A model's storage as the engine's `models` part holds it: no refs (they are `relationships`), no bodies. */
export type ModelSpec = {
	/** What a record is, for people and the agent. */
	description: string;
	/** The previous model name: a schema migration renames its table instead of replacing it. */
	was?: string;
	/** The model's icon (an Iconify name). */
	icon?: IconName;
	/** Optional pure CEL identifier over `record`, shared by clients and live approval references; automatically indexed when declared. */
	record_label?: string;

	/**
	 * The stored fields. Every row also carries the system columns `id revision created_at created_by
	 * updated_at updated_by`, which are not field names: `revision` is the row version every update checks (rule 25), so a
	 * document's own revision mark is a field such as `document_revision` (`bolt check`: `load/reserved-field`).
	 */
	fields: { readonly [name: string]: FieldKind };
	/** The natural key (never null): what imports match rows by. Upsert matches by `id`. */
	key?: readonly string[];
	/** Unique field sets, optionally partial (`where`). */
	unique?: readonly { fields: readonly string[]; where?: object; name?: string }[];
	/** Physical indexes lowered from the named author declarations. */
	indexes?: readonly NativeIndex[];
	/** Named row checks: a `Where` every row must match. */
	check?: { readonly [name: string]: object };
	/** Matching rows cannot be deleted. Updates may change only fields excepted by every matching rule. */
	locks?: Readonly<
		Record<string, { where: Readonly<Record<string, Json>>; except?: readonly string[] }>
	>;
	/** Rows with equal `key` fields may not have overlapping `period`s. */
	noOverlap?: readonly { key: readonly string[]; period: string; where?: object; name?: string }[];
	/** Computed fields: an expression over the row's own fields, stored and kept current. */
	computed?: { readonly [name: string]: { kind: ComputedKind; scale?: number; expr: Expr } };
	/** Text search over `text` fields, semantic (embedding) search over `semantic.fields`, and custom `indexes`. */
	search?: {
		text: readonly string[];
		semantic?: {
			fields: readonly string[];
			model: EmbeddingModelName;
			/** The embedding column's width: the model class is asked for exactly this many numbers, stored or probed. Required — a
			 * workspace states it, so the host's binding is a conformance question, not a guess bolt makes for it. */
			dim: number;
		};
		indexes?: { readonly [index: string]: SearchIndexSpec };
	};
	/** A system table's physical row (the built-in layer only). */
	table?: TableSpec;
};
/**
 * A sync as the engine reads it: `with` a file or an integration, its parsers (a custom one by media type and
 * extensions), the sheet's `schema` and page `context`, the read cadence and partition key, and which bodies exist.
 */
export type SyncEntry = {
	with: string;
	parser?: readonly (string | { type: string; extensions: readonly string[] })[];
	schema?: InputFields;
	context?: InputFields;
	every?: string;
	partitions?: string;
	read?: true;
	write?: true;
};
/**
 * A model's exposure as the engine's `exposures` part holds it: its outputs (each root key is the model), the
 * `create`/`update` column layers, `delete` and syncs; `true` marks a body the model declares (`transform`, `check`,
 * `notify`, an `effect` verb), which runs in the guest. Each path's model is `layerModels`'.
 */
export type ExposureSpec = CatalogExposure & {
	create?: {
		columns: LayerColumns;
		filled?: LayerColumns;
		transform?: true;
		/** Write-only layers the create payload may attach by id, setting the target's named ref to the new row. */
		attaches?: { readonly [layer: string]: { readonly model: string; readonly field: string } };
	};
	update?: { columns: LayerColumns; transform?: true };
	delete?: { check?: true };
	notify?: true;
	effect?: { created?: true; updated?: true; deleted?: true };
	syncs?: { readonly [sync: string]: SyncEntry };
};

/** The bodies of one model as the guest calls them by path (`model.<model>.bodies.…`). */
export type ModelBodies = {
	readonly create?: Body;
	readonly update?: Body;
	readonly delete?: Body;
	readonly notify?: Body;
	readonly effect: { readonly created?: Body; readonly updated?: Body; readonly deleted?: Body };
	readonly indexes: {
		readonly [index: string]: {
			readonly vector?: Body;
			readonly probe?: Body;
			readonly rerank?: Body;
		};
	};
	readonly syncs: {
		readonly [sync: string]: {
			readonly read?: Body;
			readonly write?: Body;
			readonly parse: { readonly [type: string]: Body };
		};
	};
};
/** What `model()` returns: its name, the literal, and the bodies the guest calls. */
export type Model<K extends string, S> = {
	readonly name: K;
	readonly spec: S;
	readonly bodies: ModelBodies;
};

const isBody = (x: unknown): x is Body => typeof x === 'function';
/** A ctx-bearing body (its ctx the second argument) through the guest edge. */
const guest = (x: unknown): Body | undefined => (isBody(x) ? attached(x, 1) : undefined);
const mapValues = <V, R>(
	o: { readonly [key: string]: V },
	f: (value: V) => R
): { [key: string]: R } => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

/** The verbs a model `effect` declares, in their run names' order (`<model>.effect.<verb>`). */
export const EFFECT_VERBS = ['created', 'updated', 'deleted'] as const;
function bodiesOf(m: ModelLiteral): ModelBodies {
	const create = guest(m.create?.transform),
		update = guest(m.update?.transform),
		check = guest(m.delete?.check),
		notify = guest(m.notify);
	return {
		...(create === undefined ? {} : { create }),
		...(update === undefined ? {} : { update }),
		...(check === undefined ? {} : { delete: check }),
		...(notify === undefined ? {} : { notify }),
		effect: Object.fromEntries(
			EFFECT_VERBS.flatMap((verb) => {
				const body = guest(m.effect?.[verb]);
				return body === undefined ? [] : [[verb, body]];
			})
		),
		// pure: stored as authored, called without a ctx
		indexes: Object.fromEntries(
			Object.entries(m.indexes ?? {}).flatMap(([name, x]) =>
				'vector' in x
					? [
							[
								name,
								{
									...(isBody(x.vector) ? { vector: x.vector } : {}),
									...(isBody(x.probe) ? { probe: x.probe } : {}),
									...(isBody(x.rerank) ? { rerank: x.rerank } : {})
								}
							]
						]
					: []
			)
		),
		syncs: mapValues(m.syncs ?? {}, (x) => {
			const read = guest(x.read),
				write = guest(x.write);
			return {
				...(read === undefined ? {} : { read }),
				...(write === undefined ? {} : { write }),
				parse: Object.fromEntries(
					(x.parser ?? []).flatMap((p): [string, Body][] => {
						if (typeof p === 'string') return [];
						const body = guest(p.parse);
						return body === undefined ? [] : [[p.type, body]];
					})
				)
			};
		})
	};
}

/**
 * `src/data/model/<name>/+model.ts`: one entity. Its storage (`fields`, `ref` fields that relate it to other models, keys,
 * checks, computed fields, `search`), its exposure (`outputs`; `create`, `update` and `delete` with their column
 * layers and write callbacks), `notify`, `effect` and `syncs`. Every callback sits on what triggers it, inside the literal, and is
 * typed from the generated names by `name` (`bolt sync`; `bolt check` refuses a name that is not the folder's): until the
 * next sync a body does not see a field just added. Returns the name, the literal and the bodies.
 * Declaring an exposure makes the operation available; policies still decide which callers and rows may use it.
 * Native surfaces derive from this one declaration: `Table` and `Form` render the permitted columns and defaults, a
 * declared file sync adds Import/Export/Template to the toolbar, record history is automatic, `notify` receives every
 * write and approval event, and a policy check returning `ctx.approve` holds the write for its flow. Pages and agents
 * must not wire those again.
 * @param name The model folder's name, also used by generated row and write types.
 * @param spec Storage, read outputs, guarded write layers and their callbacks; omit operations the model must not expose.
 * @returns Declaration metadata and attached callback bodies. Calling model does not read or write records.
 * @example
 * export default model('orders', {
 * 	description: 'Customer orders.',
 * 	record_label: 'record.number',
 * 	fields: {
 * 		number: { kind: 'seq', pattern: 'SO-{yyyy}-{0000}' },
 * 		customer: { kind: 'ref', to: 'customers', inverse: 'orders' },
 * 		notes: { kind: 'text', optional: true }
 * 	},
 * 	outputs: { default: { fields: 'all', customer: { fields: ['name'] } } },
 * 	create: {
 * 		columns: { orders: ['customer', 'notes'] },
 * 		transform: function* (rows, ctx) {
 * 			const { customers } = yield* ctx.query({ customers: { where: { id: { in: rows.map((r) => r.customer) } }, fields: ['id', 'blocked'], all: true } });
 * 			const blocked = new Set(customers.rows.filter((c) => c.blocked).map((c) => c.id));
 * 			const at = rows.findIndex((r) => blocked.has(r.customer));
 * 			if (at >= 0) return yield* ctx.refuse('This customer is blocked.', { field: 'customer', row: at });
 * 			return rows;
 * 		}
 * 	}
 * });
 */
/* @__NO_SIDE_EFFECTS__ */
export function model<const K extends string, const S extends ModelLiteral>(
	name: K,
	spec: S & NoInfer<Checked<ModelLiteral, S, Exact<S, ModelFor<K, S>>>> & NoInfer<BodiesFor<K>>
): Model<K, S> {
	return { name, spec, bodies: bodiesOf(spec) };
}

/** The engine's three manifest parts of one model literal (`projectManifest` and the names generator both read it). */
export type ModelParts = {
	readonly model: ModelSpec;
	/** Each ref field, keyed `'<model>.<field>'`. */
	readonly relationships: { readonly [key: string]: RelationshipSpec };
	/** The exposure; absent when the model declares no `read`. */
	readonly exposure?: ExposureSpec;
};
/**
 * Splits a model literal into storage (`ModelSpec`, refs removed), its refs (`RelationshipSpec` by `'<name>.<field>'`) and,
 * when it declares `outputs.default`, its exposure (`ExposureSpec`). Output trees become native read paths and
 * a body (a function or the check serializer's `true`) becomes its marker.
 */
export function splitModel(name: string, literal: ModelLiteral): ModelParts {
	if (Object.hasOwn(literal, 'label')) throw new Error("model '" + name + "': use record_label");
	if (Object.hasOwn(literal, 'computed'))
		throw new Error("model '" + name + "': declare computed on its field");
	if (
		Object.hasOwn(literal, 'index') ||
		Object.hasOwn(literal, 'search') ||
		Object.hasOwn(literal.table ?? {}, 'indexes')
	)
		throw new Error("model '" + name + "': declare named indexes");
	for (const key of ['unique', 'check', 'noOverlap', 'locked'])
		if (Object.hasOwn(literal, key))
			throw new Error(`model '${name}': declare '${key}' in constraints`);
	const {
		fields,
		constraints,
		indexes,
		outputs,
		create,
		update,
		delete: del,
		attaches,
		notify,
		effect,
		syncs,
		...storage
	} = literal;
	const own: { [field: string]: FieldKind } = {};
	const computed: Record<string, NonNullable<ModelSpec['computed']>[string]> = {};
	const relationships: { [key: string]: RelationshipSpec } = {};
	for (const [field, kind] of Object.entries(fields)) {
		if ('computed' in kind)
			computed[field] = {
				kind: kind.kind,
				expr: kind.computed,
				...(kind.scale === undefined ? {} : { scale: kind.scale })
			};
		else if (kind.kind !== 'ref') own[field] = kind;
		else if (kind.many === true) {
			const { on_delete, owned, inverse, where, ...value } = kind;
			if (on_delete !== undefined || owned === true || inverse !== undefined)
				throw new Error(`'${name}.${field}': many references are inline values`);
			own[field] = {
				...value,
				...(where === undefined
					? {}
					: { where: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(where) })
			};
		} else {
			if (Object.hasOwn(kind, 'onDelete')) throw new Error(`'${name}.${field}' uses on_delete`);
			const { kind: _ref, on_delete, ...relationship } = kind;
			relationships[`${name}.${field}`] = {
				...relationship,
				...(on_delete === undefined
					? {}
					: { onDelete: on_delete === 'set_null' ? 'setNull' : on_delete })
			};
		}
	}
	const rules: Pick<ModelSpec, 'unique' | 'check' | 'noOverlap' | 'locks'> = {};
	if (constraints !== undefined) {
		const unique: NonNullable<ModelSpec['unique']>[number][] = [];
		const check: Record<string, object> = {};
		const noOverlap: NonNullable<ModelSpec['noOverlap']>[number][] = [];
		const locks: Record<string, NonNullable<ModelSpec['locks']>[string]> = {};
		for (const [rule, constraint] of Object.entries(decodeConstraints(constraints))) {
			if ('unique' in constraint) {
				const { unique: fields, where } = constraint;
				unique.push({ fields, name: rule, ...(where === undefined ? {} : { where }) });
			} else if ('check' in constraint) {
				check[rule] = constraint.check;
			} else if ('no_overlap' in constraint) {
				const { no_overlap: period, per: key, where } = constraint;
				noOverlap.push({ key, period, name: rule, ...(where === undefined ? {} : { where }) });
			} else {
				const { locked: where, except } = constraint;
				locks[rule] = { where, ...(except === undefined ? {} : { except }) };
			}
		}
		if (unique.length > 0) rules.unique = unique;
		if (Object.keys(check).length > 0) rules.check = check;
		if (noOverlap.length > 0) rules.noOverlap = noOverlap;
		if (Object.keys(locks).length > 0) rules.locks = locks;
	}
	const physical: NativeIndex[] = [];
	const text = new Set<string>();
	let semantic: SemanticIndex | undefined;
	const searches: Record<string, SearchIndexSpec> = {};
	for (const [index, entry] of Object.entries(indexes ?? {})) {
		if ('on' in entry) physical.push(entry);
		else if ('text' in entry) for (const field of entry.text) text.add(field);
		else if ('semantic' in entry) {
			if (semantic !== undefined) throw new Error(name + ': declare one semantic index');
			semantic = entry.semantic;
		} else {
			if (index === 'semantic')
				throw new Error(name + ": 'semantic' is reserved for semantic search");
			searches[index] = {
				description: entry.description,
				dim: entry.dim,
				metric: entry.metric,
				input: entry.input,
				...(typeof entry.vector === 'string' ? { field: entry.vector } : {}),
				...(entry.candidates === undefined ? {} : { candidates: entry.candidates }),
				...(entry.rerank === undefined ? {} : { rerank: true })
			};
		}
	}
	const stored: ModelSpec = {
		...storage,
		...rules,
		fields: own,
		...(Object.keys(computed).length === 0 ? {} : { computed }),
		...(physical.length === 0 ? {} : { indexes: physical }),
		...(text.size === 0 && semantic === undefined && Object.keys(searches).length === 0
			? {}
			: {
					search: {
						text: [...text],
						...(semantic === undefined ? {} : { semantic }),
						...(Object.keys(searches).length === 0 ? {} : { indexes: searches })
					}
				})
	};
	if (outputs === undefined) return { model: stored, relationships };
	const { default: defaultOutput, ...named } = outputs;
	const layersOf = (output: ReadOutput): ReadLayers => {
		const layers: Record<string, { fields: OutputFields }> = {};
		const add = (path: string, layer: ReadOutput) => {
			if (
				typeof layer !== 'object' ||
				layer === null ||
				(layer.fields !== 'all' &&
					(!Array.isArray(layer.fields) || !layer.fields.every((f) => typeof f === 'string')))
			)
				throw new Error(`'${path}' must list its output fields or declare fields: 'all'`);
			layers[path] = { fields: layer.fields };
			for (const [relation, child] of Object.entries(layer)) {
				if (relation === 'fields') continue;
				if (
					typeof child !== 'object' ||
					child === null ||
					!('fields' in child) ||
					relation.includes('.')
				)
					throw new Error(`'${path}.${relation}' must be a nested output with fields`);
				add(`${path}.${relation}`, child);
			}
		};
		add(name, output);
		return layers;
	};
	const exposure: ExposureSpec = {
		outputs: { default: layersOf(defaultOutput), ...mapValues(named, layersOf) },
		...(create === undefined
			? {}
			: {
					create: {
						columns: create.columns,
						...(create.filled === undefined ? {} : { filled: create.filled }),
						...(create.transform === undefined ? {} : { transform: true }),
						...(attaches === undefined ? {} : { attaches })
					}
				}),
		...(update === undefined
			? {}
			: {
					update: {
						columns: update.columns,
						...(update.transform === undefined ? {} : { transform: true })
					}
				}),
		...(del === undefined ? {} : { delete: del.check === undefined ? {} : { check: true } }),
		...(notify === undefined ? {} : { notify: true }),
		...(effect === undefined
			? {}
			: {
					effect: Object.fromEntries(
						EFFECT_VERBS.flatMap((verb) =>
							effect[verb] === undefined ? [] : [[verb, true] as const]
						)
					)
				}),
		...(syncs === undefined
			? {}
			: {
					syncs: mapValues(syncs, (x): SyncEntry => ({
						with: x.with,
						...(x.parser === undefined
							? {}
							: {
									parser: x.parser.map((p) =>
										typeof p === 'string' ? p : { type: p.type, extensions: p.extensions }
									)
								}),
						...(x.schema === undefined ? {} : { schema: x.schema }),
						...(x.context === undefined ? {} : { context: x.context }),
						...(x.every === undefined ? {} : { every: x.every }),
						...(x.partitions === undefined ? {} : { partitions: x.partitions }),
						...(x.read === undefined ? {} : { read: true }),
						...(x.write === undefined ? {} : { write: true })
					}))
				})
	};
	return { model: stored, relationships, exposure };
}

/**
 * The model behind each path `root`'s exposure declares (the root itself included), and what is wrong with the others:
 * a path that does not start at the root, is deeper than `LAYER_MAX_DEPTH`, lacks its parent in the same map, crosses an
 * arc (a ref to several models) or names no relation; a write layer must be a many-relation (its rows' parent is the
 * layer above). `relationships` holds every ref field (`'<model>.<field>'`), the built-in layer's included.
 */
export function layerModels(
	root: string,
	c: ExposureSpec,
	relationships: { readonly [key: string]: RelationshipSpec }
): { readonly models: { readonly [path: string]: string }; readonly errors: readonly string[] } {
	const models: { [path: string]: string } = { [root]: root },
		errors: string[] = [];
	const step = (from: string, rel: string): { model: string; many: boolean } | string => {
		const one = relationships[`${from}.${rel}`];
		if (one !== undefined)
			return typeof one.to === 'string'
				? { model: one.to, many: false }
				: `'${rel}' is an arc (a ref to several models) and cannot be a layer`;
		const back = Object.entries(relationships).find(
			([, r]) =>
				r.inverse === rel && (typeof r.to === 'string' ? r.to === from : r.to.includes(from))
		);
		return back === undefined
			? `'${rel}' is no relation of ${from}`
			: { model: back[0].slice(0, back[0].indexOf('.')), many: true };
	};
	const maps: readonly (readonly [
		string,
		{ readonly [path: string]: unknown } | undefined,
		boolean
	])[] = [
		...Object.entries(c.outputs).map(
			([output, layers]) => [`outputs.${output}`, layers, false] as const
		),
		['create.columns', c.create?.columns, true],
		['create.filled', c.create?.filled, true],
		['update.columns', c.update?.columns, true]
	];
	for (const [where, map, write] of maps) {
		if (map === undefined) continue;
		if (!Object.hasOwn(map, root) && where !== 'create.filled')
			errors.push(`${where}: declare the root layer '${root}'`);
		// shortest first: a parent resolves before its children
		for (const path of Object.keys(map).sort((a, b) => a.split('.').length - b.split('.').length)) {
			const segments = path.split('.');
			if (segments[0] !== root) {
				errors.push(`${where}: '${path}' does not start at '${root}'`);
				continue;
			}
			if (segments.length > LAYER_MAX_DEPTH) {
				errors.push(`${where}: '${path}' is deeper than ${LAYER_MAX_DEPTH} levels`);
				continue;
			}
			if (segments.length === 1) continue;
			const parent = segments.slice(0, -1).join('.');
			const above = models[parent];
			if ((!Object.hasOwn(map, parent) && where !== 'create.filled') || above === undefined) {
				errors.push(`${where}: '${path}' needs its parent layer '${parent}'`);
				continue;
			}
			const next = step(above, segments.at(-1)!);
			if (typeof next === 'string') errors.push(`${where}: ${path}: ${next}`);
			else if (write && !next.many)
				errors.push(
					`${where}: '${path}' is a ref; a write layer is a many-relation (its child rows)`
				);
			else if (models[path] !== undefined && models[path] !== next.model)
				errors.push(`${where}: '${path}' resolves to ${next.model}, elsewhere to ${models[path]}`);
			else models[path] = next.model;
		}
	}
	return { models, errors };
}
