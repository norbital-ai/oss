// `model(name, spec)` (§1, §2): one entity in `src/data/model/<name>/+model.ts`: what it stores (fields, `ref` fields,
// keys, checks, computed fields, search), what callers see and send (`read`, `create`, `update`, `delete`), and its code
// (write callbacks, queries, search indexes, `notify`, syncs), every callback inside the literal. The data part is
// checked against the literal itself; each body is typed from the generated names by the model's `name`, never from the
// literal, so no type reads its own file. Cross-model names (an inverse, a roll-up, a FK in `label`) are checked by `Verify`.
// `splitModel` turns a literal into the engine's three manifest parts: storage, relationships, exposure.
import { attached, type AgentUse, type Body } from './body.ts';
import type {
	BodyReturn,
	CreateRow,
	In,
	NotifyCtx,
	NotifyEvent,
	QueryCtx,
	QuerySpecOf,
	QueryName,
	UpdateSet,
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
	ValidOutput,
	OutputKind,
	ValidInputs,
	ValueOf
} from './fields.ts';
import type {
	ColumnName,
	IndexInput,
	IndexName,
	IntegrationName,
	ManyRels,
	OneRels,
	OwnedFk,
	RelationshipSpec,
	Row,
	StoredRow,
	SyncName,
	TargetName,
	TargetsOf,
	WritableField
} from './names.ts';
import type { MediaType } from './media-types.ts';
import type { Notice } from './runtime/facilities.ts';
import type { EmbeddingModelName } from './runtime/names.ts';
import type { BuiltinParser, FileSync, RemoteSync } from './runtime/sync.ts';
import type { Duration, IconName, Json, Msg, Vector } from './values.ts';
import type { StaticWhere, Where } from './where.ts';

/** The kinds a computed field's expression may produce. */
export type ComputedKind = 'text' | 'int' | 'decimal' | 'money' | 'bool' | 'date' | 'instant';
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
	isNull?: boolean;
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
type FieldsIn<M> = M extends { fields: unknown } ? M['fields'] : {};
type ComputedIn<M> = M extends { computed: unknown } ? M['computed'] : {};
/** The literal's stored fields without its refs: what kinds, defaults and own-row predicates are checked against. */
type OwnFields<F> = { [P in keyof F as F[P] extends { kind: 'ref' } ? never : P]: F[P] };

// ── ref fields ──
type GrantKey = 'read' | 'history' | 'create' | 'update' | 'delete' | 'queries' | 'moves' | 'via';
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
	kind: 'ref';
	to: TargetName | readonly [TargetName, TargetName, ...TargetName[]];
	inverse?: R extends { inverse: infer I } ? InverseSpec<I, T> : string;
	optional?: true;
	owned?: true;
	default?: { actor: [T] extends ['sys_user'] ? 'id' | 'party' : 'party' };
	// `owned` implies cascade; `setNull` needs an optional ref (rule 4)
	onDelete?: R extends { owned: true }
		? 'cascade'
		: R extends { optional: true }
			? 'restrict' | 'cascade' | 'setNull'
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
	kind: 'ref';
	/** The target model, or two or more for an arc (the value is then a `RecordRef`). */
	to: string | readonly string[];
	/** The many-relation on the target that lists this model's rows (`customer.orders`). */
	inverse?: string;
	optional?: true;
	/** Composition: the child is written through its parent's `with` and deleted with it; its key never changes (rule 41). */
	owned?: true;
	/** What deleting the target does: refuse (`restrict`, default), delete this row (`cascade`), or clear the ref (`setNull`). */
	onDelete?: 'restrict' | 'cascade' | 'setNull';
	/** Which target rows the ref may name: a static predicate over the target's own fields (`{ integration: { eq } }` for an instance). */
	where?: object;
	/** Filled from the writer when omitted: their member id (`sys_user` refs) or their party. */
	default?: { actor: 'id' | 'party' };
};

// ── exposure: what callers read and send ──
type Writable<F> = {
	[P in keyof F]: F[P] extends { kind: 'seq' | 'sum' | 'count' } ? never : P;
}[keyof F] &
	string;
type OwnedRef<F> = OfKind<F, { kind: 'ref'; owned: true }>;
type RefNames<F> = OfKind<F, { kind: 'ref' }>;
type Exposed<S, X> = S extends { read: unknown }
	? X
	: 'error: a model without read is not exposed: declare read first';
/** The relation actions a create or update allows per many-relation, each child's columns its own `Selection`. */
type With<M> = {
	[R in keyof ManyRels<M>]?: {
		create?: Selection<ManyRels<M>[R]>;
		update?: Selection<ManyRels<M>[R], 'update'>;
		upsert?: Selection<ManyRels<M>[R]>;
		link?: {};
		unlink?: {};
		delete?: {};
	};
};
/**
 * A nested child's allowlist under its parent's `with`: its writable columns (an update never lists an owned child's
 * parent key, rule 41), what its create fills when the writer omits it (`filled`), and its own relation actions.
 */
export type Selection<M, Op = 'create'> = {
	columns: readonly (Op extends 'update'
		? Exclude<WritableField<M>, OwnedFk<M>>
		: WritableField<M>)[];
	filled?: Op extends 'update' ? never : readonly WritableField<M>[];
	with?: With<M>;
};
interface CreateFor<K, F> {
	columns: readonly Writable<F>[];
	filled?: readonly Writable<F>[];
	with?: With<K>;
	transform?: unknown;
}
interface UpdateFor<K, F> {
	columns: readonly Exclude<Writable<F>, OwnedRef<F>>[];
	with?: With<K>;
	transform?: unknown;
}
type ReadFor<K, F, C> =
	| 'all'
	| {
			fields?: 'all' | readonly ((keyof F | keyof C) & string)[];
			relations?: 'all' | readonly (RefNames<F> | (keyof ManyRels<K> & string))[];
	  };
type Verb = 'create' | 'update' | 'delete' | 'upsert' | 'import' | 'export' | 'erase';
type InputPart<X> = X extends { input: unknown } ? ValidInputs<X['input']> : never;
type OutputPart<X> = X extends { output: unknown } ? ValidOutput<X['output']> : never;
type QueriesFor<Q> = {
	[N in keyof Q]: N extends Verb ? `error: '${N & string}' is a generated verb` : QueryEntry<Q[N]>;
};
type QueryEntry<X> = {
	description: string;
	input: InputPart<X>;
	output: OutputPart<X>;
	agent?: AgentUse;
	run: unknown;
};
type Part<S, K extends string> = S extends { [P in K]: infer V } ? V : {};

// ── search indexes ──
type Candidates = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;
type Metric = 'l2' | 'cosine' | 'ip';
type IndexesFor<F, X> = {
	[I in keyof X]: I extends 'semantic'
		? "error: 'semantic' is search.semantic's name"
		: IndexFor<F, X[I]>;
};
interface IndexFor<F, X> {
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
	label: string | readonly string[];
	fields: {
		[P in keyof F]: P extends ReservedKeys
			? `error: '${P & string}' is a system column`
			: F[P] extends { kind: 'ref' }
				? RefFor<F[P]>
				: ValidField<F[P], Own>;
	};
	key?: S extends { key: infer L } ? ColRefs<F & CK, L> : never;
	unique?: readonly { fields: readonly string[]; where?: OwnWhere<All>; name?: string }[];
	index?: readonly (string | readonly string[])[];
	/** A rule rows must keep; `{ where, message }` gives the refusal its member-facing message (else it names the rule). */
	check?: { readonly [name: string]: OwnWhere<All> | { where: OwnWhere<All>; message: Msg } };
	noOverlap?: readonly {
		key: readonly string[];
		period: OfKind<Own, { kind: 'period' }>;
		where?: OwnWhere<All>;
		name?: string;
	}[];
	computed?: ComputedSpec<Own, C, keyof F | SystemColumn>;
	search?: {
		text: readonly OfKind<All, { kind: 'text' | 'enum' } | { kind: 'seq'; pattern: string }>[]; // hook:reads — a patterned seq is text
		semantic?: {
			fields: readonly OfKind<Own, { kind: 'text' | 'file' }>[];
			model: EmbeddingModelName;
			dim: number;
		};
		indexes?: S extends { search: { indexes: infer X } } ? IndexesFor<Own, X> : never;
	};
	table?: {
		primary: 'text' | 'uuid' | 'identity' | { field: keyof Own & string };
		identity?: OfKind<Own, { kind: 'int' }>;
		indexes?: readonly {
			on: readonly ((keyof (F & CK) & string) | { lower: OfKind<Own, { kind: 'text' }> })[];
			unique?: true;
			where?: OwnWhere<All>;
		}[];
	};
	read?: ReadFor<K, F, C>;
	create?: Exposed<S, CreateFor<K, F>>;
	update?: Exposed<S, UpdateFor<K, F>>;
	delete?: Exposed<S, { check?: unknown }>;
	queries?: Exposed<S, QueriesFor<Part<S, 'queries'>>>;
	notify?: Exposed<S, unknown>;
	syncs?: Exposed<S, { [N in keyof Part<S, 'syncs'>]: SyncFor<Part<S, 'syncs'>[N]> }>;
}

// ── bodies: typed from the generated names by the model's name, never from the literal ──
type QueryRun<X> = (
	input: In<X>,
	ctx: QueryCtx
) => BodyReturn<X extends { output: infer O } ? ValueOf<O> : never>;
type IndexMetadata = Pick<
	NonNullable<NonNullable<ModelLiteral['search']>['indexes']>[string],
	'description' | 'dim' | 'metric' | 'input' | 'candidates'
>;
interface IndexBodies<K, Q> extends IndexMetadata {
	/** Pure: the row's vector, `null` to leave it out of the index; or the name of a `vector` field an automation fills. */
	vector?: ((row: StoredRow<K>) => Vector | null) | string;
	/** Pure: the probe vector for a search input, and a `where` applied inside the index scan. */
	probe?: (input: Q) => { vector: Vector; where?: Where<K> };
	/** Pure: an exact score over the candidate page, ascending; `undefined` keeps index order. */
	rerank?: (input: Q, row: Row<K>) => number | undefined;
}
interface BodiesFor<K> {
	create?: {
		/**
		 * Runs for every row created in this model, by every path, before it is written: a page or Form, the agent, and
		 * `ctx.act` in an automation; a sync's `read` and a file import; an upsert's creates; and a child created
		 * through its parent's `with`, after the parent's own callback, in the same statement. One call per batch (up to
		 * 1,000 rows), never per row: returns the rows to insert with derived values filled, or refuses. Seed packs (restored
		 * data) and derived roll-ups do not run it.
		 */
		transform?: (
			rows: readonly CreateRow<K>[],
			ctx: WriteCtx<K>
		) => BodyReturn<readonly CreateRow<K>[]>;
	};
	update?: {
		/**
		 * Runs for every row updated in this model, by every path, before it is written: a page or Form, the agent, and
		 * `ctx.act` in an automation; a sync's `read` and a file import; an upsert's updates; a bulk edit; an
		 * approval resubmit (the requester's save) and a per-record restore; a link or unlink of a child (an update of that
		 * child); and a child updated through its parent's `with`, after the parent's own callback. Receives `{ before, set }`
		 * per row (the stored row and the change) and returns the sets to write, in order, or refuses. Seed packs and
		 * derived roll-ups do not run it; nor does an upsert that keeps a matched row (`onConflict: 'keep'`).
		 */
		transform?: (
			changes: readonly { readonly before: StoredRow<K>; readonly set: UpdateSet<K> }[],
			ctx: WriteCtx<K>
		) => BodyReturn<readonly UpdateSet<K>[]>;
	};
	delete?: {
		/**
		 * Runs before every row of this model is deleted, by every path: a page, the agent, and `ctx.act` in an automation;
		 * a sync's `read` and a file import's prune; and a child deleted through its parent's `with`. Receives
		 * the stored rows and may only refuse. Seed packs and derived roll-ups do not run it.
		 */
		check?: (rows: readonly StoredRow<K>[], ctx: WriteCtx<K>) => BodyReturn<void>;
	};
	queries?: { [Q in QueryName<K>]?: QuerySpec & { run?: QueryRun<QuerySpecOf<K, Q>> } };
	/**
	 * Runs after the commit for every write and approval event of this model (the event says which) and returns the notices
	 * to send: who (`to`), what (`title`, `description`), how (`via` conversation connections; the inbox always), files.
	 * It reads as the workspace and does no I/O, so a notification never delays or fails a write.
	 */
	notify?: (event: NotifyEvent<K>, ctx: NotifyCtx) => BodyReturn<readonly Notice[]>;
	search?: { indexes?: { [I in IndexName<K>]?: IndexBodies<K, InputOf<IndexInput<K, I>>> } };
	syncs?: { [Sy in SyncName<K>]?: FileSync<K, Sy> | RemoteSync<K, Sy> };
}

// ── the general literal, and the engine's parts ──
type WithBase = { readonly [relation: string]: { readonly [action: string]: SelectionBase | {} } };
type SelectionBase = { columns: readonly string[]; filled?: readonly string[]; with?: WithBase };
/** A model literal as `model()` takes it in general: bodies are functions, or the `true` the check serializer writes. */
export type ModelLiteral = {
	/** What a record is, for people and the agent. */
	description: string;
	/** The previous model name: a schema migration renames its table instead of replacing it. */
	was?: string;
	/** The model's icon (an Iconify name). */
	icon?: IconName;
	/** The field path (or paths, joined) that names a record: `'name'`, `['code', 'name']`. */
	label: string | readonly string[];
	/** The stored fields, `ref` fields included. Every row also carries the system columns (see `ModelSpec.fields`). */
	fields: { readonly [name: string]: FieldKind | RefField };
	key?: readonly string[];
	unique?: readonly { fields: readonly string[]; where?: object; name?: string }[];
	index?: readonly (string | readonly string[])[];
	check?: { readonly [name: string]: object };
	/**
	 * A row matching this own-field predicate is read-only: the host refuses its update and delete, and the record page
	 * offers a lock instead of Edit. It is application-layer only, never a database permission.
	 */
	locked?: { readonly [field: string]: Json };
	noOverlap?: readonly { key: readonly string[]; period: string; where?: object; name?: string }[];
	computed?: { readonly [name: string]: { kind: ComputedKind; scale?: number; expr: Expr } };
	/**
	 * Every kind of search: the search box over `text` fields, `semantic` meaning the platform embeds, and custom `indexes`
	 * over any vector computed from the row (searched with `query(m, { search: { <index>: input } })`). An index's `dim`
	 * is at most 2,000 (`bolt check`) and its name is never `semantic`.
	 */
	search?: {
		text: readonly string[];
		semantic?: { fields: readonly string[]; model: EmbeddingModelName; dim: number };
		indexes?: {
			readonly [index: string]: {
				description: string;
				dim: number;
				metric: Metric;
				vector: unknown;
				input: InputFields;
				probe: unknown;
				rerank?: unknown;
				candidates?: Candidates;
			};
		};
	};
	table?: TableSpec;
	/** What callers read (grants narrow it further); without `read` the model is not exposed. `{}` reads every field. */
	read?: 'all' | { fields?: 'all' | readonly string[]; relations?: 'all' | readonly string[] };
	/** The generated `create`: the columns a writer sends, the fields its `transform` fills, relation actions under `with`. */
	create?: SelectionBase & { transform?: unknown };
	/** The generated `update`: the columns a writer changes, relation actions under `with`, its `transform`. */
	update?: { columns: readonly string[]; with?: WithBase; transform?: unknown };
	/** The generated `delete`, with an optional `check`. */
	delete?: { check?: unknown };
	/** Named reads: typed `input`, an `output` kind, and `run`. */
	queries?: { readonly [query: string]: QuerySpec & { run: unknown } };
	/** The notices each write and approval event sends. */
	notify?: unknown;
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
	/** Indexes over fields or a text field lowercased, optionally unique and partial (`where`). */
	indexes?: readonly {
		on: readonly (string | { lower: string })[];
		unique?: true;
		where?: object;
	}[];
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
	/** The field path (or paths, joined) that names a record: `'name'`, `['code', 'name']`. */
	label: string | readonly string[];
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
	/** Extra indexes: a field or a field list each. */
	index?: readonly (string | readonly string[])[];
	/** Named row checks: a `Where` every row must match. */
	check?: { readonly [name: string]: object };
	/** A row matching this own-field predicate is read-only: update and delete are refused, and the record shows a lock. */
	locked?: { readonly [field: string]: Json };
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
/** A declared query as the engine reads it: `input` fields, the `output` kind, and how the agent may call it. */
export type QuerySpec = {
	description: string;
	input: InputFields;
	output: OutputKind;
	agent?: AgentUse;
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
 * A model's exposure as the engine's `collections` part holds it: what callers `read`, the `create`/`update` input
 * allowlists, `delete`, declared queries and syncs; `true` marks a body the model declares
 * (`transform`, `check`, `notify`), which runs in the guest.
 */
export type CollectionSpec = {
	read: { fields: 'all' | readonly string[]; relations?: 'all' | readonly string[] };
	create?: { input: SelectionBase; transform?: true };
	update?: { input: SelectionBase; transform?: true };
	delete?: { check?: true };
	queries?: { readonly [query: string]: QuerySpec };
	notify?: true;
	syncs?: { readonly [sync: string]: SyncEntry };
};

/** The bodies of one model as the guest calls them by path (`collection.<model>.bodies.…`). */
export type ModelBodies = {
	readonly create?: Body;
	readonly update?: Body;
	readonly delete?: Body;
	readonly notify?: Body;
	readonly queries: { readonly [query: string]: Body };
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
const runs = (o: { readonly [name: string]: { readonly run: unknown } } | undefined) =>
	Object.fromEntries(
		Object.entries(o ?? {}).flatMap(([name, x]): [string, Body][] => {
			const body = guest(x.run);
			return body === undefined ? [] : [[name, body]];
		})
	);
const mapValues = <V, R>(
	o: { readonly [key: string]: V },
	f: (value: V) => R
): { [key: string]: R } => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));

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
		queries: runs(m.queries),
		// pure: stored as authored, called without a ctx
		indexes: mapValues(m.search?.indexes ?? {}, (x) => ({
			...(isBody(x.vector) ? { vector: x.vector } : {}),
			...(isBody(x.probe) ? { probe: x.probe } : {}),
			...(isBody(x.rerank) ? { rerank: x.rerank } : {})
		})),
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
 * checks, computed fields, `search`), its exposure (`read`; `create`, `update` and `delete` with their write callbacks;
 * named `queries`), `notify` and `syncs`. Every callback sits on what triggers it, inside the literal, and is
 * typed from the generated names by `name` (`bolt sync`; `bolt check` refuses a name that is not the folder's): until the
 * next sync a body does not see a field just added. Returns the name, the literal and the bodies.
 * @example
 * export default model('orders', {
 * 	description: 'Customer orders.',
 * 	label: 'number',
 * 	fields: {
 * 		number: { kind: 'seq', pattern: 'SO-{yyyy}-{0000}' },
 * 		customer: { kind: 'ref', to: 'customers', inverse: 'orders' },
 * 		notes: { kind: 'text', optional: true }
 * 	},
 * 	read: 'all',
 * 	create: {
 * 		columns: ['customer', 'notes'],
 * 		transform: function* (rows, ctx) {
 * 			const customers = yield* ctx.db.query('customers', { where: { id: { in: rows.map((r) => r.customer) } }, all: true });
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
	readonly collection?: CollectionSpec;
};
/**
 * Splits a model literal into storage (`ModelSpec`, refs removed), its refs (`RelationshipSpec` by `'<name>.<field>'`) and,
 * when it declares `read`, its exposure (`CollectionSpec`). Pure data in, data out: a body (a function, or the check
 * serializer's `true`) becomes its marker, and `read: 'all'` or a `read` without `fields` reads every field.
 */
export function splitModel(name: string, literal: ModelLiteral): ModelParts {
	const {
		fields,
		search,
		read,
		create,
		update,
		delete: del,
		queries,
		notify,
		syncs,
		...storage
	} = literal;
	const own: { [field: string]: FieldKind } = {};
	const relationships: { [key: string]: RelationshipSpec } = {};
	for (const [field, kind] of Object.entries(fields)) {
		if (kind.kind !== 'ref') own[field] = kind;
		else {
			const { kind: _ref, ...relationship } = kind;
			relationships[`${name}.${field}`] = relationship;
		}
	}
	const stored: ModelSpec = {
		...storage,
		fields: own,
		...(search === undefined
			? {}
			: {
					search: {
						text: search.text,
						...(search.semantic === undefined ? {} : { semantic: search.semantic }),
						...(search.indexes === undefined
							? {}
							: {
									indexes: mapValues(search.indexes, (x): SearchIndexSpec => ({
										description: x.description,
										dim: x.dim,
										metric: x.metric,
										input: x.input,
										...(typeof x.vector === 'string' ? { field: x.vector } : {}),
										...(x.candidates === undefined ? {} : { candidates: x.candidates }),
										...(x.rerank === undefined ? {} : { rerank: true })
									}))
								})
					}
				})
	};
	if (read === undefined) return { model: stored, relationships };
	const input = ({ columns, filled, with: relations }: SelectionBase): SelectionBase => ({
		columns,
		...(filled === undefined ? {} : { filled }),
		...(relations === undefined ? {} : { with: relations })
	});
	const collection: CollectionSpec = {
		read:
			read === 'all'
				? { fields: 'all', relations: 'all' }
				: {
						fields: read.fields ?? 'all',
						...(read.relations === undefined ? {} : { relations: read.relations })
					},
		...(create === undefined
			? {}
			: {
					create: {
						input: input(create),
						...(create.transform === undefined ? {} : { transform: true })
					}
				}),
		...(update === undefined
			? {}
			: {
					update: {
						input: input(update),
						...(update.transform === undefined ? {} : { transform: true })
					}
				}),
		...(del === undefined ? {} : { delete: del.check === undefined ? {} : { check: true } }),
		...(queries === undefined ? {} : { queries: mapValues(queries, ({ run: _run, ...q }) => q) }),
		...(notify === undefined ? {} : { notify: true }),
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
	return { model: stored, relationships, collection };
}
