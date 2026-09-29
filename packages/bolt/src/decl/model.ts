// `model()` (§3.3.2): storage only. Own-field positions are checked here; positions that may name an FK a relationship
// adds (label, key, unique, index, check, seq.per, state.edit) accept any name here and are checked by `Verify`.
import type { Checked, Exact, FieldKind, Literal, ValidField } from './fields.ts';
import type { IconName, Msg } from './values.ts';
import type { EmbeddingModelName } from './runtime/names.ts';

/** The kinds a computed field's expression may produce. */
export type ComputedKind = 'text' | 'int' | 'decimal' | 'money' | 'bool' | 'date' | 'instant';
type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year';
type E = Expr;
/** A computed expression: an operator tree over the model's own fields (§3.3.2, rule 3). */
export type Expr =
	| { field: string } | number | string | boolean
	| { plus: readonly [E, E] } | { minus: readonly [E, E] } | { times: readonly [E, E] } | { div: readonly [E, E] }
	| { round: readonly [E, number] } | { concat: readonly E[] } | { plusDays: readonly [E, E] } | { startOf: readonly [E, Unit] }
	| { text: E } | { lower: E } | { upper: E } | { trim: E }
	| { substring: readonly [E, E] | readonly [E, E, E] } | { regexReplace: readonly [E, string, string] }
	/** A json field's member as text (`party->>'id'`). */
	| { jsonText: readonly [E, string] }
	| { eq: readonly [E, E] } | { ne: readonly [E, E] } | { gt: readonly [E, E] } | { gte: readonly [E, E] }
	| { lt: readonly [E, E] } | { lte: readonly [E, E] }
	| { and: readonly E[] } | { or: readonly E[] } | { not: E }
	| { when: readonly [E, E, E] } | { coalesce: readonly E[] };

// ── the result kind of a tree, or an `error: …` message naming the problem ──
type Err = `error: ${string}`;
type Num = 'int' | 'decimal' | 'money';
type FieldKindName<K> = K extends { kind: 'sum' } ? 'decimal' : K extends { kind: 'count' } ? 'int'
	: K extends { kind: 'seq'; pattern: string } ? 'text' : K extends { kind: 'seq' } ? 'int'
	: K extends { kind: 'state' | 'currency' } ? 'enum' : K extends { kind: infer X } ? X : never;
type Promote<A, B> = A extends 'money' ? 'money' : B extends 'money' ? 'money' : A extends 'decimal' ? 'decimal' : B extends 'decimal' ? 'decimal' : 'int';
type Two<A, B, R> = A extends Err ? A : B extends Err ? B : R;
type All<Ks, K, R, Msg extends string> = Ks extends readonly [infer H, ...infer T] ? H extends Err ? H : H extends K ? All<T, K, R, Msg> : `error: ${Msg}` : R;
type Unify<A, B> = Two<A, B, A extends B ? A : A extends Num ? B extends Num ? Promote<A, B> : `error: when/coalesce arms differ (${A & string}, ${B & string})`
	: A extends 'enum' | 'text' ? B extends 'enum' | 'text' ? 'text' : `error: when/coalesce arms differ (${A & string}, ${B & string})`
	: `error: when/coalesce arms differ (${A & string}, ${B & string})`>;
type UnifyAll<Ks> = Ks extends readonly [infer H, infer N, ...infer T] ? UnifyAll<[Unify<H, N>, ...T]> : Ks extends readonly [infer H] ? H : 'error: empty';
type Kinds<Xs, F> = { [I in keyof Xs]: KindOfExpr<Xs[I], F> };
type Comparable<A, B> = Two<A, B, A extends Num ? B extends Num ? 'bool' : `error: cannot compare ${A} with ${B & string}`
	: A extends 'enum' | 'text' ? B extends 'enum' | 'text' ? 'bool' : `error: cannot compare ${A} with ${B & string}`
	: A extends B ? 'bool' : `error: cannot compare ${A & string} with ${B & string}`>;
type Arith<Op extends string, A, B> = Two<A, B, A extends Num ? B extends Num
	? Op extends 'times' ? A extends 'money' ? B extends 'money' ? 'error: money times money' : 'money' : Promote<A, B>
	: Op extends 'div' ? A extends 'money' ? B extends 'money' ? 'decimal' : 'money' : B extends 'money' ? 'error: division by money' : 'decimal'
	: Promote<A, B>
	: `error: ${Op} needs numbers` : `error: ${Op} needs numbers`>;
type Text1<A, Op extends string> = A extends Err ? A : A extends 'text' ? 'text' : `error: ${Op} needs text`;
/** The kind an expression evaluates to over fields `F`. */
export type KindOfExpr<X, F> =
	X extends number ? `${X}` extends `${string}.${string}` ? 'decimal' : 'int'
	: X extends string ? 'text' : X extends boolean ? 'bool'
	: X extends { field: infer N } ? N extends keyof F ? FieldKindName<F[N]> : `error: unknown field '${N & string}'`
	: X extends { plus: readonly [infer A, infer B] } ? Arith<'plus', KindOfExpr<A, F>, KindOfExpr<B, F>>
	: X extends { minus: readonly [infer A, infer B] } ? Arith<'minus', KindOfExpr<A, F>, KindOfExpr<B, F>>
	: X extends { times: readonly [infer A, infer B] } ? Arith<'times', KindOfExpr<A, F>, KindOfExpr<B, F>>
	: X extends { div: readonly [infer A, infer B] } ? Arith<'div', KindOfExpr<A, F>, KindOfExpr<B, F>>
	: X extends { round: readonly [infer A, number] } ? KindOfExpr<A, F> extends infer K ? K extends Err | Num ? K : 'error: round needs a number' : never
	: X extends { concat: infer Xs } ? All<Kinds<Xs, F>, 'text' | 'enum', 'text', 'concat needs text (cast with `text`)'>
	: X extends { plusDays: readonly [infer A, infer B] } ? Two<KindOfExpr<A, F>, KindOfExpr<B, F>,
		KindOfExpr<A, F> extends 'date' ? KindOfExpr<B, F> extends 'int' ? 'date' : 'error: plusDays needs an int' : 'error: plusDays needs a date'>
	: X extends { startOf: readonly [infer A, Unit] } ? KindOfExpr<A, F> extends infer K ? K extends Err | 'date' | 'instant' ? K : 'error: startOf needs a date or an instant' : never
	: X extends { text: infer A } ? KindOfExpr<A, F> extends infer K ? K extends Err ? K : K extends Num | 'text' | 'enum' | 'date' ? 'text' : `error: text cannot cast ${K & string}` : never
	: X extends { lower: infer A } ? Text1<KindOfExpr<A, F>, 'lower'> : X extends { upper: infer A } ? Text1<KindOfExpr<A, F>, 'upper'>
	: X extends { trim: infer A } ? Text1<KindOfExpr<A, F>, 'trim'>
	: X extends { substring: readonly [infer A, ...unknown[]] } ? Text1<KindOfExpr<A, F>, 'substring'>
	: X extends { regexReplace: readonly [infer A, string, string] } ? Text1<KindOfExpr<A, F>, 'regexReplace'>
	: X extends { jsonText: readonly [infer A, string] } ? KindOfExpr<A, F> extends infer K ? K extends Err ? K : K extends 'json' ? 'text' : 'error: jsonText needs a json field' : never
	: X extends { eq: readonly [infer A, infer B] } | { ne: readonly [infer A, infer B] } ? Comparable<KindOfExpr<A, F>, KindOfExpr<B, F>>
	: X extends { gt: readonly [infer A, infer B] } | { gte: readonly [infer A, infer B] } | { lt: readonly [infer A, infer B] } | { lte: readonly [infer A, infer B] }
		? Comparable<KindOfExpr<A, F>, KindOfExpr<B, F>>
	: X extends { and: infer Xs } | { or: infer Xs } ? All<Kinds<Xs, F>, 'bool', 'bool', 'and/or need booleans'>
	: X extends { not: infer A } ? KindOfExpr<A, F> extends infer K ? K extends Err ? K : K extends 'bool' ? 'bool' : 'error: not needs a boolean' : never
	: X extends { when: readonly [infer C, infer A, infer B] } ? KindOfExpr<C, F> extends infer K ? K extends Err ? K : K extends 'bool'
		? Unify<KindOfExpr<A, F>, KindOfExpr<B, F>> : 'error: when needs a boolean condition' : never
	: X extends { coalesce: infer Xs } ? UnifyAll<Kinds<Xs, F>>
	: 'error: unknown operator';

// ── the model literal ──
type NonBtree = { kind: 'json' | 'file' | 'point' | 'vector' | 'period' | 'custom' | 'sum' | 'count' } | { many: true };
type ColRef<F, N> = N extends keyof F ? F[N] extends NonBtree ? `error: '${N & string}' is not an indexable field` : N : N;
type ColRefs<F, L> = { readonly [I in keyof L]: ColRef<F, L[I]> };
type OfKind<F, K> = { [P in keyof F]: F[P] extends K ? P : never }[keyof F] & string;
type Reserved = 'id' | 'revision' | 'approval_id' | 'created_at' | 'created_by' | 'updated_at' | 'updated_by';
// a system table (`table`) carries no engine columns but its key, so those names are its own fields
type ReservedIn<M> = M extends { table: object } ? 'id' : Reserved;
type Loose = { readonly [k: string]: unknown };
/** An own-row predicate at the model literal: own fields typed, other names (FKs) left to `Verify`. */
type OwnWhere<F> = { [P in keyof F]?: OwnOps<F, F[P]> } & { and?: readonly OwnWhere<F>[]; or?: readonly OwnWhere<F>[]; not?: OwnWhere<F> } & Loose;
type OwnVal<F, K> = Literal<K> | { field: OfKind<F, { kind: KindGroup<K> }> };
type KindGroup<K> = K extends { kind: 'int' | 'decimal' | 'money' | 'sum' | 'count' } ? 'int' | 'decimal' | 'money' | 'sum' | 'count'
	: K extends { kind: infer X } ? X : never;
type OwnOps<F, K> = { eq?: OwnVal<F, K>; ne?: OwnVal<F, K>; in?: readonly Literal<K>[]; nin?: readonly Literal<K>[]; isNull?: boolean;
	lt?: OwnVal<F, K>; lte?: OwnVal<F, K>; gt?: OwnVal<F, K>; gte?: OwnVal<F, K>; like?: string };
type ComputedSpec<F, C> = { [P in keyof C]: P extends keyof F | Reserved ? `error: '${P & string}' is already a field`
	: C[P] extends { kind: infer K; expr: infer X } ? KindOfExpr<X, F & C> extends infer R
		// `unknown`, not the tree: a tree checked against itself was a full `Exact` walk that could refuse nothing
		? R extends K ? { kind: ComputedKind; scale?: number; expr: unknown } : { kind: ComputedKind; scale?: number; expr: R extends Err ? R : `error: expr is ${R & string}, declared ${K & string}` }
		: never : never };
type FieldsIn<M> = M extends { fields: infer F } ? F : {};
type ComputedIn<M> = M extends { computed: infer C } ? C : {};

type ModelSpecFor<M, F = FieldsIn<M>, C = ComputedIn<M>, All = F & { [P in keyof C]: { kind: C[P] extends { kind: infer K } ? K : never } }> = {
	description: string; icon?: IconName;
	label: string | readonly string[];
	fields: { [P in keyof F]: P extends ReservedIn<M> ? `error: '${P & string}' is a system column` : ValidField<F[P], F> };
	key?: M extends { key: infer L } ? ColRefs<All, L> : never;
	unique?: readonly { fields: readonly string[]; where?: OwnWhere<All>; name?: string }[];
	index?: readonly (string | readonly string[])[];
	/** A rule rows must keep; `{ where, message }` gives the refusal its member-facing message (else it names the rule). */
	check?: { readonly [name: string]: OwnWhere<All> | { where: OwnWhere<All>; message: Msg } };
	noOverlap?: readonly { key: readonly string[]; period: OfKind<F, { kind: 'period' }>; where?: OwnWhere<All>; name?: string }[];
	computed?: ComputedSpec<F, C>;
	search?: { text: readonly OfKind<All, { kind: 'text' | 'enum' } | { kind: 'seq'; pattern: string }>[]; // hook:reads — a patterned seq is text
		semantic?: { fields: readonly OfKind<F, { kind: 'text' | 'file' }>[]; model: EmbeddingModelName; dim: number } };
	table?: { primary: 'text' | 'uuid' | 'identity' | { field: keyof F & string }; identity?: OfKind<F, { kind: 'int' }>;
		indexes?: readonly { on: readonly ((keyof All & string) | { lower: OfKind<F, { kind: 'text' }> })[]; unique?: true; where?: OwnWhere<All> }[] };
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
	indexes?: readonly { on: readonly (string | { lower: string })[]; unique?: true; where?: object }[];
};
export type ModelSpec = {
	/** What a record is, for people and the agent. */
	description: string;
	/** The model's icon (an Iconify name). */
	icon?: IconName;
	/** The field path (or paths, joined) that names a record: `'name'`, `['code', 'name']`. */
	label: string | readonly string[];
	/**
	 * The stored fields. Every row also carries the system columns `id revision approval_id created_at created_by
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
	/** Rows with equal `key` fields may not have overlapping `period`s. */
	noOverlap?: readonly { key: readonly string[]; period: string; where?: object; name?: string }[];
	/** Computed fields: an expression over the row's own fields, stored and kept current. */
	computed?: { readonly [name: string]: { kind: ComputedKind; scale?: number; expr: Expr } };
	/** Text search over `text` fields, and semantic (embedding) search over `semantic.fields`. */
	search?: { text: readonly string[]; semantic?: { fields: readonly string[]; model: EmbeddingModelName;
		/** The embedding column's width: the model class is asked for exactly this many numbers, stored or probed. Required — a
		 * workspace states it, so the host's binding is a conformance question, not a guess bolt makes for it. */
		dim: number } };
	/** A system table's physical row (the built-in layer only). */
	table?: TableSpec;
};

/**
 * `src/data/model/<m>/+model.ts`: a model's storage: its `fields` (each a kind literal), the `label` paths that name a
 * record, keys, uniqueness, indexes, checks, computed fields and search. Returns the literal: declarations are data.
 * @example
 * export default model({
 * 	description: 'Products in the catalogue.',
 * 	icon: 'lucide:package',
 * 	label: 'name',
 * 	fields: { code: { kind: 'text', unique: true }, name: { kind: 'text' }, unit_price: { kind: 'decimal', scale: 4, optional: true } },
 * 	search: { text: ['name'] }
 * });
 */
export function model<const M extends ModelSpec>(spec: M & Checked<ModelSpec, M, Exact<M, ModelSpecFor<M>>>): M {
	return spec;
}
