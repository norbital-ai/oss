// The query IR → one SQL statement per read (A4). A caller read is conjoined with the caller's Authority at every level
// (rule 13) and every touch of a maskable field reads `CASE WHEN <admitting arms> THEN f END` (rule 14); a workspace
// read (the transform, rule 15) is neither. Rows come back as one jsonb value each, in wire form.
import type { Authority, Bindings, Order, PageIR, Pred, ReadIR, Reader, RelSelectIR, SelectIR, Sql } from '../contracts.ts';
import { BoltError, LIMITS } from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import type { Operand } from '../../decl/where.ts';
import type { Catalog, CollectionInfo, FieldInfo } from '../../protocol/catalog.ts';
import { EMBEDDING_COLUMN, SEARCH_COLUMN, SEMANTIC, collectionOf, defaultFields, exposedField, exposedRelation, q, storedFields } from '../../protocol/catalog.ts';
import { inverted, operand, periodEnds, plain } from './eval.ts';

const invalid = (message: string) => new BoltError('invalid', 'decode', message);
const forbidden = (message: string) => new BoltError('forbidden', 'admission', message);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One statement being built: its parameters and alias counter. */
class Build {
	params: Json[] = [];
	private n = 0;
	readonly cat: Catalog; readonly bindings: Bindings; readonly authority: Authority | null; readonly caller: boolean;
	constructor(cat: Catalog, bindings: Bindings, authority: Authority | null, caller: boolean) {
		this.cat = cat; this.bindings = bindings; this.authority = authority; this.caller = caller;
	}
	alias(): string { return `a${this.n++}`; }
	bind(v: Json, pg?: string): string {
		this.params.push(v);
		// a list travels as JSON text (both adapters send parameters as text), so an array type is built from it
		if (pg?.endsWith('[]') && Array.isArray(v)) return `ARRAY(SELECT jsonb_array_elements_text($${this.params.length}::jsonb))::${pg}`;
		return pg === undefined ? `$${this.params.length}` : `$${this.params.length}::${pg}`;
	}
	sql(text: string): Sql {
		if (this.params.length > LIMITS.statement.params) throw new BoltError('tooLarge', 'decode', `a read binds more than ${LIMITS.statement.params} parameters`);
		return { text, params: this.params };
	}
}
/** How a level compiles: `scoped` conjoins scope and masks; `exposed` holds names to the collection's read exposure. */
type Level = { scoped: boolean; exposed: boolean };
const RAW: Level = { scoped: false, exposed: false };

function fieldOf(c: CollectionInfo, name: string, lv: Level): FieldInfo {
	const f = c.model.fields.get(name);
	if (f === undefined || (lv.exposed && !exposedField(c, name))) throw invalid(`'${c.name}' has no readable field '${name}'`);
	return f;
}
function maskOf(b: Build, c: CollectionInfo, name: string, lv: Level): Pred | undefined {
	return lv.scoped ? b.authority?.collections[c.name]?.masks[name] : undefined;
}
/** A field as a query touches it: the column, or under a mask the column only where an admitting arm holds. */
function col(b: Build, c: CollectionInfo, a: string, name: string, lv: Level): string {
	const f = fieldOf(c, name, lv);
	const raw = `${a}.${q(f.column)}`;
	const mask = maskOf(b, c, name, lv);
	return mask === undefined ? raw : `(CASE WHEN ${pred(b, c, a, mask, RAW)} THEN ${raw} END)`;
}
/** The caller's scope on `c` at alias `a`, or null when unscoped; a caller with no read arm sees nothing. */
function scope(b: Build, c: CollectionInfo, a: string, lv: Level): string | null {
	if (!lv.scoped) return null;
	const arms = b.authority?.collections[c.name]?.read ?? [];
	return arms.length === 0 ? 'false' : `(${arms.map((arm) => pred(b, c, a, arm.where, RAW)).join(' OR ')})`;
}
const conj = (...parts: (string | null)[]) => parts.filter((x): x is string => x !== null).join(' AND ') || 'true';

function value(b: Build, f: FieldInfo, v: Json): string {
	let p = plain(v, f);
	if (p !== null && f.pg === 'uuid' && (typeof p !== 'string' || !UUID.test(p))) throw invalid(`'${f.name}' takes an id`);
	if (f.email && typeof p === 'string') p = p.toLowerCase();
	return b.bind(p, f.pg);
}
function rhs(b: Build, c: CollectionInfo, a: string, f: FieldInfo, arg: { lit: Json } | Operand, lv: Level): string {
	if ('lit' in arg) return value(b, f, arg.lit);
	if ('field' in arg) return col(b, c, a, arg.field, lv);
	return value(b, f, operand(arg, b.bindings, b.authority, f.kind));
}
function relation(b: Build, c: CollectionInfo, rel: string, target: string, lv: Level) {
	if (lv.exposed && !exposedRelation(c, rel)) throw invalid(`'${c.name}' exposes no relation '${rel}'`);
	// a caller crosses only into collections; the workspace may reach a model no collection exposes
	const t = lv.exposed ? collectionOf(b.cat, target) : b.cat.collections.get(target) ?? { name: target, model: b.cat.models.get(target)!, fields: 'all', relations: 'all', similarity: {} };
	const one = c.model.one.get(rel);
	const fk = one !== undefined ? (one.targets.length > 1 ? `${rel}__${target}` : rel) : c.model.many.get(rel)!.column;
	/** The join from `a` (on `c`) to `t` (on the target); rule 14: a foreign key masked to the caller joins nothing where its mask fails. */
	const link = (a: string, x: string) => one !== undefined ? conj(`${x}."id" = ${a}.${q(fk)}`, maskAt(b, c, a, rel, lv))
		: conj(`${x}.${q(fk)} = ${a}."id"`, maskAt(b, t, x, fk.split('__')[0]!, lv));
	return { t, one: one !== undefined, fk, link };
}
const maskAt = (b: Build, c: CollectionInfo, a: string, name: string, lv: Level): string | null => {
	const mask = maskOf(b, c, name, lv);
	return mask === undefined ? null : `(${pred(b, c, a, mask, RAW)})`;
};
const OPS = { eq: '=', ne: 'IS DISTINCT FROM', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;

/** `Pred` → a boolean SQL expression over alias `a` of collection `c`. */
function pred(b: Build, c: CollectionInfo, a: string, p: Pred, lv: Level): string {
	switch (p.t) {
		case 'const': return p.value ? 'true' : 'false';
		case 'and': return p.of.length === 0 ? 'true' : `(${p.of.map((x) => pred(b, c, a, x, lv)).join(' AND ')})`;
		case 'or': return p.of.length === 0 ? 'false' : `(${p.of.map((x) => pred(b, c, a, x, lv)).join(' OR ')})`;
		// unknown collapses to false before negation, as in the JS evaluator
		case 'not': return `(NOT COALESCE(${pred(b, c, a, p.of, lv)}, false))`;
		case 'null': return `(${col(b, c, a, p.field, lv)} IS ${p.is ? '' : 'NOT '}NULL)`;
		case 'cmp': {
			const f = fieldOf(c, p.field, lv);
			const fold = (x: string) => f.email ? `lower(${x})` : x;
			return `(${fold(col(b, c, a, p.field, lv))} ${OPS[p.op]} ${fold(rhs(b, c, a, f, p.arg, lv))})`;
		}
		case 'like': return `(${col(b, c, a, p.field, lv)} ILIKE ${b.bind(p.pattern, 'text')})`;
		case 'in': {
			const f = fieldOf(c, p.field, lv);
			const raw = Array.isArray(p.args) ? p.args : operand(p.args as Operand, b.bindings, b.authority);
			const list = (Array.isArray(raw) ? raw : raw === null ? [] : [raw]).map((x) => plain(x, f));
			if (f.pg === 'uuid' && list.some((x) => typeof x !== 'string' || !UUID.test(x))) throw invalid(`'${f.name}' takes ids`);
			const x = f.email ? `lower(${col(b, c, a, p.field, lv)})` : col(b, c, a, p.field, lv);
			const hit = `(${x} = ANY(${b.bind(f.email ? list.map((v) => String(v).toLowerCase()) : list, `${f.pg}[]`)}))`;
			return p.negated ? `(NOT COALESCE(${hit}, false))` : hit;
		}
		case 'list': {
			const x = col(b, c, a, p.field, lv);
			if (p.op === 'isEmpty') return p.arg === true ? `(COALESCE(cardinality(${x}), 0) = 0)` : `(cardinality(${x}) > 0)`;
			const arr = b.bind(p.op === 'has' ? [p.arg] : p.arg, 'text[]');
			return p.op === 'hasAny' ? `(${x} && ${arr})` : `(${x} @> ${arr})`;
		}
		case 'period': {
			const f = fieldOf(c, p.field, lv);
			const x = col(b, c, a, p.field, lv);
			const date = f.periodOf === 'date';
			const arg = 'lit' in p.arg ? periodEnds(f, p.arg.lit, b.bindings, b.authority) : 'field' in p.arg ? null : operand(p.arg, b.bindings, b.authority, f.periodOf);
			if (p.op === 'contains') {
				const point = 'field' in p.arg ? col(b, c, a, p.arg.field, lv) : b.bind(plain(arg), date ? 'date' : 'timestamptz');
				return `(${x} @> ${point})`;
			}
			const r = plain(arg) as { from?: string; to?: string | null; start?: string; end?: string | null } | null;
			if (r === null || typeof r !== 'object') throw invalid(`'${p.field}.${p.op}' takes a period`);
			// an exclusive date bound is the day after `to`; compare the inclusive ends
			if (date ? r.to != null && plain(r.from ?? null)! > plain(r.to)! : inverted(f, plain(r.start ?? null), plain(r.end ?? null))) return 'false';
			const other = date ? `daterange(${b.bind(plain(r.from ?? null), 'date')}, ${b.bind(plain(r.to ?? null), 'date')}, '[]')`
				: `tstzrange(${b.bind(plain(r.start ?? null), 'timestamptz')}, ${b.bind(plain(r.end ?? null), 'timestamptz')}, '[)')`;
			return `(${x} ${p.op === 'overlaps' ? '&&' : '<@'} ${other})`;
		}
		case 'geo': {
			const x = col(b, c, a, p.field, lv);
			const [lat, lng] = [`(${x})[1]`, `(${x})[0]`];
			if (p.near !== undefined) {
				const [pt, m] = p.near;
				const [plat, plng] = [b.bind(pt.lat, 'float8'), b.bind(pt.lng, 'float8')];
				return `(6371008.8 * 2 * asin(sqrt(power(sin(radians(${lat} - ${plat}) / 2), 2) + cos(radians(${plat})) * cos(radians(${lat})) * power(sin(radians(${lng} - ${plng}) / 2), 2))) <= ${b.bind(m, 'float8')})`;
			}
			const s = p.within!;
			if ('bbox' in s) {
				const [u, v] = s.bbox;
				return `(${lat} BETWEEN ${b.bind(Math.min(u.lat, v.lat), 'float8')} AND ${b.bind(Math.max(u.lat, v.lat), 'float8')} AND ${lng} BETWEEN ${b.bind(Math.min(u.lng, v.lng), 'float8')} AND ${b.bind(Math.max(u.lng, v.lng), 'float8')})`;
			}
			return `(${x} <@ ${b.bind(`(${s.polygon.map((pt) => `(${pt.lng},${pt.lat})`).join(',')})`, 'polygon')})`;
		}
		case 'json': {
			const x = col(b, c, a, p.field, lv);
			if ('isEmpty' in p) return p.isEmpty ? `(${x} IS NULL OR ${x} = '[]'::jsonb)` : `(jsonb_typeof(${x}) = 'array' AND ${x} <> '[]'::jsonb)`;
			return `(${x} @> ${b.bind(JSON.stringify(p.contains), 'jsonb')})`;
		}
		case 'one': case 'many': case 'count': case 'agg': {
			const r = relation(b, c, p.rel, p.target, lv);
			const t = b.alias();
			const from = `FROM ${q(r.t.model.name)} ${t} WHERE ${conj(r.link(a, t), scope(b, r.t, t, lv))}`;
			if (p.t === 'agg') {
				const f = fieldOf(r.t, p.of, lv);
				if (maskOf(b, r.t, p.of, lv) !== undefined) throw forbidden(`'${p.of}' is masked to this caller and cannot be aggregated (rule 14)`);
				const x = p.fn === 'sum' ? `COALESCE(sum(${t}.${q(f.column)}), 0)` : `${p.fn}(${t}.${q(f.column)})`;
				const pg = p.fn === 'sum' || p.fn === 'avg' ? 'numeric' : f.pg;
				return `((SELECT ${x} ${from}) ${p.op === 'ne' ? '<>' : OPS[p.op]} ${b.bind(plain(p.arg, f), pg)})`;
			}
			if (p.t === 'count') return `((SELECT count(*) ${from}) ${OPS[p.op] === 'IS DISTINCT FROM' ? '<>' : OPS[p.op]} ${b.bind(p.n, 'int8')})`;
			const inner = pred(b, r.t, t, p.pred, lv);
			if (p.t === 'one' || p.q === 'some') return `EXISTS (SELECT 1 ${from} AND ${inner})`;
			if (p.q === 'none') return `(NOT EXISTS (SELECT 1 ${from} AND ${inner}))`;
			return `(NOT EXISTS (SELECT 1 ${from} AND NOT COALESCE(${inner}, false)))`;
		}
	}
}

// ── rows ──
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (x: string) => `to_char(${x} AT TIME ZONE 'UTC', ${ISO})`;
const tag = (t: string, x: string) => `jsonb_build_object('${t}', ${x})`;
/** A column in wire form as jsonb (the tagged JSON of `RowData`): `$dec` decimals, `$t` ISO instants, `$d` dates, periods as
 * `{ from, to }` / `{ start, end }` of those. */
function wire(f: FieldInfo, x: string, a: string): string {
	if (f.arms !== undefined) return `(CASE ${f.arms.map((arm) => `WHEN ${a}.${q(`${f.column}__${arm}`)} IS NOT NULL THEN jsonb_build_object('collection', '${arm}', 'id', ${a}.${q(`${f.column}__${arm}`)})`).join(' ')} END)`;
	if (f.pg === 'numeric') return `(CASE WHEN ${x} IS NOT NULL THEN ${tag('$dec', `${x}::text`)} END)`;
	if (f.pg === 'timestamptz') return `(CASE WHEN ${x} IS NOT NULL THEN ${tag('$t', iso(x))} END)`;
	if (f.pg === 'date') return `(CASE WHEN ${x} IS NOT NULL THEN ${tag('$d', `${x}::text`)} END)`;
	if (f.pg === 'time') return `to_jsonb(${x}::text)`;
	if (f.pg === 'vector') return `(${x}::text::jsonb)`;
	if (f.pg === 'point') return `(CASE WHEN ${x} IS NOT NULL THEN jsonb_build_object('lat', (${x})[1], 'lng', (${x})[0]) END)`;
	if (f.pg === 'daterange') return `(CASE WHEN ${x} IS NOT NULL THEN jsonb_build_object('from', ${tag('$d', `lower(${x})::text`)}, 'to', CASE WHEN NOT upper_inf(${x}) THEN ${tag('$d', `(upper(${x}) - 1)::text`)} END) END)`;
	if (f.pg === 'tstzrange') return `(CASE WHEN ${x} IS NOT NULL THEN jsonb_build_object('start', ${tag('$t', iso(`lower(${x})`))}, 'end', CASE WHEN NOT upper_inf(${x}) THEN ${tag('$t', iso(`upper(${x})`))} END) END)`;
	return `to_jsonb(${x})`;
}
export const MASKED = `'{"$masked":true}'::jsonb`;
function item(b: Build, c: CollectionInfo, a: string, name: string, lv: Level): string {
	const f = fieldOf(c, name, lv);
	const out = wire(f, `${a}.${q(f.column)}`, a);
	const mask = maskOf(b, c, name, lv);
	return `${mask === undefined ? out : `(CASE WHEN ${pred(b, c, a, mask, RAW)} THEN ${out} ELSE ${MASKED} END)`} AS ${q(name)}`;
}
/** The select list of one level: `id`, the fields, and each selected relation as a correlated subquery. */
function items(b: Build, c: CollectionInfo, a: string, s: SelectIR, lv: Level, one = false): string[] {
	const fields = s.fields ?? (b.caller ? defaultFields(c, one) : storedFields(c.model));
	const out = [`${a}."id" AS "id"`, ...fields.filter((f) => f !== 'id').map((f) => item(b, c, a, f, lv))];
	for (const [rel, r] of Object.entries(s.relations)) out.push(`${arm(b, c, a, rel, r, lv)} AS ${q(rel)}`);
	return out;
}
function arm(b: Build, c: CollectionInfo, a: string, rel: string, r: RelSelectIR, lv: Level): string {
	const x = relation(b, c, rel, r.target, lv);
	const t = b.alias();
	if (!r.many) return `(SELECT to_jsonb(r) FROM (SELECT ${items(b, x.t, t, r.select, lv).join(', ')} FROM ${q(x.t.model.name)} ${t} WHERE ${conj(x.link(a, t), scope(b, x.t, t, lv))}) r)`;
	const p = r.page ?? invalidPage();
	if ('after' in p && p.after !== undefined) throw invalid(`relation arm '${rel}' takes no cursor`);
	const limit = 'all' in p ? LIMITS.page.relationArm + 1 : p.limit;
	const ord = orderBy(b, x.t, t, r.order ?? [], lv).map((k) => `${k.expr} ${k.dir}`).join(', ');
	const where = conj(x.link(a, t), scope(b, x.t, t, lv), r.where === undefined ? null : pred(b, x.t, t, r.where, lv));
	return `(SELECT COALESCE(jsonb_agg(to_jsonb(r) - '$n' ORDER BY r."$n"), '[]'::jsonb) FROM (SELECT ${items(b, x.t, t, r.select, lv).join(', ')}, row_number() OVER (ORDER BY ${ord}) AS "$n" FROM ${q(x.t.model.name)} ${t} WHERE ${where} ORDER BY ${ord} LIMIT ${limit}) r)`;
}
const invalidPage = (): never => { throw invalid('a many-relation arm states { limit } or { all: true } (rule 9)'); };

// ── order and cursors (rule 11) ──
type Key = { expr: string; pg: string; dir: 'asc' | 'desc' };
const UNORDERED = new Set(['json', 'file', 'custom', 'vector', 'point', 'ref', 'daterange', 'tstzrange']);
function orderBy(b: Build, c: CollectionInfo, a: string, o: Order, lv: Level, first: Key[] = []): Key[] {
	const keys = o.map(({ field, dir }): Key => {
		const own = !field.includes('.');
		if (!own && lv.exposed) readable(b, c, field, lv);
		// a related key is a scalar subselect over the same joins and scopes as a filter; a missing or unseen target is null
		const { expr, f } = own ? { expr: col(b, c, a, field, lv), f: fieldOf(c, field, lv) } : path(b, c, a, field, lv);
		if (UNORDERED.has(f.kind) || UNORDERED.has(f.pg) || f.many) throw invalid(`'${field}' has no order`);
		return { expr, pg: f.pg, dir };
	});
	return [...first, ...keys, { expr: `${a}."id"`, pg: c.model.fields.get('id')!.pg, dir: 'asc' }];
}
/** Rule 14 for a related sort key (`account.name`): each hop an exposed one-relation the caller reads unmasked, into a
 * collection it reads, and the field exposed and unmasked; else `invalidInput`. An ordering never leaks a mask. */
function readable(b: Build, c: CollectionInfo, p: string, lv: Level): void {
	const bad = (why: string): never => { throw new BoltError('invalidInput', 'decode', `orderBy '${p}': ${why}`); };
	const steps = p.split('.');
	let x = c;
	for (const s of steps.slice(0, -1)) {
		const rel = x.model.one.get(s);
		if (rel === undefined || rel.targets.length > 1 || !exposedRelation(x, s) || maskOf(b, x, s, lv) !== undefined)
			bad(`'${x.name}.${s}' is not a relation this caller reads`);
		const t = b.cat.collections.get(rel!.targets[0]!) ?? bad(`'${rel!.targets[0]}' is not a collection`);
		if (lv.scoped && (b.authority?.collections[t.name]?.read ?? []).length === 0) bad(`'${t.name}' is not read by this caller`);
		x = t;
	}
	const last = steps.at(-1)!;
	if (!exposedField(x, last) || maskOf(b, x, last, lv) !== undefined) bad(`'${x.name}.${last}' is not a field this caller reads unmasked`);
}
/** FNV-1a over the query minus its page: a cursor is bound to the query it came from (`BadCursor` otherwise). */
export function hash(ir: unknown): string {
	let h = 0x811c9dc5;
	for (const ch of JSON.stringify(ir)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
	return (h >>> 0).toString(36);
}
export function encodeCursor(h: string, values: readonly (string | null)[]): string {
	return btoa(unescape(encodeURIComponent(JSON.stringify({ h, k: values })))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function decodeCursor(cursor: string, h: string, n: number): (string | null)[] {
	try {
		const v = JSON.parse(decodeURIComponent(escape(atob(cursor.replaceAll('-', '+').replaceAll('_', '/'))))) as { h?: unknown; k?: unknown };
		if (v.h === h && Array.isArray(v.k) && v.k.length === n && v.k.every((x) => x === null || typeof x === 'string')) return v.k as (string | null)[];
	} catch { /* below */ }
	throw new BoltError('badCursor', 'decode', 'the cursor does not belong to this query (rule 11)');
}
/** Rows after the cursor position: ASC puts nulls last, DESC first, as Postgres orders by default. */
function seek(b: Build, keys: readonly Key[], values: readonly (string | null)[]): string {
	const branches: string[] = [];
	keys.forEach((k, i) => {
		const v = values[i] ?? null;
		if (k.dir === 'asc' && v === null) return;
		const eq = keys.slice(0, i).map((p, j) => values[j] == null ? `${p.expr} IS NULL` : `${p.expr} = ${b.bind(values[j]!, p.pg)}`);
		const after = k.dir === 'asc' ? `(${k.expr} > ${b.bind(v, k.pg)} OR ${k.expr} IS NULL)` : v === null ? `${k.expr} IS NOT NULL` : `${k.expr} < ${b.bind(v, k.pg)}`;
		branches.push(`(${[...eq, after].join(' AND ')})`);
	});
	return branches.length === 0 ? 'false' : `(${branches.join(' OR ')})`;
}

// ── statements ──
export type Compiled = { sql: Sql; kind: 'rows' | 'one' | 'agg'; limit: number | 'all' | null; hash: string; keys: number };
function start(cat: Catalog, reader: Reader, bindings: Bindings, collection: string) {
	const c = collectionOf(cat, collection);
	const authority = reader.as === 'caller' ? reader.authority : null;
	const caller = authority !== null;
	const lv: Level = { scoped: caller && !authority.admin, exposed: caller };
	if (lv.scoped && (authority!.collections[collection]?.read ?? []).length === 0)
		throw forbidden(`no held policy grants reading '${collection}' (rule 33)`);
	return { c, b: new Build(cat, bindings, authority, caller), lv };
}
function pageLimit(p: PageIR): number | 'all' { return 'all' in p ? 'all' : p.limit; }

/** `read`, `get`, `aggregate` or `similar` (with its probe resolved) as one statement. */
export function compile(cat: Catalog, ir: ReadIR, reader: Reader, bindings: Bindings,
	probe?: { field: string; vector: readonly number[]; where?: Pred; take: number; from?: string }): Compiled {
	if (ir.kind !== 'read' && ir.kind !== 'get' && ir.kind !== 'aggregate' && ir.kind !== 'similar') throw invalid(`'${ir.kind}' is not a statement read`);
	const { c, b, lv } = start(cat, reader, bindings, ir.collection);
	const a = b.alias();
	const table = `${q(c.model.name)} ${a}`;
	if (ir.kind === 'get') {
		const pg = c.model.fields.get('id')!.pg;
		if (pg === 'uuid' && !UUID.test(ir.id)) return { sql: b.sql('SELECT NULL::jsonb AS j WHERE false'), kind: 'one', limit: null, hash: '', keys: 0 };
		return { sql: b.sql(`SELECT to_jsonb(r) AS j FROM (SELECT ${items(b, c, a, ir.select, lv, true).join(', ')} FROM ${table} WHERE ${conj(`${a}."id" = ${b.bind(ir.id, pg)}`, scope(b, c, a, lv))}) r`),
			kind: 'one', limit: null, hash: '', keys: 0 };
	}
	if (ir.kind === 'similar' && probe!.field === SEMANTIC) {
		// L-BOLT-123: `search.semantic`'s platform embedding, cosine, probed by an embedded text or by a readable record's own vector
		if (c.model.semantic === undefined) throw invalid(`'${c.name}' declares no search.semantic (rule 16)`);
		const x = `${a}.${q(EMBEDDING_COLUMN)}`, s = b.alias();
		const to = probe!.from === undefined ? `${b.bind(`[${probe!.vector.join(',')}]`, 'vector')}`
			: `(SELECT ${s}.${q(EMBEDDING_COLUMN)} FROM ${q(c.model.name)} ${s} WHERE ${conj(`${s}."id" = ${b.bind(probe!.from, 'uuid')}`, scope(b, c, s, lv))})`;
		const dist = `(${x} <=> ${to})`;
		const where = conj(scope(b, c, a, lv), `${dist} IS NOT NULL`, probe!.from === undefined ? null : `${a}."id" <> ${b.bind(probe!.from, 'uuid')}`,
			ir.where === undefined ? null : pred(b, c, a, ir.where, lv));
		const sel = items(b, c, a, ir.select ?? { fields: null, relations: {} }, lv);
		return { sql: b.sql(`SELECT to_jsonb(r) AS j FROM (SELECT ${sel.join(', ')}, ${dist}::float8 AS "$distance" FROM ${table} WHERE ${where} ORDER BY ${dist}, ${a}."id" LIMIT ${probe!.take}) r`),
			kind: 'rows', limit: probe!.take, hash: '', keys: 0 };
	}
	if (ir.kind === 'similar') {
		const f = fieldOf(c, probe!.field, lv);
		if (f.kind !== 'vector') throw invalid(`'${probe!.field}' is not a vector field`);
		if (probe!.vector.length !== (f.dim ?? probe!.vector.length) || !probe!.vector.every(Number.isFinite)) throw invalid(`the probe is not ${f.dim} finite numbers`);
		const x = col(b, c, a, f.name, lv);
		const dist = `(${x} ${f.metric === 'cosine' ? '<=>' : f.metric === 'ip' ? '<#>' : '<->'} ${b.bind(`[${probe!.vector.join(',')}]`, 'vector')})`;
		const where = conj(scope(b, c, a, lv), `${x} IS NOT NULL`, probe!.where === undefined ? null : pred(b, c, a, probe!.where, lv),
			ir.where === undefined ? null : pred(b, c, a, ir.where, lv));
		const sel = items(b, c, a, ir.select ?? { fields: null, relations: {} }, lv);
		return { sql: b.sql(`SELECT to_jsonb(r) AS j FROM (SELECT ${sel.join(', ')}, ${dist}::float8 AS "$distance" FROM ${table} WHERE ${where} ORDER BY ${dist}, ${a}."id" LIMIT ${probe!.take}) r`),
			kind: 'rows', limit: probe!.take, hash: '', keys: 0 };
	}
	if (ir.kind === 'aggregate') return aggregate(b, c, a, ir, lv);
	// read
	let search: string | null = null;
	let first: Key[] = [];
	if (ir.search !== undefined) {
		if (c.model.search.length === 0) throw invalid(`'${c.name}' declares no searchable fields (rule 16)`);
		// L-BOLT-121/122: the term is folded and tokenized by the document's own functions (native words and CJK runs as
		// prefixes, romanized spellings, pinyin joins, Latin skeletons); a row meeting any lexeme is found, and one holding
		// every native word ranks first, then by how much of the query landed. A term of noise is no tsquery: no rows.
		const hybrid = probe?.field === SEMANTIC;
		const doc = `${a}.${q(SEARCH_COLUMN)}`, term = b.bind(hybrid ? ir.search.replace(/^\/semantic\s+/, '') : ir.search, 'text');
		const any = `bolt_search_query(${term}, false)`;
		const match = `coalesce(${doc} @@ ${any}, false)`;
		const rank = `(coalesce(${doc} @@ bolt_search_query(${term}, true), false)::int * 2 + coalesce(ts_rank('{1,1,1,1}', ${doc}, ${any}), 0) + 0.1 / (1 + length(${doc})))`;
		search = match;
		if (hybrid) {
			// `/semantic` (L-BOLT-123): the lexical and the embedding rankings fused by reciprocal rank (k = 60), so an exact hit
			// always outranks a row only the vector found; one page, no cursor (a window rank cannot be sought)
			if (c.model.semantic === undefined) throw invalid(`'${c.name}' declares no search.semantic (rule 16)`);
			if ('after' in ir.page && ir.page.after !== undefined) throw invalid('a /semantic search reads one page');
			const x = `${a}.${q(EMBEDDING_COLUMN)}`, dist = `(${x} <=> ${b.bind(`[${probe!.vector.join(',')}]`, 'vector')})`;
			search = `(${match} OR ${x} IS NOT NULL)`;
			first = [{ expr: `((CASE WHEN ${match} THEN 1.0 / (60 + rank() OVER (ORDER BY ${match} DESC, ${rank} DESC)) ELSE 0 END
				+ CASE WHEN ${x} IS NOT NULL THEN 1.0 / (60 + rank() OVER (ORDER BY ${dist})) ELSE 0 END)::float8)`, pg: 'float8', dir: 'desc' }];
			const keys = orderBy(b, c, a, [], lv, first);
			const limit = pageLimit(ir.page), take = limit === 'all' ? LIMITS.page.all + 1 : limit;
			const where = conj(scope(b, c, a, lv), ir.where === undefined ? null : pred(b, c, a, ir.where, lv), search);
			return { sql: b.sql(`SELECT to_jsonb(r) AS j FROM (SELECT ${items(b, c, a, ir.select, lv).join(', ')} FROM ${table} WHERE ${where} ORDER BY ${keys.map((k) => `${k.expr} ${k.dir}`).join(', ')} LIMIT ${take}) r`),
				kind: 'rows', limit: 'all', hash: '', keys: 0 };
		}
		if (ir.order === undefined || ir.order.length === 0) first = [{ expr: `(${rank}::float8)`, pg: 'float8', dir: 'desc' }];
	}
	const keys = orderBy(b, c, a, ir.order ?? [], lv, first);
	const { page, ...rest } = ir;
	const h = hash(rest);
	const after = 'after' in page && page.after !== undefined ? seek(b, keys, decodeCursor(page.after, h, keys.length)) : null;
	const where = conj(scope(b, c, a, lv), ir.where === undefined ? null : pred(b, c, a, ir.where, lv), search, after);
	const limit = pageLimit(page);
	const take = limit === 'all' ? LIMITS.page.all + 1 : limit + 1;
	const cursor = limit === 'all' ? '' : `, jsonb_build_array(${keys.map((k) => `${k.expr}::text`).join(', ')}) AS "$k"`;
	return { sql: b.sql(`SELECT to_jsonb(r) AS j FROM (SELECT ${items(b, c, a, ir.select, lv).join(', ')}${cursor} FROM ${table} WHERE ${where} ORDER BY ${keys.map((k) => `${k.expr} ${k.dir}`).join(', ')} LIMIT ${take}) r`),
		kind: 'rows', limit, hash: h, keys: keys.length };
}

/**
 * Rule 12: reads of one shape merge into one lateral statement. `get`s of one collection and select become the ids
 * unnested with their ordinal and each row as a lateral subquery: one row per id, in order, `j` null when not found.
 */
export function compileGets(cat: Catalog, collection: string, ids: readonly string[], select: SelectIR, reader: Reader, bindings: Bindings): Sql {
	const { c, b, lv } = start(cat, reader, bindings, collection);
	const a = b.alias();
	const pg = c.model.fields.get('id')!.pg;
	const list = b.bind(ids.map((id) => pg !== 'uuid' || UUID.test(id) ? id : null), `${pg}[]`);
	return b.sql(`SELECT (SELECT to_jsonb(r) FROM (SELECT ${items(b, c, a, select, lv, true).join(', ')} FROM ${q(c.model.name)} ${a} WHERE ${conj(`${a}."id" = v.id`, scope(b, c, a, lv))}) r) AS j
	FROM unnest(${list}) WITH ORDINALITY v(id, n) ORDER BY v.n`);
}

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
const NUM = new Set(['int', 'decimal', 'money', 'sum', 'count', 'number', 'duration']);
/** A field reached by a one-relation path (`'account.region'`), each hop scoped; a masked field is `forbidden` (rule 14). */
function path(b: Build, c: CollectionInfo, a: string, p: string, lv: Level): { expr: string; f: FieldInfo } {
	const [head, ...tail] = p.split('.');
	if (tail.length === 0 || c.model.fields.get(p)) {
		const f = fieldOf(c, p, lv);
		if (maskOf(b, c, p, lv) !== undefined) throw forbidden(`'${p}' is masked to this caller and cannot be aggregated (rule 14)`);
		return { expr: col(b, c, a, p, lv), f };
	}
	const rel = c.model.one.get(head!);
	if (rel === undefined || rel.targets.length > 1) throw invalid(`'${head}' is not a one-relation of '${c.name}'`);
	const r = relation(b, c, head!, rel.targets[0]!, lv);
	const t = b.alias();
	const inner = path(b, r.t, t, tail.join('.'), lv);
	return { expr: `(SELECT ${inner.expr} FROM ${q(r.t.model.name)} ${t} WHERE ${conj(r.link(a, t), scope(b, r.t, t, lv))})`, f: inner.f };
}
function aggregate(b: Build, c: CollectionInfo, a: string, ir: Extract<ReadIR, { kind: 'aggregate' }>, lv: Level): Compiled {
	const cols: string[] = [];
	const groups: Key[] = [];
	const key: string[] = [];
	for (const bucket of ir.by) {
		const { expr, f } = path(b, c, a, bucket.field, lv);
		let g = expr;
		let pg = f.pg;
		if (bucket.unit !== undefined) {
			if (f.kind !== 'date' && f.kind !== 'instant') throw invalid(`'${bucket.field}' is not a date or instant`);
			g = f.kind === 'date' ? `date_trunc('${bucket.unit}', ${expr})::date` : `(date_trunc('${bucket.unit}', ${expr}, ${b.bind(b.bindings.tz, 'text')}) AT TIME ZONE ${b.bind(b.bindings.tz, 'text')})::date`;
			pg = 'date';
		} else if (UNORDERED.has(f.kind) || UNORDERED.has(f.pg) || f.many) throw invalid(`'${bucket.field}' cannot be a bucket`);
		groups.push({ expr: g, pg, dir: 'asc' });
		key.push(`${lit(bucket.field)}, ${bucket.unit === undefined ? wire(f, g, a) : tag('$d', `${g}::text`)}`);
	}
	if (key.length > 0) cols.push(`jsonb_build_object(${key.join(', ')}) AS "key"`);
	if (ir.count) cols.push('count(*) AS "count"');
	for (const fn of ['sum', 'avg', 'min', 'max'] as const) {
		const fields = ir[fn];
		if (fields === undefined || fields.length === 0) continue;
		cols.push(`jsonb_build_object(${fields.map((name) => {
			const { expr, f } = path(b, c, a, name, lv);
			if ((fn === 'sum' || fn === 'avg') && !NUM.has(f.kind)) throw invalid(`'${name}' is not numeric`);
			if (UNORDERED.has(f.kind) || UNORDERED.has(f.pg) || f.many) throw invalid(`'${name}' cannot be aggregated`);
			const agg = `${fn}(${expr})`;
			return `${lit(name)}, ${fn === 'sum' || fn === 'avg' ? `(CASE WHEN ${agg} IS NOT NULL THEN ${tag('$dec', `${agg}::numeric::text`)} END)` : wire(f, agg, a)}`;
		}).join(', ')}) AS ${q(fn)}`);
	}
	if (cols.length === 0) throw invalid('an aggregate asks for something');
	const where = conj(scope(b, c, a, lv), ir.where === undefined ? null : pred(b, c, a, ir.where, lv));
	if (groups.length === 0) return { sql: b.sql(`SELECT to_jsonb(r) AS j FROM (SELECT ${cols.join(', ')} FROM ${q(c.model.name)} ${a} WHERE ${where}) r`), kind: 'agg', limit: null, hash: '', keys: 0 };
	const page = ir.page!;
	const { page: _, ...rest } = ir;
	const h = hash(rest);
	const having = 'after' in page && page.after !== undefined ? ` HAVING ${seek(b, groups, decodeCursor(page.after, h, groups.length))}` : '';
	const limit = pageLimit(page);
	const take = limit === 'all' ? LIMITS.page.all + 1 : limit + 1;
	const cursor = limit === 'all' ? '' : `, jsonb_build_array(${groups.map((k) => `${k.expr}::text`).join(', ')}) AS "$k"`;
	return { sql: b.sql(`SELECT to_jsonb(r) AS j FROM (SELECT ${cols.join(', ')}${cursor} FROM ${q(c.model.name)} ${a} WHERE ${where} GROUP BY ${groups.map((g) => g.expr).join(', ')}${having} ORDER BY ${groups.map((g) => g.expr).join(', ')} LIMIT ${take}) r`),
		kind: 'rows', limit, hash: h, keys: groups.length };
}

/** For tests and the live router: a predicate alone, as the WHERE of `SELECT id FROM <c>`. */
/** The ids a grant predicate (rule 14 arm, mask) admits: compiled raw, as a scope is, but with `holder`'s actor operands. */
export function grantSql(cat: Catalog, collection: string, p: Pred, holder: Authority, bindings: Bindings): Sql {
	const c = collectionOf(cat, collection), b = new Build(cat, bindings, holder, false), a = b.alias();
	return b.sql(`SELECT ${a}."id" AS id FROM ${q(c.model.name)} ${a} WHERE ${pred(b, c, a, p, RAW)} ORDER BY ${a}."id"`);
}
export function whereSql(cat: Catalog, collection: string, p: Pred, reader: Reader, bindings: Bindings): Sql {
	const { c, b, lv } = start(cat, reader, bindings, collection);
	const a = b.alias();
	return b.sql(`SELECT ${a}."id" AS id FROM ${q(c.model.name)} ${a} WHERE ${conj(scope(b, c, a, lv), pred(b, c, a, p, lv))} ORDER BY ${a}."id"`);
}
