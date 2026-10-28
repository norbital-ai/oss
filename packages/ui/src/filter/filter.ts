import { Match, Predicate, Result, Schema } from 'effect';
import { inputSchema, type Value } from '@norbital-ai/std/kind';
import { Decimal } from '@norbital-ai/std/decimal';
import { encodeWire } from '@norbital-ai/std/wire';
import { utcOf } from '@norbital-ai/std/zone';
import { compileVar, evaluateVar, memberAdmits, type VarResult } from '@norbital-ai/std/vars';
import { likePattern } from '../kinds/kind.js';
import { sortable as kindSortable } from '../kinds/registry.js';
// The view popover's typed model (rule 16b, P34): filter rows that mirror `Where` (§3.3.9) and can only lower to a
// decodable one, sort keys that are an `OrderBy`, and their URL form. Pure: no DOM, no relative value imports.
import type { ModelExposure } from '../kinds/context.js';
import type { Json, Kind } from '../kinds/kind.js';

/** A `Where` literal (§3.3.9). ui has no bolt dependency, so it is structural here; `$bolt` narrows it to `Where<C>`. */
export type Where = { readonly [key: string]: Json };
/** A sort key; `near` orders by distance from that point, nearest first (a point field). */
export type SortKey = { field: string; dir: 'asc' | 'desc'; near?: { lat: number; lng: number } };
/** One `OrderBy` key object: `{ field: dir }`, or through a one-relation `{ account: { name: dir } }`. */
type SortObject = { readonly [field: string]: 'asc' | 'desc' | SortObject };
/** An `OrderBy` literal: a field, a key object, or up to 4 of them. */
export type OrderBy = string | SortObject | readonly (string | SortObject)[];
type Catalog = { readonly [model: string]: ModelExposure };

export type Cmp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
export type Op =
	| Cmp
	| 'in'
	| 'nin'
	| 'like'
	| 'isNull'
	| 'notNull'
	| 'has'
	| 'hasAny'
	| 'hasAll'
	| 'isEmpty'
	| 'notEmpty'
	| 'during'
	| 'contains'
	| 'overlaps'
	| 'within'
	| 'near'
	| 'search'
	| 'similar';
const OpSchema = Schema.Literals([
	'eq',
	'ne',
	'lt',
	'lte',
	'gt',
	'gte',
	'in',
	'nin',
	'like',
	'isNull',
	'notNull',
	'has',
	'hasAny',
	'hasAll',
	'isEmpty',
	'notEmpty',
	'during',
	'contains',
	'overlaps',
	'within',
	'near',
	'search',
	'similar'
]);
const CmpSchema = Schema.Literals(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']);
const AggSchema = Schema.Literals(['count', 'sum', 'min', 'max', 'avg']);
/** A model's search index (`$search`: every word) and embedding (`$similar`: nearest in meaning) as condition keys. */
export const INDEX: { readonly [key: string]: { op: 'search' | 'similar'; label: string } } = {
	$search: { op: 'search', label: 'Search' },
	$similar: { op: 'similar', label: 'Topic' }
};
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
const varOf = (value: Json | Value): string | null =>
	Predicate.isObject(value) &&
	keysOf(value).length === 1 &&
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
export type Quant = 'some' | 'none' | 'every' | 'count' | 'sum' | 'min' | 'max' | 'avg';

// ── the engine's condition catalogue (rule 16b): the builder renders exactly these, never a second operator table ──
/** One step of an offered condition's nesting from the model root (bolt's `FilterStep`, structurally). */
export type FilterStep =
	| { k: 'field'; name: string }
	| { k: 'is'; rel: string }
	| { k: 'arm'; rel: string; arm: string }
	| { k: 'some' | 'every' | 'none'; rel: string }
	| { k: 'count'; rel: string }
	| { k: 'agg'; rel: string; fn: 'sum' | 'avg' | 'min' | 'max'; of: string };
/** One offered (field, operator) pair as the host's `filter.options` returns it. */
export type Offer = {
	label: string;
	path: readonly FilterStep[];
	op: string;
	opLabel: string;
	kind: string;
	values?: readonly { label: string; arg: RawArg }[];
	sort?: string;
};
const stepName = (s: FilterStep): string =>
	s.k === 'field' ? s.name : s.k === 'arm' ? `${s.rel}:${s.arm}` : s.rel;
/** Whether two steps are the same: a field's name, an arc's relation and arm, a relation's kind and name. */
const sameStep = (a: FilterStep, b: FilterStep): boolean =>
	a.k === 'field' || b.k === 'field'
		? a.k === 'field' && b.k === 'field' && a.name === b.name
		: a.k === 'arm' || b.k === 'arm'
			? a.k === 'arm' && b.k === 'arm' && a.rel === b.rel && a.arm === b.arm
			: a.k === b.k && a.rel === b.rel;
export const pathOf = (steps: readonly FilterStep[]): string => steps.map(stepName).join('.');
/** An offer's steps within a context (`prefix` steps from the root), or `null` when it belongs to another context. */
export function within(offer: Offer, prefix: readonly FilterStep[]): readonly FilterStep[] | null {
	if (offer.path.length < prefix.length) return null;
	return prefix.every((s, i) => offer.path[i] !== undefined && sameStep(s, offer.path[i]))
		? offer.path.slice(prefix.length)
		: null;
}
/** The catalogue paths a picker offers in a context: offered condition paths, and the many-relations to expand. */
export function offeredPaths(
	offers: readonly Offer[],
	prefix: readonly FilterStep[]
): { conditions: Set<string>; many: Set<string> } {
	const conditions = new Set<string>(),
		many = new Set<string>();
	for (const o of offers) {
		const rest = within(o, prefix);
		const first = rest?.[0];
		if (first === undefined) continue;
		if (first.k === 'some' || first.k === 'every' || first.k === 'none') many.add(first.rel);
		else if (first.k === 'count' || first.k === 'agg') many.add(first.rel);
		else conditions.add(pathOf(rest ?? []));
	}
	return { conditions, many };
}
/** The offers for one condition path in a context: its operators, labels, values and literal kind. */
export function offersFor(
	offers: readonly Offer[],
	prefix: readonly FilterStep[],
	path: string
): readonly Offer[] {
	return offers.filter((o) => {
		const rest = within(o, prefix);
		return (
			rest !== null &&
			(rest.at(-1)?.k === 'field' || rest.at(-1)?.k === 'is' || rest.at(-1)?.k === 'arm') &&
			pathOf(rest) === path
		);
	});
}
/** What a many-relation offers in a context: its count and aggregate comparisons, and the aggregate child fields. */
export function manyOffers(
	offers: readonly Offer[],
	at: readonly FilterStep[],
	path: string
): { all: boolean; count: readonly Offer[]; aggs: readonly Offer[] } {
	const { prefix, name: rel } = manyAt(at, path);
	const count: Offer[] = [],
		aggs: Offer[] = [];
	let all = false;
	for (const o of offers) {
		const rest = within(o, prefix);
		const [first, second] = [rest?.[0], rest?.[1]];
		if (first === undefined) continue;
		if ((first.k === 'some' || first.k === 'every' || first.k === 'none') && first.rel === rel)
			all = true;
		else if (first.k === 'count' && first.rel === rel) count.push(o);
		else if (first.k === 'agg' && first.rel === rel && second === undefined) aggs.push(o);
	}
	return { all, count, aggs };
}
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
			n?: number | null;
	  };

/** A many-relation's child model: the one whose relation to its owner declares it as `inverse`; `rel` may be
 * reached through one-relations (`customer.invoices`). */
export function childOf(cat: Catalog, model: string, rel: string): string | undefined {
	const steps = rel.split('.'),
		name = steps.pop() ?? '';
	const owner = steps.reduce<string | undefined>(
		(c, s) => (c === undefined ? undefined : cat[c]?.relations?.[s]?.targets[0]),
		model
	);
	if (owner === undefined || !(cat[owner]?.many ?? []).includes(name)) return undefined;
	return Object.keys(cat).find((c) =>
		Object.values(cat[c]?.relations ?? {}).some(
			(r) => r.inverse === name && r.targets.includes(owner)
		)
	);
}
/** The catalogue steps to a many-relation row's own options: the one-relations it is reached through, then itself. */
export const manyAt = (
	prefix: readonly FilterStep[],
	rel: string
): { prefix: FilterStep[]; name: string } => {
	const steps = rel.split('.'),
		name = steps.pop() ?? '';
	return { prefix: [...prefix, ...steps.map((r) => ({ k: 'is' as const, rel: r }))], name };
};
const keysOf = (v: object) => Object.keys(v);

// ── the field tree ──
/** What a path ends on: a field of a kind, or a one-relation (a record condition). */
export type Resolved =
	| { leaf: 'field'; kind: Kind; nullable: boolean; label: string }
	| { leaf: 'rel'; targets: readonly string[]; nullable: boolean; label: string };
const RESERVED = new Set(['and', 'or', 'not']);
/** Fields a viewer may filter on: readable, not hidden, not masked (rule 16a narrowing). */
export const filterable = (x: ModelExposure, f: string) =>
	!RESERVED.has(f) &&
	x.fields[f] !== undefined &&
	!x.fields[f]?.hidden &&
	!(x.masked ?? []).includes(f);
const SYS: { readonly [f: string]: Kind } = {
	created_at: { kind: 'instant' },
	updated_at: { kind: 'instant' }
};

export function resolve(cat: Catalog, model: string, path: string): Resolved | null {
	const steps = path.split('.');
	let c = model;
	for (let i = 0; i < steps.length; i++) {
		const x = cat[c];
		if (x === undefined) return null;
		const [name = '', arm] = (steps[i] ?? '').split(':');
		const rel = x.relations?.[name];
		const last = i === steps.length - 1;
		if (rel !== undefined && !(x.masked ?? []).includes(name)) {
			const targets = arm === undefined ? rel.targets : rel.targets.includes(arm) ? [arm] : [];
			if (targets.length === 0 || (rel.targets.length > 1 && arm === undefined)) return null; // an arc is named by its arm
			if (last)
				return { leaf: 'rel', targets, nullable: rel.optional === true, label: rel.label ?? name };
			if (i >= 2) return null; // two hops, as today's builder
			const target = targets[0];
			if (target === undefined) return null;
			c = target;
			continue;
		}
		if (!last || arm !== undefined) return null;
		if (INDEX[name] !== undefined)
			return (name === '$search' ? (x.search?.length ?? 0) > 0 : x.semantic === true)
				? {
						leaf: 'field',
						kind: { kind: 'text' },
						nullable: false,
						label: INDEX[name]?.label ?? name
					}
				: null;
		const kind =
			(c.startsWith('$') ? undefined : SYS[name]) ??
			(filterable(x, name) ? x.fields[name] : undefined); // `$local`: no system columns
		return kind === undefined
			? null
			: { leaf: 'field', kind, nullable: kind.optional === true, label: kind.label ?? name };
	}
	return null;
}

/** The kind a condition's literal is edited and checked as: state → its states, derived numbers → numbers. */
export function valueKind(k: Kind): Kind {
	if (k.kind === 'state') return { kind: 'enum', values: Object.keys(k.states) };
	if ((k.kind === 'text' || k.kind === 'enum') && k.many) {
		const { many: _, ...scalar } = k;
		return scalar;
	}
	if (k.kind === 'seq') return k.pattern === undefined ? { kind: 'int' } : { kind: 'text' };
	if (k.kind === 'sum' || k.kind === 'count' || k.kind === 'money') return { kind: 'number' };
	return k;
}
/** The kind of value a variable must produce in a value position, or `null` where none is taken (§3.3.9 `Dyn`). */
function varResult(r: Resolved, op: Op): VarResult | null {
	if (op === 'in' || op === 'nin') return 'list';
	if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains'].includes(op)) return null;
	if (r.leaf === 'rel') return op === 'eq' || op === 'ne' ? 'text' : null;
	if (op === 'contains' && r.kind.kind !== 'period') return null;
	const k = r.kind.kind === 'period' ? (r.kind.of === 'date' ? 'date' : 'instant') : r.kind.kind;
	return k === 'date' ? 'date' : k === 'instant' ? 'instant' : 'text';
}
/** The field a variable's requestor members are admitted against (std/vars `memberAdmits`). */
const varField = (r: Resolved) =>
	r.leaf === 'rel'
		? { kind: 'id', of: r.targets[0] }
		: {
				kind: r.kind.kind,
				email: r.kind.kind === 'text' && r.kind.format === 'email',
				phone: r.kind.kind === 'text' && r.kind.format === 'phone',
				team: r.kind.kind === 'text' && r.kind.format === 'team'
			};
/** Why `text` is not a variable this position takes, or `undefined` when it is. An instant position takes a date too
 * (that day's midnight in the workspace zone). */
export function varError(r: Resolved, op: Op, text: string): string | undefined {
	const want = varResult(r, op);
	if (want === null) return 'this condition takes no variable';
	let c = compileVar(text, want);
	if ('error' in c && want === 'instant') {
		const day = compileVar(text, 'date');
		if (!('error' in day)) c = day;
	}
	if ('error' in c) return c.error;
	const f = varField(r);
	const refused = c.requestor.find((m) => !memberAdmits(f, m));
	return refused === undefined
		? undefined
		: `requestor.${refused} does not compare with this field`;
}
/** The `@` presets a value position offers: requestor members and clock expressions its kind admits. */
const PRESETS = [
	'requestor.id',
	'requestor.email',
	'requestor.phone',
	'requestor.party',
	'requestor.teams',
	'requestor.teamTree',
	'today',
	'today - days(7)',
	'startOfWeek(today)',
	'startOfMonth(today)',
	'now',
	'now - hours(1)'
];
export const variablesFor = (r: Resolved, op: Op): readonly { name: string; arg: Arg }[] =>
	// the requestor's id names a member record: offered on a link, though a ported text column may compare with it
	PRESETS.filter(
		(text) => varError(r, op, text) === undefined && (text !== 'requestor.id' || r.leaf === 'rel')
	).map((text) => ({
		name: variableName(text),
		arg: { _tag: 'var', var: text }
	}));
/** A variable's chip text: `requestor` for the requestor's id, else the expression itself. */
const variableName = (text: string): string => (text === 'requestor.id' ? 'requestor' : text);
/** The variable a value is (`requestor`, `today - days(7)`), or `undefined` for a literal or another operand. */
export const variableOf = (arg: Arg | null): string | undefined =>
	arg !== null && arg._tag === 'var' ? variableName(arg.var) : undefined;
/** The operand choices of a value position: a literal, a variable, a same-row field. */
export function operandsFor(r: Resolved, op: Op): ('lit' | 'var' | 'field')[] {
	return [
		'lit',
		...(variablesFor(r, op).length > 0 ? ['var' as const] : []),
		...(r.leaf === 'field' && ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(op)
			? ['field' as const]
			: [])
	];
}
/** The same-row fields a `{ field }` operand at `path` may name: the same kind, beside it on its model. */
export function fieldsFor(cat: Catalog, model: string, path: string): readonly string[] {
	if (path.includes('.')) return [];
	const r = resolve(cat, model, path);
	if (r === null || r.leaf !== 'field') return [];
	const kind = valueKind(r.kind).kind;
	return Object.keys(cat[model]?.fields ?? {}).filter((f) => {
		if (f === path) return false;
		const o = resolve(cat, model, f);
		return o !== null && o.leaf === 'field' && valueKind(o.kind).kind === kind;
	});
}
export const argKind = (arg: Arg | null): 'lit' | 'list' | 'range' | 'var' | 'field' =>
	arg === null ? 'lit' : arg._tag;

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
const isPoint = (v: Json): v is { lat: number; lng: number } =>
	Predicate.isObject(v) && typeof v['lat'] === 'number' && typeof v['lng'] === 'number';
/** A radius as words: "500 m", "1.5 km". */
export const radiusText = (m: number) =>
	m >= 1000 ? `${Math.round(m / 100) / 10} km` : `${Math.round(m)} m`;
const pointText = (p: { lat: number; lng: number }) => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;

// ── variables at the page's clock ──
/** What a time variable resolves against: the page's `bolt.clock('day')` and the workspace zone. */
export type FilterClock = { readonly today: string; readonly now: string; readonly zone: string };
/** A `{ var }` as the literal it is at `clock` (a date on an instant position is its midnight in the zone), or as
 * itself when it reads only the requestor (the host binds it) or without a clock (the URL). */
function evaluated(text: string, clock: FilterClock | undefined, instant: boolean): Json {
	const c = compileVar(text);
	if (clock === undefined || 'error' in c || !c.time || c.requestor.length > 0)
		return { var: text };
	const v = evaluateVar(c, clock);
	return instant && typeof v === 'string' && v.length === 10
		? new Date(utcOf(v, 0, clock.zone)).toISOString()
		: v;
}
/** A span's bound: a literal, or a variable at `clock`. */
function bound(value: Json, clock: FilterClock | undefined, instant: boolean): Json {
	const text = varOf(value);
	return text === null ? value : evaluated(text, clock, instant);
}

// ── lowering: Node → Where ──
function operand(arg: Arg, clock: FilterClock | undefined, instant: boolean): Json {
	return Match.value(arg).pipe(
		Match.tagsExhaustive({
			lit: (value) => encodeWire(value.lit),
			list: (value) => encodeWire(value.list),
			range: (value) => value.range.map((b) => bound(b, clock, instant)),
			var: (value) => evaluated(value.var, clock, instant),
			field: (value) => ({ field: value.field })
		})
	);
}
/** Whether a condition is complete (an incomplete row is shown but not sent). */
export function complete(n: Node): boolean {
	if (n.t === 'group') return n.of.some(complete);
	if (n.t === 'many')
		return ['some', 'none', 'every'].includes(n.q)
			? true
			: n.op !== undefined &&
					typeof n.n === 'number' &&
					Number.isFinite(n.n) &&
					(n.q === 'count' ? Number.isInteger(n.n) && n.n >= 0 : n.field !== undefined);
	if (['isNull', 'notNull', 'isEmpty', 'notEmpty'].includes(n.op)) return true;
	const a = n.arg;
	if (a === null) return false;
	if ('lit' in a) return a.lit !== null && a.lit !== '';
	if ('list' in a) return a.list.length > 0;
	return true;
}
function leafOps(
	n: Extract<Node, { t: 'cond' }>,
	clock: FilterClock | undefined,
	instant: boolean
): Json {
	const a = n.arg;
	switch (n.op) {
		case 'isNull':
			return { isNull: true };
		case 'notNull':
			return { isNull: false };
		case 'isEmpty':
			return { isEmpty: true };
		case 'notEmpty':
			return { isEmpty: false };
		case 'like':
			return { like: likePattern(String(a !== null && 'lit' in a ? a.lit : '')) };
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
export function toWhere(cat: Catalog, model: string, n: Node, clock?: FilterClock): Where | null {
	if (!complete(n)) return null;
	if (n.t === 'group') {
		const parts = n.of
			.map((x) => toWhere(cat, model, x, clock))
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
				.map((x) => toWhere(cat, child, x, clock))
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
	let body = leafOps(n, clock, instant);
	if (body === null) return null;
	// a record picked by label is sent in the `is` form (it needs the relation exposed, never its FK column); variables
	// and `isNull` stay on the FK
	if (r.leaf === 'rel' && n.arg !== null && ('lit' in n.arg || 'list' in n.arg))
		body = { is: { id: body } };
	return wrap(steps, { [name]: arm === undefined ? body : { [arm]: body } });
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
	clock?: FilterClock
): Where | null {
	const parts = rows
		.map((r) => toWhere(cat, model, r, clock))
		.filter((x): x is Where => x !== null);
	return parts.length === 0 ? null : parts.length === 1 ? (parts[0] ?? {}) : { and: parts };
}

// ── parsing: Where → Node (the popover shows `initialFilter`, a URL and an AI answer as rows) ──
function argOf(r: Resolved, op: Op, v: Json): Arg | null {
	const text = varOf(v);
	if (text !== null) return varError(r, op, text) === undefined ? { _tag: 'var', var: text } : null;
	if (
		Predicate.isObject(v) &&
		keysOf(v).length === 1 &&
		typeof v['field'] === 'string' &&
		operandsFor(r, op).includes('field')
	)
		return { _tag: 'field', field: v['field'] };
	if (op === 'in' || op === 'nin' || op === 'hasAny' || op === 'hasAll') {
		if (!Array.isArray(v) || v.length === 0) return null;
		const k = r.leaf === 'field' ? valueKind(r.kind) : null;
		return v.every((x) =>
			k === null
				? typeof x === 'string'
				: Result.isSuccess(Schema.decodeUnknownResult(inputSchema(k))(encodeWire(x)))
		)
			? { _tag: 'list', list: v }
			: null;
	}
	if (r.leaf === 'rel') return typeof v === 'string' && v !== '' ? { _tag: 'lit', lit: v } : null;
	const k: Kind =
		op === 'contains' && r.kind.kind === 'period'
			? { kind: r.kind.of }
			: op === 'contains' && r.kind.kind === 'json'
				? r.kind
				: valueKind(r.kind);
	if (v === null) return null;
	const decoded = Schema.decodeUnknownResult(inputSchema(k))(v);
	return decoded._tag === 'Success' ? { _tag: 'lit', lit: decoded.success } : null;
}
function fieldNodes(cat: Catalog, model: string, path: string, ops: Json): Node[] | null {
	const r = resolve(cat, model, path);
	if (r === null || !Predicate.isObject(ops) || keysOf(ops).length === 0) return null;
	const out: Node[] = [];
	let rest: { [k: string]: Json } = { ...ops };
	// a `{ gte, lt }` pair on a date or instant is one relative span (`during`); anything else is its own row
	if (
		r.leaf === 'field' &&
		(r.kind.kind === 'date' || r.kind.kind === 'instant') &&
		'gte' in rest &&
		'lt' in rest
	) {
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
		let op: Op = k,
			arg: Arg | null = null;
		if (k === 'isNull' || k === 'isEmpty') {
			if (typeof v !== 'boolean') return null;
			op = k === 'isNull' ? (v ? 'isNull' : 'notNull') : v ? 'isEmpty' : 'notEmpty';
		} else if (k === 'like') {
			const text = typeof v === 'string' ? unlike(v) : null;
			if (text === null) return null;
			arg = { _tag: 'lit', lit: text };
		} else if (k === 'near') {
			// within metres of a point (a described "near <place>"): shown, its radius editable
			if (
				r.leaf !== 'field' ||
				r.kind.kind !== 'point' ||
				!Array.isArray(v) ||
				v.length !== 2 ||
				!isPoint(v[0] ?? null) ||
				typeof v[1] !== 'number'
			)
				return null;
			arg = { _tag: 'lit', lit: v };
		} else {
			arg = argOf(r, op, v);
			if (arg === null) return null;
		}
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
	prefix = ''
): Node[] | null {
	const x = cat[at];
	if (!Predicate.isObject(w) || x === undefined) return null;
	const out: Node[] = [];
	for (const [key, v] of Object.entries(w)) {
		if (key === 'and' || key === 'or') {
			if (!Array.isArray(v) || v.length === 0) return null;
			const of = v.map((p) => fromWhere(cat, root, p, at, prefix));
			if (of.some((p) => p === null || p.length === 0)) return null;
			const flat: Node[] = of.flatMap((part): Node[] =>
				part === null ? [] : part.length === 1 ? part : [{ t: 'group', join: 'and', of: part }]
			);
			if (key === 'and' && prefix === '') out.push(...flat);
			else out.push({ t: 'group', join: key, of: flat });
		} else if (key === 'not') {
			// `is: { not }` differs from `not: { is }` on a null relation: only the root form is a row
			if (prefix !== '' || !Predicate.isObject(v) || keysOf(v).length === 0) return null;
			const of = fromWhere(cat, root, v);
			if (of === null) return null;
			out.push({ t: 'group', join: 'and', not: true, of });
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
				!Predicate.isObject(v) ||
				keysOf(v).length === 0 ||
				child === undefined
			)
				return null;
			for (const [q, body] of Object.entries(v)) {
				if (q === 'some' || q === 'none' || q === 'every') {
					const of = fromWhere(cat, child, body);
					if (of === null) return null;
					out.push({ t: 'many', rel, q, of });
				} else if (Schema.is(AggSchema)(q)) {
					if (!Predicate.isObject(body)) return null;
					const { of: field, ...cmp } = body;
					const [op, n] = Object.entries(cmp)[0] ?? [];
					if (keysOf(cmp).length !== 1 || !Schema.is(CmpSchema)(op) || typeof n !== 'number')
						return null;
					if (
						q === 'count'
							? field !== undefined || !Number.isInteger(n) || n < 0
							: typeof field !== 'string' || !aggregable(cat, child, q).includes(field)
					)
						return null;
					out.push({
						t: 'many',
						rel,
						q,
						of: [],
						op,
						n,
						...(q === 'count' ? {} : { field: typeof field === 'string' ? field : '' })
					});
				} else return null;
			}
		} else if (x.relations?.[key] !== undefined) {
			const rel = x.relations[key];
			if (rel === undefined) return null;
			if (!Predicate.isObject(v) || keysOf(v).length === 0) return null;
			const arms: [string | null, Json][] =
				rel.targets.length > 1 ? Object.entries(v) : [[null, v]];
			for (const [arm, body] of arms) {
				if (arm !== null && !rel.targets.includes(arm)) return null;
				const path = prefix + (arm === null ? key : `${key}:${arm}`);
				if (!Predicate.isObject(body) || keysOf(body).length === 0) return null;
				let nodes: Node[] | null;
				if ('is' in body) {
					const is = body['is'];
					if (keysOf(body).length !== 1 || !Predicate.isObject(is) || keysOf(is).length === 0)
						return null;
					const idOps = keysOf(is).length === 1 && Predicate.isObject(is['id']) ? is['id'] : null;
					nodes =
						idOps !== null && keysOf(idOps).every((k) => ['eq', 'ne', 'in', 'nin'].includes(k))
							? fieldNodes(cat, root, path, idOps)
							: path.split('.').length > 2
								? null
								: fromWhere(cat, root, is, arm ?? rel.targets[0] ?? '', `${path}.`);
				} else nodes = fieldNodes(cat, root, path, body);
				if (nodes === null) return null;
				out.push(...nodes);
			}
		} else {
			const nodes = fieldNodes(cat, root, prefix + key, v);
			if (nodes === null) return null;
			out.push(...nodes);
		}
	}
	return out;
}

/** Child fields a many-relation aggregate may name (§3.3.9: numbers and durations; `min`/`max` also dates). */
function aggregable(cat: Catalog, child: string, q: Quant): string[] {
	const x = cat[child];
	if (x === undefined) return [];
	const ok = new Set([
		'int',
		'decimal',
		'money',
		'duration',
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
	!Predicate.isObject(w) || keysOf(w).length === 0
		? []
		: keysOf(w).length === 1 && Array.isArray(w['and'])
			? [...w['and']]
			: Object.entries(w).map(([k, v]) => ({ [k]: v }));

// ── sorting ──
/** `Sortable<C>`: readable, unmasked, ordered fields and `created_at`/`updated_at` (§3.3.9); with the catalog, also each
 * unmasked one-relation's target fields the viewer reads (`account.name`, shown "Account › Name"), one hop. */
export function sortable(x: ModelExposure | undefined, system = true, cat?: Catalog): string[] {
	if (x === undefined) return [];
	const own = Object.keys(x.fields).filter(
		(f) => filterable(x, f) && x.fields[f] !== undefined && kindSortable(x.fields[f])
	);
	const related =
		cat === undefined
			? []
			: Object.entries(x.relations ?? {}).flatMap(([r, rel]) => {
					const t = rel.targets.length === 1 ? cat[rel.targets[0] ?? ''] : undefined;
					return t === undefined || (x.masked ?? []).includes(r)
						? []
						: sortable(t, false)
								.filter((f) => t.relations?.[f] === undefined)
								.map((f) => `${r}.${f}`);
				});
	return [
		...own,
		...(system ? ['created_at', 'updated_at'].filter((f) => !own.includes(f)) : []),
		...related
	];
}
export const ORDER_MAX_KEYS = 4;
export const orderText = (keys: readonly SortKey[]) =>
	keys
		.map((k) =>
			k.near === undefined ? `${k.field}:${k.dir}` : `${k.field}:near(${k.near.lat} ${k.near.lng})`
		)
		.join(',');
/** `field:asc,field:desc` → keys; each junk key is dropped (and counted). */
export function parseOrder(
	text: string,
	allowed: readonly string[] | null
): { keys: SortKey[]; dropped: number } {
	const keys: SortKey[] = [];
	let dropped = 0;
	for (const part of text.split(',').filter(Boolean)) {
		const m =
			/^(\w+(?:\.\w+){0,2}):(?:(asc|desc)|near\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\))$/.exec(part);
		// a nearest-first key names a point, never in the sortable list: the decode holds it to a point the viewer reads
		const near = m?.[3] === undefined ? undefined : { lat: Number(m[3]), lng: Number(m[4]) };
		if (
			m === null ||
			(near === undefined && allowed !== null && !allowed.includes(m[1] ?? '')) ||
			keys.some((k) => k.field === m[1]) ||
			keys.length >= ORDER_MAX_KEYS
		)
			dropped++;
		else
			keys.push(
				near === undefined
					? { field: m[1] ?? '', dir: m[2] === 'desc' ? 'desc' : 'asc' }
					: { field: m[1] ?? '', dir: 'asc', near }
			);
	}
	return { keys, dropped };
}
/** An `OrderBy` literal as keys (an AI answer or the author's); a related key `{ account: { name: 'asc' } }` is `account.name`. */
export function orderKeys(o: Json | undefined): SortKey[] {
	const jsonArray = (value: Json): value is readonly Json[] => Array.isArray(value);
	const jsonObject = (value: Json): value is { readonly [key: string]: Json } =>
		Predicate.isObject(value);
	const items = o === undefined || o === null ? [] : jsonArray(o) ? o : [o];
	const flat = (value: Json, at: string): SortKey[] => {
		if (typeof value === 'string')
			return value === 'asc' || value === 'desc' ? [{ field: at, dir: value }] : [];
		if (!jsonObject(value)) return [];
		const near = value['near'];
		if (keysOf(value).length === 1 && near !== undefined && isPoint(near))
			return [{ field: at, dir: 'asc', near }];
		return Object.entries(value).flatMap(([key, nested]) => flat(nested, `${at}.${key}`));
	};
	return items.flatMap((x): SortKey[] =>
		typeof x === 'string'
			? [{ field: x, dir: 'asc' }]
			: jsonObject(x)
				? Object.entries(x).flatMap(([k, v]) => flat(v, k))
				: []
	);
}
/** Keys as an `OrderBy`: a path nests (`account.name` → `{ account: { name: dir } }`). */
export const orderOf = (keys: readonly SortKey[]): Json =>
	keys.map((k) =>
		k.field
			.split('.')
			.reduceRight<Json>((v, f) => ({ [f]: v }), k.near === undefined ? k.dir : { near: k.near })
	);
/** A sort key in words: "Site › Location nearest to 1.3291, 103.7690", or the field's own label. */
export const sortText = (cat: Catalog, model: string, k: SortKey, human: (s: string) => string) =>
	k.near === undefined
		? pathLabel(cat, model, k.field, human)
		: `${pathLabel(cat, model, k.field, human)} nearest to ${pointText(k.near)}`;

// ── URL state (`?<key>.where=`, `?<key>.order=`, rule 16b) ──
type ViewUrl = { where: Json | undefined; order: string | undefined; badJson: boolean };
export function readViewUrl(params: URLSearchParams, key: string): ViewUrl {
	const raw = params.get(`${key}.where`),
		order = params.get(`${key}.order`) ?? undefined;
	if (raw === null) return { where: undefined, order, badJson: false };
	const result = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))(raw);
	return result._tag === 'Success'
		? { where: result.success, order, badJson: false }
		: { where: undefined, order, badJson: true };
}
/** `where` is written once the viewer has touched the rows (an empty `{}` records a cleared `initialFilter`). */
export function writeViewUrl(
	params: URLSearchParams,
	key: string,
	s: { where: Where | null; touched: boolean; order: readonly SortKey[] }
): URLSearchParams {
	const out = new URLSearchParams(params);
	if (s.touched) out.set(`${key}.where`, JSON.stringify(s.where ?? {}));
	else out.delete(`${key}.where`);
	if (s.order.length > 0) out.set(`${key}.order`, orderText(s.order));
	else out.delete(`${key}.order`);
	return out;
}

// ── a local array's rows, evaluated in the browser ──
const cmpVal = (a: Value, b: Value): number =>
	a instanceof Decimal &&
	(b instanceof Decimal || (typeof b === 'string' && /^-?\d+(\.\d+)?$/.test(b)))
		? a.cmp(b)
		: typeof a === 'number' && typeof b === 'number'
			? a - b
			: String(a).localeCompare(String(b));
export function matches(row: { readonly [f: string]: Value }, n: Node): boolean {
	if (!complete(n)) return true;
	if (n.t === 'group') {
		const of = n.of.filter(complete),
			r = n.join === 'and' ? of.every((x) => matches(row, x)) : of.some((x) => matches(row, x));
		return n.not ? !r : r;
	}
	if (n.t === 'many') return true;
	const v =
		n.path
			.split('.')
			.reduce<Value | undefined>(
				(object, key) => (Predicate.isObject(object) ? object[key] : undefined),
				row
			) ?? null;
	const a = n.arg !== null && 'lit' in n.arg ? n.arg.lit : null,
		list = n.arg !== null && 'list' in n.arg ? n.arg.list : [];
	switch (n.op) {
		case 'isNull':
			return v === null;
		case 'notNull':
			return v !== null;
		case 'like': {
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
			return v !== null && String(v) === String(a);
		case 'ne':
			return v === null || String(v) !== String(a);
		case 'in':
			return list.some((x) => String(x) === String(v));
		case 'nin':
			return !list.some((x) => String(x) === String(v));
		case 'gt':
			return v !== null && cmpVal(v, a) > 0;
		case 'gte':
			return v !== null && cmpVal(v, a) >= 0;
		case 'lt':
			return v !== null && cmpVal(v, a) < 0;
		case 'lte':
			return v !== null && cmpVal(v, a) <= 0;
		default:
			return true;
	}
}
/** Nulls last ascending and first descending (rule 11). */
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
					.reduce<Value | undefined>((o, f) => (Predicate.isObject(o) ? o[f] : undefined), r);
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

// ── labels (English fallbacks; the view passes them through `msg`) ──
export const QUANT_LABEL: { readonly [q in Quant]: string } = {
	some: 'has any',
	none: 'has none',
	every: 'all match',
	count: 'count',
	sum: 'sum of',
	min: 'min of',
	max: 'max of',
	avg: 'average of'
};
/** "Account › Owner › Name": each step's declared label, else its humanized name. */
export function pathLabel(
	cat: Catalog,
	model: string,
	path: string,
	human: (s: string) => string
): string {
	const out: string[] = [];
	let c = model;
	for (const step of path.split('.')) {
		const [name = '', arm] = step.split(':');
		const x = cat[c],
			rel = x?.relations?.[name];
		// a relation is named for its record ("Site"), never its key column ("Site id"): the describer's own words
		out.push(
			(INDEX[name]?.label ??
				rel?.label ??
				x?.fields[name]?.label ??
				human(rel === undefined ? name : name.replace(/_id$/, ''))) +
				(arm === undefined ? '' : ` (${human(arm)})`)
		);
		c = arm ?? rel?.targets[0] ?? c;
	}
	return out.join(' › ');
}
const argText = (arg: Arg | null): string =>
	arg === null
		? ''
		: Match.value(arg).pipe(
				Match.tagsExhaustive({
					lit: (value) => String(value.lit),
					list: (value) => value.list.map(String).join(', '),
					range: (value) =>
						value.label ?? `${boundText(value.range[0])} – ${boundText(value.range[1])}`,
					var: (value) => `@${variableName(value.var)}`,
					field: (value) => value.field
				})
			);
const boundText = (value: Json): string => {
	const text = varOf(value);
	return text === null ? String(value) : `@${variableName(text)}`;
};
/** One line for a node: the author's read-only scope and a row's summary. `ref` names a relation's record (its label, never
 * its id); `opLabel` names the operator (the catalogue's words, when the caller has them, else the machine operator). */
export function nodeText(
	cat: Catalog,
	model: string,
	n: Node,
	human: (s: string) => string,
	ref?: (target: string, id: string) => string,
	opLabel: (op: string, path: string) => string = (op) => op
): string {
	if (n.t === 'group') {
		const inner = n.of
			.map((x) => nodeText(cat, model, x, human, ref, opLabel))
			.join(n.join === 'and' ? ' and ' : ' or ');
		return n.not ? `not (${inner})` : n.of.length > 1 ? `(${inner})` : inner;
	}
	const head = pathLabel(cat, model, n.t === 'many' ? n.rel : n.path, human);
	if (n.t === 'many') {
		const child = childOf(cat, model, n.rel) ?? '';
		return ['some', 'none', 'every'].includes(n.q)
			? `${head} ${QUANT_LABEL[n.q]}${n.of.length ? `: ${n.of.map((x) => nodeText(cat, child, x, human, ref, opLabel)).join(' and ')}` : ''}`
			: `${head} ${QUANT_LABEL[n.q]}${n.field ? ` ${pathLabel(cat, child, n.field, human)}` : ''} ${opLabel(n.op ?? 'eq', n.rel)} ${n.n}`;
	}
	if (n.op === 'near' && n.arg !== null && 'lit' in n.arg && Array.isArray(n.arg.lit)) {
		const [p, m] = n.arg.lit;
		if (!isPoint(p ?? null) || typeof m !== 'number') return head;
		return `${head} within ${radiusText(m)} of ${pointText(p)}`;
	}
	const r = resolve(cat, model, n.path),
		a = n.arg;
	const named = (v: Value) =>
		r?.leaf === 'rel' && ref !== undefined && typeof v === 'string'
			? ref(r.targets[0] ?? '', v)
			: String(v);
	const arg =
		a !== null && 'lit' in a
			? named(a.lit)
			: a !== null && 'list' in a
				? a.list.map(named).join(', ')
				: argText(a);
	return `${head} ${opLabel(n.op, n.path)} ${arg}`.trim();
}
