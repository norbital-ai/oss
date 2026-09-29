/// <reference types="node" />
// The manifest is the schema (§5.2, rule 69): the models, relationships and workspace currency/zone rendered as
// schema objects, each with its create and drop SQL, the columns it reads, and a count of the rows that would refuse
// it. `plan.ts` diffs two object lists; nothing here reads the catalogue.
//
// One enforcing place per declared constraint (§5.2): kind / NOT NULL / CHECK, FK (NO ACTION) / UNIQUE / EXCLUDE
// (every one but `key` DEFERRABLE INITIALLY IMMEDIATE), GENERATED STORED (`computed`, the search document). Engine
// pieces (delete rules, state edges, `seq` numbering, roll-up deltas, file accept, json shapes) are the write area's.
import { createHash } from 'node:crypto';
import type { Expr, ModelSpec } from '../../decl/model.ts';
import type { FieldKind } from '../../decl/fields.ts';
import type { RelationshipSpec } from '../../decl/names.ts';
import { BoltError } from '../contracts.ts';
import { engineObjects } from './engine.ts';
import { SEARCH_FUNCTIONS } from './search.ts';

/** What the database depends on: the fingerprint is over exactly this (rule 69). */
export type SchemaSlice = {
	models: { readonly [model: string]: ModelSpec };
	relationships: { readonly [key: string]: RelationshipSpec };
	currency: string | null;
	tz: string;
};
/** How a constraint name maps back to the declaration, for the SQLSTATE → refusal map (§5.2). */
export type ConstraintMeta = { model: string; kind: 'unique' | 'check' | 'overlap' | 'fk'; fields: readonly string[]; rule?: string;
	/** hook:write — a check's authored refusal message (`check: { <rule>: { where, message } }`). */
	message?: string };
/** hook:write — a model check is a bare `Where` or `{ where, message }` (the message is the refusal a member reads). */
export const checkOf = (c: object): { where: object; message?: string } =>
	'where' in c && 'message' in c && typeof c.message === 'string' ? { where: c.where as object, message: c.message } : { where: c };
/** Create order: a later rank may depend on an earlier one; drops run in reverse. */
export const RANK = { extension: 0, function: 1, table: 2, column: 3, backfill: 4, default: 5, notNull: 6, constraint: 7, fk: 8, index: 9 } as const;
export type SchemaObject = {
	id: string; rank: keyof typeof RANK; table: string;
	/** Own columns this object reads: a replaced column replaces its dependants. */
	deps: readonly string[];
	create: readonly string[];
	/** What a change of rebuilds the object, when not all of `create` (a column's default is its own object). */
	shape?: string;
	/** `null`: never dropped (extensions, engine tables). */
	drop: string | null;
	/** Dropping it loses authored data (a table, a stored column): the destructive class. */
	stored?: true;
	/** Derived on create (a generated or roll-up column): the backfill class on a populated table. */
	derived?: true;
	/** `select count(*)::int as n …`: rows the new object would refuse (the validating class). */
	violations?: string;
	meta?: ConstraintMeta & { name: string };
};

/** JSON with sorted keys, `undefined` dropped: the same slice always hashes and renders the same. */
export function canonical(v: unknown): string {
	return JSON.stringify(v, (_k, x: unknown) => (x !== null && typeof x === 'object' && !Array.isArray(x)
		? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
}
const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;
const lit = (v: string): string => `'${v.replaceAll("'", "''")}'`;
const fail = (message: string): never => { throw new BoltError('schema', 'derive', message); };
const hash8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8);
/** `<table≤40>__<kind>__<hash8>` (§5.2): ≤ 63 bytes for any table name the build admits. */
const cname = (table: string, kind: string, def: string): string => `${table.slice(0, 40)}__${kind}__${hash8(def)}`;
const ident = (name: string): string =>
	Buffer.byteLength(name) > 63 ? fail(`identifier '${name}' is over 63 bytes; shorten the model or field name`) : name;

// ISO 4217 exponents that are not 2 (the minor-unit CHECK on money, rule 68).
const MINOR: Record<number, readonly string[]> = {
	0: ['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'],
	3: ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'], 4: ['CLF', 'UYW'],
};
const minorUnits = (code: string): number => Number(Object.entries(MINOR).find(([, cs]) => cs.includes(code))?.[0] ?? 2);
/** The money minor-unit CHECK's helper (rule 68); the engine registry (`engine.ts`) creates it. */
export const MINOR_FN = `create or replace function bolt_minor_units(c text) returns int language sql immutable parallel safe as $$ select case ${
	Object.entries(MINOR).map(([n, cs]) => `when c in (${cs.map(lit).join(', ')}) then ${n}`).join(' ')} else 2 end $$`;

const SYSTEM_COLUMNS = 'id uuid primary key, revision int not null default 1, approval_id uuid, created_at timestamptz not null default now(), '
	+ 'created_by text, updated_at timestamptz not null default now(), updated_by text';
/** A system table's primary key column (`table.primary`): `id` of its type, or the field that is the key. */
const primaryOf = (spec: ModelSpec): { name: string; type: string } => {
	const p = spec.table!.primary;
	return typeof p === 'object' ? { name: p.field, type: colType(spec.fields[p.field] ?? fail(`table.primary names unknown field '${p.field}'`)) }
		: { name: 'id', type: p === 'identity' ? 'bigint' : p };
};

// ── columns ──
type Col = { name: string; type: string; kind: FieldKind | { kind: 'ref'; optional?: true } ; optional: boolean };
const SQL_TYPE: Record<string, string> = {
	text: 'text', int: 'int', decimal: 'numeric', money: 'numeric', currency: 'text', bool: 'boolean', date: 'date', instant: 'timestamptz',
	time: 'time', duration: 'int', enum: 'text', state: 'text', sum: 'numeric', count: 'int', json: 'jsonb', file: 'jsonb', point: 'point', custom: 'jsonb', ref: 'uuid',
};
function colType(k: FieldKind): string {
	if (k.kind === 'period') return k.of === 'date' ? 'daterange' : 'tstzrange';
	if (k.kind === 'vector') return `vector(${k.dim})`;
	if (k.kind === 'seq') return k.pattern === undefined ? 'int' : 'text';
	const t = SQL_TYPE[k.kind] ?? fail(`unknown field kind '${k.kind}'`);
	return (k.kind === 'text' || k.kind === 'enum') && k.many === true ? `${t}[]` : t;
}
const optionalOf = (k: FieldKind): boolean => 'optional' in k && k.optional === true;

type Rel = { key: string; model: string; field: string; to: readonly string[]; spec: RelationshipSpec; cols: readonly string[] };
/** An FK column takes its target's key type: a workspace model's uuid, a system table's own (`table.primary`). */
export const fkType = (models: SchemaSlice['models'], target: string): string => {
	const spec = models[target];
	return spec === undefined ? 'text' : spec.table === undefined ? 'uuid' : primaryOf(spec).type;
};
function relationships(s: SchemaSlice): Rel[] {
	return Object.entries(s.relationships).map(([key, spec]) => {
		const [model = '', field = ''] = key.split('.');
		const to = typeof spec.to === 'string' ? [spec.to] : spec.to;
		return { key, model, field, to, spec, cols: to.length === 1 ? [field] : to.map((t) => ident(`${field}__${t}`)) };
	});
}

/** Model → its columns by field name (an arc field names several). */
type Table = { model: string; spec: ModelSpec; cols: Map<string, Col>; fieldCols: Map<string, readonly string[]> };
function tables(s: SchemaSlice, rels: readonly Rel[]): Map<string, Table> {
	const out = new Map<string, Table>();
	for (const [model, spec] of Object.entries(s.models)) {
		ident(model);
		const cols = new Map<string, Col>();
		const fieldCols = new Map<string, readonly string[]>();
		for (const [name, kind] of Object.entries(spec.fields)) {
			cols.set(name, { name: ident(name), type: colType(kind), kind, optional: optionalOf(kind) });
			fieldCols.set(name, [name]);
		}
		for (const r of rels.filter((x) => x.model === model)) {
			r.cols.forEach((c, i) => cols.set(c, { name: c, type: fkType(s.models, r.to[i]!), kind: { kind: 'ref' }, optional: r.spec.optional === true || r.cols.length > 1 }));
			fieldCols.set(r.field, r.cols);
		}
		for (const [name, c] of Object.entries(spec.computed ?? {})) fieldCols.set(name, [name]), cols.set(name, { name, type: SQL_TYPE[c.kind] ?? 'text', kind: { kind: c.kind } as FieldKind, optional: true });
		// a system table carries its key alone; a workspace row every engine column
		if (spec.table !== undefined) {
			const key = primaryOf(spec);
			if (key.name === 'id') fieldCols.set('id', ['id']), cols.set('id', { name: 'id', type: key.type, kind: { kind: 'text' }, optional: false });
		} else for (const sys of ['id', 'revision', 'approval_id', 'created_at', 'created_by', 'updated_at', 'updated_by'])
			fieldCols.set(sys, [sys]), cols.set(sys, { name: sys, type: sys === 'revision' ? 'int' : sys.endsWith('_at') ? 'timestamptz' : sys.endsWith('_by') ? 'text' : 'uuid', kind: { kind: 'text' }, optional: true });
		out.set(model, { model, spec, cols, fieldCols });
	}
	return out;
}

// ── literals by column type ──
function sqlValue(v: unknown, type: string): string {
	if (v === null || v === undefined) return 'null';
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	if (type.endsWith('[]')) return `${lit(`{${(v as readonly unknown[]).map((x) => `"${String(x).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`)}::${type}`;
	if (typeof v === 'object') return `${lit(JSON.stringify(v))}::${type === 'jsonb' ? 'jsonb' : type}`;
	return `${lit(String(v))}::${type}`;
}
const OFFSET = /^([+-])(\d+)(s|min|h|d)$/;
const interval = (offset: string): string => {
	if (offset === '') return '';
	const m = OFFSET.exec(offset) ?? fail(`bad offset '${offset}'`);
	const unit = { s: 'seconds', min: 'minutes', h: 'hours', d: 'days' }[m[3] as 's' | 'min' | 'h' | 'd'];
	return ` ${m[1]} interval ${lit(`${m[2]} ${unit}`)}`;
};
/** A literal default, or the clock operands (`{ now }`, `{ today }` in the workspace zone); actor defaults are the write's. */
function defaultSql(k: FieldKind, type: string, tz: string): string | null {
	if (k.kind === 'state') return lit(k.initial);
	if (!('default' in k) || k.default === undefined) return null;
	const d = k.default as unknown;
	if (d !== null && typeof d === 'object' && !Array.isArray(d)) {
		if ('now' in d) return `(now()${interval(String(d.now))})`;
		if ('today' in d) return `((now()${interval(String(d.today))}) at time zone ${lit(tz)})::date`;
		if ('actor' in d) return null;
	}
	return sqlValue(d, type);
}

// ── static predicates (check, unique/noOverlap `where`) → SQL, two-valued: a null never passes a comparison ──
type Where = { readonly [k: string]: unknown };
/** `plain`: three-valued, as a query writes it, so a partial index's predicate is one the planner can prove a query implies. */
function whereSql(w: Where, t: Table, col: (c: string) => string = q, plain = false): string {
	const parts: string[] = [];
	for (const [key, ops] of Object.entries(w)) {
		if (ops === undefined) continue;
		if (key === 'and' || key === 'or') {
			const arms = (ops as readonly Where[]).map((x) => whereSql(x, t, col, plain));
			parts.push(arms.length === 0 ? (key === 'and' ? 'true' : 'false') : `(${arms.join(` ${key} `)})`);
			continue;
		}
		if (key === 'not') { parts.push(`not ${whereSql(ops as Where, t, col, plain)}`); continue; }
		const cols = t.fieldCols.get(key) ?? fail(`${t.model}: unknown field '${key}' in a predicate`);
		if (cols.length !== 1) fail(`${t.model}.${key}: an exclusive arc cannot appear in a static predicate`);
		const c = t.cols.get(cols[0] as string) as Col;
		parts.push(...Object.entries(ops as Where).map(([op, v]) => leaf(col(c.name), c, op, v, t, col, plain)));
	}
	return parts.length === 0 ? 'true' : `(${parts.join(' and ')})`;
}
function leaf(c: string, col: Col, op: string, v: unknown, t: Table, colOf: (c: string) => string, plain = false): string {
	const val = (x: unknown): string => {
		if (x !== null && typeof x === 'object' && 'field' in x) {
			const other = t.fieldCols.get(String(x.field))?.[0] ?? fail(`${t.model}: unknown field '${String(x.field)}'`);
			return colOf(other);
		}
		return sqlValue(x, col.type);
	};
	const two = (sql: string) => plain ? sql : `coalesce(${sql}, false)`;
	const elem = col.type.replace('[]', '');
	const list = (xs: unknown) => `array[${(xs as readonly unknown[]).map((x) => sqlValue(x, elem)).join(', ')}]::${elem}[]`;
	if (plain && (op === 'in' || op === 'nin')) return `${c}${op === 'nin' ? ' not' : ''} in (${(v as readonly unknown[]).map((x) => sqlValue(x, elem)).join(', ')})`;
	if (plain && op === 'ne') return `${c} <> ${val(v)}`;
	const range = (p: unknown) => {
		const r = p as { from?: string; to?: string | null; start?: string; end?: string | null };
		return col.type === 'daterange' ? `daterange(${sqlValue(r.from, 'date')}, ${sqlValue(r.to, 'date')}, '[]')` : `tstzrange(${sqlValue(r.start, 'timestamptz')}, ${sqlValue(r.end, 'timestamptz')}, '[)')`;
	};
	switch (op) {
		case 'eq': return two(`${c} = ${val(v)}`);
		case 'ne': return `${c} is distinct from ${val(v)}`;
		case 'lt': return two(`${c} < ${val(v)}`);
		case 'lte': return two(`${c} <= ${val(v)}`);
		case 'gt': return two(`${c} > ${val(v)}`);
		case 'gte': return two(`${c} >= ${val(v)}`);
		case 'in': return two(`${c} = any(${list(v)})`);
		case 'nin': return `not ${two(`${c} = any(${list(v)})`)}`;
		case 'isNull': return v === true ? `${c} is null` : `${c} is not null`;
		case 'like': return two(`${c} like ${lit(String(v))}`);
		case 'has': return two(`${c} @> ${list([v])}`);
		case 'hasAny': return two(`${c} && ${list(v)}`);
		case 'hasAll': return two(`${c} @> ${list(v)}`);
		case 'isEmpty': return v === true ? two(`cardinality(${c}) = 0`) : two(`cardinality(${c}) > 0`);
		case 'contains': return two(`${c} @> ${sqlValue(v, col.type === 'daterange' ? 'date' : 'timestamptz')}`);
		case 'overlaps': return two(`${c} && ${range(v)}`);
		case 'within': return two(`${c} <@ ${range(v)}`);
		default: return fail(`${t.model}: operator '${op}' cannot appear in a static predicate`);
	}
}

// ── computed expressions → immutable SQL (rule 3) ──
type Kind = 'text' | 'int' | 'decimal' | 'bool' | 'date' | 'instant';
const KIND_OF: Record<string, Kind> = { text: 'text', enum: 'text', state: 'text', currency: 'text', int: 'int', count: 'int', duration: 'int',
	decimal: 'decimal', money: 'decimal', sum: 'decimal', bool: 'bool', date: 'date', instant: 'instant' };
const SQL_OF: Record<Kind, string> = { text: 'text', int: 'int', decimal: 'numeric', bool: 'boolean', date: 'date', instant: 'timestamptz' };
function exprSql(e: Expr, t: Table, tz: string, depth = 0): { sql: string; kind: Kind } {
	if (depth > 32) fail(`${t.model}: a computed expression refers to itself`);
	const x = (a: Expr) => exprSql(a, t, tz, depth + 1);
	if (typeof e === 'number') return Number.isInteger(e) ? { sql: `(${e})`, kind: 'int' } : { sql: `${lit(String(e))}::numeric`, kind: 'decimal' };
	if (typeof e === 'string') return { sql: `${lit(e)}::text`, kind: 'text' };
	if (typeof e === 'boolean') return { sql: String(e), kind: 'bool' };
	const [op, arg] = Object.entries(e)[0] ?? fail(`${t.model}: empty expression`);
	const args = arg as readonly Expr[];
	const num = (a: { sql: string; kind: Kind }, k: Kind) => (k === 'decimal' ? `(${a.sql})::numeric` : a.sql);
	const arith = (sym: string) => {
		const [a, b] = [x(args[0] as Expr), x(args[1] as Expr)];
		const k: Kind = a.kind === 'int' && b.kind === 'int' ? 'int' : 'decimal';
		return { sql: `(${num(a, k)} ${sym} ${num(b, k)})`, kind: k };
	};
	const cmp = (sym: string) => ({ sql: `(${x(args[0] as Expr).sql} ${sym} ${x(args[1] as Expr).sql})`, kind: 'bool' as const });
	switch (op) {
		case 'field': {
			const name = String(arg);
			const computed = t.spec.computed?.[name];
			// a generated column may not read another: inline the other tree
			if (computed !== undefined) return { sql: `(${x(computed.expr).sql})::${SQL_OF[KIND_OF[computed.kind] ?? 'text']}`, kind: KIND_OF[computed.kind] ?? 'text' };
			const c = t.cols.get(name) ?? fail(`${t.model}: computed reads unknown field '${name}'`);
			const k = c.kind.kind === 'seq' ? (c.type === 'int' ? 'int' : 'text') : KIND_OF[c.kind.kind] ?? fail(`${t.model}.${name}: a ${c.kind.kind} field cannot be computed over`);
			return { sql: q(name), kind: k };
		}
		case 'plus': return arith('+');
		case 'minus': return arith('-');
		case 'times': return arith('*');
		case 'div': { const [a, b] = [x(args[0] as Expr), x(args[1] as Expr)]; return { sql: `((${a.sql})::numeric / nullif((${b.sql})::numeric, 0))`, kind: 'decimal' }; }
		case 'round': return { sql: `round((${x(args[0] as Expr).sql})::numeric, ${Number(args[1])})`, kind: 'decimal' };
		case 'concat': return { sql: `(${args.map((a) => `coalesce(${text(x(a))}, '')`).join(' || ')})`, kind: 'text' };
		case 'plusDays': return { sql: `(${x(args[0] as Expr).sql} + (${x(args[1] as Expr).sql})::int)`, kind: 'date' };
		case 'startOf': {
			const a = x(args[0] as Expr);
			const unit = lit(String(args[1]));
			return a.kind === 'date' ? { sql: `date_trunc(${unit}, (${a.sql})::timestamp)::date`, kind: 'date' }
				: { sql: `(date_trunc(${unit}, (${a.sql}) at time zone ${lit(tz)}) at time zone ${lit(tz)})`, kind: 'instant' };
		}
		case 'text': return { sql: text(x(arg as Expr)), kind: 'text' };
		case 'lower': case 'upper': return { sql: `${op}(${x(arg as Expr).sql})`, kind: 'text' };
		case 'trim': return { sql: `btrim(${x(arg as Expr).sql})`, kind: 'text' };
		case 'substring': return { sql: `substr(${args.map((a) => x(a).sql).join(', ')})`, kind: 'text' };
		case 'regexReplace': return { sql: `regexp_replace(${x(args[0] as Expr).sql}, ${lit(String(args[1]))}, ${lit(String(args[2]))}, 'g')`, kind: 'text' };
		case 'jsonText': {
			const from = args[0] as Expr;
			const name = typeof from === 'object' && 'field' in from ? from.field : fail(`${t.model}: jsonText reads a json field`);
			if (t.cols.get(name)?.type !== 'jsonb') fail(`${t.model}: jsonText reads a json field, not '${name}'`);
			return { sql: `(${q(name)} ->> ${lit(String(args[1]))})`, kind: 'text' };
		}
		case 'eq': return cmp('=');
		case 'ne': return cmp('<>');
		case 'gt': return cmp('>');
		case 'gte': return cmp('>=');
		case 'lt': return cmp('<');
		case 'lte': return cmp('<=');
		case 'and': case 'or': return { sql: `(${args.map((a) => x(a).sql).join(` ${op} `)})`, kind: 'bool' };
		case 'not': return { sql: `(not ${x(arg as Expr).sql})`, kind: 'bool' };
		case 'when': { const [c, a, b] = args.map(x) as [ReturnType<typeof x>, ReturnType<typeof x>, ReturnType<typeof x>];
			const k: Kind = a.kind === b.kind ? a.kind : a.kind === 'text' || b.kind === 'text' ? 'text' : 'decimal';
			return { sql: `(case when ${c.sql} then ${num(a, k)} else ${num(b, k)} end)`, kind: k }; }
		case 'coalesce': { const xs = args.map(x); const k: Kind = xs.every((a) => a.kind === xs[0]?.kind) ? (xs[0]?.kind ?? 'text') : xs.some((a) => a.kind === 'text') ? 'text' : 'decimal';
			return { sql: `coalesce(${xs.map((a) => num(a, k)).join(', ')})`, kind: k }; }
		default: return fail(`${t.model}: unknown operator '${op}'`);
	}
}
/** `::text` is immutable for numbers and text; a date is spelled out, since `date::text` reads DateStyle. */
function text(a: { sql: string; kind: Kind }): string {
	if (a.kind === 'date') return `(lpad(extract(year from ${a.sql})::int::text, 4, '0') || '-' || lpad(extract(month from ${a.sql})::int::text, 2, '0') || '-' || lpad(extract(day from ${a.sql})::int::text, 2, '0'))`;
	return a.kind === 'text' ? a.sql : `(${a.sql})::text`;
}

// ── the objects ──
const SEARCH = 'bolt_search';
const EMBEDDING = 'bolt_embedding';

export function schemaObjects(declared: SchemaSlice): SchemaObject[] {
	// Render from sorted keys: the applied slice comes back from `bolt_schema.slice` (jsonb) with its keys reordered, and
	// a state's keys or a predicate's fields in another order would hash every constraint name differently from the
	// manifest's — the plan would re-create a constraint the database already has.
	const s = JSON.parse(canonical(declared)) as SchemaSlice;
	const rels = relationships(s);
	const all = tables(s, rels);
	const out: SchemaObject[] = [];
	// an object's id names its definition, so a second push of one id (a declared `index` on a relationship's FK column,
	// which already gets its index) is the same object and is dropped
	const ids = new Set<string>();
	const push = (o: SchemaObject) => { if (!ids.has(o.id)) { ids.add(o.id); out.push(o); } };
	const anyKind = (k: string) => Object.values(s.models).some((m) => Object.values(m.fields).some((f) => f.kind === k));
	if (Object.values(s.models).some((m) => (m.noOverlap ?? []).length > 0))
		push({ id: 'extension:btree_gist', rank: 'extension', table: '', deps: [], create: ['create extension if not exists btree_gist'], drop: null });
	if (anyKind('vector') || Object.values(s.models).some((m) => m.search?.semantic !== undefined))
		push({ id: 'extension:vector', rank: 'extension', table: '', deps: [], create: ['create extension if not exists vector'], drop: null });

	for (const t of all.values()) {
		const T = q(t.model);
		// a system table (`table`): its key alone, plain uniques (an `on conflict` arbiter), no approval index
		const sys = t.spec.table;
		const deferrable = sys === undefined ? ' deferrable initially immediate' : '';
		const constraint = (kind: 'uq' | 'key' | 'ck' | 'ex', def: string, deps: readonly string[], violations: string, meta: ConstraintMeta) => {
			const name = cname(t.model, kind, def);
			push({ id: `constraint:${t.model}.${name}`, rank: 'constraint', table: t.model, deps, violations, meta: { ...meta, name },
				create: [`alter table ${T} add constraint ${q(name)} ${def}`], drop: `alter table ${T} drop constraint if exists ${q(name)}` });
		};
		const check = (expr: string, deps: readonly string[], meta: ConstraintMeta) =>
			constraint('ck', `check (${expr})`, deps, `select count(*)::int as n from ${T} where (${expr}) is false`, meta);
		const index = (kind: string, def: string, deps: readonly string[], unique = false) => {
			const name = cname(t.model, kind, def);
			push({ id: `index:${t.model}.${name}`, rank: 'index', table: t.model, deps, create: [`create ${unique ? 'unique ' : ''}index ${q(name)} on ${T} ${def}`], drop: `drop index if exists ${q(name)}` });
		};
		const colsOf = (fields: readonly string[]) => fields.flatMap((f) => t.fieldCols.get(f) ?? fail(`${t.model}: unknown field '${f}'`));

		const key = sys === undefined ? undefined : primaryOf(t.spec);
		const keyDef = key === undefined ? SYSTEM_COLUMNS : `${q(key.name)} ${key.type}${sys?.primary === 'identity' ? ' generated always as identity' : ''} primary key`;
		push({ id: `table:${t.model}`, rank: 'table', table: t.model, deps: [], stored: true, create: [`create table ${T} (${keyDef})`], drop: `drop table if exists ${T} cascade` });
		// A.2 L-BOLT-103: the approval ownership index — seal, restore and held reads find a request's rows by `approval_id`
		if (sys === undefined) index('approval', '(approval_id) where approval_id is not null', []);

		// stored fields
		for (const [name, k] of Object.entries(t.spec.fields)) {
			if (name === key?.name) continue;
			const c = t.cols.get(name) as Col;
			const C = q(name);
			if (name === sys?.identity) {
				push({ id: `column:${t.model}.${name}`, rank: 'column', table: t.model, deps: [name], shape: 'identity', stored: true,
					create: [`alter table ${T} add column ${C} bigint generated by default as identity`], drop: `alter table ${T} drop column if exists ${C} cascade` });
				continue;
			}
			const rollup = k.kind === 'sum' || k.kind === 'count';
			const def = defaultSql(k, c.type, s.tz) ?? (rollup ? '0' : null);
			push({ id: `column:${t.model}.${name}`, rank: 'column', table: t.model, deps: [name], shape: c.type, create: [`alter table ${T} add column ${C} ${c.type}${def === null ? '' : ` default ${def}`}`],
				drop: `alter table ${T} drop column if exists ${C} cascade`, ...(rollup ? { derived: true as const } : { stored: true as const }) });
			if (def !== null && !rollup)
				push({ id: `default:${t.model}.${name}`, rank: 'default', table: t.model, deps: [name], create: [`alter table ${T} alter column ${C} set default ${def}`], drop: `alter table ${T} alter column ${C} drop default` });
			if (!c.optional || rollup)
				push({ id: `notNull:${t.model}.${name}`, rank: 'notNull', table: t.model, deps: [name], create: [`alter table ${T} alter column ${C} set not null`],
					drop: `alter table ${T} alter column ${C} drop not null`, violations: `select count(*)::int as n from ${T} where ${C} is null` });
			if (rollup) push(rollupBackfill(t, name, k, rels, all));
			const kc = kindCheck(C, k, s.currency, t);
			if (kc !== null) check(kc, k.kind === 'money' && typeof k.currency === 'string' && !/^[A-Z]{3}$/.test(k.currency) ? [name, k.currency] : [name], { model: t.model, kind: 'check', fields: [name] });
			if (k.kind === 'text' && k.many === true || k.kind === 'enum' && k.many === true) index('gin', `using gin (${C})`, [name]);
			if (k.kind === 'point') index('gist', `using gist (${C})`, [name]);
			if (k.kind === 'vector') index('hnsw', `using hnsw (${C} vector_${k.metric}_ops)`, [name]);
			if ('unique' in k && k.unique === true)
				constraint('uq', `unique (${C})${deferrable}`, [name], dupes(T, [C], `${C} is not null`), { model: t.model, kind: 'unique', fields: [name] });
			if (k.kind === 'seq') {
				const scope = colsOf(k.per ?? []);
				const cols = [...scope.map(q), C];
				constraint('uq', `unique nulls not distinct (${cols.join(', ')})${deferrable}`, [...scope, name], dupes(T, cols), { model: t.model, kind: 'unique', fields: [...(k.per ?? []), name] });
			}
		}

		// computed and the search documents: generated stored columns
		for (const [name, c] of Object.entries(t.spec.computed ?? {})) {
			const e = exprSql(c.expr, t, s.tz);
			push({ id: `column:${t.model}.${name}`, rank: 'column', table: t.model, deps: [name, ...exprDeps(c.expr, t)], derived: true,
				create: [`alter table ${T} add column ${q(name)} ${SQL_OF[KIND_OF[c.kind] ?? 'text']} generated always as ((${e.sql})::${SQL_OF[KIND_OF[c.kind] ?? 'text']}) stored`],
				drop: `alter table ${T} drop column if exists ${q(name)} cascade` });
		}
		if (t.spec.search !== undefined) {
			// the multilingual document (L-BOLT-121/122): folded, tokenized and romanized when the row is written
			const doc = t.spec.search.text.map((f) => {
				const computed = t.spec.computed?.[f];
				if (computed !== undefined) return text(exprSql(computed.expr, t, s.tz));
				const col = t.cols.get(f) ?? fail(`${t.model}: search names unknown field '${f}'`);
				return col.type.endsWith('[]') ? `bolt_search_join(${q(f)}::text[])` : `${q(f)}::text`;
			});
			const deps = t.spec.search.text.flatMap((f) => (t.spec.computed?.[f] ? exprDeps(t.spec.computed[f].expr, t) : [f]));
			for (const fn of SEARCH_FUNCTIONS) push({ id: `function:${fn.id}`, rank: 'function', table: '', deps: [], create: [fn.sql], drop: null });
			push({ id: `column:${t.model}.${SEARCH}`, rank: 'column', table: t.model, deps: [SEARCH, ...deps], derived: true,
				create: [`alter table ${T} add column ${SEARCH} tsvector generated always as (${doc.length === 0 ? "''::tsvector" : `bolt_search_document(${doc.map((d) => `coalesce(${d}, '')`).join(" || ' ' || ")})`}) stored`],
				drop: `alter table ${T} drop column if exists ${SEARCH} cascade` });
			index('gin', `using gin (${SEARCH})`, [SEARCH]);
			const sem = t.spec.search.semantic;
			if (sem !== undefined) {
				// platform-managed: backfilled by the `bolt.embed` run after commit (rule 16)
				push({ id: `column:${t.model}.${EMBEDDING}`, rank: 'column', table: t.model, deps: [EMBEDDING], derived: true,
					create: [`alter table ${T} add column ${EMBEDDING} vector(${sem.dim})`], drop: `alter table ${T} drop column if exists ${EMBEDDING} cascade` });
				index('hnsw', `using hnsw (${EMBEDDING} vector_cosine_ops)`, [EMBEDDING]);
			}
		}

		// declared identity and invariants
		if (t.spec.key !== undefined) {
			const cols = colsOf(t.spec.key);
			constraint('key', `unique (${cols.map(q).join(', ')})`, cols, dupes(T, cols.map(q)), { model: t.model, kind: 'unique', fields: t.spec.key });
		}
		for (const u of t.spec.unique ?? []) {
			const cols = colsOf(u.fields);
			const meta: ConstraintMeta = { model: t.model, kind: 'unique', fields: u.fields, ...(u.name === undefined ? {} : { rule: u.name }) };
			if (u.where === undefined) {
				const nulls = cols.length > 1 ? ' nulls not distinct' : '';
				constraint('uq', `unique${nulls} (${cols.map(q).join(', ')})${deferrable}`, cols, dupes(T, cols.map(q), cols.length > 1 ? undefined : `${q(cols[0] as string)} is not null`), meta);
			} else if (sys !== undefined) {
				// a system table's partial uniqueness is a plain unique index: never swapped mid-statement, and an arbiter
				index('ux', `(${cols.map(q).join(', ')}) where ${whereSql(u.where as Where, t, q, true)}`, [...cols, ...whereDeps(u.where as Where)], true);
			} else {
				// a partial UNIQUE index cannot be deferred; an EXCLUDE with `=` can
				const pred = whereSql(u.where as Where, t);
				const keys = cols.length > 1 ? nullAsValue(cols, t) : cols.map((c) => `${q(c)} with =`);
				constraint('ex', `exclude using btree (${keys.join(', ')}) where ${pred} deferrable initially immediate`, [...cols, ...whereDeps(u.where as Where)],
					dupes(T, cols.length > 1 ? cols.map((c) => `${q(c)}`) : cols.map(q), cols.length > 1 ? pred : `${q(cols[0] as string)} is not null and ${pred}`), meta);
			}
		}
		for (const [rule, c] of Object.entries(t.spec.check ?? {})) {
			const { where: w, message } = checkOf(c); // hook:write
			check(whereSql(w as Where, t), whereDeps(w as Where), { model: t.model, kind: 'check', fields: whereDeps(w as Where), rule, ...(message === undefined ? {} : { message }) });
		}
		for (const o of t.spec.noOverlap ?? []) {
			const cols = colsOf(o.key);
			const pred = o.where === undefined ? null : whereSql(o.where as Where, t);
			const alias = (a: string) => (c: string) => `${a}.${q(c)}`;
			const pairs = [...cols.map((c) => `a.${q(c)} is not distinct from b.${q(c)}`), `a.${q(o.period)} && b.${q(o.period)}`,
				...(pred === null ? [] : [whereSql(o.where as Where, t, alias('a')), whereSql(o.where as Where, t, alias('b'))])];
			constraint('ex', `exclude using gist (${[...nullAsValue(cols, t), `${q(o.period)} with &&`].join(', ')})${pred === null ? '' : ` where ${pred}`} deferrable initially immediate`,
				[...cols, o.period, ...(o.where === undefined ? [] : whereDeps(o.where as Where))],
				`select count(*)::int as n from ${T} a join ${T} b on a.id < b.id and ${pairs.join(' and ')}`,
				{ model: t.model, kind: 'overlap', fields: [...o.key, o.period], ...(o.name === undefined ? {} : { rule: o.name }) });
		}
		for (const i of t.spec.index ?? []) {
			const cols = colsOf(typeof i === 'string' ? [i] : i);
			index('ix', `(${cols.map(q).join(', ')})`, cols);
		}
		for (const i of sys?.indexes ?? []) {
			const on = i.on.map((x) => typeof x === 'string' ? { f: x, sql: q(colsOf([x])[0] as string) } : { f: x.lower, sql: `lower(${q(colsOf([x.lower])[0] as string)})` });
			const where = i.where === undefined ? '' : ` where ${whereSql(i.where as Where, t, q, true)}`;
			index(i.unique === true ? 'ux' : 'ix', `(${on.map((x) => x.sql).join(', ')})${where}`, [...on.map((x) => x.f), ...(i.where === undefined ? [] : whereDeps(i.where as Where))], i.unique === true);
		}
	}

	// relationships: FK columns, NO ACTION FKs (checked at end of statement), an index each, the arc CHECK
	for (const r of rels) {
		if (!all.has(r.model)) fail(`relationship '${r.key}' names unknown model '${r.model}'`);
		const T = q(r.model);
		r.cols.forEach((c, i) => {
			const target = r.to[i] as string;
			push({ id: `column:${r.model}.${c}`, rank: 'column', table: r.model, deps: [c], stored: true, create: [`alter table ${T} add column ${q(c)} ${fkType(s.models, target)}`], drop: `alter table ${T} drop column if exists ${q(c)} cascade` });
			// a system table's cascade is the database's (its rows are the engine's, no write statement deletes them)
			const cascade = r.spec.onDelete === 'cascade' && s.models[r.model]?.table !== undefined ? ' on delete cascade' : '';
			const def = `foreign key (${q(c)}) references ${q(target)} (${s.models[target]?.table === undefined ? 'id' : q(primaryOf(s.models[target]!).name)})${cascade}`;
			const name = cname(r.model, 'fk', def);
			push({ id: `fk:${r.model}.${name}`, rank: 'fk', table: r.model, deps: [c], meta: { name, model: r.model, kind: 'fk', fields: [r.field] },
				create: [`alter table ${T} add constraint ${q(name)} ${def}`], drop: `alter table ${T} drop constraint if exists ${q(name)}`,
				violations: `select count(*)::int as n from ${T} c where c.${q(c)} is not null and not exists (select 1 from ${q(target)} p where p.id = c.${q(c)})` });
			const ix = cname(r.model, 'ix', `(${q(c)})`);
			push({ id: `index:${r.model}.${ix}`, rank: 'index', table: r.model, deps: [c], create: [`create index ${q(ix)} on ${T} (${q(c)})`], drop: `drop index if exists ${q(ix)}` });
		});
		if (r.cols.length === 1 && r.spec.optional !== true)
			push({ id: `notNull:${r.model}.${r.field}`, rank: 'notNull', table: r.model, deps: [r.field], create: [`alter table ${T} alter column ${q(r.field)} set not null`],
				drop: `alter table ${T} alter column ${q(r.field)} drop not null`, violations: `select count(*)::int as n from ${T} where ${q(r.field)} is null` });
		if (r.cols.length > 1) {
			const expr = `num_nonnulls(${r.cols.map(q).join(', ')}) ${r.spec.optional === true ? '<=' : '='} 1`;
			const name = cname(r.model, 'ck', expr);
			push({ id: `constraint:${r.model}.${name}`, rank: 'constraint', table: r.model, deps: r.cols, meta: { name, model: r.model, kind: 'check', fields: [r.field] },
				create: [`alter table ${T} add constraint ${q(name)} check (${expr})`], drop: `alter table ${T} drop constraint if exists ${q(name)}`,
				violations: `select count(*)::int as n from ${T} where (${expr}) is false` });
		}
	}
	// the engine's private objects (X-18) come last: a private table may reference a system table
	for (const o of engineObjects()) push(o);
	return out;
}

/** Composite identity treats null as a value (§5.2): `coalesce(x, <sentinel>)` plus `x is null`, exact for any sentinel. */
function nullAsValue(cols: readonly string[], t: Table): string[] {
	return cols.flatMap((c) => {
		const col = t.cols.get(c) as Col;
		if (!col.optional) return [`${q(c)} with =`];
		const sentinel = col.type === 'boolean' ? 'false' : col.type === 'uuid' ? `'00000000-0000-0000-0000-000000000000'::uuid`
			: ['int', 'numeric'].includes(col.type) ? '0' : ['date', 'timestamptz'].includes(col.type) ? `'-infinity'::${col.type}` : `''::${col.type}`;
		return [`(coalesce(${q(c)}, ${sentinel})) with =`, `(${q(c)} is null) with =`];
	});
}
/** Rows beyond the first of each duplicate group (`group by` treats nulls as equal, as NULLS NOT DISTINCT does). */
const dupes = (T: string, cols: readonly string[], where?: string) =>
	`select coalesce(sum(n - 1), 0)::int as n from (select count(*) as n from ${T}${where === undefined ? '' : ` where ${where}`} group by ${cols.join(', ')} having count(*) > 1) d`;
function whereDeps(w: Where): string[] {
	return Object.entries(w).flatMap(([k, v]) => (k === 'and' || k === 'or' ? (v as Where[]).flatMap(whereDeps) : k === 'not' ? whereDeps(v as Where) : [k]));
}
function exprDeps(e: Expr, t: Table): string[] {
	if (e === null || typeof e !== 'object') return [];
	if ('field' in e) { const c = t.spec.computed?.[e.field]; return c === undefined ? [e.field] : exprDeps(c.expr, t); }
	return Object.values(e).flatMap((a) => (Array.isArray(a) ? (a as Expr[]).flatMap((x) => exprDeps(x, t)) : exprDeps(a as Expr, t)));
}

/** The CHECK a kind implies (rule 68: formats, bounds, membership, minor units, valid periods, point range). */
function kindCheck(C: string, k: FieldKind, wsCurrency: string | null, t: Table): string | null {
	const parts: string[] = [];
	switch (k.kind) {
		case 'text':
			if (k.many === true) break;
			if (k.max !== undefined) parts.push(`char_length(${C}) <= ${k.max}`);
			if (k.format === 'email') parts.push(`${C} ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'`);
			if (k.format === 'phone') parts.push(`${C} ~ '^\\+?[0-9][0-9 ()\\-.]{2,}$'`);
			if (k.format === 'url') parts.push(`${C} ~ '^https?://\\S+$'`);
			if (k.format === 'zone') parts.push(`${C} ~ '^[A-Za-z_]+(/[A-Za-z0-9_+\\-]+)*$'`);
			break;
		case 'int': case 'decimal':
			if (k.kind === 'decimal') parts.push(`round(${C}, ${k.scale}) = ${C}`);
			if (k.kind === 'decimal' && k.precision !== undefined) parts.push(`abs(${C}) < 1e${k.precision - k.scale}`);
			if (k.min !== undefined) parts.push(`${C} >= ${k.min}`);
			if (k.max !== undefined) parts.push(`${C} <= ${k.max}`);
			break;
		case 'money': {
			const cur = k.currency ?? wsCurrency;
			if (cur === null) break;
			parts.push(/^[A-Z]{3}$/.test(cur) ? `round(${C}, ${minorUnits(cur)}) = ${C}`
				: t.cols.has(cur) ? `round(${C}, bolt_minor_units(${q(cur)})) = ${C}` : fail(`${t.model}: money currency '${cur}' is neither a code nor a field`));
			break;
		}
		case 'currency': parts.push(`${C} ~ '^[A-Z]{3}$'`); break;
		case 'duration': parts.push(`${C} >= 0`); break;
		case 'period': parts.push(`not isempty(${C}) and not lower_inf(${C})`); break;
		case 'enum': parts.push(k.many === true ? `${C} <@ array[${k.values.map(lit).join(', ')}]::text[]` : `${C} in (${k.values.map(lit).join(', ')})`); break;
		case 'state': parts.push(`${C} in (${Object.keys(k.states).map(lit).join(', ')})`); break;
		case 'seq': if (k.kind === 'seq' && k.pattern === undefined) parts.push(`${C} >= 1`); break;
		case 'file': parts.push(k.multiple === true ? `jsonb_typeof(${C}) = 'array' and jsonb_array_length(${C}) <= 20` : `jsonb_typeof(${C}) = 'object'`); break;
		case 'point': parts.push(`${C}[1] between -90 and 90 and ${C}[0] between -180 and 180`); break;
		default: break;
	}
	return parts.length === 0 ? null : parts.join(' and ');
}

/** A new roll-up column's values from its children (the backfill class). */
function rollupBackfill(t: Table, name: string, k: FieldKind & { kind: 'sum' | 'count' }, rels: readonly Rel[], all: Map<string, Table>): SchemaObject {
	const [inverse = '', field] = k.of.split('.');
	const r = rels.find((x) => x.to.includes(t.model) && (x.spec.inverse ?? x.model) === inverse)
		?? fail(`${t.model}.${name}: no relationship to ${t.model} has the inverse '${inverse}'`);
	const child = all.get(r.model) as Table;
	const fk = r.cols[r.to.indexOf(t.model)] as string;
	const where = k.where === undefined ? '' : ` and ${whereSql(k.where, child, (c) => `c.${q(c)}`)}`;
	const agg = k.kind === 'count' ? 'count(*)::int' : `coalesce(sum(c.${q(field ?? fail(`${t.model}.${name}: a sum names '<inverse>.<field>'`))}), 0)`;
	return { id: `backfill:${t.model}.${name}`, rank: 'backfill', table: t.model, deps: [name], derived: true, drop: null,
		create: [`update ${q(t.model)} p set ${q(name)} = (select ${agg} from ${q(r.model)} c where c.${q(fk)} = p.id${where})`] };
}

/** Constraint name → its declaration, for the SQLSTATE map. */
export function constraintIndex(s: SchemaSlice): ReadonlyMap<string, ConstraintMeta> {
	return new Map(schemaObjects(s).flatMap((o) => (o.meta === undefined ? [] : [[o.meta.name, o.meta] as const])));
}
