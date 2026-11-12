// Filter nodes and Where literals share one round-trip conversion boundary.
import { type FilterClock, varOf, type Arg, type Node, complete, type Op, jsonObject, OpSchema, AggSchema, CmpSchema, type Quant } from './node.js';
import { type Json, likePattern, isPoint } from '../kinds/kind.js';
import { compile_var, evaluate_var } from '@norbital-ai/std/vars';
import { utc_of } from '@norbital-ai/std/zone';
import { Match, Result, Schema } from 'effect';
import { encode_wire } from '@norbital-ai/std/wire';
import { type Catalog, childOf, resolve, type Resolved, INDEX, filterable } from './catalog.js';
import { type Where, input_schema } from '@norbital-ai/std/kind';
import { type FilterVariables, varError, operandsFor, valueKind, litKind, grammarOps } from './operators.js';

// ── literals ──
/** A `like` pattern as its words: an unescaped `%` inside separates them; an unescaped `_` is not text. */
const unlike = (p: string): string | null => {
	if (!/^%.*%$/s.test(p) || /(^|[^\\])(\\\\)*_/.test(p.slice(1, -1))) return null;
	return p
		.slice(1, -1)
		.split(/(?<!\\)%/)
		.map((w) => w.replace(/\\(.)/g, '$1'))
		.filter((w) => w !== '')
		.join(' ');
};

/** A `{ var }` as the literal it is at `clock` (a date on an instant position is its midnight in the zone), or as
 * itself when it reads only the requestor (the host binds it) or without a clock (the URL). */
export function evaluated(text: string, clock: FilterClock | undefined, instant: boolean): Json {
	const c = compile_var(text);
	if (clock === undefined || 'error' in c || !c.time || c.requestor.length > 0)
		return { var: text };
	const v = evaluate_var(c, clock);
	return instant && typeof v === 'string' && v.length === 10
		? new Date(utc_of(v, 0, clock.zone)).toISOString()
		: v;
}

/** A span's bound: a literal, or a variable at `clock`. */
export function bound(value: Json, clock: FilterClock | undefined, instant: boolean): Json {
	const text = varOf(value);
	return text === null ? value : evaluated(text, clock, instant);
}

// ── lowering: Node → Where ──
function operand(arg: Arg, clock: FilterClock | undefined, instant: boolean): Json {
	return Match.value(arg).pipe(
		Match.tagsExhaustive({
			lit: (value) => encode_wire(value.lit),
			list: (value) => encode_wire(value.list),
			range: (value) => value.range.map((b) => bound(b, clock, instant)),
			var: (value) => evaluated(value.var, clock, instant),
			field: (value) => ({ field: value.field })
		})
	);
}

function leafOps(
	n: Extract<Node, { t: 'cond' }>,
	clock: FilterClock | undefined,
	instant: boolean
): Json {
	const a = n.arg;
	switch (n.op) {
		case 'not_in':
			return { in: a === null ? null : operand(a, clock, instant) };
		case 'is_null':
			return { is_null: true };
		case 'not_null':
			return { is_null: false };
		case 'like':
			// a variable is the whole pattern (`'SG:' + entry.id + ':%'`); a literal is words in order
			return a !== null && a._tag === 'var'
				? { like: operand(a, clock, instant) }
				: { like: likePattern(String(a !== null && 'lit' in a ? a.lit : '')) };
		case 'search':
		case 'similar':
			return a !== null && 'lit' in a && typeof a.lit === 'string' ? a.lit : null;
		case 'during': {
			if (a === null || !('range' in a)) return null;
			return { gte: bound(a.range[0], clock, instant), lt: bound(a.range[1], clock, instant) };
		}
		default:
			return { [n.op]: a === null ? null : operand(a, clock, instant) };
	}
}

/**
 * A viewer node as a `Where` over `model`; incomplete rows lower to nothing. With `clock`, a relative value is the
 * literal it stands for now (what a read sends); without, it stays relative (the URL).
 */
function lowerWhere(cat: Catalog, model: string, n: Node, clock?: FilterClock): Where | null {
	if (!complete(n)) return null;
	if (n.t === 'group') {
		const parts = n.of
			.map((x) => lowerWhere(cat, model, x, clock))
			.filter((x): x is Where => x !== null);
		if (parts.length === 0) return null;
		const body: Where =
			parts.length === 1 && n.join === 'and' ? (parts[0] ?? {}) : { [n.join]: parts };
		return n.not ? { not: body } : body;
	}
	if (n.t === 'many') {
		const steps = n.rel.split('.'),
			name = steps.pop() ?? '';
		if (n.q === 'some' || n.q === 'none' || n.q === 'every') {
			const child = childOf(cat, model, n.rel) ?? '';
			const inner = n.of
				.map((x) => lowerWhere(cat, child, x, clock))
				.filter((x): x is Where => x !== null);
			return wrap(steps, {
				[name]: {
					[n.q]: inner.length === 0 ? {} : inner.length === 1 ? (inner[0] ?? {}) : { and: inner }
				}
			});
		}
		if (
			n.op === undefined ||
			n.n === undefined ||
			n.n === null ||
			(n.q !== 'count' && n.field === undefined)
		)
			return null;
		const cmp = { [n.op]: n.n };
		return wrap(steps, {
			[name]: { [n.q]: n.q === 'count' ? cmp : { of: n.field ?? '', ...cmp } }
		});
	}
	const r = resolve(cat, model, n.path);
	if (r === null) return null;
	const steps = n.path.split('.');
	const [name = '', arm] = (steps.pop() ?? '').split(':');
	const instant =
		r.leaf === 'field' &&
		(r.kind.kind === 'instant' || (r.kind.kind === 'period' && r.kind.of !== 'date'));
	if (n.op === 'is_empty' || n.op === 'not_empty') return wrap(steps, n.op === 'is_empty'
		? { or: [{ [name]: { is_null: true } }, { [name]: { eq: [] } }] }
		: { and: [{ [name]: { is_null: false } }, { [name]: { ne: [] } }] });
	if (n.op === 'has_any' || n.op === 'has_all') {
		if (n.arg?._tag !== 'list') return null;
		const join = n.op === 'has_all' ? 'and' : 'or';
		return wrap(steps, { [join]: n.arg.list.map((value) => ({ [name]: { has: encode_wire(value) } })) });
	}
	let body = leafOps(n, clock, instant);
	if (body === null) return null;
	// a record picked by label is sent in the `is` form (it needs the relation exposed, never its FK column); variables
	// and `is_null` stay on the FK
	if (r.leaf === 'rel' && n.arg !== null && ('lit' in n.arg || 'list' in n.arg))
		body = { is: { id: body } };
	const field = { [name]: arm === undefined ? body : { [arm]: body } };
	return wrap(steps, n.op === 'not_in' ? { not: field } : field);
}

/** A `Where` the builder can read back is the only one a read may receive. */
export function toWhere(
	cat: Catalog,
	model: string,
	n: Node,
	clock?: FilterClock,
	variables?: FilterVariables
): Where | null {
	const where = lowerWhere(cat, model, n, clock);
	return where === null || fromWhere(cat, model, where, model, '', variables) === null
		? null
		: where;
}

function wrap(steps: readonly string[], inner: Where): Where {
	return steps.reduceRight<Where>((acc, s) => {
		const [name = '', arm] = s.split(':');
		return { [name]: arm === undefined ? { is: acc } : { [arm]: { is: acc } } };
	}, inner);
}

/** The viewer's rows as one `Where` (each top-level row a conjunct, so a URL clause drops alone). */
export function rowsWhere(
	cat: Catalog,
	model: string,
	rows: readonly Node[],
	clock?: FilterClock,
	variables?: FilterVariables
): Where | null {
	const parts = rows
		.map((r) => toWhere(cat, model, r, clock, variables))
		.filter((x): x is Where => x !== null);
	return parts.length === 0 ? null : parts.length === 1 ? (parts[0] ?? {}) : { and: parts };
}

// ── parsing: Where → Node (the popover shows `initial_filter`, a URL and an AI answer as rows) ──
export function argOf(r: Resolved, op: Op, v: Json, variables?: FilterVariables): Arg | null {
	const text = varOf(v);
	if (text !== null)
		return varError(r, op, text, variables) === undefined ? { _tag: 'var', var: text } : null;
	if (
		jsonObject(v) &&
		Object.keys(v).length === 1 &&
		typeof v['field'] === 'string' &&
		operandsFor(r, op).includes('field')
	)
		return { _tag: 'field', field: v['field'] };
	if (op === 'in' || op === 'not_in' || op === 'has_any' || op === 'has_all') {
		if (!Array.isArray(v) || v.length === 0) return null;
		const k = r.leaf === 'field' ? valueKind(r.kind) : null;
		return v.every((x) =>
			k === null
				? typeof x === 'string'
				: Result.isSuccess(Schema.decodeUnknownResult(input_schema(k))(encode_wire(x)))
		)
			? { _tag: 'list', list: v }
			: null;
	}
	if (r.leaf === 'rel') return typeof v === 'string' && v !== '' ? { _tag: 'lit', lit: v } : null;
	if (v === null) return null;
	const decoded = Schema.decodeUnknownResult(input_schema(litKind(r, op)))(v);
	return decoded._tag === 'Success' ? { _tag: 'lit', lit: decoded.success } : null;
}

export function fieldNodes(
	cat: Catalog,
	model: string,
	path: string,
	ops: Json,
	variables?: FilterVariables
): Node[] | null {
	const r = resolve(cat, model, path);
	if (r === null || !jsonObject(ops) || Object.keys(ops).length === 0) return null;
	const allowed = grammarOps(r);
	const out: Node[] = [];
	let rest: { [k: string]: Json } = { ...ops };
	// a `{ gte, lt }` pair on a date or instant is one relative span (`during`); anything else is its own row
	if (
		r.leaf === 'field' &&
		(r.kind.kind === 'date' || r.kind.kind === 'instant') &&
		'gte' in rest &&
		'lt' in rest
	) {
		const from = argOf(r, 'gte', rest['gte'] ?? null, variables),
			to = argOf(r, 'lt', rest['lt'] ?? null, variables);
		if (from === null || to === null) return null;
		out.push({
			t: 'cond',
			path,
			op: 'during',
			arg: { _tag: 'range', range: [rest['gte'] ?? null, rest['lt'] ?? null] }
		});
		const { gte: _g, lt: _l, ...o } = rest;
		rest = o;
	}
	for (const [k, v] of Object.entries(rest)) {
		if (!Schema.is(OpSchema)(k)) return null;
		// the read's own spellings: null tests are booleans, and a span is the gte/lt pair above
		if (['not_null', 'is_empty', 'not_empty', 'during', 'not_in', 'has_any', 'has_all'].includes(k)) return null;
		let op: Op = k,
			arg: Arg | null = null;
		if (k === 'is_null') {
			if (typeof v !== 'boolean') return null;
			op = v ? 'is_null' : 'not_null';
		} else if (k === 'like' && varOf(v) !== null) {
			arg = argOf(r, op, v, variables);
			if (arg === null) return null;
		} else if (k === 'like') {
			const text = typeof v === 'string' ? unlike(v) : null;
			if (text === null) return null;
			arg = { _tag: 'lit', lit: text };
		} else if (k === 'near') {
			// within metres of a point (a described "near <place>"): shown, its radius editable
			const pair = Array.isArray(v) && v.length === 2 ? v : null,
				point = pair?.[0] ?? null,
				metres = pair?.[1];
			if (
				r.leaf !== 'field' ||
				r.kind.kind !== 'point' ||
				!isPoint(point) ||
				!Number.isFinite(point.lat) ||
				!Number.isFinite(point.lng) ||
				typeof metres !== 'number' ||
				!Number.isFinite(metres) ||
				metres < 0 ||
				pair === null
			)
				return null;
			arg = { _tag: 'lit', lit: pair };
		} else {
			arg = argOf(r, op, v, variables);
			if (arg === null) return null;
		}
		if (!allowed.includes(op)) return null;
		out.push({ t: 'cond', path, op, arg });
	}
	return out;
}

/** A `Where` over `root` as rows; `null` when any part names what the popover cannot show or decode would refuse.
 * `at`/`prefix` walk a one-relation's `is` body (two hops), whose rows keep paths from the root. */
export function fromWhere(
	cat: Catalog,
	root: string,
	w: Json,
	at = root,
	prefix = '',
	variables?: FilterVariables
): Node[] | null {
	const x = cat[at];
	if (!jsonObject(w) || x === undefined) return null;
	const out: Node[] = [];
	for (const [key, v] of Object.entries(w)) {
		if (key === 'and' || key === 'or') {
			if (!Array.isArray(v) || v.length === 0) return null;
			if (v.length === 2) {
				const [left, right] = v;
				const [field] = jsonObject(left) ? Object.keys(left) : [];
				const equality = key === 'or' ? 'eq' : 'ne';
				const null_test = field !== undefined && jsonObject(left) ? left[field] : undefined;
				const array_test = field !== undefined && jsonObject(right) ? right[field] : undefined;
				const empty = jsonObject(array_test) ? array_test[equality] : undefined;
				const resolved = field === undefined ? null : resolve(cat, root, prefix + field);
				if (field !== undefined && jsonObject(left) && Object.keys(left).length === 1 && jsonObject(right) && Object.keys(right).length === 1 &&
					jsonObject(null_test) && Object.keys(null_test).length === 1 && null_test['is_null'] === (key === 'or') &&
					jsonObject(array_test) && Object.keys(array_test).length === 1 && Array.isArray(empty) && empty.length === 0 &&
					resolved?.leaf === 'field' && resolved.kind.many === true && (resolved.kind.kind === 'text' || resolved.kind.kind === 'enum')) {
					out.push({ t: 'cond', path: prefix + field, op: key === 'or' ? 'is_empty' : 'not_empty', arg: null });
					continue;
				}
			}
			const of = v.map((p) => fromWhere(cat, root, p, at, prefix, variables));
			if (of.some((p) => p === null || p.length === 0)) return null;
			const flat: Node[] = of.flatMap((part): Node[] =>
				part === null ? [] : part.length === 1 ? part : [{ t: 'group', join: 'and', of: part }]
			);
			const first = flat[0];
			if (first?.t === 'cond' && first.op === 'has' && flat.every((node) => node.t === 'cond' && node.op === 'has' && node.path === first.path && node.arg?._tag === 'lit')) {
				const list = flat.flatMap((node) => node.t === 'cond' && node.arg?._tag === 'lit' ? [node.arg.lit] : []);
				out.push({ t: 'cond', path: first.path, op: key === 'and' ? 'has_all' : 'has_any', arg: { _tag: 'list', list } });
			} else if (key === 'and' && prefix === '') out.push(...flat);
			else out.push({ t: 'group', join: key, of: flat });
		} else if (key === 'not') {
			if (!jsonObject(v) || Object.keys(v).length === 0) return null;
			const of = fromWhere(cat, root, v, at, prefix, variables);
			if (of === null) return null;
			const sole = of.length === 1 ? of[0] : undefined;
			// Collapse only a leaf at this record scope. Moving `not` across `is` changes null-relation semantics.
			if (sole?.t === 'cond' && sole.op === 'in' && !sole.path.slice(prefix.length).includes('.'))
				out.push({ ...sole, op: 'not_in' });
			else if (prefix === '') out.push({ t: 'group', join: 'and', not: true, of });
			else return null;
		} else if (INDEX[key] !== undefined) {
			const path = prefix + key;
			if (typeof v !== 'string' || v.trim() === '' || resolve(cat, root, path) === null)
				return null;
			out.push({ t: 'cond', path, op: INDEX[key]?.op ?? 'search', arg: { _tag: 'lit', lit: v } });
		} else if ((x.many ?? []).includes(key)) {
			// at the root, or one relation hop on (`customer: { is: { invoices: { some } } }` is the row `customer.invoices`)
			const child = childOf(cat, at, key),
				rel = prefix + key;
			if (
				prefix.split('.').length > 2 ||
				!jsonObject(v) ||
				Object.keys(v).length === 0 ||
				child === undefined
			)
				return null;
			for (const [q, body] of Object.entries(v)) {
				if (q === 'some' || q === 'none' || q === 'every') {
					const of = fromWhere(cat, child, body, child, '', variables);
					if (of === null) return null;
					out.push({ t: 'many', rel, q, of });
				} else if (Schema.is(AggSchema)(q)) {
					if (!jsonObject(body)) return null;
					const { of: field, ...cmp } = body;
					if (Object.keys(cmp).length === 0) return null;
					for (const [op, n] of Object.entries(cmp)) {
						if (!Schema.is(CmpSchema)(op) || (typeof n !== 'number' && typeof n !== 'string'))
							return null;
						const kind = typeof field === 'string' ? cat[child]?.fields[field] : undefined;
						const date = kind?.kind === 'date' || kind?.kind === 'instant';
						const valid =
							q === 'count'
								? field === undefined && typeof n === 'number' && Number.isInteger(n) && n >= 0
								: typeof field === 'string' &&
									aggregable(cat, child, q).includes(field) &&
									(date
										? typeof n === 'string' &&
											kind !== undefined &&
											Result.isSuccess(Schema.decodeUnknownResult(input_schema(kind))(n))
										: typeof n === 'number' && Number.isFinite(n));
						if (!valid) return null;
						out.push({
							t: 'many',
							rel,
							q,
							of: [],
							op,
							n,
							...(q === 'count' ? {} : { field: typeof field === 'string' ? field : '' })
						});
					}
				} else return null;
			}
		} else if (x.relations?.[key] !== undefined) {
			const rel = x.relations[key];
			if (rel === undefined) return null;
			if (!jsonObject(v) || Object.keys(v).length === 0) return null;
			const arms: [string | null, Json][] =
				rel.targets.length > 1 ? Object.entries(v) : [[null, v]];
			for (const [arm, body] of arms) {
				if (arm !== null && !rel.targets.includes(arm)) return null;
				const path = prefix + (arm === null ? key : `${key}:${arm}`);
				if (!jsonObject(body) || Object.keys(body).length === 0) return null;
				let nodes: Node[] | null;
				if ('is' in body) {
					const is = body['is'];
					if (Object.keys(body).length !== 1 || !jsonObject(is) || Object.keys(is).length === 0) return null;
					if ('id' in is && Object.keys(is).length !== 1) return null;
					const idOps = Object.keys(is).length === 1 && jsonObject(is['id']) ? is['id'] : null;
					nodes =
						idOps !== null && Object.keys(idOps).every((k) => ['eq', 'ne', 'in'].includes(k))
							? fieldNodes(cat, root, path, idOps, variables)
							: path.split('.').length > 2
								? null
								: fromWhere(cat, root, is, arm ?? rel.targets[0] ?? '', `${path}.`, variables);
				} else nodes = fieldNodes(cat, root, path, body, variables);
				if (nodes === null) return null;
				out.push(...nodes);
			}
		} else {
			const nodes = fieldNodes(cat, root, prefix + key, v, variables);
			if (nodes === null) return null;
			out.push(...nodes);
		}
	}
	return out;
}

/** Child fields a many-relation aggregate may name (§3.3.9: numbers; `min`/`max` also dates). */
function aggregable(cat: Catalog, child: string, q: Quant): string[] {
	const x = cat[child];
	if (x === undefined) return [];
	const ok = new Set([
		'int',
		'decimal',
		'money',
		'number',
		...(q === 'min' || q === 'max' ? ['date', 'instant'] : [])
	]);
	return Object.keys(x.fields).filter(
		(f) =>
			filterable(x, f) &&
			x.fields[f] !== undefined &&
			ok.has(x.fields[f].kind) &&
			!('many' in x.fields[f] && x.fields[f].many)
	);
}

/** Top-level conjuncts: each is kept or dropped alone. */
export const clauses = (w: Json): Json[] =>
	!jsonObject(w) || Object.keys(w).length === 0
		? []
		: Object.keys(w).length === 1 && Array.isArray(w['and'])
			? [...w['and']]
			: Object.entries(w).map(([k, v]) => ({ [k]: v }));
