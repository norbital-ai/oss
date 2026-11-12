// Changing a filter field, operator or quantifier retains only representable input.
import { type Resolved, type Catalog, resolve, type Offer, type FilterStep, childOf, manyOffers } from './catalog.js';
import { CmpSchema, type Op, type Node, type Arg, type Quant } from './node.js';
import { litKind, type FilterVariables, varError, operandsFor, fieldsFor, operatorsFor, valueKind } from './operators.js';
import { argOf, fieldNodes } from './where.js';
import { encode_wire } from '@norbital-ai/std/wire';
import { Result, Schema } from 'effect';
import { input_schema } from '@norbital-ai/std/kind';

const valueFamily = (r: Resolved, op: Op): string => {
	if (r.leaf === 'rel') return `rel:${[...r.targets].sort().join(',')}`;
	const k = litKind(r, op).kind;
	if (['text', 'enum', 'state'].includes(k)) return 'text';
	return ['int', 'number', 'decimal', 'money', 'sum', 'count'].includes(k) ? 'number' : k;
};

/** Keep an input only when the destination can represent all of it. */
function retainedArg(
	cat: Catalog,
	model: string,
	before: Extract<Node, { t: 'cond' }>,
	path: string,
	op: Op,
	variables?: FilterVariables
): Arg | null {
	const from = resolve(cat, model, before.path),
		to = resolve(cat, model, path),
		arg = before.arg;
	if (
		from === null ||
		to === null ||
		arg === null ||
		['is_null', 'not_null', 'is_empty', 'not_empty'].includes(op)
	)
		return null;
	if (arg._tag === 'var') return varError(to, op, arg.var, variables) === undefined ? arg : null;
	if (arg._tag === 'field')
		return operandsFor(to, op).includes('field') && fieldsFor(cat, model, path).includes(arg.field)
			? arg
			: null;
	if (valueFamily(from, before.op) !== valueFamily(to, op)) return null;
	if (arg._tag === 'range')
		return op === 'during' && arg.range.every((v) => argOf(to, 'eq', v, variables) !== null)
			? arg
			: null;
	if (op === 'during') return null;
	if (op === 'near' && arg._tag === 'lit') {
		const n = fieldNodes(cat, model, path, { near: encode_wire(arg.lit) })?.[0];
		return n?.t === 'cond' ? n.arg : null;
	}
	const list = ['in', 'not_in', 'has_any', 'has_all'].includes(op);
	if (list) return argOf(to, op, encode_wire(arg._tag === 'list' ? arg.list : [arg.lit]));
	if (arg._tag === 'list')
		return arg.list.length === 1 ? argOf(to, op, encode_wire(arg.list[0] ?? null)) : null;
	return argOf(to, op, encode_wire(arg.lit));
}

/** Field, operator and value move together; unrelated rows are never changed. */
export function selectField(
	cat: Catalog,
	model: string,
	node: Node,
	path: string,
	many: boolean,
	offers: readonly Offer[],
	prefix: readonly FilterStep[] = [],
	variables?: FilterVariables
): Node {
	if (many && childOf(cat, model, path) === undefined) return node;
	if (many)
		return node.t === 'many' && node.rel === path
			? node
			: { t: 'many', rel: path, q: 'some', of: [] };
	const r = resolve(cat, model, path);
	if (r === null) return node;
	const ops = operatorsFor(offers, prefix, path, r);
	const op = node.t === 'cond' && ops.some((o) => o.op === node.op) ? node.op : ops[0]?.op;
	if (op === undefined) return node;
	if (node.t === 'cond' && node.path === path && node.op === op) return node;
	return {
		t: 'cond',
		path,
		op,
		arg: node.t === 'cond' ? retainedArg(cat, model, node, path, op, variables) : null
	};
}

export function selectOperator(
	cat: Catalog,
	model: string,
	node: Extract<Node, { t: 'cond' }>,
	op: Op,
	offers: readonly Offer[],
	prefix: readonly FilterStep[] = [],
	variables?: FilterVariables
): Extract<Node, { t: 'cond' }> {
	const r = resolve(cat, model, node.path);
	if (
		r === null ||
		op === node.op ||
		!operatorsFor(offers, prefix, node.path, r).some((o) => o.op === op)
	)
		return node;
	return { ...node, op, arg: retainedArg(cat, model, node, node.path, op, variables) };
}

export function aggregateValue(
	cat: Catalog,
	child: string,
	q: Quant,
	field: string | undefined,
	value: number | string | null | undefined
): number | string | null {
	if (value === undefined || value === null) return null;
	if (q === 'count')
		return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
	const kind = field === undefined ? undefined : cat[child]?.fields[field];
	if (kind === undefined) return null;
	if (
		['date', 'instant'].includes(kind.kind)
			? typeof value !== 'string'
			: typeof value !== 'number' || !Number.isFinite(value)
	)
		return null;
	return Result.isSuccess(Schema.decodeUnknownResult(input_schema(valueKind(kind)))(value))
		? value
		: null;
}

const endStep = (o: Offer): FilterStep | undefined => o.path.at(-1);

/** The aggregate function an offer names, or null for a field/count offer. */
export const aggFn = (o: Offer): Quant | null => {
	const step = endStep(o);
	return step?.k === 'agg' ? step.fn : null;
};

/** The child field an aggregate offer summarises. */
export const aggOf = (o: Offer): string | null => {
	const step = endStep(o);
	return step?.k === 'agg' ? step.of : null;
};

/** Move a many-relation scope to another quantifier, keeping only values the new quantifier can carry. */
export function selectQuantifier(
	cat: Catalog,
	model: string,
	offers: readonly Offer[],
	prefix: readonly FilterStep[],
	m: Extract<Node, { t: 'many' }>,
	q: Quant
): Extract<Node, { t: 'many' }> {
	if (q === m.q) return m;
	if (q === 'some' || q === 'none' || q === 'every') return { t: 'many', rel: m.rel, q, of: m.of };
	const mo = manyOffers(offers, prefix, m.rel);
	const at = q === 'count' ? mo.count : mo.aggs.filter((o) => aggFn(o) === q);
	const first = at[0];
	if (first === undefined) return m;
	const field =
		q === 'count'
			? undefined
			: at.some((o) => aggOf(o) === m.field)
				? m.field
				: (aggOf(first) ?? undefined);
	const fieldOffers = q === 'count' ? at : at.filter((o) => aggOf(o) === field);
	const comparisons = fieldOffers.map((offer) => offer.op).filter(Schema.is(CmpSchema));
	const op = m.op !== undefined && comparisons.includes(m.op) ? m.op : comparisons[0];
	if (op === undefined) return m;
	return {
		t: 'many',
		rel: m.rel,
		q,
		of: [],
		op,
		n: aggregateValue(cat, childOf(cat, model, m.rel) ?? '', q, field, m.n),
		...(field === undefined ? {} : { field })
	};
}
