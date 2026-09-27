// The view popover's typed model (rule 16b, P34): filter rows that mirror `Where` (§3.3.9) and can only lower to a
// decodable one, sort keys that are an `OrderBy`, and their URL form. Pure: no DOM, no relative value imports.
import type { CollectionExposure } from '../kinds/context.js';
import type { Json, Kind } from '../kinds/kind.js';

/** A `Where` literal (§3.3.9). ui has no bolt dependency, so it is structural here; `$bolt` narrows it to `Where<C>`. */
export type Where = { readonly [key: string]: Json };
export type SortKey = { field: string; dir: 'asc' | 'desc' };
/** One `OrderBy` key object: `{ field: dir }`, or through a one-relation `{ account: { name: dir } }`. */
export type SortObject = { readonly [field: string]: 'asc' | 'desc' | SortObject };
/** An `OrderBy` literal: a field, a key object, or up to 4 of them. */
export type OrderBy = string | SortObject | readonly (string | SortObject)[];
type Catalog = { readonly [collection: string]: CollectionExposure };

export type Cmp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
export type Op = Cmp | 'in' | 'nin' | 'like' | 'isNull' | 'notNull' | 'has' | 'hasAny' | 'hasAll' | 'isEmpty' | 'notEmpty'
	| 'during' | 'contains' | 'overlaps' | 'within';
export type Unit = 'week' | 'month' | 'quarter' | 'year';
export type Preset = 'today' | 'yesterday' | 'last7' | 'next7' | 'last30' | `${'this' | 'last' | 'next'}_${Unit}`;
/** A condition's value: a literal, a list, a relative date, an actor, or a date preset (`during`). */
export type Arg = { lit: Json } | { list: readonly Json[] } | { today: string } | { now: string } | { startOf: Unit; shift?: number }
	| { actor: 'id' | 'party' | 'teams' } | { preset: Preset };
export type Quant = 'some' | 'none' | 'every' | 'count' | 'sum' | 'min' | 'max' | 'avg';
export type Node =
	/** `path`: own field, or one-relation steps then a field (`account.owner.name`, two hops; an arm is `ref:arm`); a path
	 * that ends on a relation is a condition on the related record. */
	| { t: 'cond'; path: string; op: Op; arg: Arg | null }
	| { t: 'group'; join: 'and' | 'or'; not?: true; of: readonly Node[] }
	/** A many-relation: has any / none / all match with nested conditions, or `count` / an aggregate of a child field. */
	| { t: 'many'; rel: string; q: Quant; of: readonly Node[]; field?: string; op?: Cmp; n?: number | null };

/** A many-relation's child collection: the one whose relation to `collection` declares it as `inverse`. */
export function childOf(cat: Catalog, collection: string, rel: string): string | undefined {
	if (!(cat[collection]?.many ?? []).includes(rel)) return undefined;
	return Object.keys(cat).find((c) => Object.values(cat[c]!.relations ?? {}).some((r) => r.inverse === rel && r.targets.includes(collection)));
}
const isObj = (v: unknown): v is { readonly [k: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysOf = (v: object) => Object.keys(v);

// ── the field tree ──
/** What a path ends on: a field of a kind, or a one-relation (a record condition). */
export type Resolved = { leaf: 'field'; kind: Kind; nullable: boolean; label: string } | { leaf: 'rel'; targets: readonly string[]; nullable: boolean; label: string };
const RESERVED = new Set(['and', 'or', 'not']);
/** Fields a viewer may filter on: readable, not hidden, not masked (rule 16a narrowing). */
export const filterable = (x: CollectionExposure, f: string) => !RESERVED.has(f) && x.fields[f] !== undefined && !x.fields[f]!.hidden && !(x.masked ?? []).includes(f);
const SYS: { readonly [f: string]: Kind } = { created_at: { kind: 'instant' }, updated_at: { kind: 'instant' } };

export function resolve(cat: Catalog, collection: string, path: string): Resolved | null {
	const steps = path.split('.');
	let c = collection;
	for (let i = 0; i < steps.length; i++) {
		const x = cat[c];
		if (x === undefined) return null;
		const [name, arm] = steps[i]!.split(':') as [string, string | undefined];
		const rel = x.relations?.[name];
		const last = i === steps.length - 1;
		if (rel !== undefined && !(x.masked ?? []).includes(name)) {
			const targets = arm === undefined ? rel.targets : rel.targets.includes(arm) ? [arm] : [];
			if (targets.length === 0 || (rel.targets.length > 1 && arm === undefined)) return null; // an arc is named by its arm
			if (last) return { leaf: 'rel', targets, nullable: rel.optional === true, label: rel.label ?? name };
			if (i >= 2) return null; // two hops, as today's builder
			c = targets[0]!;
			continue;
		}
		if (!last || arm !== undefined) return null;
		const kind = (c.startsWith('$') ? undefined : SYS[name]) ?? (filterable(x, name) ? x.fields[name]! : undefined); // `$local`: no system columns
		return kind === undefined ? null : { leaf: 'field', kind, nullable: kind.optional === true, label: kind.label ?? name };
	}
	return null;
}

const NUM = new Set(['int', 'number', 'decimal', 'money', 'sum', 'count', 'duration']);
/** Operators per kind (a runtime port of `Ops`, §3.3.9); `isNull` only on a nullable field. */
export function opsFor(r: Resolved): Op[] {
	const nul: Op[] = r.nullable ? ['isNull', 'notNull'] : [];
	if (r.leaf === 'rel') return ['eq', 'ne', 'in', 'nin', ...nul];
	const k = r.kind;
	if ((k.kind === 'text' || k.kind === 'enum') && k.many) return ['has', 'hasAny', 'hasAll', 'isEmpty', 'notEmpty'];
	if (k.kind === 'period') return ['contains', 'overlaps', 'within', ...nul];
	if (k.kind === 'json') return ['contains', ...nul];
	if (['point', 'file', 'vector', 'custom'].includes(k.kind)) return nul.length ? nul : [];
	if (k.kind === 'text' || (k.kind === 'seq' && k.pattern !== undefined)) return ['like', 'eq', 'ne', 'in', 'nin', ...nul];
	if (NUM.has(k.kind) || k.kind === 'seq') return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', ...nul];
	if (k.kind === 'date' || k.kind === 'instant') return ['during', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', ...nul];
	if (k.kind === 'time') return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', ...nul];
	if (k.kind === 'bool') return ['eq', ...nul];
	return ['eq', 'ne', 'in', 'nin', ...nul]; // enum, state, currency, id
}
/** The kind a condition's literal is edited and checked as: state → its states, derived numbers → numbers. */
export function valueKind(k: Kind): Kind {
	if (k.kind === 'state') return { kind: 'enum', values: Object.keys(k.states) };
	if ((k.kind === 'text' || k.kind === 'enum') && k.many) return { ...k, many: undefined } as Kind;
	if (k.kind === 'seq') return k.pattern === undefined ? { kind: 'int' } : { kind: 'text' };
	if (k.kind === 'sum' || k.kind === 'count' || k.kind === 'money') return { kind: 'number' };
	return k;
}
/** The operand choices of a value position (§3.3.9 `Dyn`): a literal, relative dates, actor references. */
export function operandsFor(r: Resolved, op: Op): ('lit' | 'today' | 'now' | 'startOf' | 'me' | 'party' | 'team')[] {
	if (r.leaf === 'rel') {
		const t = r.targets[0];
		if (op === 'in' || op === 'nin') return ['lit', ...(t === 'sys_team' ? ['team' as const] : [])];
		return ['lit', ...(t === 'sys_user' ? ['me' as const] : []), 'party'];
	}
	if (!(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains'] as Op[]).includes(op)) return ['lit'];
	const k = r.kind.kind === 'period' ? (r.kind.of === 'date' ? 'date' : 'instant') : r.kind.kind;
	if (op === 'contains' && r.kind.kind !== 'period') return ['lit'];
	return k === 'date' ? ['lit', 'today', 'startOf'] : k === 'instant' ? ['lit', 'now', 'startOf'] : ['lit'];
}
export const argKind = (a: Arg | null): string => a === null ? 'lit' : 'actor' in a ? ({ id: 'me', party: 'party', teams: 'team' } as const)[a.actor] : keysOf(a)[0]!;

// ── presets (rule 16a; workspace timezone, Monday weeks, evaluated by the host) ──
const U: readonly Unit[] = ['week', 'month', 'quarter', 'year'];
export const PRESETS: readonly Preset[] = ['today', 'yesterday', 'last7', 'next7', 'last30', ...U.flatMap((u) => (['this', 'last', 'next'] as const).map((w) => `${w}_${u}` as Preset))];
/** A preset as `{ gte, lt }` bounds for a date or instant field; `null` when the kind cannot state it. */
export function presetBounds(p: Preset, kind: 'date' | 'instant'): { gte: Json; lt: Json } | null {
	const cal = /^(this|last|next)_(\w+)$/.exec(p);
	if (cal !== null) {
		const s = cal[1] === 'this' ? 0 : cal[1] === 'last' ? -1 : 1, unit = cal[2] as Unit;
		const at = (n: number): Json => n === 0 ? { startOf: unit } : { startOf: unit, shift: n };
		return { gte: at(s), lt: at(s + 1) };
	}
	const days: { readonly [p: string]: [number, number] } = { today: [0, 1], yesterday: [-1, 0], last7: [-6, 1], next7: [0, 7], last30: [-29, 1] };
	const [a, b] = days[p]!;
	const off = (n: number) => n === 0 ? '' : `${n > 0 ? '+' : '-'}${Math.abs(n)}d`;
	if (kind === 'date') return { gte: { today: off(a) }, lt: { today: off(b) } };
	// an instant has no "today" operand: the rolling presets only
	const rolling: { readonly [p: string]: [string, string] } = { last7: ['-7d', ''], last30: ['-30d', ''], next7: ['', '+7d'] };
	return rolling[p] === undefined ? null : { gte: { now: rolling[p]![0] }, lt: { now: rolling[p]![1] } };
}
export const presetsFor = (kind: 'date' | 'instant') => PRESETS.filter((p) => presetBounds(p, kind) !== null);

// ── literals ──
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Whether a literal is of the kind (rule 11a's literal check, advisory; the host decodes again). */
export function validLit(k: Kind, v: Json): boolean {
	if (v === null || v === undefined) return false;
	switch (k.kind) {
		case 'int': case 'duration': case 'count': return Number.isInteger(v);
		case 'number': case 'decimal': case 'money': case 'sum': return (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));
		case 'bool': return typeof v === 'boolean';
		case 'date': return typeof v === 'string' && ISO_DATE.test(v);
		case 'instant': return typeof v === 'string' && !Number.isNaN(Date.parse(v));
		case 'time': return typeof v === 'string' && /^\d{2}:\d{2}/.test(v);
		case 'enum': return typeof v === 'string' && k.values.includes(v);
		case 'state': return typeof v === 'string' && Object.hasOwn(k.states, v);
		case 'seq': return k.pattern === undefined ? Number.isInteger(v) : typeof v === 'string';
		case 'period': return isObj(v) && ('from' in v || 'start' in v);
		case 'json': return true;
		default: return typeof v === 'string' && v !== '';
	}
}
/** `like` text with `%`, `_` and `\` escaped, wrapped as "contains". */
export const likeOf = (text: string) => `%${text.replace(/[%_\\]/g, '\\$&')}%`;
const unlike = (p: string): string | null => /^%.*%$/s.test(p) && !/(^|[^\\])(\\\\)*[%_]/.test(p.slice(1, -1)) ? p.slice(1, -1).replace(/\\(.)/g, '$1') : null;

// ── lowering: Node → Where ──
function operand(a: Arg): Json {
	if ('lit' in a) return a.lit;
	if ('list' in a) return a.list as Json;
	if ('actor' in a) return { actor: a.actor };
	if ('preset' in a) return null;
	return a as Json;
}
/** Whether a condition is complete (an incomplete row is shown but not sent). */
export function complete(n: Node): boolean {
	if (n.t === 'group') return n.of.some(complete);
	if (n.t === 'many') return ['some', 'none', 'every'].includes(n.q) ? true
		: n.op !== undefined && typeof n.n === 'number' && Number.isFinite(n.n) && (n.q === 'count' ? Number.isInteger(n.n) && n.n >= 0 : n.field !== undefined);
	if (['isNull', 'notNull', 'isEmpty', 'notEmpty'].includes(n.op)) return true;
	const a = n.arg;
	if (a === null) return false;
	if ('lit' in a) return a.lit !== null && a.lit !== '';
	if ('list' in a) return a.list.length > 0;
	return true;
}
function leafOps(n: Extract<Node, { t: 'cond' }>, r: Resolved): Json {
	const a = n.arg;
	switch (n.op) {
		case 'isNull': return { isNull: true };
		case 'notNull': return { isNull: false };
		case 'isEmpty': return { isEmpty: true };
		case 'notEmpty': return { isEmpty: false };
		case 'like': return { like: likeOf(String(a !== null && 'lit' in a ? a.lit : '')) };
		case 'during': {
			const kind = r.leaf === 'field' && r.kind.kind === 'instant' ? 'instant' : 'date';
			return a !== null && 'preset' in a ? presetBounds(a.preset, kind) : null;
		}
		default: return { [n.op]: a === null ? null : operand(a) };
	}
}
/** A viewer node as a `Where` over `collection`; incomplete rows lower to nothing. */
export function toWhere(cat: Catalog, collection: string, n: Node): Where | null {
	if (!complete(n)) return null;
	if (n.t === 'group') {
		const parts = n.of.map((x) => toWhere(cat, collection, x)).filter((x): x is Where => x !== null);
		if (parts.length === 0) return null;
		const body: Where = parts.length === 1 && n.join === 'and' ? parts[0]! : { [n.join]: parts };
		return n.not ? { not: body } : body;
	}
	if (n.t === 'many') {
		if (n.q === 'some' || n.q === 'none' || n.q === 'every') {
			const child = childOf(cat, collection, n.rel) ?? '';
			const inner = n.of.map((x) => toWhere(cat, child, x)).filter((x): x is Where => x !== null);
			return { [n.rel]: { [n.q]: inner.length === 0 ? {} : inner.length === 1 ? inner[0]! : { and: inner } } };
		}
		const cmp = { [n.op!]: n.n! };
		return { [n.rel]: { [n.q]: n.q === 'count' ? cmp : { of: n.field!, ...cmp } } };
	}
	const r = resolve(cat, collection, n.path);
	if (r === null) return null;
	const steps = n.path.split('.');
	const [name, arm] = steps.pop()!.split(':') as [string, string | undefined];
	let body = leafOps(n, r);
	if (body === null) return null;
	// a record picked by label is sent in the `is` form (it needs the relation exposed, never its FK column); actor
	// operands and `isNull` stay on the FK
	if (r.leaf === 'rel' && n.arg !== null && ('lit' in n.arg || 'list' in n.arg)) body = { is: { id: body } };
	return wrap(steps, { [name]: arm === undefined ? body : { [arm]: body } });
}
function wrap(steps: readonly string[], inner: Where): Where {
	return steps.reduceRight<Where>((acc, s) => {
		const [name, arm] = s.split(':') as [string, string | undefined];
		return { [name]: arm === undefined ? { is: acc } : { [arm]: { is: acc } } };
	}, inner);
}
/** The viewer's rows as one `Where` (each top-level row a conjunct, so a URL clause drops alone). */
export function rowsWhere(cat: Catalog, collection: string, rows: readonly Node[]): Where | null {
	const parts = rows.map((r) => toWhere(cat, collection, r)).filter((x): x is Where => x !== null);
	return parts.length === 0 ? null : parts.length === 1 ? parts[0]! : { and: parts };
}

// ── parsing: Where → Node (the popover shows `initialFilter`, a URL and an AI answer as rows) ──
const OPERAND = new Set(['today', 'now', 'startOf', 'actor']);
function argOf(r: Resolved, op: Op, v: Json): Arg | null {
	if (op === 'in' || op === 'nin' || op === 'hasAny' || op === 'hasAll') {
		if (isObj(v) && v['actor'] === 'teams' && op !== 'hasAny' && op !== 'hasAll') return operandsFor(r, op).includes('team') ? { actor: 'teams' } : null;
		if (!Array.isArray(v) || v.length === 0) return null;
		const k = r.leaf === 'field' ? valueKind(r.kind) : null;
		return v.every((x) => k === null ? typeof x === 'string' : validLit(k, x)) ? { list: v } : null;
	}
	if (isObj(v) && keysOf(v).length >= 1 && OPERAND.has(keysOf(v)[0]!)) {
		const kinds = operandsFor(r, op);
		if ('actor' in v) {
			const a = v['actor'];
			const want = a === 'id' ? 'me' : a === 'party' ? 'party' : null;
			return want !== null && kinds.includes(want) ? { actor: a as 'id' | 'party' } : null;
		}
		if ('startOf' in v) return kinds.includes('startOf') && U.includes(v['startOf'] as Unit) && (v['shift'] === undefined || Number.isInteger(v['shift']))
			? v as Arg : null;
		const key = keysOf(v)[0] as 'today' | 'now';
		return keysOf(v).length === 1 && kinds.includes(key) && /^([+-]\d+(s|min|h|d))?$/.test(String(v[key])) ? { [key]: String(v[key]) } as Arg : null;
	}
	if (r.leaf === 'rel') return typeof v === 'string' && v !== '' ? { lit: v } : null;
	const k = op === 'contains' && r.kind.kind === 'period' ? { kind: r.kind.of } as Kind : op === 'contains' && r.kind.kind === 'json' ? r.kind : valueKind(r.kind);
	return validLit(k, v) ? { lit: v } : null;
}
function fieldNodes(cat: Catalog, collection: string, path: string, ops: Json): Node[] | null {
	const r = resolve(cat, collection, path);
	if (r === null || !isObj(ops) || keysOf(ops).length === 0) return null;
	const allowed = opsFor(r);
	const out: Node[] = [];
	let rest: { [k: string]: Json } = { ...ops };
	if (r.leaf === 'field' && (r.kind.kind === 'date' || r.kind.kind === 'instant') && 'gte' in rest && 'lt' in rest) {
		const kind = r.kind.kind;
		const p = presetsFor(kind).find((x) => JSON.stringify(presetBounds(x, kind)) === JSON.stringify({ gte: rest['gte'], lt: rest['lt'] }));
		if (p !== undefined) { out.push({ t: 'cond', path, op: 'during', arg: { preset: p } }); const { gte: _g, lt: _l, ...o } = rest; rest = o; }
	}
	for (const [k, v] of Object.entries(rest)) {
		let op = k as Op, arg: Arg | null = null;
		if (k === 'isNull' || k === 'isEmpty') {
			if (typeof v !== 'boolean') return null;
			op = (k === 'isNull' ? (v ? 'isNull' : 'notNull') : v ? 'isEmpty' : 'notEmpty');
		} else if (k === 'like') {
			const text = typeof v === 'string' ? unlike(v) : null;
			if (text === null) return null;
			arg = { lit: text };
		} else {
			arg = argOf(r, op, v);
			if (arg === null) return null;
		}
		if (!allowed.includes(op)) return null;
		out.push({ t: 'cond', path, op, arg });
	}
	return out;
}
/** A `Where` over `root` as rows; `null` when any part names what the popover cannot show or decode would refuse.
 * `at`/`prefix` walk a one-relation's `is` body (two hops), whose rows keep paths from the root. */
export function fromWhere(cat: Catalog, root: string, w: Json, at = root, prefix = ''): Node[] | null {
	const x = cat[at];
	if (!isObj(w) || x === undefined) return null;
	const out: Node[] = [];
	for (const [key, v] of Object.entries(w)) {
		if (key === 'and' || key === 'or') {
			if (!Array.isArray(v) || v.length === 0) return null;
			const of = v.map((p) => fromWhere(cat, root, p, at, prefix));
			if (of.some((p) => p === null || p.length === 0)) return null;
			const flat = of.map((p) => p!.length === 1 ? p![0]! : { t: 'group', join: 'and', of: p! } as Node);
			if (key === 'and' && prefix === '') out.push(...flat);
			else out.push({ t: 'group', join: key, of: flat });
		} else if (key === 'not') {
			// `is: { not }` differs from `not: { is }` on a null relation: only the root form is a row
			if (prefix !== '' || !isObj(v) || keysOf(v).length === 0) return null;
			const of = fromWhere(cat, root, v);
			if (of === null) return null;
			out.push({ t: 'group', join: 'and', not: true, of });
		} else if ((x.many ?? []).includes(key)) {
			const child = childOf(cat, at, key);
			if (prefix !== '' || !isObj(v) || keysOf(v).length === 0 || child === undefined) return null;
			for (const [q, body] of Object.entries(v)) {
				if (q === 'some' || q === 'none' || q === 'every') {
					const of = fromWhere(cat, child, body);
					if (of === null) return null;
					out.push({ t: 'many', rel: key, q, of });
				} else if (q === 'count' || ['sum', 'min', 'max', 'avg'].includes(q)) {
					if (!isObj(body)) return null;
					const { of: field, ...cmp } = body;
					const [op, n] = Object.entries(cmp)[0] ?? [];
					if (keysOf(cmp).length !== 1 || !['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(op!) || typeof n !== 'number') return null;
					if (q === 'count' ? field !== undefined || !Number.isInteger(n) || n < 0 : typeof field !== 'string' || !aggregable(cat, child, q as Quant).includes(field)) return null;
					out.push({ t: 'many', rel: key, q: q as Quant, of: [], op: op as Cmp, n, ...(q === 'count' ? {} : { field: field as string }) });
				} else return null;
			}
		} else if (x.relations?.[key] !== undefined) {
			const rel = x.relations[key]!;
			if (!isObj(v) || keysOf(v).length === 0) return null;
			const arms: [string | null, Json][] = rel.targets.length > 1 ? Object.entries(v) : [[null, v]];
			for (const [arm, body] of arms) {
				if (arm !== null && !rel.targets.includes(arm)) return null;
				const path = prefix + (arm === null ? key : `${key}:${arm}`);
				if (!isObj(body) || keysOf(body).length === 0) return null;
				let nodes: Node[] | null;
				if ('is' in body) {
					const is = body['is'];
					if (keysOf(body).length !== 1 || !isObj(is) || keysOf(is).length === 0) return null;
					const idOps = keysOf(is).length === 1 && isObj(is['id']) ? is['id'] : null;
					nodes = idOps !== null && keysOf(idOps).every((k) => ['eq', 'ne', 'in', 'nin'].includes(k)) ? fieldNodes(cat, root, path, idOps)
						: path.split('.').length > 2 ? null : fromWhere(cat, root, is, arm ?? rel.targets[0]!, `${path}.`);
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
export function aggregable(cat: Catalog, child: string, q: Quant): string[] {
	const x = cat[child];
	if (x === undefined) return [];
	const ok = new Set(['int', 'decimal', 'money', 'duration', 'number', ...(q === 'min' || q === 'max' ? ['date', 'instant'] : [])]);
	return Object.keys(x.fields).filter((f) => filterable(x, f) && ok.has(x.fields[f]!.kind) && !(x.fields[f] as { many?: true }).many);
}
/** Top-level conjuncts: each is kept or dropped alone. */
export const clauses = (w: Json): Json[] => !isObj(w) || keysOf(w).length === 0 ? [] : keysOf(w).length === 1 && Array.isArray(w['and']) ? [...w['and'] as Json[]]
	: Object.entries(w).map(([k, v]) => ({ [k]: v }));

// ── sorting ──
const UNSORTABLE = new Set(['json', 'file', 'custom', 'vector', 'point', 'period']);
/** `Sortable<C>`: readable, unmasked, ordered fields and `created_at`/`updated_at` (§3.3.9); with the catalog, also each
 * unmasked one-relation's target fields the viewer reads (`account.name`, shown "Account › Name"), one hop. */
export function sortable(x: CollectionExposure | undefined, system = true, cat?: Catalog): string[] {
	if (x === undefined) return [];
	const own = Object.keys(x.fields).filter((f) => filterable(x, f) && !UNSORTABLE.has(x.fields[f]!.kind) && !(x.fields[f] as { many?: true }).many);
	const related = cat === undefined ? [] : Object.entries(x.relations ?? {}).flatMap(([r, rel]) => {
		const t = rel.targets.length === 1 ? cat[rel.targets[0]!] : undefined;
		return t === undefined || (x.masked ?? []).includes(r) ? [] : sortable(t, false).filter((f) => t.relations?.[f] === undefined).map((f) => `${r}.${f}`);
	});
	return [...own, ...(system ? ['created_at', 'updated_at'].filter((f) => !own.includes(f)) : []), ...related];
}
export const ORDER_MAX_KEYS = 4;
export const orderText = (keys: readonly SortKey[]) => keys.map((k) => `${k.field}:${k.dir}`).join(',');
/** `field:asc,field:desc` → keys; each junk key is dropped (and counted). */
export function parseOrder(text: string, allowed: readonly string[] | null): { keys: SortKey[]; dropped: number } {
	const keys: SortKey[] = [];
	let dropped = 0;
	for (const part of text.split(',').filter(Boolean)) {
		const m = /^(\w+(?:\.\w+){0,2}):(asc|desc)$/.exec(part);
		if (m === null || (allowed !== null && !allowed.includes(m[1]!)) || keys.some((k) => k.field === m[1]) || keys.length >= ORDER_MAX_KEYS) dropped++;
		else keys.push({ field: m[1]!, dir: m[2] as 'asc' | 'desc' });
	}
	return { keys, dropped };
}
/** An `OrderBy` literal as keys (an AI answer or the author's); a related key `{ account: { name: 'asc' } }` is `account.name`. */
export function orderKeys(o: Json | undefined): SortKey[] {
	const items = o === undefined || o === null ? [] : Array.isArray(o) ? o : [o];
	const flat = (x: Json, at: string): SortKey[] => typeof x === 'string' ? (x === 'asc' || x === 'desc' ? [{ field: at, dir: x }] : [])
		: isObj(x) ? Object.entries(x).flatMap(([k, v]) => flat(v, `${at}.${k}`)) : [];
	return items.flatMap((x): SortKey[] => typeof x === 'string' ? [{ field: x, dir: 'asc' }]
		: isObj(x) ? Object.entries(x).flatMap(([k, v]) => flat(v, k)) : []);
}
/** Keys as an `OrderBy`: a path nests (`account.name` → `{ account: { name: dir } }`). */
export const orderOf = (keys: readonly SortKey[]): Json => keys.map((k) => k.field.split('.').reduceRight<Json>((v, f) => ({ [f]: v }), k.dir));

// ── URL state (`?<key>.where=`, `?<key>.order=`, rule 16b) ──
export type ViewUrl = { where: Json | undefined; order: string | undefined; badJson: boolean };
export function readViewUrl(params: URLSearchParams, key: string): ViewUrl {
	const raw = params.get(`${key}.where`), order = params.get(`${key}.order`) ?? undefined;
	if (raw === null) return { where: undefined, order, badJson: false };
	try { return { where: JSON.parse(raw) as Json, order, badJson: false }; } catch { return { where: undefined, order, badJson: true }; }
}
/** `where` is written once the viewer has touched the rows (an empty `{}` records a cleared `initialFilter`). */
export function writeViewUrl(params: URLSearchParams, key: string, s: { where: Where | null; touched: boolean; order: readonly SortKey[] }): URLSearchParams {
	const out = new URLSearchParams(params);
	if (s.touched) out.set(`${key}.where`, JSON.stringify(s.where ?? {})); else out.delete(`${key}.where`);
	if (s.order.length > 0) out.set(`${key}.order`, orderText(s.order)); else out.delete(`${key}.order`);
	return out;
}

// ── a local array's rows, evaluated in the browser ──
const cmpVal = (a: Json, b: Json): number => typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
// hook:codec — `$bolt` hands std's `Decimal` (no own fields, `toJSON` its exact text) where the wire had `$dec`
const plainOf = (v: Json | undefined): Json => isObj(v) && keysOf(v).length === 0 && typeof (v as { toJSON?: unknown }).toJSON === 'function' ? Number((v as unknown as { toJSON(): string }).toJSON()) : isObj(v) && keysOf(v).length === 1 && ['$dec', '$d', '$t'].includes(keysOf(v)[0]!) ? (keysOf(v)[0] === '$dec' ? Number(v['$dec']) : v[keysOf(v)[0]!]!) : v ?? null;
export function matches(row: { readonly [f: string]: Json }, n: Node): boolean {
	if (!complete(n)) return true;
	if (n.t === 'group') {
		const of = n.of.filter(complete), r = n.join === 'and' ? of.every((x) => matches(row, x)) : of.some((x) => matches(row, x));
		return n.not ? !r : r;
	}
	if (n.t === 'many') return true;
	const v = plainOf(n.path.split('.').reduce<Json | undefined>((o, k) => isObj(o) ? o[k] : undefined, row));
	const a = n.arg !== null && 'lit' in n.arg ? n.arg.lit : null, list = n.arg !== null && 'list' in n.arg ? n.arg.list : [];
	switch (n.op) {
		case 'isNull': return v === null;
		case 'notNull': return v !== null;
		case 'like': return String(v ?? '').toLowerCase().includes(String(a).toLowerCase());
		case 'eq': return v !== null && String(v) === String(a);
		case 'ne': return v === null || String(v) !== String(a);
		case 'in': return list.some((x) => String(x) === String(v));
		case 'nin': return !list.some((x) => String(x) === String(v));
		case 'gt': return v !== null && cmpVal(v, a) > 0;
		case 'gte': return v !== null && cmpVal(v, a) >= 0;
		case 'lt': return v !== null && cmpVal(v, a) < 0;
		case 'lte': return v !== null && cmpVal(v, a) <= 0;
		default: return true;
	}
}
/** Nulls last ascending and first descending (rule 11). */
export function sortRows<R extends { readonly [f: string]: Json }>(rows: readonly R[], keys: readonly SortKey[]): R[] {
	if (keys.length === 0) return [...rows];
	return [...rows].sort((x, y) => {
		for (const k of keys) {
			const at = (r: R) => k.field.split('.').reduce<Json | undefined>((o, f) => isObj(o) ? o[f] : undefined, r);
			const a = plainOf(at(x)), b = plainOf(at(y));
			const c = a === b ? 0 : a === null ? 1 : b === null ? -1 : cmpVal(a, b);
			if (c !== 0) return k.dir === 'asc' ? c : -c;
		}
		return 0;
	});
}
/** Kinds guessed from a local array's values: its columns are the only fields. */
export function localExposure(rows: readonly { readonly [f: string]: Json }[], fields: readonly string[], labels: (f: string) => string): CollectionExposure {
	const kindOf = (f: string): Kind => {
		const v = rows.map((r) => plainOf(r[f])).find((x) => x !== null);
		return { kind: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : 'text', optional: true, label: labels(f) };
	};
	return { label: [], fields: Object.fromEntries(fields.filter((f) => !f.includes('.')).map((f) => [f, kindOf(f)])) };
}

// ── labels (English fallbacks; the view passes them through `msg`) ──
export const OP_LABEL: { readonly [op in Op]: string } = {
	eq: 'is', ne: 'is not', lt: 'less than', lte: 'at most', gt: 'more than', gte: 'at least',
	in: 'is any of', nin: 'is none of', like: 'contains', isNull: 'is empty', notNull: 'is not empty', has: 'has', hasAny: 'has any of',
	hasAll: 'has all of', isEmpty: 'is empty', notEmpty: 'is not empty', during: 'is within', contains: 'contains', overlaps: 'overlaps', within: 'is within',
};
const WHEN: { readonly [op: string]: string } = { lt: 'before', lte: 'on or before', gt: 'after', gte: 'on or after' };
/** An operator's words for the field it applies to: dates compare as before/after, numbers as less/more. */
export const opText = (op: Op, r: Resolved | null): { key: string; text: string } =>
	r?.leaf === 'field' && ['date', 'instant', 'time'].includes(r.kind.kind) && WHEN[op] !== undefined ? { key: `when.${op}`, text: WHEN[op]! } : { key: op, text: OP_LABEL[op] };
export const QUANT_LABEL: { readonly [q in Quant]: string } = {
	some: 'has any', none: 'has none', every: 'all match', count: 'count', sum: 'sum of', min: 'min of', max: 'max of', avg: 'average of',
};
export const PRESET_LABEL = (p: Preset): string => ({ today: 'today', yesterday: 'yesterday', last7: 'last 7 days', next7: 'next 7 days', last30: 'last 30 days' } as { readonly [k: string]: string })[p]
	?? p.replace('_', ' ');
/** "Account › Owner › Name": each step's declared label, else its humanized name. */
export function pathLabel(cat: Catalog, collection: string, path: string, human: (s: string) => string): string {
	const out: string[] = [];
	let c = collection;
	for (const step of path.split('.')) {
		const [name, arm] = step.split(':') as [string, string | undefined];
		const x = cat[c], rel = x?.relations?.[name];
		out.push((rel?.label ?? x?.fields[name]?.label ?? human(name)) + (arm === undefined ? '' : ` (${human(arm)})`));
		c = arm ?? rel?.targets[0] ?? c;
	}
	return out.join(' › ');
}
const argText = (a: Arg | null): string => a === null ? '' : 'lit' in a ? String(a.lit) : 'list' in a ? a.list.map(String).join(', ')
	: 'preset' in a ? PRESET_LABEL(a.preset) : 'actor' in a ? ({ id: 'me', party: 'my party', teams: 'my teams' } as const)[a.actor]
	: 'startOf' in a ? `start of ${({ 0: 'this', [-1]: 'last', 1: 'next' } as { readonly [n: number]: string })[a.shift ?? 0] ?? `${a.shift}`} ${a.startOf}`
	: 'today' in a ? `today ${a.today}`.trim() : `now ${a.now}`.trim();
/** One line for a node: the author's read-only scope and a row's summary. `ref` names a relation's record (its label, never
 * its id). */
export function nodeText(cat: Catalog, collection: string, n: Node, human: (s: string) => string, ref?: (target: string, id: string) => string): string {
	if (n.t === 'group') {
		const inner = n.of.map((x) => nodeText(cat, collection, x, human, ref)).join(n.join === 'and' ? ' and ' : ' or ');
		return n.not ? `not (${inner})` : n.of.length > 1 ? `(${inner})` : inner;
	}
	const head = pathLabel(cat, collection, n.t === 'many' ? n.rel : n.path, human);
	if (n.t === 'many') {
		const child = childOf(cat, collection, n.rel) ?? '';
		return ['some', 'none', 'every'].includes(n.q)
			? `${head} ${QUANT_LABEL[n.q]}${n.of.length ? `: ${n.of.map((x) => nodeText(cat, child, x, human, ref)).join(' and ')}` : ''}`
			: `${head} ${QUANT_LABEL[n.q]}${n.field ? ` ${pathLabel(cat, child, n.field, human)}` : ''} ${n.op} ${n.n}`;
	}
	const r = resolve(cat, collection, n.path), a = n.arg;
	const named = (v: Json) => r?.leaf === 'rel' && ref !== undefined && typeof v === 'string' ? ref(r.targets[0]!, v) : String(v);
	const arg = a !== null && 'lit' in a ? named(a.lit) : a !== null && 'list' in a ? a.list.map(named).join(', ') : argText(a);
	return `${head} ${opText(n.op, r).text} ${arg}`.trim();
}
