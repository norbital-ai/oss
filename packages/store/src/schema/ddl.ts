// The schema is its tables: each table, relation and many-to-many relation rendered as schema objects, each with its
// create and drop SQL, the columns it reads, and a count of the rows that would refuse it. `plan.ts` diffs two object
// lists; the migration files are rendered from that diff.
//
// One enforcing place per declared constraint: kind / NOT NULL / CHECK, FK, UNIQUE / EXCLUDE, GENERATED STORED
// (`computed`, the search document). An audited table's uniques, checks and exclusions are DEFERRABLE INITIALLY
// IMMEDIATE (a natural key is not: it is an `on conflict` arbiter). Legacy snapshots retain their original DDL.
import { Effect, Schema } from 'effect';
import * as ReadonlyArray from 'effect/Array';
import { sha256, toHex, canonical } from '../hash.ts';
import type { Json } from '../values.ts';
import type { Catalog } from '../catalog.ts';
import { catalogOf, indexColumn } from '../catalog.ts';
import { where } from '../decode.ts';
import { ownPredSql } from '../write/predicate.ts';
import { jsonPath } from '../read/values.ts';
import { StoreError } from '../errors.ts';
import { clockDefault } from '@norbital-ai/std/vars';
import { searchFunctions } from './search.ts';
import { ROW_RULES_V1, ROW_RULES_V2 } from './rules.ts';
import { JSON_VALID } from './json.ts';
import { SchemaSpec, type Expr, type FieldSpec, type RefSpec, type TableSpec } from './spec.ts';

type Fx<A> = Effect.Effect<A, StoreError>;
/** How a constraint name maps back to its declaration, for a writer's SQLSTATE → refusal map. */
export type ConstraintMeta = {
	model: string;
	kind: 'unique' | 'check' | 'overlap' | 'fk';
	fields: readonly string[];
	rule?: string;
	/** A check's authored refusal message (`check: { <rule>: { where, message } }`). */
	message?: string;
};
/** A check is a bare where literal or `{ where, message }` (the message is the refusal a reader is shown). */
export const checkOf = (c: object): { where: object; message?: string } =>
	'where' in c &&
	typeof c.where === 'object' &&
	c.where !== null &&
	'message' in c &&
	typeof c.message === 'string'
		? { where: c.where, message: c.message }
		: { where: c };
/** Create order: a later rank may depend on an earlier one; drops run in reverse. */
export const RANK = {
	extension: 0,
	function: 1,
	table: 2,
	column: 3,
	backfill: 4,
	default: 5,
	notNull: 6,
	constraint: 7,
	fk: 8,
	index: 9
} as const;
export const SchemaObjectSchema = Schema.Struct({
	id: Schema.String,
	rank: Schema.Literals([
		'extension',
		'function',
		'table',
		'column',
		'backfill',
		'default',
		'notNull',
		'constraint',
		'fk',
		'index'
	]),
	table: Schema.String,
	/** Own columns this object reads: a replaced column replaces its dependants. */
	deps: Schema.Array(Schema.String),
	create: Schema.Array(Schema.String),
	/** What a change of rebuilds the object, when not all of `create` (a column's default is its own object). */
	shape: Schema.optionalKey(Schema.String),
	/** `null`: never dropped (extensions, a host's own objects). */
	drop: Schema.NullOr(Schema.String),
	/** Dropping it loses data (a table, a stored column): the destructive class. */
	stored: Schema.optionalKey(Schema.Literal(true)),
	/** Derived on create (a generated or roll-up column): the backfill class on a populated table. */
	derived: Schema.optionalKey(Schema.Literal(true)),
	/** `select count(*)::int as n …`: rows the new object would refuse (the validating class). */
	violations: Schema.optionalKey(Schema.String)
});
export type SchemaObject = typeof SchemaObjectSchema.Type & {
	readonly meta?: ConstraintMeta & { name: string };
};

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;
const lit = (v: string): string => `'${v.replaceAll("'", "''")}'`;
const fail = (message: string) => Effect.fail(StoreError.of('schema', 'derive', message));
const hash8 = (s: string): string => toHex(sha256(s)).slice(0, 8);
/** `<table≤40>__<kind>__<hash8>`: at most 63 bytes for any table name `ident` admits. */
const cname = (table: string, kind: string, def: string): string =>
	`${table.slice(0, 40)}__${kind}__${hash8(def)}`;
const ident = (name: string): Fx<string> =>
	new TextEncoder().encode(name).length > 63
		? fail(`identifier '${name}' is over 63 bytes; shorten the table or field name`)
		: Effect.succeed(name);

// ISO 4217 exponents that are not 2 (the minor-unit CHECK on money).
const MINOR: Record<number, readonly string[]> = {
	0: [
		'BIF',
		'CLP',
		'DJF',
		'GNF',
		'ISK',
		'JPY',
		'KMF',
		'KRW',
		'PYG',
		'RWF',
		'UGX',
		'UYI',
		'VND',
		'VUV',
		'XAF',
		'XOF',
		'XPF'
	],
	3: ['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'],
	4: ['CLF', 'UYW']
};
const minorUnits = (code: string): number =>
	Number(Object.entries(MINOR).find(([, cs]) => cs.includes(code))?.[0] ?? 2);
/** The money minor-unit CHECK's helper; a schema with a field-named currency creates it. */
export const MINOR_FN = `create or replace function bolt_minor_units(c text) returns int language sql immutable parallel safe as $$ select case ${Object.entries(
	MINOR
)
	.map(([n, cs]) => `when c in (${cs.map(lit).join(', ')}) then ${n}`)
	.join(' ')} else 2 end $$`;

const AUDIT =
	'revision int not null default 1, created_at timestamptz not null default now(), ' +
	'created_by text, updated_at timestamptz not null default now(), updated_by text';
const AUDIT_UPDATE = `create or replace function store_audit_update() returns trigger language plpgsql as $store_audit$
begin
	if new.revision is not distinct from old.revision then
		new.revision := old.revision + 1;
		new.updated_at := clock_timestamp();
		new.updated_by := null;
	end if;
	return new;
end;
$store_audit$`;

// ── columns ──
type Col = { name: string; type: string; kind: string; optional: boolean };
export const PG: Record<string, string> = {
	text: 'text',
	int: 'int',
	number: 'double precision',
	decimal: 'numeric',
	money: 'numeric',
	currency: 'text',
	bool: 'boolean',
	date: 'date',
	instant: 'timestamptz',
	time: 'time',
	duration: 'int',
	enum: 'text',
	state: 'text',
	sum: 'numeric',
	count: 'int',
	json: 'jsonb',
	list: 'jsonb',
	object: 'jsonb',
	file: 'jsonb',
	point: 'point',
	custom: 'jsonb',
	ref: 'uuid'
};
/** A stored field's column type; inline unions and records live inside a shaped json value. */
export function colType(k: FieldSpec): string | undefined {
	if (k.kind === 'int' && k.storage === 'int64') return 'bigint';
	if (k.kind === 'period') return k.of === 'date' ? 'daterange' : 'tstzrange';
	if (k.kind === 'vector') return `vector(${k.dim})`;
	if (k.kind === 'seq') return k.pattern === undefined ? 'int' : 'text';
	const t = PG[k.kind];
	if (t === undefined) return undefined;
	return (k.kind === 'text' || k.kind === 'enum') && k.many === true ? `${t}[]` : t;
}
const typeOf = (k: FieldSpec, where: string): Fx<string> => {
	const t = colType(k);
	return t === undefined
		? fail(`${where}: a '${k.kind}' is an input kind, not a stored one`)
		: Effect.succeed(t);
};

type Rel = {
	key: string;
	model: string;
	field: string;
	to: readonly string[];
	spec: RefSpec;
	cols: readonly string[];
};
/** A table's single key column: its name and type (an FK to it has that type). */
type KeyCol = { name: string; type: string };
const keyOf = (spec: TableSpec): Fx<readonly KeyCol[]> =>
	ReadonlyArray.isArray<TableSpec['key']>(spec.key)
		? Effect.forEach(spec.key, (f) => {
				const k = spec.fields[f];
				return k === undefined
					? fail(`key names unknown field '${f}'`)
					: Effect.map(typeOf(k, f), (type) => ({ name: f, type }));
			})
		: Effect.succeed([
				{
					name: 'id',
					type: spec.key === 'identity' ? 'bigint' : spec.key === 'text' ? 'text' : 'uuid'
				}
			]);
/** An FK column takes its target's key type; a composite key is no FK target. */
const fkType = Effect.fnUntraced(function* (s: SchemaSpec, target: string, key: string) {
	const spec = s.tables[target];
	if (spec === undefined)
		return yield* fail(`relation '${key}' points at undeclared table '${target}'`);
	const k = yield* keyOf(spec);
	const [only] = k;
	if (k.length !== 1 || only === undefined)
		return yield* fail(
			`relation '${key}': '${target}' has a composite key, which no FK may point at`
		);
	return only;
});
function relations(s: SchemaSpec): Effect.Effect<Rel[], StoreError> {
	const refs = Object.entries(s.tables).flatMap(([model, t]) =>
		Object.entries(t.fields).flatMap(([field, k]) =>
			k.kind === 'ref' ? [{ model, field, spec: k }] : []
		)
	);
	return Effect.forEach(refs, ({ model, field, spec }) =>
		Effect.gen(function* () {
			const key = `${model}.${field}`;
			if (spec.onDelete === 'setNull' && spec.optional !== true)
				return yield* fail(`relation '${key}': onDelete 'setNull' needs an optional ref`);
			const to = typeof spec.to === 'string' ? [spec.to] : spec.to;
			const cols =
				to.length === 1 ? [field] : yield* Effect.forEach(to, (t) => ident(`${field}__${t}`));
			const rel: Rel = { key, model, field, to, spec, cols };
			return rel;
		})
	);
}

/** Table → its columns by field name (a polymorphic field names several). */
type Table = {
	catalog: Catalog;
	model: string;
	spec: TableSpec;
	cols: Map<string, Col>;
	fieldCols: Map<string, readonly string[]>;
};
const tables = Effect.fnUntraced(function* (s: SchemaSpec, rels: readonly Rel[]) {
	const out = new Map<string, Table>();
	const catalogue = catalogOf(s);
	for (const [model, spec] of Object.entries(s.tables)) {
		yield* ident(model);
		const cols = new Map<string, Col>();
		const fieldCols = new Map<string, readonly string[]>();
		for (const [name, kind] of Object.entries(spec.fields)) {
			if (kind.kind === 'ref') continue;
			cols.set(name, {
				name: yield* ident(name),
				type: yield* typeOf(kind, `${model}.${name}`),
				kind: kind.kind,
				optional: kind.optional === true
			});
			fieldCols.set(name, [name]);
		}
		for (const r of rels.filter((x) => x.model === model)) {
			for (const [i, c] of r.cols.entries()) {
				const target = r.to[i] ?? '';
				cols.set(c, {
					name: c,
					type: (yield* fkType(s, target, r.key)).type,
					kind: 'ref',
					optional: r.spec.optional === true || r.cols.length > 1
				});
			}
			fieldCols.set(r.field, r.cols);
		}
		for (const [name, c] of Object.entries(spec.computed ?? {})) {
			fieldCols.set(name, [name]);
			cols.set(name, { name, type: PG[c.kind] ?? 'text', kind: c.kind, optional: true });
		}
		if (!ReadonlyArray.isArray<TableSpec['key']>(spec.key)) {
			const [id] = yield* keyOf(spec);
			fieldCols.set('id', ['id']);
			cols.set('id', { name: 'id', type: id?.type ?? 'uuid', kind: 'id', optional: false });
		}
		if (spec.audit === true)
			for (const a of ['revision', 'created_at', 'created_by', 'updated_at', 'updated_by']) {
				fieldCols.set(a, [a]);
				cols.set(a, {
					name: a,
					type: a === 'revision' ? 'int' : a.endsWith('_at') ? 'timestamptz' : 'text',
					kind: 'text',
					optional: true
				});
			}
		out.set(model, { catalog: catalogue, model, spec, cols, fieldCols });
	}
	return out;
});

// ── literals by column type ──
function sqlValue(v: unknown, type: string, native = false): Fx<string> {
	if (native && type === 'jsonb' && v !== undefined)
		return Effect.succeed(`${lit(canonical(v))}::jsonb`);
	if (v === null || v === undefined) return Effect.succeed('null');
	if (typeof v === 'boolean') return Effect.succeed(v ? 'true' : 'false');
	if (type.endsWith('[]'))
		return ReadonlyArray.isArray(v)
			? Effect.succeed(
					`${lit(`{${v.map((x) => `"${String(x).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`)}::${type}`
				)
			: fail('an array default takes a list');
	if (typeof v === 'object') return Effect.succeed(`${lit(canonical(v))}::${type}`);
	return Effect.succeed(`${lit(String(v))}::${type}`);
}
const isRecord = (v: unknown): v is { readonly [k: string]: unknown } =>
	typeof v === 'object' && v !== null && !ReadonlyArray.isArray(v);
/** A literal default, or a clock variable (`{ var: 'now' }`, `{ var: 'today + days(7)' }` in the schema's zone); a writer
 * fills the rest (`{ var: 'requestor.id' }`). */
const defaultSql = Effect.fnUntraced(function* (
	k: FieldSpec,
	type: string,
	tz: string,
	native = false
) {
	if (k.kind === 'state') return lit(k.initial);
	const d = k.default;
	if (d === undefined) return null;
	if (isRecord(d) && Object.keys(d).length === 1 && typeof d['var'] === 'string') {
		const text = d['var'],
			clock = clockDefault(text);
		if (clock?.base === 'now' && (!native || k.kind === 'instant'))
			return `(now()${clock.interval})`;
		if (clock?.base === 'today' && (!native || k.kind === 'date'))
			return `((now()${clock.interval}) at time zone ${lit(tz)})::date`;
		if (
			(text === 'requestor.id' || text === 'requestor.party') &&
			(!native || k.kind === 'ref' || k.kind === 'id' || k.kind === 'text')
		)
			return null;
	}
	return yield* sqlValue(d, type, native);
});

// ── static predicates (check, unique/noOverlap `where`) → SQL, two-valued: a null never passes a comparison ──
/** Static declarations normalize through the same Pred as reads and grants. */
const staticSql = Effect.fnUntraced(function* (
	w: object,
	t: Table,
	col: (field: string) => string = q,
	plain: boolean = false
) {
	const pred = yield* where(t.catalog, t.model, sortedKeys(w));
	const sample = col('__bolt_column__');
	const row =
		sample === q('__bolt_column__') ? '' : sample.slice(0, sample.indexOf(q('__bolt_column__')));
	const fields = new Map(
		[...(t.catalog.models.get(t.model)?.fields ?? [])].map(([name, field]) => [
			name,
			{ ...field, pg: t.cols.get(name)?.type ?? field.pg }
		])
	);
	const sql = yield* ownPredSql(pred, row, { p: () => 'null' }, !plain, fields);
	return pred.t === 'const' || pred.t === 'and' || pred.t === 'or' || pred.t === 'not'
		? sql
		: `(${sql})`;
});

/** A where literal with every object's keys sorted, at every depth: one predicate renders one way. */
function sortedKeys(v: unknown): unknown {
	if (ReadonlyArray.isArray(v)) return v.map(sortedKeys);
	if (!isRecord(v)) return v;
	return Object.fromEntries(
		Object.entries(v)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, x]): [string, unknown] => [k, sortedKeys(x)])
	);
}

// ── computed expressions → immutable SQL ──
type Kind = 'text' | 'int' | 'decimal' | 'bool' | 'date' | 'instant';
const KIND_OF: Record<string, Kind> = {
	text: 'text',
	enum: 'text',
	state: 'text',
	currency: 'text',
	int: 'int',
	count: 'int',
	duration: 'int',
	decimal: 'decimal',
	money: 'decimal',
	sum: 'decimal',
	bool: 'bool',
	date: 'date',
	instant: 'instant'
};
const SQL_OF: Record<Kind, string> = {
	text: 'text',
	int: 'int',
	decimal: 'numeric',
	bool: 'boolean',
	date: 'date',
	instant: 'timestamptz'
};
type Typed = { sql: string; kind: Kind };
const exprSql: (e: Expr, t: Table, tz: string, depth?: number) => Fx<Typed> = Effect.fnUntraced(
	function* (e: Expr, t: Table, tz: string, depth = 0) {
		if (depth > 32) return yield* fail(`${t.model}: a computed expression refers to itself`);
		const x = (a: Expr) => exprSql(a, t, tz, depth + 1);
		if (typeof e === 'number')
			return Number.isInteger(e)
				? { sql: `(${e})`, kind: 'int' }
				: { sql: `${lit(String(e))}::numeric`, kind: 'decimal' };
		if (typeof e === 'string') return { sql: `${lit(e)}::text`, kind: 'text' };
		if (typeof e === 'boolean') return { sql: String(e), kind: 'bool' };
		const num = (value: Typed, kind: Kind) =>
			kind === 'decimal' ? `(${value.sql})::numeric` : value.sql;
		const arith = Effect.fnUntraced(function* (sym: string, args: readonly [Expr, Expr]) {
			const [left, right] = [yield* x(args[0]), yield* x(args[1])];
			const kind: Kind = left.kind === 'int' && right.kind === 'int' ? 'int' : 'decimal';
			const out: Typed = { sql: `(${num(left, kind)} ${sym} ${num(right, kind)})`, kind };
			return out;
		});
		const cmp = Effect.fnUntraced(function* (sym: string, args: readonly [Expr, Expr]) {
			const out: Typed = {
				sql: `(${(yield* x(args[0])).sql} ${sym} ${(yield* x(args[1])).sql})`,
				kind: 'bool'
			};
			return out;
		});
		if ('field' in e) {
			const computed = t.spec.computed?.[e.field];
			if (computed !== undefined) {
				const kind = KIND_OF[computed.kind] ?? 'text';
				return { sql: `(${(yield* x(computed.expr)).sql})::${SQL_OF[kind]}`, kind };
			}
			const column = t.cols.get(e.field);
			if (column === undefined)
				return yield* fail(`${t.model}: computed reads unknown field '${e.field}'`);
			const kind =
				column.kind === 'seq' ? (column.type === 'int' ? 'int' : 'text') : KIND_OF[column.kind];
			if (kind === undefined)
				return yield* fail(`${t.model}.${e.field}: a ${column.kind} field cannot be computed over`);
			return { sql: q(e.field), kind };
		}
		if ('plus' in e) return yield* arith('+', e.plus);
		if ('minus' in e) return yield* arith('-', e.minus);
		if ('times' in e) return yield* arith('*', e.times);
		if ('div' in e) {
			const [left, right] = [yield* x(e.div[0]), yield* x(e.div[1])];
			return {
				sql: `((${left.sql})::numeric / nullif((${right.sql})::numeric, 0))`,
				kind: 'decimal'
			};
		}
		if ('round' in e)
			return {
				sql: `round((${(yield* x(e.round[0])).sql})::numeric, ${e.round[1]})`,
				kind: 'decimal'
			};
		if ('concat' in e) {
			const parts = yield* Effect.forEach(e.concat, x);
			return {
				sql: `(${parts.map((value) => `coalesce(${text(value)}, '')`).join(' || ')})`,
				kind: 'text'
			};
		}
		if ('plusDays' in e)
			return {
				sql: `(${(yield* x(e.plusDays[0])).sql} + (${(yield* x(e.plusDays[1])).sql})::int)`,
				kind: 'date'
			};
		if ('startOf' in e) {
			const value = yield* x(e.startOf[0]),
				unit = lit(e.startOf[1]);
			return value.kind === 'date'
				? { sql: `date_trunc(${unit}, (${value.sql})::timestamp)::date`, kind: 'date' }
				: {
						sql: `(date_trunc(${unit}, (${value.sql}) at time zone ${lit(tz)}) at time zone ${lit(tz)})`,
						kind: 'instant'
					};
		}
		if ('text' in e) return { sql: text(yield* x(e.text)), kind: 'text' };
		if ('lower' in e) return { sql: `lower(${(yield* x(e.lower)).sql})`, kind: 'text' };
		if ('upper' in e) return { sql: `upper(${(yield* x(e.upper)).sql})`, kind: 'text' };
		if ('trim' in e) return { sql: `btrim(${(yield* x(e.trim)).sql})`, kind: 'text' };
		if ('substring' in e) {
			const parts = yield* Effect.forEach(e.substring, x);
			return { sql: `substr(${parts.map((value) => value.sql).join(', ')})`, kind: 'text' };
		}
		if ('regexReplace' in e)
			return {
				sql: `regexp_replace(${(yield* x(e.regexReplace[0])).sql}, ${lit(e.regexReplace[1])}, ${lit(e.regexReplace[2])}, 'g')`,
				kind: 'text'
			};
		if ('jsonText' in e) {
			const from = e.jsonText[0];
			const name = typeof from === 'object' && 'field' in from ? from.field : undefined;
			if (name === undefined || t.cols.get(name)?.type !== 'jsonb')
				return yield* fail(
					`${t.model}: jsonText reads a json field, not '${name ?? JSON.stringify(from)}'`
				);
			return { sql: `(${q(name)} ->> ${lit(e.jsonText[1])})`, kind: 'text' };
		}
		if ('jsonLength' in e) {
			const from = e.jsonLength;
			const name = typeof from === 'object' && 'field' in from ? from.field : undefined;
			if (name === undefined || t.cols.get(name)?.type !== 'jsonb')
				return yield* fail(`${t.model}: jsonLength reads a JSON array column`);
			return { sql: `jsonb_array_length(${q(name)})`, kind: 'int' };
		}
		if ('eq' in e) return yield* cmp('=', e.eq);
		if ('ne' in e) return yield* cmp('<>', e.ne);
		if ('gt' in e) return yield* cmp('>', e.gt);
		if ('gte' in e) return yield* cmp('>=', e.gte);
		if ('lt' in e) return yield* cmp('<', e.lt);
		if ('lte' in e) return yield* cmp('<=', e.lte);
		if ('and' in e)
			return {
				sql: `(${(yield* Effect.forEach(e.and, x)).map((v) => v.sql).join(' and ')})`,
				kind: 'bool'
			};
		if ('or' in e)
			return {
				sql: `(${(yield* Effect.forEach(e.or, x)).map((v) => v.sql).join(' or ')})`,
				kind: 'bool'
			};
		if ('not' in e) return { sql: `(not ${(yield* x(e.not)).sql})`, kind: 'bool' };
		if ('when' in e) {
			const [condition, left, right] = [
				yield* x(e.when[0]),
				yield* x(e.when[1]),
				yield* x(e.when[2])
			];
			const kind: Kind =
				left.kind === right.kind
					? left.kind
					: left.kind === 'text' || right.kind === 'text'
						? 'text'
						: 'decimal';
			return {
				sql: `(case when ${condition.sql} then ${num(left, kind)} else ${num(right, kind)} end)`,
				kind
			};
		}
		const values = yield* Effect.forEach(e.coalesce, x);
		const kind: Kind = values.every((value) => value.kind === values[0]?.kind)
			? (values[0]?.kind ?? 'text')
			: values.some((value) => value.kind === 'text')
				? 'text'
				: 'decimal';
		return { sql: `coalesce(${values.map((value) => num(value, kind)).join(', ')})`, kind };
	}
);
/** `::text` is immutable for numbers and text; a date is spelled out, since `date::text` reads DateStyle. */
function text(a: Typed): string {
	if (a.kind === 'date')
		return `(lpad(extract(year from ${a.sql})::int::text, 4, '0') || '-' || lpad(extract(month from ${a.sql})::int::text, 2, '0') || '-' || lpad(extract(day from ${a.sql})::int::text, 2, '0'))`;
	return a.kind === 'text' ? a.sql : `(${a.sql})::text`;
}

// ── the objects ──
const SEARCH = 'bolt_search';
const EMBEDDING = 'bolt_embedding';

/**
 * Every object a schema holds, in a stable order with stable ids (each id names its definition), followed by `extra`:
 * objects a host keeps beside its tables (Bolt's engine tables), re-asserted with every plan.
 */
const objectsWithSearch = (searchDefinitions: typeof searchFunctions) =>
	Effect.fn('Store.schemaObjects')(function* (
		declared: SchemaSpec,
		extra: readonly SchemaObject[] = []
	) {
		// Every definition renders from sorted keys (predicates, a state's names, a JSON default): a snapshot read back
		// may have its keys reordered, and another order would hash every constraint name differently — the plan would
		// re-create a constraint the database already has.
		const s = yield* Schema.decodeUnknownEffect(SchemaSpec)(declared).pipe(
			Effect.mapError((cause) => StoreError.of('schema', 'derive', cause.message, cause))
		);
		const rels = yield* relations(s);
		const all = yield* tables(s, rels);
		const out: SchemaObject[] = [];
		// an object's id names its definition, so a second push of one id (a declared `index` on a relation's FK column,
		// which already gets its index) is the same object and is dropped
		const ids = new Set<string>();
		const push = (o: SchemaObject) => {
			if (!ids.has(o.id)) {
				ids.add(o.id);
				out.push(o);
			}
		};
		const anyKind = (k: string) =>
			Object.values(s.tables).some((m) => Object.values(m.fields).some((f) => f.kind === k));
		if (
			Object.values(s.tables).some(
				(table) =>
					table.nativeRules !== undefined &&
					Object.values(table.fields).some((field) => colType(field) === 'jsonb')
			)
		)
			push({
				id: 'function:store_json_valid',
				rank: 'function',
				table: '',
				deps: [],
				create: [JSON_VALID],
				drop: 'drop function if exists store_json_valid(jsonb,jsonb)'
			});
		if (Object.values(s.tables).some((m) => m.nativeRules !== undefined))
			push({
				id: 'function:store_row_rules',
				rank: 'function',
				table: '',
				deps: [],
				create: [
					Object.values(s.tables).some((m) => m.nativeRules === 2) ? ROW_RULES_V2 : ROW_RULES_V1
				],
				drop: 'drop function if exists store_row_rules()'
			});
		if (
			Object.values(s.tables).some(
				(m) => m.nativeRules === undefined && m.audit === true && m.managedDeletes !== true
			)
		)
			push({
				id: 'function:store_audit_update',
				rank: 'function',
				table: '',
				deps: [],
				create: [AUDIT_UPDATE],
				drop: 'drop function if exists store_audit_update()'
			});
		if (Object.values(s.tables).some((m) => (m.noOverlap ?? []).length > 0))
			push({
				id: 'extension:btree_gist',
				rank: 'extension',
				table: '',
				deps: [],
				create: ['create extension if not exists btree_gist'],
				drop: null
			});
		if (
			anyKind('vector') ||
			Object.values(s.tables).some(
				(m) =>
					m.search?.semantic !== undefined ||
					Object.values(m.search?.indexes ?? {}).some((index) => index.field === undefined)
			)
		)
			push({
				id: 'extension:vector',
				rank: 'extension',
				table: '',
				deps: [],
				create: ['create extension if not exists vector'],
				drop: null
			});

		for (const t of all.values()) {
			const T = q(t.model);
			const workspace = t.spec.audit === true;
			const deferrable = workspace ? ' deferrable initially immediate' : '';
			const constraint = (
				kind: 'uq' | 'key' | 'ck' | 'ex',
				def: string,
				deps: readonly string[],
				violations: string,
				meta: ConstraintMeta
			) => {
				const name = cname(t.model, kind, def);
				push({
					id: `constraint:${t.model}.${name}`,
					rank: 'constraint',
					table: t.model,
					deps,
					violations,
					meta: { ...meta, name },
					create: [`alter table ${T} add constraint ${q(name)} ${def}`],
					drop: `alter table ${T} drop constraint if exists ${q(name)}`
				});
			};
			const check = (expr: string, deps: readonly string[], meta: ConstraintMeta) =>
				constraint(
					'ck',
					`check (${expr})`,
					deps,
					`select count(*)::int as n from ${T} where (${expr}) is false`,
					meta
				);
			const index = (kind: string, def: string, deps: readonly string[], unique = false) => {
				const name = cname(t.model, kind, def);
				push({
					id: `index:${t.model}.${name}`,
					rank: 'index',
					table: t.model,
					deps,
					create: [`create ${unique ? 'unique ' : ''}index ${q(name)} on ${T} ${def}`],
					drop: `drop index if exists ${q(name)}`
				});
			};
			const colsOf = (fields: readonly string[]) =>
				Effect.map(
					Effect.forEach(fields, (f) => {
						const cols = t.fieldCols.get(f);
						return cols === undefined
							? fail(`${t.model}: unknown field '${f}'`)
							: Effect.succeed(cols);
					}),
					(cs) => cs.flat()
				);

			const key = yield* keyOf(t.spec);
			const keyNames = key.map((k) => k.name);
			const keyDef =
				key.length > 1
					? `${key.map((k) => `${q(k.name)} ${k.type} not null`).join(', ')}, primary key (${keyNames.map(q).join(', ')})`
					: `${q(key[0]?.name ?? 'id')} ${key[0]?.type ?? 'uuid'}${t.spec.key === 'identity' ? ' generated always as identity' : ''} primary key`;
			push({
				id: `table:${t.model}`,
				rank: 'table',
				table: t.model,
				deps: [],
				stored: true,
				create: [`create table ${T} (${keyDef}${workspace ? `, ${AUDIT}` : ''})`],
				drop: `drop table if exists ${T} cascade`
			});
			if (workspace && t.spec.nativeRules === undefined && t.spec.managedDeletes !== true)
				push({
					id: `trigger:${t.model}.store_audit_update`,
					rank: 'index',
					table: t.model,
					deps: ['revision', 'updated_at', 'updated_by'],
					create: [
						`create trigger store_audit_update before update on ${T} for each row execute function store_audit_update()`
					],
					drop: `drop trigger if exists store_audit_update on ${T}`
				});
			if (t.spec.nativeRules !== undefined) {
				type State = Extract<FieldSpec, { kind: 'state' }>;
				const statesOf = (spec: TableSpec) =>
					Object.fromEntries(
						Object.entries(spec.fields).flatMap(
							([name, kind]): [string, Pick<State, 'initial' | 'states'>][] =>
								kind.kind === 'state'
									? [[name, { initial: kind.initial, states: kind.states }]]
									: []
						)
					);
				const parents: {
					column: string;
					table: string;
					key: string;
					type: string;
					relation: string;
					states: object;
				}[] = [];
				for (const rel of rels.filter(
					(rel) =>
						rel.model === t.model && rel.spec.owned === true && rel.spec.inverse !== undefined
				))
					for (const [i, target] of rel.to.entries()) {
						const parent = all.get(target);
						if (parent === undefined) continue;
						const key = yield* fkType(s, target, rel.key);
						parents.push({
							column: rel.cols[i] ?? rel.field,
							table: target,
							key: key.name,
							type: key.type,
							relation: rel.spec.inverse ?? '',
							states: statesOf(parent.spec)
						});
					}
				for (const parent of all.values())
					for (const [name, through] of Object.entries(parent.spec.through ?? {})) {
						if (through.table !== t.model) continue;
						const rel = rels.find((rel) => rel.model === t.model && rel.field === through.from);
						if (rel === undefined) continue;
						const i = rel.to.indexOf(parent.model);
						if (i < 0) continue;
						const key = yield* fkType(s, parent.model, rel.key);
						parents.push({
							column: rel.cols[i] ?? through.from,
							table: parent.model,
							key: key.name,
							type: key.type,
							relation: name,
							states: statesOf(parent.spec)
						});
					}
				const fields = Object.fromEntries(
					Object.entries(t.spec.fields)
						.filter(([, kind]) => !['seq', 'sum', 'count'].includes(kind.kind))
						.map(([name]): [string, readonly string[]] => [name, t.fieldCols.get(name) ?? [name]])
				);
				const config = {
					key: keyNames,
					audit: workspace,
					states: statesOf(t.spec),
					fields,
					parents: parents.sort(
						(a, b) =>
							a.table.localeCompare(b.table) ||
							a.column.localeCompare(b.column) ||
							a.relation.localeCompare(b.relation)
					)
				};
				push({
					id: `trigger:${t.model}.store_row_rules`,
					rank: 'index',
					table: t.model,
					deps: [
						...new Set([
							...keyNames,
							...Object.values(fields).flat(),
							...(workspace
								? ['revision', 'created_at', 'created_by', 'updated_at', 'updated_by']
								: [])
						])
					],
					create: [
						`create trigger store_row_rules before insert or update or delete on ${T} for each row execute function store_row_rules(${lit(canonical(config))})`
					],
					drop: `drop trigger if exists store_row_rules on ${T}`
				});
			}

			// Primary and identity columns already exist, but their declared value constraints still apply.
			if (t.spec.nativeRules !== undefined)
				for (const name of [
					...new Set([...keyNames, ...(t.spec.identity === undefined ? [] : [t.spec.identity])])
				]) {
					const kind = t.spec.fields[name];
					if (kind === undefined) continue;
					const checkSql = yield* kindCheck(q(name), kind, s.currency, t, true);
					if (checkSql !== null)
						check(checkSql, [name], { model: t.model, kind: 'check', fields: [name] });
					if (name === t.spec.identity) continue;
					const type = yield* typeOf(kind, `${t.model}.${name}`);
					const def = yield* defaultSql(kind, type, s.tz, true);
					if (def !== null)
						push({
							id: `default:${t.model}.${name}`,
							rank: 'default',
							table: t.model,
							deps: [name],
							create: [`alter table ${T} alter column ${q(name)} set default ${def}`],
							drop: `alter table ${T} alter column ${q(name)} drop default`
						});
				}

			// stored fields
			for (const [name, k] of Object.entries(t.spec.fields)) {
				if (keyNames.includes(name) || k.kind === 'ref') continue;
				const c = t.cols.get(name);
				if (c === undefined) return yield* fail(`${t.model}: unknown field '${name}'`);
				const C = q(name);
				if (name === t.spec.identity) {
					push({
						id: `column:${t.model}.${name}`,
						rank: 'column',
						table: t.model,
						deps: [name],
						shape: 'identity',
						stored: true,
						create: [`alter table ${T} add column ${C} bigint generated by default as identity`],
						drop: `alter table ${T} drop column if exists ${C} cascade`
					});
					continue;
				}
				const rollup = k.kind === 'sum' || k.kind === 'count';
				const def =
					(yield* defaultSql(k, c.type, s.tz, t.spec.nativeRules !== undefined)) ??
					(rollup ? '0' : null);
				push({
					id: `column:${t.model}.${name}`,
					rank: 'column',
					table: t.model,
					deps: [name],
					shape: c.type,
					create: [
						`alter table ${T} add column ${C} ${c.type}${def === null ? '' : ` default ${def}`}`
					],
					drop: `alter table ${T} drop column if exists ${C} cascade`,
					...(rollup ? { derived: true as const } : { stored: true as const })
				});
				if (def !== null && !rollup)
					push({
						id: `default:${t.model}.${name}`,
						rank: 'default',
						table: t.model,
						deps: [name],
						create: [`alter table ${T} alter column ${C} set default ${def}`],
						drop: `alter table ${T} alter column ${C} drop default`
					});
				if (!c.optional || rollup)
					push({
						id: `notNull:${t.model}.${name}`,
						rank: 'notNull',
						table: t.model,
						deps: [name],
						create: [`alter table ${T} alter column ${C} set not null`],
						drop: `alter table ${T} alter column ${C} drop not null`,
						violations: `select count(*)::int as n from ${T} where ${C} is null`
					});
				if (k.kind === 'sum' || k.kind === 'count')
					push(yield* rollupBackfill(t, name, k, rels, all));
				const kc = yield* kindCheck(C, k, s.currency, t, t.spec.nativeRules !== undefined);
				if (kc !== null)
					check(
						kc,
						k.kind === 'money' && typeof k.currency === 'string' && !/^[A-Z]{3}$/.test(k.currency)
							? [name, k.currency]
							: [name],
						{ model: t.model, kind: 'check', fields: [name] }
					);
				if ((k.kind === 'text' || k.kind === 'enum') && k.many === true)
					index('gin', `using gin (${C})`, [name]);
				if (k.kind === 'point') index('gist', `using gist (${C})`, [name]);
				if (k.kind === 'vector') index('hnsw', `using hnsw (${C} vector_${k.metric}_ops)`, [name]);
				if (k.unique === true)
					constraint(
						'uq',
						`unique (${C})${deferrable}`,
						[name],
						dupes(T, [C], `${C} is not null`),
						{
							model: t.model,
							kind: 'unique',
							fields: [name]
						}
					);
				if (k.kind === 'seq') {
					const scope = yield* colsOf(k.per ?? []);
					const cols = [...scope.map(q), C];
					constraint(
						'uq',
						`unique nulls not distinct (${cols.join(', ')})${deferrable}`,
						[...scope, name],
						dupes(T, cols),
						{ model: t.model, kind: 'unique', fields: [...(k.per ?? []), name] }
					);
				}
			}

			// computed and the search documents: generated stored columns
			for (const [name, c] of Object.entries(t.spec.computed ?? {})) {
				const e = yield* exprSql(c.expr, t, s.tz);
				const type = SQL_OF[KIND_OF[c.kind] ?? 'text'];
				push({
					id: `column:${t.model}.${name}`,
					rank: 'column',
					table: t.model,
					deps: [name, ...(yield* exprDeps(c.expr, t))],
					derived: true,
					create: [
						`alter table ${T} add column ${q(name)} ${type} generated always as ((${e.sql})::${type}) stored`
					],
					drop: `alter table ${T} drop column if exists ${q(name)} cascade`
				});
			}
			const search = t.spec.search;
			if (search !== undefined) {
				// the multilingual document: folded, tokenized and romanized when the row is written. A link in `text` is
				// matched through the linked row's own document when read, never copied into this one.
				const own = search.text.filter((f) => t.spec.fields[f]?.kind !== 'ref');
				const doc = yield* Effect.forEach(own, (f) =>
					Effect.gen(function* () {
						const computed = t.spec.computed?.[f];
						if (computed !== undefined) return text(yield* exprSql(computed.expr, t, s.tz));
						const col = t.cols.get(f);
						if (col === undefined)
							return yield* fail(`${t.model}: search names unknown field '${f}'`);
						return col.type.endsWith('[]') ? `bolt_search_join(${q(f)}::text[])` : `${q(f)}::text`;
					})
				);
				const deps = (yield* Effect.forEach(own, (f) => {
					const computed = t.spec.computed?.[f];
					return computed === undefined ? Effect.succeed([f]) : exprDeps(computed.expr, t);
				})).flat();
				for (const fn of searchDefinitions())
					push({
						id: `function:${fn.id}`,
						rank: 'function',
						table: '',
						deps: [],
						create: [fn.sql],
						drop: null
					});
				push({
					id: `column:${t.model}.${SEARCH}`,
					rank: 'column',
					table: t.model,
					deps: [SEARCH, ...deps],
					derived: true,
					create: [
						`alter table ${T} add column ${SEARCH} tsvector generated always as (${doc.length === 0 ? "''::tsvector" : `bolt_search_document(${doc.map((d) => `coalesce(${d}, '')`).join(" || ' ' || ")})`}) stored`
					],
					drop: `alter table ${T} drop column if exists ${SEARCH} cascade`
				});
				index('gin', `using gin (${SEARCH})`, [SEARCH]);
				const sem = search.semantic;
				if (sem !== undefined) {
					// platform-managed: a host fills it after commit
					push({
						id: `column:${t.model}.${EMBEDDING}`,
						rank: 'column',
						table: t.model,
						deps: [EMBEDDING],
						derived: true,
						create: [`alter table ${T} add column ${EMBEDDING} vector(${sem.dim})`],
						drop: `alter table ${T} drop column if exists ${EMBEDDING} cascade`
					});
					index('hnsw', `using hnsw (${EMBEDDING} vector_cosine_ops)`, [EMBEDDING]);
				}
				for (const [name, declaration] of Object.entries(search.indexes ?? {})) {
					if (declaration.field !== undefined) {
						const field = t.spec.fields[declaration.field];
						if (
							field?.kind !== 'vector' ||
							field.dim !== declaration.dim ||
							field.metric !== declaration.metric
						)
							return yield* fail(
								`${t.model}: search index '${name}' must match its vector field '${declaration.field}'`
							);
						continue;
					}
					const column = yield* ident(indexColumn(name));
					const C = q(column);
					push({
						id: `column:${t.model}.${column}`,
						rank: 'column',
						table: t.model,
						deps: [column],
						derived: true,
						create: [`alter table ${T} add column ${C} vector(${declaration.dim})`],
						drop: `alter table ${T} drop column if exists ${C} cascade`
					});
					index('hnsw', `using hnsw (${C} vector_${declaration.metric}_ops)`, [column]);
				}
			}

			// declared identity and invariants
			if (t.spec.natural !== undefined) {
				const cols = yield* colsOf(t.spec.natural);
				if (t.spec.nativeRules !== undefined)
					for (const column of cols)
						push({
							id: `notNull:${t.model}.${column}`,
							rank: 'notNull',
							table: t.model,
							deps: [column],
							create: [`alter table ${T} alter column ${q(column)} set not null`],
							drop: `alter table ${T} alter column ${q(column)} drop not null`,
							violations: `select count(*)::int as n from ${T} where ${q(column)} is null`
						});
				constraint('key', `unique (${cols.map(q).join(', ')})`, cols, dupes(T, cols.map(q)), {
					model: t.model,
					kind: 'unique',
					fields: t.spec.natural
				});
			}
			for (const u of t.spec.unique ?? []) {
				const cols = yield* colsOf(u.fields);
				const meta: ConstraintMeta = {
					model: t.model,
					kind: 'unique',
					fields: u.fields,
					...(u.name === undefined ? {} : { rule: u.name })
				};
				const [first] = cols;
				if (first === undefined) return yield* fail(`${t.model}: a unique names no field`);
				if (u.where === undefined) {
					const nulls = cols.length > 1 ? ' nulls not distinct' : '';
					constraint(
						'uq',
						`unique${nulls} (${cols.map(q).join(', ')})${deferrable}`,
						cols,
						dupes(T, cols.map(q), cols.length > 1 ? undefined : `${q(first)} is not null`),
						meta
					);
				} else if (!workspace) {
					// a plain table's partial uniqueness is a unique index: never swapped mid-statement, and an arbiter
					index(
						'ux',
						`(${cols.map(q).join(', ')}) where ${yield* staticSql(u.where, t, q, true)}`,
						[...cols, ...whereDeps(u.where)],
						true
					);
				} else {
					// a partial UNIQUE index cannot be deferred; an EXCLUDE with `=` can
					const pred = yield* staticSql(u.where, t);
					const keys =
						cols.length > 1 ? yield* nullAsValue(cols, t) : cols.map((c) => `${q(c)} with =`);
					constraint(
						'ex',
						`exclude using btree (${keys.join(', ')}) where ${pred} deferrable initially immediate`,
						[...cols, ...whereDeps(u.where)],
						dupes(T, cols.map(q), cols.length > 1 ? pred : `${q(first)} is not null and ${pred}`),
						meta
					);
				}
			}
			for (const [rule, c] of Object.entries(t.spec.check ?? {})) {
				const { where: w, message } = checkOf(c);
				check(yield* staticSql(w, t), whereDeps(w), {
					model: t.model,
					kind: 'check',
					fields: whereDeps(w),
					rule,
					...(message === undefined ? {} : { message })
				});
			}
			for (const o of t.spec.noOverlap ?? []) {
				const cols = yield* colsOf(o.key);
				const pred = o.where === undefined ? null : yield* staticSql(o.where, t);
				const alias = (a: string) => (c: string) => `${a}.${q(c)}`;
				const pairs = [
					...cols.map((c) => `a.${q(c)} is not distinct from b.${q(c)}`),
					`a.${q(o.period)} && b.${q(o.period)}`,
					...(o.where === undefined
						? []
						: [yield* staticSql(o.where, t, alias('a')), yield* staticSql(o.where, t, alias('b'))])
				];
				constraint(
					'ex',
					`exclude using gist (${[...(yield* nullAsValue(cols, t)), `${q(o.period)} with &&`].join(', ')})${pred === null ? '' : ` where ${pred}`} deferrable initially immediate`,
					[...cols, o.period, ...(o.where === undefined ? [] : whereDeps(o.where))],
					`select count(*)::int as n from ${T} a join ${T} b on (${keyNames.map((k) => `a.${q(k)}`).join(', ')}) < (${keyNames.map((k) => `b.${q(k)}`).join(', ')}) and ${pairs.join(' and ')}`,
					{
						model: t.model,
						kind: 'overlap',
						fields: [...o.key, o.period],
						...(o.name === undefined ? {} : { rule: o.name })
					}
				);
			}
			for (const i of t.spec.index ?? []) {
				const cols = yield* colsOf(typeof i === 'string' ? [i] : i);
				index('ix', `(${cols.map(q).join(', ')})`, cols);
			}
			for (const i of t.spec.indexes ?? []) {
				const on = yield* Effect.forEach(i.on, (x) =>
					typeof x === 'object' && 'expr' in x
						? Effect.gen(function* () {
								const expr = yield* exprSql(x.expr, t, s.tz);
								return { deps: yield* exprDeps(x.expr, t), sql: `(${expr.sql})` };
							})
						: Effect.map(colsOf([typeof x === 'string' ? x : x.lower]), ([c]) =>
								typeof x === 'string'
									? { deps: [x], sql: q(c ?? x) }
									: { deps: [x.lower], sql: `lower(${q(c ?? x.lower)})` }
							)
				);
				const wh = i.where === undefined ? '' : ` where ${yield* staticSql(i.where, t, q, true)}`;
				index(
					i.unique === true ? 'ux' : 'ix',
					`(${on.map((x) => x.sql).join(', ')})${wh}`,
					[...on.flatMap((x) => x.deps), ...(i.where === undefined ? [] : whereDeps(i.where))],
					i.unique === true
				);
			}
			for (const p of t.spec.paths ?? []) {
				const col = t.cols.get(p.field);
				if (col?.type !== 'jsonb')
					return yield* fail(`${t.model}: a path index reads a json field, not '${p.field}'`);
				if ('gin' in p) index('gin', `using gin (${q(p.field)} jsonb_path_ops)`, [p.field]);
				else
					index(
						'px',
						`((${yield* pathText(t.spec.fields[p.field], q(p.field), p.path, `${t.model}.${p.field}`)}))`,
						[p.field]
					);
			}
		}

		// relations: FK columns, FKs (checked at end of statement), an index each, the polymorphic CHECK
		for (const r of rels) {
			const owner = all.get(r.model);
			if (owner === undefined)
				return yield* fail(`relation '${r.key}' names unknown table '${r.model}'`);
			const T = q(r.model);
			for (const [i, c] of r.cols.entries()) {
				const target = r.to[i] ?? '';
				const key = yield* fkType(s, target, r.key);
				push({
					id: `column:${r.model}.${c}`,
					rank: 'column',
					table: r.model,
					deps: [c],
					stored: true,
					create: [`alter table ${T} add column ${q(c)} ${key.type}`],
					drop: `alter table ${T} drop column if exists ${q(c)} cascade`
				});
				const action = r.spec.onDelete ?? (r.spec.owned === true ? 'cascade' : 'restrict');
				const onDelete =
					owner.spec.nativeRules !== undefined
						? ` on delete ${action === 'setNull' ? 'set null' : action} on update restrict`
						: owner.spec.managedDeletes === true
							? ''
							: action === 'cascade'
								? ' on delete cascade'
								: action === 'setNull'
									? ' on delete set null'
									: '';
				const def = `foreign key (${q(c)}) references ${q(target)} (${q(key.name)})${onDelete}`;
				const name = cname(r.model, 'fk', def);
				push({
					id: `fk:${r.model}.${name}`,
					rank: 'fk',
					table: r.model,
					deps: [c],
					meta: { name, model: r.model, kind: 'fk', fields: [r.field] },
					create: [`alter table ${T} add constraint ${q(name)} ${def}`],
					drop: `alter table ${T} drop constraint if exists ${q(name)}`,
					violations: `select count(*)::int as n from ${T} c where c.${q(c)} is not null and not exists (select 1 from ${q(target)} p where p.${q(key.name)} = c.${q(c)})`
				});
				if (owner.spec.nativeRules !== undefined && r.spec.unique === true) {
					const def = `unique (${q(c)})${owner.spec.audit === true ? ' deferrable initially immediate' : ''}`;
					const name = cname(r.model, 'uq', def);
					push({
						id: `constraint:${r.model}.${name}`,
						rank: 'constraint',
						table: r.model,
						deps: [c],
						meta: { name, model: r.model, kind: 'unique', fields: [r.field] },
						create: [`alter table ${T} add constraint ${q(name)} ${def}`],
						drop: `alter table ${T} drop constraint if exists ${q(name)}`,
						violations: dupes(T, [q(c)], `${q(c)} is not null`)
					});
				}
				const ix = cname(r.model, 'ix', `(${q(c)})`);
				push({
					id: `index:${r.model}.${ix}`,
					rank: 'index',
					table: r.model,
					deps: [c],
					create: [`create index ${q(ix)} on ${T} (${q(c)})`],
					drop: `drop index if exists ${q(ix)}`
				});
			}
			if (r.cols.length === 1 && r.spec.optional !== true)
				push({
					id: `notNull:${r.model}.${r.field}`,
					rank: 'notNull',
					table: r.model,
					deps: [r.field],
					create: [`alter table ${T} alter column ${q(r.field)} set not null`],
					drop: `alter table ${T} alter column ${q(r.field)} drop not null`,
					violations: `select count(*)::int as n from ${T} where ${q(r.field)} is null`
				});
			if (r.cols.length > 1) {
				const expr = `num_nonnulls(${r.cols.map(q).join(', ')}) ${r.spec.optional === true ? '<=' : '='} 1`;
				const name = cname(r.model, 'ck', expr);
				push({
					id: `constraint:${r.model}.${name}`,
					rank: 'constraint',
					table: r.model,
					deps: r.cols,
					meta: { name, model: r.model, kind: 'check', fields: [r.field] },
					create: [`alter table ${T} add constraint ${q(name)} check (${expr})`],
					drop: `alter table ${T} drop constraint if exists ${q(name)}`,
					violations: `select count(*)::int as n from ${T} where (${expr}) is false`
				});
			}
		}
		// many-to-many: the join table's pair is unique, and indexed the other way round for the inverse walk
		for (const t of Object.values(s.tables))
			for (const m of Object.values(t.through ?? {})) {
				const T = q(m.table);
				const [a, b] = [q(m.from), q(m.to)];
				const ux = cname(m.table, 'ux', `(${a}, ${b})`);
				push({
					id: `index:${m.table}.${ux}`,
					rank: 'index',
					table: m.table,
					deps: [m.from, m.to],
					create: [`create unique index ${q(ux)} on ${T} (${a}, ${b})`],
					drop: `drop index if exists ${q(ux)}`
				});
				const back = cname(m.table, 'ix', `(${b}, ${a})`);
				push({
					id: `index:${m.table}.${back}`,
					rank: 'index',
					table: m.table,
					deps: [m.from, m.to],
					create: [`create index ${q(back)} on ${T} (${b}, ${a})`],
					drop: `drop index if exists ${q(back)}`
				});
			}
		if (out.some((o) => o.create.some((c) => c.includes('bolt_minor_units('))))
			push({
				id: 'function:bolt_minor_units',
				rank: 'function',
				table: '',
				deps: [],
				create: [MINOR_FN],
				drop: null
			});
		for (const o of extra) push(o);
		return out;
	});

/** Complete SQL definitions, including the database's multilingual search functions. */
export const schemaObjects = /*#__PURE__*/ objectsWithSearch(searchFunctions);
/** Classification only: these fixed, never-dropped functions have no constraint metadata or destructive steps. */
export const schemaObjectsForClassification = /*#__PURE__*/ objectsWithSearch(() => []);

/** A json value's text at `path` (`#>> '{a,b}'`), cast to the kind the field's shape declares there. */
export const pathText = Effect.fn('Store.pathText')(function* (
	field: FieldSpec | undefined,
	column: string,
	path: readonly string[],
	at: string
) {
	let k: FieldSpec | undefined = field;
	for (const step of path) {
		k = k?.kind === 'json' ? k.shape : k;
		k = k?.kind === 'object' ? (k.fields[step] ?? k.rest) : k?.kind === 'record' ? k.of : undefined;
		if (k === undefined)
			return yield* fail(`${at}: '${path.join('.')}' is no scalar path of its shape`);
	}
	const type = k === undefined ? undefined : colType(k);
	if (k === undefined || type === undefined || type === 'jsonb')
		return yield* fail(`${at}: '${path.join('.')}' ends at no scalar`);
	const text = `${column} #>> ${jsonPath(path)}`;
	return type === 'text' ? `(${text})` : `(${text})::${type}`;
});

/** Composite identity treats null as a value: `coalesce(x, <sentinel>)` plus `x is null`, exact for any sentinel. */
const nullAsValue = (cols: readonly string[], t: Table): Fx<string[]> =>
	Effect.map(
		Effect.forEach(cols, (c) => {
			const col = t.cols.get(c);
			if (col === undefined) return fail(`${t.model}: unknown column '${c}'`);
			if (!col.optional) return Effect.succeed([`${q(c)} with =`]);
			const sentinel =
				col.type === 'boolean'
					? 'false'
					: col.type === 'uuid'
						? `'00000000-0000-0000-0000-000000000000'::uuid`
						: ['int', 'bigint', 'numeric', 'double precision'].includes(col.type)
							? '0'
							: ['date', 'timestamptz'].includes(col.type)
								? `'-infinity'::${col.type}`
								: `''::${col.type}`;
			return Effect.succeed([
				`(coalesce(${q(c)}, ${sentinel})) with =`,
				`(${q(c)} is null) with =`
			]);
		}),
		(xs) => xs.flat()
	);
/** Rows beyond the first of each duplicate group (`group by` treats nulls as equal, as NULLS NOT DISTINCT does). */
const dupes = (T: string, cols: readonly string[], where?: string) =>
	`select coalesce(sum(n - 1), 0)::int as n from (select count(*) as n from ${T}${where === undefined ? '' : ` where ${where}`} group by ${cols.join(', ')} having count(*) > 1) d`;
function whereDeps(w: object): string[] {
	const record: Readonly<Record<string, unknown>> = { ...w };
	return Object.entries(record).flatMap(([key, value]) =>
		key === 'and' || key === 'or'
			? ReadonlyArray.isArray(value)
				? value.flatMap((part) =>
						typeof part === 'object' && part !== null ? whereDeps(part) : []
					)
				: []
			: key === 'not'
				? typeof value === 'object' && value !== null
					? whereDeps(value)
					: []
				: [key]
	);
}
/** The fields an expression reads, through computed fields. */
const exprDeps = (e: Expr, t: Table): Fx<string[]> => {
	const seen = new Set<string>();
	const visit = (x: Expr, depth: number): Fx<string[]> => {
		if (typeof x !== 'object') return Effect.succeed([]);
		if (depth > 32) return fail(`${t.model}: a computed expression refers to itself`);
		if ('field' in x) {
			const computed = t.spec.computed?.[x.field];
			if (computed === undefined || seen.has(x.field)) return Effect.succeed([x.field]);
			seen.add(x.field);
			return visit(computed.expr, depth + 1);
		}
		return Effect.map(
			Effect.forEach(children(x), (c) => visit(c, depth + 1)),
			(xs) => xs.flat()
		);
	};
	return visit(e, 0);
};
/** An operator node's operands. */
function children(
	e: Exclude<Expr, number | string | boolean | { readonly field: string }>
): readonly Expr[] {
	if ('round' in e) return [e.round[0]];
	if ('startOf' in e) return [e.startOf[0]];
	if ('regexReplace' in e) return [e.regexReplace[0]];
	if ('jsonText' in e) return [e.jsonText[0]];
	if ('jsonLength' in e) return [e.jsonLength];
	if ('text' in e) return [e.text];
	if ('lower' in e) return [e.lower];
	if ('upper' in e) return [e.upper];
	if ('trim' in e) return [e.trim];
	if ('not' in e) return [e.not];
	if ('plus' in e) return e.plus;
	if ('minus' in e) return e.minus;
	if ('times' in e) return e.times;
	if ('div' in e) return e.div;
	if ('concat' in e) return e.concat;
	if ('plusDays' in e) return e.plusDays;
	if ('substring' in e) return e.substring;
	if ('eq' in e) return e.eq;
	if ('ne' in e) return e.ne;
	if ('gt' in e) return e.gt;
	if ('gte' in e) return e.gte;
	if ('lt' in e) return e.lt;
	if ('lte' in e) return e.lte;
	if ('and' in e) return e.and;
	if ('or' in e) return e.or;
	if ('when' in e) return e.when;
	return e.coalesce;
}

/** The CHECK a kind implies: formats, bounds, membership, minor units, valid periods, point range. */
const kindCheck = (
	C: string,
	k: FieldSpec,
	wsCurrency: string | null,
	t: Table,
	native = false
): Fx<string | null> => {
	if (native && colType(k) === 'jsonb')
		return Effect.succeed(
			`(${C} is null or store_json_valid(${C}, ${lit(canonical(k))}::jsonb) is true)`
		);
	const parts: string[] = [];
	switch (k.kind) {
		case 'text':
			if (k.many === true) {
				if (native) {
					const invalid = ['@.type() != "string"'];
					if (k.max !== undefined && Number.isFinite(k.max)) {
						const overflow = Math.floor(k.max) + 1;
						// PostgreSQL bounds each regex repetition at 255; fixed groups retain larger text limits.
						const repeat = (n: number): string =>
							n <= 255
								? `.{${n}}`
								: `(?:${repeat(Math.floor(n / 255))}){255}${n % 255 === 0 ? '' : `.{${n % 255}}`}`;
						invalid.push(
							overflow <= 0
								? '@.type() == "string"'
								: `@ like_regex ${canonical(`^${repeat(overflow)}`)} flag "s"`
						);
					}
					const formats: Record<string, string> = {
						email: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
						phone: '^\\+?[0-9][0-9 ()\\-.]{2,}$',
						url: '^https?://\\S+$',
						zone: '^[A-Za-z_]+(/[A-Za-z0-9_+\\-]+)*$'
					};
					const format = k.format === undefined ? undefined : formats[k.format];
					if (format !== undefined) invalid.push(`!(@ like_regex ${canonical(format)})`);
					parts.push(
						`not jsonb_path_exists(to_jsonb(${C}), ${lit(`strict $[*] ? (${invalid.join(' || ')})`)})`
					);
				}
				break;
			}
			if (k.max !== undefined) parts.push(`char_length(${C}) <= ${k.max}`);
			if (k.format === 'email') parts.push(`${C} ~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$'`);
			if (k.format === 'phone') parts.push(`${C} ~ '^\\+?[0-9][0-9 ()\\-.]{2,}$'`);
			if (k.format === 'url') parts.push(`${C} ~ '^https?://\\S+$'`);
			if (k.format === 'zone') parts.push(`${C} ~ '^[A-Za-z_]+(/[A-Za-z0-9_+\\-]+)*$'`);
			break;
		case 'int':
		case 'decimal':
			if (native && k.kind === 'decimal')
				parts.push(`${C} not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`);
			if (k.kind === 'decimal') parts.push(`round(${C}, ${k.scale}) = ${C}`);
			if (k.kind === 'decimal' && k.precision !== undefined)
				parts.push(`abs(${C}) < 1e${k.precision - k.scale}`);
			if (k.min !== undefined) parts.push(`${C} >= ${k.min}`);
			if (k.max !== undefined) parts.push(`${C} <= ${k.max}`);
			break;
		case 'number':
			if (native) {
				parts.push(
					`${C} not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)`
				);
				if (k.min !== undefined) parts.push(`${C} >= ${k.min}`);
				if (k.max !== undefined) parts.push(`${C} <= ${k.max}`);
			}
			break;
		case 'money': {
			if (native)
				parts.push(`${C} not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`);
			// a declared scale (a unit price) replaces the minor-unit check
			if (k.scale !== undefined) {
				parts.push(`round(${C}, ${k.scale}) = ${C}`);
				break;
			}
			const cur = k.currency ?? wsCurrency;
			if (cur === null) break;
			if (/^[A-Z]{3}$/.test(cur)) parts.push(`round(${C}, ${minorUnits(cur)}) = ${C}`);
			else if (t.cols.has(cur)) parts.push(`round(${C}, bolt_minor_units(${q(cur)})) = ${C}`);
			else return fail(`${t.model}: money currency '${cur}' is neither a code nor a field`);
			break;
		}
		case 'currency':
			parts.push(`${C} ~ '^[A-Z]{3}$'`);
			break;
		case 'duration':
			parts.push(`${C} >= 0`);
			break;
		case 'date':
		case 'instant':
			if (native) parts.push(`isfinite(${C})`);
			break;
		case 'time':
			if (native) parts.push(`${C} < time '24:00'`);
			break;
		case 'period':
			parts.push(`not isempty(${C}) and not lower_inf(${C})`);
			break;
		case 'enum':
			if (native && k.many === true)
				parts.push(`not jsonb_path_exists(to_jsonb(${C}), 'strict $[*] ? (@.type() != "string")')`);
			parts.push(
				k.many === true
					? `${C} <@ array[${k.values.map(lit).join(', ')}]::text[]`
					: `${C} in (${k.values.map(lit).join(', ')})`
			);
			break;
		case 'state':
			parts.push(`${C} in (${Object.keys(k.states).sort().map(lit).join(', ')})`);
			break;
		case 'seq':
			if (k.pattern === undefined) parts.push(`${C} >= 1`);
			break;
		case 'list':
			parts.push(`jsonb_typeof(${C}) = 'array'`);
			break;
		case 'object':
			parts.push(`jsonb_typeof(${C}) = 'object'`);
			break;
		case 'file':
			parts.push(
				k.multiple === true
					? `jsonb_typeof(${C}) = 'array' and jsonb_array_length(${C}) <= 20`
					: `jsonb_typeof(${C}) = 'object'`
			);
			break;
		case 'point':
			parts.push(`${C}[1] between -90 and 90 and ${C}[0] between -180 and 180`);
			break;
		default:
			break;
	}
	return Effect.succeed(parts.length === 0 ? null : parts.join(' and '));
};

/** A new roll-up column's values from its children (the backfill class). */
const rollupBackfill = Effect.fnUntraced(function* (
	t: Table,
	name: string,
	k: Extract<FieldSpec, { kind: 'sum' | 'count' }>,
	rels: readonly Rel[],
	all: Map<string, Table>
) {
	const [inverse = '', field] = k.of.split('.');
	const r = rels.find((x) => x.to.includes(t.model) && (x.spec.inverse ?? x.model) === inverse);
	if (r === undefined)
		return yield* fail(
			`${t.model}.${name}: no relationship to ${t.model} has the inverse '${inverse}'`
		);
	const child = all.get(r.model);
	const fk = r.cols[r.to.indexOf(t.model)];
	if (child === undefined || fk === undefined)
		return yield* fail(`${r.model}: missing rollup child`);
	const where =
		k.where === undefined ? '' : ` and ${yield* staticSql(k.where, child, (c) => `c.${q(c)}`)}`;
	if (k.kind === 'sum' && field === undefined)
		return yield* fail(`${t.model}.${name}: a sum names '<inverse>.<field>'`);
	const agg = k.kind === 'count' ? 'count(*)::int' : `coalesce(sum(c.${q(field ?? '')}), 0)`;
	const o: SchemaObject = {
		id: `backfill:${t.model}.${name}`,
		rank: 'backfill',
		table: t.model,
		deps: [name],
		derived: true,
		drop: null,
		create: [
			`update ${q(t.model)} p set ${q(name)} = (select ${agg} from ${q(r.model)} c where c.${q(fk)} = p.id${where})`
		]
	};
	return o;
});

/** Constraint name → its declaration, for a writer's SQLSTATE map. */
export const constraintIndex = Effect.fn('Store.constraintIndex')(function* (s: SchemaSpec) {
	const objects = yield* schemaObjectsForClassification(s);
	return new Map(
		objects.flatMap((o) => (o.meta === undefined ? [] : [[o.meta.name, o.meta] as const]))
	);
});
export type { Json };
