// The read IR with tagged value arms: every operand family is one `_tag`, so compilers and evaluators match arms
// instead of probing keys. The discriminants: a read by `kind`, a predicate by `t`. `decode.ts` emits it from literals.
import type { Json, Point, Shape } from './values.ts';

// ── value arms ──
/** A literal in wire form. */
type Lit = { readonly _tag: 'Lit'; readonly value: Json };
/** A same-row field (`{ field }`): compared within the row, never a relation path. */
export type Field = { readonly _tag: 'Field'; readonly field: string };
/** A named parameter bound per invocation (`{ param }`). */
type Param = { readonly _tag: 'Param'; readonly name: string };
/** What an `{ actor }` operand reads off the caller's authority. */
type ActorOperand =
	| 'id'
	| 'email'
	| 'phone'
	| 'teams'
	| 'teamTree'
	| 'party'
	| 'visitor'
	| 'instance'
	| { readonly scopes: string };
export type Actor = { readonly _tag: 'Actor'; readonly of: ActorOperand };
/** A value position resolved at execution. */
export type Operand = Field | Param | Actor;
/** A value position: a literal or an operand. */
export type Arg = Lit | Operand;
/**
 * Inside a keyed read (`ctx.read({ … })`): the values of `field` across the rows an EARLIER member of the same read
 * answered, resolved inside the one statement.
 */
export type MemberRef = {
	readonly _tag: 'Member';
	readonly member: string;
	readonly field: string;
};

// ── predicates ──
export type Cmp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
/** A test of the value at a path inside an inline value. */
export type PathTest =
	| { readonly op: Cmp | 'like'; readonly arg: Json }
	| { readonly op: 'in'; readonly args: readonly Json[]; readonly negated: boolean }
	| { readonly op: 'null'; readonly is: boolean }
	| { readonly op: 'contains'; readonly arg: Json }
	| { readonly op: 'isEmpty'; readonly is: boolean };
/** The element an `each` quantifies over, as a `path` names its field. */
export const ELEMENT = '$e';
/** The normalized `Where` (K3): one evaluator in SQL, one in JS (live routing). */
export type Pred =
	| { readonly t: 'const'; readonly value: boolean }
	| { readonly t: 'and' | 'or'; readonly of: readonly Pred[] }
	| { readonly t: 'not'; readonly of: Pred }
	| { readonly t: 'cmp'; readonly field: string; readonly op: Cmp; readonly arg: Arg }
	| { readonly t: 'like'; readonly field: string; readonly pattern: string }
	| {
			readonly t: 'text';
			readonly field: string;
			readonly mode: 'folded' | 'digits';
			readonly value: string;
	  }
	| { readonly t: 'age'; readonly field: string; readonly seconds: number }
	| {
			readonly t: 'in';
			readonly field: string;
			readonly negated: boolean;
			readonly args: readonly Json[] | Operand | MemberRef;
	  }
	| { readonly t: 'null'; readonly field: string; readonly is: boolean }
	| {
			readonly t: 'list';
			readonly field: string;
			readonly op: 'has' | 'hasAny' | 'hasAll' | 'isEmpty';
			readonly arg: Json;
	  }
	| {
			readonly t: 'period';
			readonly field: string;
			readonly op: 'contains' | 'overlaps' | 'within';
			readonly arg: Arg;
	  }
	| {
			readonly t: 'geo';
			readonly field: string;
			readonly near?: readonly [Point, number] | undefined;
			readonly within?: Shape | undefined;
	  }
	/** A one-relation `is`; on a polymorphic ref, one arm (`target`). */
	| { readonly t: 'one'; readonly rel: string; readonly target: string; readonly pred: Pred }
	| {
			readonly t: 'many';
			readonly rel: string;
			readonly target: string;
			readonly q: 'some' | 'none' | 'every';
			readonly pred: Pred;
	  }
	| {
			readonly t: 'count';
			readonly rel: string;
			readonly target: string;
			readonly op: Cmp;
			readonly n: number;
	  }
	| {
			readonly t: 'agg';
			readonly rel: string;
			readonly target: string;
			readonly fn: 'sum' | 'min' | 'max' | 'avg';
			readonly of: string;
			readonly op: Cmp;
			readonly arg: Json;
	  }
	/**
	 * A test at `path` inside an inline value (`field`, or the element an enclosing `each` binds), its text cast to
	 * `pg`: the expression a declared path index is built on.
	 */
	| {
			readonly t: 'path';
			readonly field: string;
			readonly path: readonly string[];
			readonly pg: string;
			readonly test: PathTest;
	  }
	/** A list inside an inline value, quantified: `pred` holds of some, every or none of its elements. */
	| {
			readonly t: 'each';
			readonly field: string;
			readonly path: readonly string[];
			readonly q: 'some' | 'none' | 'every';
			readonly pred: Pred;
	  }
	| { readonly t: 'json'; readonly field: string; readonly contains: Json }
	| { readonly t: 'json'; readonly field: string; readonly isEmpty: boolean }
	/** `$search`: the model's `search.text` document holds every word of `text`. */
	| { readonly t: 'search'; readonly text: string }
	/** `$similar`: the rows nearest `to` on `search.semantic`, at most `top`; `vector` is the probe the read embeds first. */
	| {
			readonly t: 'similar';
			readonly to: string;
			readonly top: number;
			readonly vector?: readonly number[] | undefined;
	  };

// ── pages, order, projection ──
/** Rule 9: a limit or everything, never a default. `after` is bound to the query's AST hash (rule 11). */
export type Limit = {
	readonly _tag: 'Limit';
	readonly limit: number;
	readonly after?: string | undefined;
};
export type All = { readonly _tag: 'All' };
export type PageIR = Limit | All;
/** A sort key; `near` orders by great-circle distance from that point, nearest first (a point field only). */
export type Order = readonly {
	readonly field: string;
	readonly dir: 'asc' | 'desc';
	readonly near?: Point | undefined;
}[];
/** `null` fields = the list's default projection (`whole`: every exposed field, heavy ones included, as a record's). */
export type SelectIR = {
	readonly fields: readonly string[] | null;
	readonly whole?: true | undefined;
	readonly relations: { readonly [rel: string]: RelSelectIR };
};
export type RelSelectIR = {
	readonly target: string;
	/** A polymorphic relation's every target, read as one row of whichever it holds (`model` names it). */
	readonly targets?: readonly string[] | undefined;
	/** A polymorphic arm may project each target's own columns and nested relations. */
	readonly targetSelects?: { readonly [target: string]: SelectIR } | undefined;
	readonly many: boolean;
	readonly select: SelectIR;
	readonly where?: Pred | undefined;
	readonly order?: Order | undefined;
	readonly page?: PageIR | undefined;
	/** A many-relation's rows measured per parent row instead of listed: one row, or with `by` its buckets (`page`). */
	readonly aggregate?: Measures | undefined;
};
/** What an aggregate measures: its buckets, a count, and per-field sums, averages, minimums and maximums. */
export type Measures = {
	readonly by: readonly Bucket[];
	readonly count?: true | undefined;
	readonly sum?: readonly string[] | undefined;
	readonly avg?: readonly string[] | undefined;
	readonly min?: readonly string[] | undefined;
	readonly max?: readonly string[] | undefined;
};
export type Bucket = {
	readonly field: string;
	readonly unit?: 'day' | 'week' | 'month' | 'quarter' | 'year' | undefined;
};
// ── reads (discriminant `kind`) ──
/** A list read; `member` and `cte` name a keyed read's member and its rows in the composed statement. */
export type ListRead = {
	readonly kind: 'read';
	readonly model: string;
	readonly where?: Pred | undefined;
	readonly select: SelectIR;
	readonly order?: Order | undefined;
	readonly search?: string | undefined;
	/** First row of each group, in the declared order; grouping precedes cursor seeking. */
	readonly firstPer?: readonly string[] | undefined;
	readonly page: PageIR;
	readonly member?: string | undefined;
	readonly cte?: string | undefined;
};
/** The reads the store compiles to one statement each. */
export type ReadIR =
	| ListRead
	| {
			readonly kind: 'get';
			readonly model: string;
			readonly id: string;
			readonly select: SelectIR;
			readonly member?: string | undefined;
			readonly cte?: string | undefined;
	  }
	| (Measures & {
			readonly kind: 'aggregate';
			readonly model: string;
			readonly where?: Pred | undefined;
			readonly page?: PageIR | undefined;
	  })
	| {
			readonly kind: 'similar';
			readonly model: string;
			/** A `search.indexes` entry, or `SEMANTIC` for `search.semantic`. */
			readonly index: string;
			readonly input: Json;
			readonly limit: number;
			readonly where?: Pred | undefined;
			readonly select?: SelectIR | undefined;
	  };
