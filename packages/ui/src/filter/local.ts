// Filtering and sorting loaded local rows, with their inferred exposure.
import type { Value } from '@norbital-ai/std/kind';
import { Decimal } from '@norbital-ai/std/decimal';
import { type Node, type FilterClock, complete, taggedArg } from './node.js';
import { value_object, type Kind } from '../kinds/kind.js';
import { evaluated, bound } from './where.js';
import type { SortKey } from './order.js';
import type { ModelExposure } from '../kinds/context.js';

// ── a local array's rows, evaluated in the browser ──
const cmpVal = (a: Value, b: Value): number =>
	a instanceof Decimal &&
	(b instanceof Decimal ||
		typeof b === 'number' ||
		(typeof b === 'string' && /^-?\d+(\.\d+)?$/.test(b)))
		? a.cmp(b instanceof Decimal ? b : String(b))
		: typeof a === 'string' &&
			  typeof b === 'string' &&
			  /^\d{4}-\d{2}-\d{2}T/.test(a) &&
			  /^\d{4}-\d{2}-\d{2}T/.test(b)
			? Date.parse(a) - Date.parse(b)
			: typeof a === 'number' && typeof b === 'number'
				? a - b
				: String(a).localeCompare(String(b));

export function matches(
	row: { readonly [f: string]: Value },
	n: Node,
	clock?: FilterClock
): boolean {
	if (!complete(n)) return true;
	if (n.t === 'group') {
		const of = n.of.filter(complete),
			r =
				n.join === 'and'
					? of.every((x) => matches(row, x, clock))
					: of.some((x) => matches(row, x, clock));
		return n.not ? !r : r;
	}
	if (n.t === 'many') {
		const related = n.rel
			.split('.')
			.reduce<Value | undefined>(
				(value, key) => (value_object(value) ? value[key] : undefined),
				row
			);
		if (!Array.isArray(related) || !related.every(value_object))
			throw new Error('Related data must be loaded before applying this filter.');
		const children = related.filter(value_object);
		const hit = (child: { readonly [key: string]: Value }) =>
			n.of.every((node) => matches(child, node, clock));
		if (n.q === 'some') return children.some(hit);
		if (n.q === 'none') return !children.some(hit);
		if (n.q === 'every') return children.every(hit);
		if (n.op === undefined || n.n === undefined || n.n === null) return false;
		let value: Value = children.length,
			target: Value = n.n;
		if (n.q !== 'count') {
			const values = children
				.map((child) => (n.field === undefined ? null : (child[n.field] ?? null)))
				.filter((v) => v !== null);
			if (n.q === 'sum' || n.q === 'avg') {
				if (n.q === 'avg' && values.length === 0) return false;
				value = values.reduce<Decimal>(
					(sum, v) => sum.plus(Decimal.of(String(v))),
					Decimal.of('0')
				);
				if (n.q === 'avg') target = Decimal.of(String(target)).times(String(values.length));
			} else {
				if (values.length === 0) return false;
				value = values.reduce((a, b) => (cmpVal(a, b) < 0 === (n.q === 'min') ? a : b));
			}
		}
		return matches(
			{ value },
			{ t: 'cond', path: 'value', op: n.op, arg: taggedArg({ lit: target }) },
			clock
		);
	}
	const v =
		n.path
			.split('.')
			.reduce<Value | undefined>(
				(object, key) => (value_object(object) ? object[key] : undefined),
				row
			) ?? null;
	const a =
			n.arg !== null && 'lit' in n.arg
				? n.arg.lit
				: n.arg !== null && 'field' in n.arg
					? (row[n.arg.field] ?? null)
					: n.arg !== null && 'var' in n.arg
						? evaluated(n.arg.var, clock, typeof v === 'string' && v.includes('T'))
						: null,
		list = n.arg !== null && 'list' in n.arg ? n.arg.list : [];
	if (n.arg !== null && 'var' in n.arg && value_object(a) && 'var' in a)
		throw new Error('Resolve variables before applying this local filter.');
	switch (n.op) {
		case 'is_null':
			return v === null;
		case 'not_null':
			return v !== null;
		case 'like': {
			// a resolved variable is a whole pattern: `%` any run, `_` one character
			if (n.arg !== null && 'var' in n.arg)
				return new RegExp(
					`^${String(a)
						.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
						.replaceAll('%', '.*')
						.replaceAll('_', '.')}$`,
					'is'
				).test(String(v ?? ''));
			// the words in order, as the engine's `%w1%w2%`
			const s = String(v ?? '').toLowerCase();
			let at = 0;
			return String(a)
				.toLowerCase()
				.trim()
				.split(/\s+/)
				.every((w) => {
					const i = s.indexOf(w, at);
					if (i < 0) return false;
					at = i + w.length;
					return true;
				});
		}
		case 'eq':
			return v !== null && (v instanceof Decimal ? cmpVal(v, a) === 0 : String(v) === String(a));
		case 'ne':
			return v === null || (v instanceof Decimal ? cmpVal(v, a) !== 0 : String(v) !== String(a));
		case 'in':
			return list.some((x) => String(x) === String(v));
		case 'not_in':
			return !list.some((x) => String(x) === String(v));
		case 'gt':
			return v !== null && cmpVal(v, a) > 0;
		case 'gte':
			return v !== null && cmpVal(v, a) >= 0;
		case 'lt':
			return v !== null && cmpVal(v, a) < 0;
		case 'lte':
			return v !== null && cmpVal(v, a) <= 0;
		case 'during': {
			if (n.arg === null || !('range' in n.arg)) return false;
			const range = n.arg.range.map((value) =>
				bound(value, clock, typeof v === 'string' && v.includes('T'))
			);
			if (range.some((x) => typeof x !== 'string' && typeof x !== 'number'))
				throw new Error('Resolve relative time before applying this local filter.');
			return v !== null && cmpVal(v, range[0] ?? null) >= 0 && cmpVal(v, range[1] ?? null) < 0;
		}
		case 'has':
			return Array.isArray(v) && v.some((x) => String(x) === String(a));
		case 'has_any':
			return Array.isArray(v) && list.some((x) => v.some((y) => String(x) === String(y)));
		case 'has_all':
			return Array.isArray(v) && list.every((x) => v.some((y) => String(x) === String(y)));
		case 'is_empty':
			return v === null || v === '' || (Array.isArray(v) && v.length === 0);
		case 'not_empty':
			return !(v === null || v === '' || (Array.isArray(v) && v.length === 0));
		case 'contains':
			return typeof v === 'string' && typeof a === 'string' && v.includes(a);
		default:
			throw new Error('This filter requires the query engine.');
	}
}

/** Nulls last ascending and first descending. */
export function sortRows<R extends { readonly [f: string]: Value }>(
	rows: readonly R[],
	keys: readonly SortKey[]
): R[] {
	if (keys.length === 0) return [...rows];
	return [...rows].sort((x, y) => {
		for (const k of keys) {
			const at = (r: R) =>
				k.field
					.split('.')
					.reduce<Value | undefined>((o, f) => (value_object(o) ? o[f] : undefined), r);
			const a = at(x) ?? null,
				b = at(y) ?? null;
			const c = a === b ? 0 : a === null ? 1 : b === null ? -1 : cmpVal(a, b);
			if (c !== 0) return k.dir === 'asc' ? c : -c;
		}
		return 0;
	});
}

/** Kinds guessed from a local array's values: its columns are the only fields. */
export function localExposure(
	rows: readonly { readonly [f: string]: Value }[],
	fields: readonly string[],
	labels: (f: string) => string
): ModelExposure {
	const kindOf = (f: string): Kind => {
		const v = rows.map((r) => r[f] ?? null).find((x) => x !== null);
		if (v instanceof Decimal)
			return { kind: 'decimal', scale: v.scale, optional: true, label: labels(f) };
		return {
			kind: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'text',
			optional: true,
			label: labels(f)
		};
	};
	return {
		label: [],
		fields: Object.fromEntries(fields.filter((f) => !f.includes('.')).map((f) => [f, kindOf(f)]))
	};
}

/** The field list `filter.describe` and `filter.options` take for a `$local` view: its text, number and bool columns. */
export type LocalFilterField = {
	name: string;
	label: string;
	kind: 'text' | 'number' | 'bool';
	optional?: boolean;
};

export function localFilterFields(
	model: string,
	x: ModelExposure | undefined
): readonly LocalFilterField[] | undefined {
	if (!model.startsWith('$') || x === undefined) return undefined;
	return Object.entries(x.fields).flatMap(([name, field]) =>
		field.kind === 'text' || field.kind === 'number' || field.kind === 'bool'
			? [{ name, label: field.label ?? name, kind: field.kind, optional: field.optional === true }]
			: []
	);
}
