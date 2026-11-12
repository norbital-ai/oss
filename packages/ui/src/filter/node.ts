// Filter nodes and decoded operand forms; completeness is shared by every consumer.
import { Schema } from 'effect';
import type { Value } from '@norbital-ai/std/kind';
import { type Json, value_object } from '../kinds/kind.js';

export const OpSchema = Schema.Literals([
	'eq',
	'ne',
	'lt',
	'lte',
	'gt',
	'gte',
	'in',
	'not_in',
	'like',
	'is_null',
	'not_null',
	'has',
	'has_any',
	'has_all',
	'is_empty',
	'not_empty',
	'during',
	'contains',
	'overlaps',
	'contained_by',
	'starts_within',
	'ends_within',
	'near',
	'search',
	'similar'
]);

export const CmpSchema = Schema.Literals(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);

export type Op = typeof OpSchema.Type;

export type Cmp = typeof CmpSchema.Type;

export const AggSchema = Schema.Literals(['count', 'sum', 'min', 'max', 'avg']);

/** A condition's value: a literal, a list, a date span (with the catalogue's label, when it came from one), a `{ var }`
 * CEL expression (`requestor.id`, `today - days(7)`, std/vars) or a same-row `{ field }`. The view keeps a variable as
 * written (its URL too, so "this month" rolls over); a read sends the literal a time variable stands for at the page's
 * clock (`toWhere` with a `FilterClock`), and a requestor variable for the host to bind. */
export type RawArg =
	| { lit: Value }
	| { list: readonly Value[] }
	| { range: readonly [Json, Json]; label?: string }
	| { var: string }
	| { field: string };

export type Arg =
	| { readonly _tag: 'lit'; readonly lit: Value }
	| { readonly _tag: 'list'; readonly list: readonly Value[] }
	| { readonly _tag: 'range'; readonly range: readonly [Json, Json]; readonly label?: string }
	| { readonly _tag: 'var'; readonly var: string }
	| { readonly _tag: 'field'; readonly field: string };

/** `{ var: '<CEL>' }`, the one spelling of a variable, as its text. */
export const varOf = (value: Value): string | null =>
	value_object(value) &&
	Object.keys(value).length === 1 &&
	'var' in value &&
	typeof value['var'] === 'string'
		? value['var']
		: null;

export function taggedArg(arg: RawArg): Arg {
	if ('lit' in arg) {
		const text = varOf(arg.lit);
		return text === null ? { _tag: 'lit', ...arg } : { _tag: 'var', var: text };
	}
	if ('list' in arg) return { _tag: 'list', ...arg };
	if ('range' in arg) return { _tag: 'range', ...arg };
	if ('var' in arg) return { _tag: 'var', ...arg };
	return { _tag: 'field', ...arg };
}

export type Quant = 'some' | 'none' | 'every' | typeof AggSchema.Type;

export type Node =
	/** `path`: own field, or one-relation steps then a field (`account.owner.name`, two hops; an arm is `ref:arm`); a path
	 * that ends on a relation is a condition on the related record. */
	| { t: 'cond'; path: string; op: Op; arg: Arg | null }
	| { t: 'group'; join: 'and' | 'or'; not?: true; of: readonly Node[] }
	/** A many-relation: has any / none / all match with nested conditions, or `count` / an aggregate of a child field.
	 * `rel` may sit one relation hop on (`customer.invoices`: the customer's invoices). */
	| {
			t: 'many';
			rel: string;
			q: Quant;
			of: readonly Node[];
			field?: string;
			op?: Cmp;
			n?: number | string | null;
	  };

/** The where/order_by decoder's one object test: an initial filter, a URL and an AI answer arrive as untyped JSON. */
export const jsonObject = (v: Json | undefined): v is { readonly [key: string]: Json } =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

// ── variables at the page's clock ──
/** What a time variable resolves against: the page's `bolt.clock('day')` and the workspace zone. */
export type FilterClock = { readonly today: string; readonly now: string; readonly zone: string };

/** Whether a condition is complete (an incomplete row is shown but not sent). */
export function complete(n: Node): boolean {
	if (n.t === 'group') return n.of.some(complete);
	if (n.t === 'many')
		return ['some', 'none', 'every'].includes(n.q)
			? true
			: n.op !== undefined &&
					(n.q === 'count'
						? typeof n.n === 'number' && Number.isInteger(n.n) && n.n >= 0
						: n.field !== undefined &&
							((typeof n.n === 'number' && Number.isFinite(n.n)) ||
								((n.q === 'min' || n.q === 'max') &&
									typeof n.n === 'string' &&
									/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(n.n) &&
									Number.isFinite(Date.parse(n.n)))));
	if (['is_null', 'not_null', 'is_empty', 'not_empty'].includes(n.op)) return true;
	const a = n.arg;
	if (a === null) return false;
	if ('lit' in a) return a.lit !== null && a.lit !== '';
	if ('list' in a) return a.list.length > 0;
	return true;
}
