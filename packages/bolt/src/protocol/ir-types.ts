// The read IR with tagged value arms (D15, quality engine H6): every operand family is one `_tag`, so compilers and
// evaluators match arms instead of probing keys (`'lit' in v`, `'field' in o`). The wire discriminants stay: `ReadIR`
// by `kind`, `Pred` by `t`. E3 adopts these in `ir.ts` (the decoder emits them); E5b, E7, E8 and E11 consume them.
import type { Json, Offset, Point } from '../decl/values.ts';
import type { CalendarUnit, Shape } from '../decl/where.ts';

// ── value arms ──
/** A literal in wire form. */
type Lit = { readonly _tag: 'Lit'; readonly value: Json };
/** A same-row field (`{ field }`): compared within the row, never a relation path. */
export type Field = { readonly _tag: 'Field'; readonly field: string };
/** A named parameter bound per invocation (`{ param }`). */
type Param = { readonly _tag: 'Param'; readonly name: string };
/** The invocation's instant moved by `offset` (`{ now }`; `''` is now). */
type Now = { readonly _tag: 'Now'; readonly offset: Offset };
/** The invocation's date in the workspace zone moved by `offset` (`{ today }`). */
type Today = { readonly _tag: 'Today'; readonly offset: Offset };
/** The first day of the calendar unit containing today, moved by `shift` whole units (`{ startOf, shift }`). */
export type StartOf = {
	readonly _tag: 'StartOf';
	readonly unit: CalendarUnit;
	readonly shift?: number | undefined;
};
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
export type Operand = Field | Param | Now | Today | StartOf | Actor;
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
/** The normalized `Where` (K3): one evaluator in SQL, one in JS (live routing). */
export type Pred =
	| { readonly t: 'const'; readonly value: boolean }
	| { readonly t: 'and' | 'or'; readonly of: readonly Pred[] }
	| { readonly t: 'not'; readonly of: Pred }
	| { readonly t: 'cmp'; readonly field: string; readonly op: Cmp; readonly arg: Arg }
	| { readonly t: 'like'; readonly field: string; readonly pattern: string }
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
	| { readonly t: 'json'; readonly field: string; readonly contains: Json }
	| { readonly t: 'json'; readonly field: string; readonly isEmpty: boolean }
	/** `$search`: the collection's `search.text` document holds every word of `text`. */
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
/** `null` fields = the list's default projection. */
export type SelectIR = {
	readonly fields: readonly string[] | null;
	readonly relations: { readonly [rel: string]: RelSelectIR };
};
export type RelSelectIR = {
	readonly target: string;
	readonly many: boolean;
	readonly select: SelectIR;
	readonly where?: Pred | undefined;
	readonly order?: Order | undefined;
	readonly page?: PageIR | undefined;
};
export type Bucket = {
	readonly field: string;
	readonly unit?: 'day' | 'week' | 'month' | 'quarter' | 'year' | undefined;
};
/** `{ instant } | { revision } | { before }` of `history` (rule 17). */
type HistoryAt =
	| { readonly _tag: 'Instant'; readonly instant: string }
	| { readonly _tag: 'Revision'; readonly revision: number }
	| { readonly _tag: 'Before'; readonly before: string };

// ── reads (wire discriminant `kind`, D15) ──
/** A list read; `member` and `cte` name a keyed read's member and its rows in the composed statement. */
export type ListRead = {
	readonly kind: 'read';
	readonly collection: string;
	readonly where?: Pred | undefined;
	readonly select: SelectIR;
	readonly order?: Order | undefined;
	readonly search?: string | undefined;
	readonly page: PageIR;
	readonly member?: string | undefined;
	readonly cte?: string | undefined;
};
export type ReadIR =
	| ListRead
	| {
			readonly kind: 'get';
			readonly collection: string;
			readonly id: string;
			readonly select: SelectIR;
			readonly member?: string | undefined;
			readonly cte?: string | undefined;
	  }
	| {
			readonly kind: 'aggregate';
			readonly collection: string;
			readonly where?: Pred | undefined;
			readonly by: readonly Bucket[];
			readonly count?: true | undefined;
			readonly sum?: readonly string[] | undefined;
			readonly avg?: readonly string[] | undefined;
			readonly min?: readonly string[] | undefined;
			readonly max?: readonly string[] | undefined;
			readonly page?: PageIR | undefined;
	  }
	| {
			readonly kind: 'similar';
			readonly collection: string;
			readonly similarity: string;
			readonly input: Json;
			readonly limit: number;
			readonly where?: Pred | undefined;
			readonly select?: SelectIR | undefined;
	  }
	| {
			readonly kind: 'history';
			readonly collection: string;
			readonly id: string;
			readonly at?: HistoryAt | undefined;
			readonly full?: true | undefined;
	  }
	/** A collection query: a guest invocation reading as its caller. */
	| {
			readonly kind: 'query';
			readonly collection: string;
			readonly query: string;
			readonly input: Json;
	  }
	/** The transform's `db.after`: stored rows overlaid with this batch. */
	| {
			readonly kind: 'after';
			readonly collection: string;
			readonly where: Pred;
			readonly query?: ListRead | undefined;
	  }
	/** The agent panel's messages of one conversation in `seq` order. */
	| {
			readonly kind: 'transcript';
			readonly collection: 'sys_message';
			readonly conversation: string;
			readonly thread: boolean;
			readonly from?: number | undefined;
	  }
	/** The shell inbox: own notices, with an optional caller-filtered open request list. */
	| {
			readonly kind: 'inbox';
			readonly collection: 'sys_notification';
			readonly member: string;
			readonly requests?: true | undefined;
	  }
	/** The agent panel's conversation list: one member's own conversations, most recently active first. */
	| {
			readonly kind: 'conversations';
			readonly collection: 'sys_conversation';
			readonly member: string;
	  };
