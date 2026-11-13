// The read IR → one SQL statement per read, relations included: each relation is a correlated jsonb subquery bounded by
// its own ORDER BY … LIMIT, so a read at any depth is one statement and one row per root. A scoped read (`Scope`) is
// conjoined with the reader's row filters at every level of the output it reads; an unscoped read is not. Rows come back as one jsonb value each, in wire form.
// The store never runs a statement: the caller executes it and decodes its rows.
import { Array as EffectArray, Effect, Result, Schema } from 'effect';
import { KIND } from '../lang/kind.ts';
import { STORE_LIMITS } from '../limits.ts';
import { StoreError } from '../errors.ts';
import { CursorPayload } from '../cursor.ts';
import type { Json } from '../values.ts';
import type {
	Arg,
	Measures,
	Operand,
	Order,
	PageIR,
	Pred,
	ReadIR,
	RelSelectIR,
	SelectIR
} from '../ir.ts';
import type { Catalog, ExposureInfo, FieldInfo } from '../catalog.ts';
import {
	EMBEDDING_COLUMN,
	SEARCH_COLUMN,
	RECORD_LABEL_COLUMN,
	SEMANTIC,
	exposure_of,
	default_fields,
	exposed_field,
	exposed_relation,
	index_column,
	stored_fields,
	catalog_for,
	DEFAULT_OUTPUT
} from '../catalog.ts';
import { argument_list, inline_leaf, UNSORTABLE } from '../decode.ts';
import { ELEMENT, type PathTest } from '../ir.ts';
import { comparable, inverted, json_path, period_test } from './values.ts';
import { label_expression, label_text_sql } from '../lang/label.ts';
import { literal as lit, q } from '../sql.ts';
import { UUID_PATTERN } from '../lang/kind.ts';

/** One statement with positional parameters (`$1…`): its text is its shape, whatever its parameters are. */
export type Sql = { readonly text: string; readonly params: readonly Json[] };
type Fx<A> = Effect.Effect<A, StoreError>;
const invalid = (message: string) => Effect.fail(StoreError.of('invalid', 'decode', message));
const forbidden = (message: string) =>
	Effect.fail(StoreError.of('forbidden', 'admission', message));
/** `$similar`: how much farther than the nearest row a row may be and still be about the same thing (cosine distance). */
const SIMILAR_BAND = 0.1;
/** What stands for the first row past a read's byte budget; no stored row has a `$over` field. */
export const OVER = '$over';
/** The row after a counted read's rows (`ListRead.total`): `{"$total": n}`, every row the read matches. */
export const TOTAL = '$total';
/** `rows` followed by its total row: the count of `source` under `filter`, in the same statement. */
const counted = (rows: string, total: boolean, source: string, filter: string) =>
	total
		? `${rows} UNION ALL SELECT jsonb_build_object('${TOTAL}', count(*)) AS j FROM ${source} WHERE ${filter}`
		: rows;
/**
 * The byte budget, kept by the database: rows leave in their order while the row text before them fits `bytes`; the
 * first row that does not becomes `{"$over": true}` and nothing follows it. A read never brings more than its budget
 * into the caller's heap, whatever its rows weigh. `OFFSET 0` fences each level, so the planner never inlines a row's
 * JSON into the size and the running sum: each row is built and measured once.
 */
export const budgeted = (rows: string, bytes: number) =>
	`SELECT CASE WHEN w."$b" > ${bytes} THEN '{"${OVER}": true}'::jsonb ELSE w.j END AS j FROM (SELECT v.j, v.n, sum(v.n) OVER (ROWS UNBOUNDED PRECEDING) AS "$b" FROM (SELECT u.j, octet_length(u.j::text) AS n FROM (${rows} OFFSET 0) u OFFSET 0) v) w WHERE w."$b" - w.n <= ${bytes}`;

/**
 * Who reads, as the compiler needs it: present, names are held to each model's read exposure, a read without a
 * `select` takes the model's default projection, and these hooks scope it. Absent, every stored row and field.
 */
export type Scope = {
	/**
	 * The row filter of one read level of `output` by its path (a root `'orders'`, a layer `'orders.lines'`), its arms
	 * OR-ed: `undefined` reads every row, `[]` none. A layer is scoped by its root's arms for that output and path.
	 */
	readonly rows: (path: string, output: string) => readonly Pred[] | undefined;
};
/** How one statement compiles: who reads, how operands resolve, which tables it reads, and its byte budget. */
export type CompileOptions = {
	readonly scope?: Scope | undefined;
	/** More columns of a root row, each `<sql> AS <name>`, over the row at `alias`, scoped or not. */
	readonly root?: ((model: string, alias: string) => readonly string[]) | undefined;
	/** A non-literal operand (`{ var }` …) to its value; without it they are `invalid`. */
	readonly resolve?: ((o: Operand) => Fx<Json>) | undefined;
	/** The zone a date bucket of an instant is cut in; UTC when unset. */
	readonly tz?: string | undefined;
	/** A model read from another relation (a prospective write's staged rows); names are quoted identifiers. */
	readonly sources?: ReadonlyMap<string, string> | undefined;
	/** The byte budget of an `all` read; a page's is `STORE_LIMITS.pageBytes`. */
	readonly allBytes?: number | undefined;
};

/** One statement being built: its parameters and alias counter. */
export class Build {
	params: Json[] = [];
	private n = 0;
	/** The elements enclosing `each` predicates bind, innermost last. */
	readonly elements: string[] = [];
	readonly cat: Catalog;
	readonly scope: Scope | undefined;
	readonly root: CompileOptions['root'];
	readonly tz: string;
	/** The root whose read output this statement reads, and that output; every other root reads its `default`. */
	readonly readRoot: string | undefined;
	readonly output: string;
	private readonly options: CompileOptions;
	constructor(
		cat: Catalog,
		options: CompileOptions = {},
		read?: { readonly root: string; readonly output: string }
	) {
		this.cat = cat;
		this.readRoot = read?.root;
		this.output = read?.output ?? DEFAULT_OUTPUT;
		this.scope = options.scope;
		this.root = options.root;
		this.tz = options.tz ?? 'UTC';
		this.options = options;
	}
	private readonly reads = new Map<string, Set<string>>();
	/** Conservative native dependencies, including fields used only to filter, sort or label. */
	touch(model: string, field?: string): void {
		let fields = this.reads.get(model);
		if (fields === undefined) this.reads.set(model, (fields = new Set()));
		if (field !== undefined) fields.add(field);
	}
	dependencies(): Compiled['dependencies'] {
		// A caller-supplied SQL extension cannot be proven by this compiler.
		return { models: this.reads, complete: this.root === undefined };
	}
	from(model: string): string {
		this.touch(model);
		return q(this.options.sources?.get(model) ?? model);
	}
	/** The output a level at `path` reads: the statement's own for its root, else `default`. */
	outputOf(path: string): string {
		return path.split('.', 1)[0] === this.readRoot ? this.output : DEFAULT_OUTPUT;
	}
	operand(o: Operand): Fx<Json> {
		if (o._tag === 'Field') return invalid('a field operand has no value of its own');
		const resolve = this.options.resolve;
		return resolve === undefined
			? invalid(`this read resolves no '${o._tag}' operand`)
			: resolve(o);
	}
	alias(): string {
		return `a${this.n++}`;
	}
	bind(v: Json, pg?: string): string {
		// Drivers disagree on JavaScript arrays (node-pg encodes a PostgreSQL array). This compiler's composite
		// parameters travel as JSON text; callers that already encoded a JSON scalar or document remain unchanged.
		this.params.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
		// a list travels as JSON text (parameters are sent as text), so an array type is built from it
		if (pg?.endsWith('[]') && EffectArray.isArray(v))
			return `ARRAY(SELECT jsonb_array_elements_text($${this.params.length}::jsonb))::${pg}`;
		return pg === undefined ? `$${this.params.length}` : `$${this.params.length}::${pg}`;
	}
	sql(text: string): Fx<Sql> {
		return this.params.length > STORE_LIMITS.statement.params
			? Effect.fail(
					StoreError.of(
						'too_large',
						'decode',
						`a read binds more than ${STORE_LIMITS.statement.params} parameters`
					)
				)
			: Effect.succeed({ text, params: this.params });
	}
}
/** How a level compiles: `scoped` conjoins the reader's scope; `exposed` holds names to the output's exposure. */
export type Level = { scoped: boolean; exposed: boolean };
export const RAW: Level = { scoped: false, exposed: false };

/** What a layer exposes, named in a refusal so a caller (often a model) can correct the read in one step. */
const readableFields = (c: ExposureInfo, lv: Level) =>
	[...c.model.fields.keys()].filter((k) => !lv.exposed || exposed_field(c, k));
const fieldOf = (b: Build, c: ExposureInfo, name: string, lv: Level): Fx<FieldInfo> => {
	const f = c.model.fields.get(name);
	if (f !== undefined && !(lv.exposed && !exposed_field(c, name))) {
		b.touch(c.model.name, name);
		return Effect.succeed(f);
	}
	const readable = readableFields(c, lv);
	return invalid(
		`'${c.path}' has no readable field '${name}'${/\p{Cf}/u.test(name) ? ' (the name holds invisible characters)' : ''}; it exposes: ${readable.join(', ')}`
	);
};
/** A row's key column at alias `a` (a single-column key: an FK points at it). */
const keyAt = (b: Build, c: ExposureInfo, a: string) => {
	const key = c.model.key[0] ?? 'id';
	b.touch(c.model.name, key);
	return `${a}.${q(key)}`;
};
/** A field as a query touches it: its column. */
const col = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	name: string,
	lv: Level
) {
	const f = yield* fieldOf(b, c, name, lv);
	return `${a}.${q(f.column)}`;
});
/** The reader's row filter on `c` at alias `a`, or null when unscoped; a reader with no arm sees nothing. */
const scope = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	lv: Level,
	output = b.outputOf(c.path)
) {
	const arms = lv.scoped ? b.scope?.rows(c.path, output) : undefined;
	if (arms === undefined) return null;
	if (arms.length === 0) return 'false';
	return `(${(yield* Effect.forEach(arms, (arm) => pred(b, c, a, arm, RAW))).join(' OR ')})`;
});
const conj = (...parts: (string | null)[]) =>
	parts.filter((x): x is string => x !== null).join(' AND ') || 'true';

const value = (b: Build, f: FieldInfo, v: Json): Fx<string> => {
	const p = comparable(v);
	if (p !== null && f.pg === 'uuid' && (typeof p !== 'string' || !UUID_PATTERN.test(p)))
		return invalid(`'${f.name}' takes an id`);
	return Effect.succeed(
		b.bind(
			f.pg === 'jsonb' && p !== null
				? JSON.stringify(p)
				: f.email === true && typeof p === 'string'
					? p.toLowerCase()
					: p,
			f.pg
		)
	);
};
const rhs = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	f: FieldInfo,
	arg: Arg,
	lv: Level
) {
	if (arg._tag === 'Lit') return yield* value(b, f, arg.value);
	if (arg._tag === 'Field') return yield* col(b, c, a, arg.field, lv);
	return yield* value(b, f, yield* b.operand(arg));
});
type Link = { t: ExposureInfo; link: (a: string, x: string) => Fx<string> };
/**
 * The level a hop from `c` through `rel` into `target` reads: the layer `c`'s root output declares at that path (its
 * exposure, the root's arms for that path; the target model's own policies never apply). A scoped reader selects,
 * filters and sorts only across declared layers; an unscoped reader may reach a model no model exposes.
 */
const level = (
	b: Build,
	c: ExposureInfo,
	rel: string,
	target: string,
	lv: Level
): Fx<ExposureInfo> => {
	const layer = b.cat.layers.get(`${c.path}.${rel}`);
	if (layer !== undefined && layer.name === target) return Effect.succeed(layer);
	if (lv.exposed && !exposed_relation(c, rel))
		return invalid(
			`'${c.path}' declares no read layer '${rel}': a read selects, filters and sorts only across the layers its model's read declares`
		);
	const root = b.cat.exposures.get(target);
	if (root !== undefined) return Effect.succeed(root);
	const model = b.cat.models.get(target);
	return lv.exposed || model === undefined
		? exposure_of(b.cat, target)
		: Effect.succeed({ name: target, path: target, model, fields: 'all', relations: 'all' });
};
const relation = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	rel: string,
	target: string,
	lv: Level
) {
	const t = yield* level(b, c, rel, target, lv);
	const one = c.model.one.get(rel);
	const many = c.model.many.get(rel);
	if (one !== undefined) {
		b.touch(c.model.name, rel);
		const fk = one.targets.length > 1 ? `${rel}__${target}` : rel;
		const link: Link['link'] = (a, x) => Effect.succeed(`${keyAt(b, t, x)} = ${a}.${q(fk)}`);
		return { t, link };
	}
	if (many === undefined) return yield* invalid(`'${c.name}' has no relation '${rel}'`);
	const through = many.through;
	if (through !== undefined) {
		b.touch(through.table, through.from);
		b.touch(through.table, through.to);
		const link: Link['link'] = (a, x) =>
			Effect.succeed(
				`EXISTS (SELECT 1 FROM ${b.from(through.table)} j WHERE j.${q(through.from)} = ${keyAt(b, c, a)} AND j.${q(through.to)} = ${keyAt(b, t, x)})`
			);
		return { t, link };
	}
	const fk = many.column;
	b.touch(t.model.name, fk);
	const link: Link['link'] = (a, x) => Effect.succeed(`${x}.${q(fk)} = ${keyAt(b, c, a)}`);
	return { t, link };
});
/**
 * The links `search.text` names: a row matches when a row it links to matches that model's own `$search`. Scoped
 * as any `is` through the link; a model already on the way is not searched again.
 */
const searchLinks = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	text: string,
	via: readonly string[],
	lv: Level
) {
	const relations = yield* Effect.forEach(
		c.model.search.flatMap((f) => {
			const rel = c.model.one.get(f);
			return rel === undefined ? [] : rel.targets.map((target) => ({ rel: f, target }));
		}),
		({ rel, target }) =>
			via.includes(target) || b.cat.models.get(target)?.search.length === 0
				? Effect.succeed('false')
				: pred(
						b,
						c,
						a,
						{ t: 'one', rel, target, pred: { t: 'search', text, via: [...via, c.model.name] } },
						lv
					)
	);
	const references = yield* labelReferences(b, c, a, lv);
	const query = references.length === 0 ? '' : `bolt_search_filter(${b.bind(text, 'text')})`;
	return [
		...relations.filter((x) => x !== 'false'),
		...references.map(
			(ref) =>
				`EXISTS (SELECT 1 FROM ${ref.from} WHERE ${ref.where} AND ${ref.document} @@ ${query} AND bolt_search_document(${ref.label}) @@ ${query})`
		)
	];
});

/** The label interpreter takes exact decimals as text and every other field in the same JSON form as materialization. */
const labelValue = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	path: string,
	lv: Level
) {
	const [field = path, ...tail] = path.split('.');
	if (!c.model.fields.has(field))
		return yield* invalid(`${c.name}.record_label: unknown field '${path}'`);
	if (lv.exposed && !exposed_field(c, field)) return undefined;
	const f = yield* fieldOf(b, c, field, lv);
	const column = `${a}.${q(f.column)}`;
	const value = f.pg === 'numeric' ? `to_jsonb((${column})::text)` : wire(f, column, a);
	return tail.length === 0 ? value : `(${value} #> ${json_path(tail)})`;
});
/** One-hop labels use their declaring output's related layers and scopes, never an unrelated target grant. */
const recordLabel = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	lv: Level,
	output = b.outputOf(c.path),
	layers: ReadonlyMap<string, ExposureInfo> = b.cat.layers
) {
	const label = c.model.record_label;
	if (label === undefined) return undefined;
	if (label.stored) {
		if (lv.exposed && !label.fields.every((field) => exposed_field(c, field))) return undefined;
		b.touch(c.model.name, RECORD_LABEL_COLUMN);
		return `${a}.${q(RECORD_LABEL_COLUMN)}`;
	}
	const program = label_expression(label.expression);
	if ('error' in program) return yield* invalid(`${c.name}.record_label: ${program.error}`);
	const values = new Map<string, string>();
	const available: string[] = [];
	for (const path of label.paths) {
		const [field = path, ...tail] = path.split('.');
		const rel = c.model.one.get(field);
		if (tail.length === 0 || rel === undefined) {
			const value = yield* labelValue(b, c, a, path, lv);
			if (value === undefined) return undefined;
			values.set(path, value);
			continue;
		}
		const target = rel.targets[0];
		if (rel.targets.length !== 1 || target === undefined)
			return yield* invalid(`${c.name}.record_label: '${field}' must name one target`);
		if (lv.exposed && !exposed_relation(c, field)) return undefined;
		const declared = layers.get(`${c.path}.${field}`);
		const model = b.cat.models.get(target);
		if (model === undefined)
			return yield* invalid(`${c.name}.record_label: unknown target '${target}'`);
		if (lv.exposed && declared === undefined) return undefined;
		const t: ExposureInfo = declared ?? {
			name: target,
			path: target,
			model,
			fields: 'all',
			relations: 'all'
		};
		if (t.model.one.has(tail[0] ?? '') && tail.length > 1)
			return yield* invalid(`${c.name}.record_label: '${path}' crosses more than one relation`);
		const x = b.alias();
		const value = yield* labelValue(b, t, x, tail.join('.'), lv);
		if (value === undefined) return undefined;
		b.touch(c.model.name, field);
		const from = `${b.from(target)} ${x} WHERE ${conj(`${keyAt(b, t, x)} = ${a}.${q(field)}`, yield* scope(b, t, x, lv, output))}`;
		available.push(`EXISTS (SELECT 1 FROM ${from})`);
		values.set(path, `(SELECT ${value} FROM ${from})`);
	}
	// every value once, in a fenced row: a related lookup is one subplan however often the expression names it
	const inputs = b.alias(),
		columns = [...values.values()].map((value, i) => `${value} AS p${i}`),
		position = new Map([...values.keys()].map((path, i) => [path, `${inputs}.p${i}`]));
	const expression = program.sql((path) => position.get(path) ?? "'null'::jsonb", true);
	const value = `(${label_text_sql(expression, `(SELECT ${columns.join(', ') || '1 AS unused'} OFFSET 0) ${inputs}`, true)})`;
	return available.length === 0
		? value
		: `(CASE WHEN ${available.join(' AND ')} THEN ${value} END)`;
});
/** Resolve live label references under the target's own readable outputs and row grants, including named-only outputs. */
const labelReferences = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	lv: Level
) {
	const link = c.model.label_link;
	const out: { from: string; where: string; label: string; document: string }[] = [];
	if (
		link === undefined ||
		(lv.exposed && ![link.model, link.record].every((f) => exposed_field(c, f)))
	)
		return out;
	for (const target of link.targets) {
		const model = b.cat.models.get(target);
		const primary = model?.key[0];
		if (model?.record_label === undefined || model.key.length !== 1 || primary === undefined)
			continue;
		const outputs = [
			[DEFAULT_OUTPUT, b.cat.exposures.get(target)] as const,
			...[...(b.cat.outputs.get(target) ?? [])].map(
				([name, output]) => [name, output.root] as const
			)
		];
		for (const [output, t] of outputs) {
			if (t === undefined) continue;
			const arms = lv.scoped ? b.scope?.rows(target, output) : undefined;
			if (arms?.length === 0) continue;
			const x = b.alias();
			const label = yield* recordLabel(
				b,
				t,
				x,
				lv,
				output,
				output === DEFAULT_OUTPUT
					? b.cat.layers
					: (b.cat.outputs.get(target)?.get(output)?.layers ?? b.cat.layers)
			);
			if (label === undefined) continue;
			const rowScope =
				arms === undefined
					? null
					: `(${(yield* Effect.forEach(arms, (p) => pred(b, t, x, p, RAW))).join(' OR ')})`;
			const pg = model.fields.get(primary)?.pg ?? 'text';
			const id = `${a}.${q(link.record)}`;
			const key =
				pg === 'text'
					? id
					: `(CASE WHEN pg_input_is_valid(${id}, ${lit(pg)}) THEN ${id}::${pg} END)`;
			b.touch(c.model.name, link.model);
			b.touch(c.model.name, link.record);
			if (model.record_label.stored) b.touch(target, SEARCH_COLUMN);
			out.push({
				from: `${b.from(target)} ${x}`,
				where: conj(
					`${a}.${q(link.model)} = ${lit(target)}`,
					`${keyAt(b, t, x)} = ${key}`,
					rowScope
				),
				label,
				document: model.record_label.stored
					? `${x}.${q(SEARCH_COLUMN)}`
					: `bolt_search_document(${label})`
			});
		}
	}
	return out;
});
/** A reader may search only fields its read exposure names. */
const exposedAll = (
	c: ExposureInfo,
	fields: readonly string[],
	lv: Level,
	what: string
): Fx<void> => {
	const hidden = fields.find((f) => lv.exposed && !exposed_field(c, f));
	return hidden === undefined
		? Effect.void
		: forbidden(`${what} on '${c.name}' covers '${hidden}', which this caller does not read`);
};
/**
 * The search document a reader matches: the stored one when its output reads every field the document holds, else one
 * built from only the values it reads, so a match never reveals a field outside its output.
 */
const searchDoc = Effect.fnUntraced(function* (b: Build, c: ExposureInfo, a: string, lv: Level) {
	const own = c.model.search.filter((f) => f !== RECORD_LABEL_COLUMN && !c.model.one.has(f)),
		// a field outside the reader's exposure is in no document it matches, on any row
		hidden = own.filter((f) => lv.exposed && !exposed_field(c, f)),
		readable = own.filter((f) => !hidden.includes(f));
	const stored = `${a}.${q(SEARCH_COLUMN)}`;
	const label = c.model.record_label;
	const readableLabel = yield* recordLabel(b, c, a, lv);
	if (
		label?.stored !== false &&
		hidden.length === 0 &&
		(label === undefined || readableLabel !== undefined)
	) {
		b.touch(c.model.name, SEARCH_COLUMN);
		return stored;
	}
	const parts: string[] = [];
	if (readableLabel !== undefined) {
		parts.push(`coalesce(${readableLabel}, '')`);
	}
	for (const f of readable) {
		const value = yield* col(b, c, a, f, lv);
		parts.push(
			`coalesce(${c.model.fields.get(f)?.pg.endsWith('[]') === true ? `bolt_search_join((${value})::text[])` : `(${value})::text`}, '')`
		);
	}
	return parts.length === 0 ? "''::tsvector" : `bolt_search_document(${parts.join(" || ' ' || ")})`;
});
const OPS = { eq: '=', ne: 'IS DISTINCT FROM', lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;
/** `Pred` → a boolean SQL expression over alias `a` of model `c`. */
export const pred: (b: Build, c: ExposureInfo, a: string, p: Pred, lv: Level) => Fx<string> =
	Effect.fnUntraced(function* (b: Build, c: ExposureInfo, a: string, p: Pred, lv: Level) {
		switch (p.t) {
			case 'const':
				return p.value ? 'true' : 'false';
			case 'and':
			case 'or': {
				if (p.of.length === 0) return p.t === 'and' ? 'true' : 'false';
				const parts = yield* Effect.forEach(p.of, (x) => pred(b, c, a, x, lv));
				return `(${parts.join(p.t === 'and' ? ' AND ' : ' OR ')})`;
			}
			// unknown collapses to false before negation, as in the JS evaluator
			case 'not':
				return `(NOT COALESCE(${yield* pred(b, c, a, p.of, lv)}, false))`;
			case 'null':
				return `(${yield* col(b, c, a, p.field, lv)} IS ${p.is ? '' : 'NOT '}NULL)`;
			case 'cmp': {
				const f = yield* fieldOf(b, c, p.field, lv);
				const fold = (x: string) => (f.email === true ? `lower(${x})` : x);
				return `(${fold(yield* col(b, c, a, p.field, lv))} ${OPS[p.op]} ${fold(yield* rhs(b, c, a, f, p.arg, lv))})`;
			}
			case 'like':
				return `(${yield* col(b, c, a, p.field, lv)} ILIKE ${b.bind(p.pattern, 'text')})`;
			case 'text': {
				const normalize = (value: string) =>
					p.mode === 'folded' ? `lower(${value})` : `regexp_replace(${value}, '\\D', '', 'g')`;
				return `(${normalize(yield* col(b, c, a, p.field, lv))} = ${normalize(b.bind(p.value, 'text'))})`;
			}
			case 'age':
				return `(${yield* col(b, c, a, p.field, lv)} < now() - ${b.bind(p.seconds, 'float8')} * interval '1 second')`;
			case 'in': {
				const f = yield* fieldOf(b, c, p.field, lv);
				const args = p.args;
				if (!argument_list(args) && args._tag === 'Member') {
					// the earlier member's rows are the composed statement's CTE `"m:<member>"`, already under its own scope;
					// `field` may be a path through the member's relation arms (`employment_id.company_id`); a many arm's rows
					// each give theirs (a lax jsonpath walks into the arrays)
					const x = yield* col(b, c, a, p.field, lv),
						m = b.alias(),
						v = b.alias();
					const path = lit(
						`$${args.field
							.split('.')
							.map((part) => `."${part}"`)
							.join('')}`
					);
					const hit = `(${x} = ANY(ARRAY(SELECT (${v} #>> '{}')::${f.pg} FROM ${q(args.member)} ${m}, jsonb_path_query(${m}.j, ${path}) ${v} WHERE jsonb_typeof(${v}) <> 'null')))`;
					return p.negated ? `(NOT COALESCE(${hit}, false))` : hit;
				}
				const raw = argument_list(args) ? args : yield* b.operand(args);
				const list = (EffectArray.isArray<typeof raw>(raw) ? raw : raw === null ? [] : [raw]).map(
					(x) => comparable(x)
				);
				if (f.pg === 'uuid' && list.some((x) => typeof x !== 'string' || !UUID_PATTERN.test(x)))
					return yield* invalid(`'${f.name}' takes ids`);
				const column = yield* col(b, c, a, p.field, lv);
				const x = f.email === true ? `lower(${column})` : column;
				const hit = `(${x} = ANY(${b.bind(f.email === true ? list.map((v) => String(v).toLowerCase()) : list, `${f.pg}[]`)}))`;
				return p.negated ? `(NOT COALESCE(${hit}, false))` : hit;
			}
			case 'has': {
				const x = yield* col(b, c, a, p.field, lv);
				return `(${x} @> ${b.bind([p.arg], 'text[]')})`;
			}
			case 'period': {
				const f = yield* fieldOf(b, c, p.field, lv);
				const x = yield* col(b, c, a, p.field, lv);
				const date = f.period_of === 'date';
				if (p.op === 'contains') {
					const at =
						p.arg._tag === 'Field'
							? yield* col(b, c, a, p.arg.field, lv)
							: b.bind(
									comparable(p.arg._tag === 'Lit' ? p.arg.value : yield* b.operand(p.arg)),
									date ? 'date' : 'timestamptz'
								);
					return `(${x} @> ${at})`;
				}
				const end = (e: Arg) => (e._tag === 'Lit' ? Effect.succeed(e.value) : b.operand(e));
				// an exclusive date bound is the day after `to`; compare the inclusive ends
				const [lo, hi] = [comparable(yield* end(p.lo)), comparable(yield* end(p.hi))];
				if (date ? lo !== null && hi !== null && String(lo) > String(hi) : inverted(f, lo, hi))
					return 'false';
				const other = date
					? `daterange(${b.bind(lo, 'date')}, ${b.bind(hi, 'date')}, '[]')`
					: `tstzrange(${b.bind(lo, 'timestamptz')}, ${b.bind(hi, 'timestamptz')}, '[)')`;
				return period_test(p.op, x, other, date);
			}
			case 'geo': {
				const x = yield* col(b, c, a, p.field, lv);
				const [lat, lng] = [`(${x})[1]`, `(${x})[0]`];
				if (p.near !== undefined)
					return `(${metres(b, x, p.near[0])} <= ${b.bind(p.near[1], 'float8')})`;
				const s = p.within;
				if (s === undefined) return yield* invalid(`'${p.field}' takes near or within`);
				if ('bbox' in s) {
					const [u, v] = s.bbox;
					return `(${lat} BETWEEN ${b.bind(Math.min(u.lat, v.lat), 'float8')} AND ${b.bind(Math.max(u.lat, v.lat), 'float8')} AND ${lng} BETWEEN ${b.bind(Math.min(u.lng, v.lng), 'float8')} AND ${b.bind(Math.max(u.lng, v.lng), 'float8')})`;
				}
				return `(${x} <@ ${b.bind(`(${s.polygon.map((pt) => `(${pt.lng},${pt.lat})`).join(',')})`, 'polygon')})`;
			}
			case 'search': {
				const own = `coalesce(${yield* searchDoc(b, c, a, lv)} @@ bolt_search_filter(${b.bind(p.text, 'text')}), false)`;
				const linked = yield* searchLinks(b, c, a, p.text, p.via ?? [], lv);
				return linked.length === 0 ? own : `(${[own, ...linked].join(' OR ')})`;
			}
			case 'similar': {
				if (p.vector === undefined)
					return yield* invalid('$similar was not embedded before compiling');
				// of what this reader reads: the nearest, and every row nearly as near (within SIMILAR_BAND of it), at most `top`
				// ponytail: one cosine band for every model (measured on text-embedding-3-small); per-model bands if another drifts
				const t = b.alias(),
					n = b.alias(),
					x = `${t}.${q(EMBEDDING_COLUMN)}`,
					d = `(${x} <=> ${b.bind(`[${p.vector.join(',')}]`, 'vector')})`;
				// an embedding cannot be rebuilt from what a reader sees: only rows it reads every embedded field of are near
				const semantic = c.model.semantic?.fields ?? [];
				b.touch(c.model.name, EMBEDDING_COLUMN);
				yield* exposedAll(c, semantic, lv, '$similar');
				return `(${a}."id" IN (SELECT ${n}."id" FROM (SELECT ${t}."id", ${d} AS d, min(${d}) OVER () AS best FROM ${b.from(c.model.name)} ${t} WHERE ${conj(yield* scope(b, c, t, lv), `${x} IS NOT NULL`)} ORDER BY ${d}, ${t}."id" LIMIT ${b.bind(p.top, 'int8')}) ${n} WHERE ${n}.d <= ${n}.best + ${SIMILAR_BAND}))`;
			}
			case 'path':
			case 'each': {
				const base = p.field === ELEMENT ? b.elements.at(-1) : yield* col(b, c, a, p.field, lv);
				if (base === undefined)
					return yield* invalid('an element predicate outside a list quantifier');
				const at = json_path(p.path);
				const value = p.path.length === 0 ? base : `(${base} #> ${at})`;
				if (p.t === 'each') {
					const e = b.alias();
					b.elements.push(`${e}.v`);
					const inner = yield* pred(b, c, a, p.pred, lv);
					b.elements.pop();
					const items = `jsonb_array_elements(CASE WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE '[]'::jsonb END) ${e}(v)`;
					if (p.q === 'some') return `EXISTS (SELECT 1 FROM ${items} WHERE ${inner})`;
					if (p.q === 'none') return `(NOT EXISTS (SELECT 1 FROM ${items} WHERE ${inner}))`;
					return `(NOT EXISTS (SELECT 1 FROM ${items} WHERE NOT COALESCE(${inner}, false)))`;
				}
				return pathTest(b, value, `(${base} #>> ${at})`, p.pg, p.test);
			}
			case 'json': {
				const x = yield* col(b, c, a, p.field, lv);
				return `(${x} @> ${b.bind(JSON.stringify(p.contains), 'jsonb')})`;
			}
			case 'one':
			case 'many':
			case 'count':
			case 'agg': {
				const r = yield* relation(b, c, p.rel, p.target, lv);
				const t = b.alias();
				const from = `FROM ${b.from(r.t.model.name)} ${t} WHERE ${conj(yield* r.link(a, t), yield* scope(b, r.t, t, lv))}`;
				if (p.t === 'agg') {
					const f = yield* fieldOf(b, r.t, p.of, lv);
					const x =
						p.fn === 'sum'
							? `COALESCE(sum(${t}.${q(f.column)}), 0)`
							: `${p.fn}(${t}.${q(f.column)})`;
					const pg = p.fn === 'sum' || p.fn === 'avg' ? 'numeric' : f.pg;
					return `((SELECT ${x} ${from}) ${p.op === 'ne' ? '<>' : OPS[p.op]} ${b.bind(comparable(p.arg), pg)})`;
				}
				if (p.t === 'count')
					return `((SELECT count(*) ${from}) ${p.op === 'ne' ? '<>' : OPS[p.op]} ${b.bind(p.n, 'int8')})`;
				const inner = yield* pred(b, r.t, t, p.pred, lv);
				if (p.t === 'one' || p.q === 'some') return `EXISTS (SELECT 1 ${from} AND ${inner})`;
				if (p.q === 'none') return `(NOT EXISTS (SELECT 1 ${from} AND ${inner}))`;
				return `(NOT EXISTS (SELECT 1 ${from} AND NOT COALESCE(${inner}, false)))`;
			}
		}
	});

/** A test of the value at a path: `value` the jsonb there, `text` its text (`#>>`), cast to `pg` to compare. */
function pathTest(b: Build, value: string, text: string, pg: string, t: PathTest): string {
	if (pg === 'jsonb' && (t.op === 'eq' || t.op === 'ne'))
		return `(${value} ${OPS[t.op]} ${b.bind(JSON.stringify(t.arg), 'jsonb')})`;
	const typed = pg === 'text' || pg === 'jsonb' ? text : `(${text})::${pg}`;
	const at = pg === 'jsonb' ? 'text' : pg;
	switch (t.op) {
		case 'contains':
			return `(${value} @> ${b.bind(JSON.stringify(t.arg), 'jsonb')})`;
		case 'null':
			return t.is
				? `(${value} IS NULL OR ${value} = 'null'::jsonb)`
				: `(${value} IS NOT NULL AND ${value} <> 'null'::jsonb)`;
		case 'like':
			return `(${typed} ILIKE ${b.bind(t.arg, 'text')})`;
		case 'in': {
			const hit = `(${typed} = ANY(${b.bind(
				t.args.map((x) => comparable(x)),
				`${at}[]`
			)}))`;
			return t.negated ? `(NOT COALESCE(${hit}, false))` : hit;
		}
		default:
			return `(${typed} ${OPS[t.op]} ${b.bind(comparable(t.arg), at)})`;
	}
}

// ── rows ──
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (x: string) => `to_char(${x} AT TIME ZONE 'UTC', ${ISO})`;
/** A decimal as its exact text. */
const dec = (x: string) => `to_jsonb(${x}::text)`;
/** A column in wire form as jsonb: decimals, dates and instants as their text; periods as
 * `{ from, to }` / `{ start, end }` of those; a polymorphic relation as `{ model, id }`. */
export function wire(f: FieldInfo, x: string, a: string): string {
	if (f.arms !== undefined)
		return `(CASE ${f.arms.map((arm) => `WHEN ${a}.${q(`${f.column}__${arm}`)} IS NOT NULL THEN jsonb_build_object('model', ${lit(arm)}, 'id', ${a}.${q(`${f.column}__${arm}`)})`).join(' ')} END)`;
	if (f.pg === 'numeric') return dec(x);
	if (f.pg === 'timestamptz') return `to_jsonb(${iso(x)})`;
	if (f.pg === 'date' || f.pg === 'time') return `to_jsonb(${x}::text)`;
	if (f.pg === 'vector') return `(${x}::text::jsonb)`;
	if (f.pg === 'point')
		return `(CASE WHEN ${x} IS NOT NULL THEN jsonb_build_object('lat', (${x})[1], 'lng', (${x})[0]) END)`;
	if (f.pg === 'daterange')
		return `(CASE WHEN ${x} IS NOT NULL THEN jsonb_build_object('from', lower(${x})::text, 'to', CASE WHEN NOT upper_inf(${x}) THEN (upper(${x}) - 1)::text END) END)`;
	if (f.pg === 'tstzrange')
		return `(CASE WHEN ${x} IS NOT NULL THEN jsonb_build_object('start', ${iso(`lower(${x})`)}, 'end', CASE WHEN NOT upper_inf(${x}) THEN ${iso(`upper(${x})`)} END) END)`;
	return `to_jsonb(${x})`;
}
const item = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	name: string,
	lv: Level
) {
	const f = yield* fieldOf(b, c, name, lv);
	return `${wire(f, `${a}.${q(f.column)}`, a)} AS ${q(name)}`;
});
/** The select list of one level: the key, the fields, and each selected relation as a correlated subquery. */
export const items: (
	b: Build,
	c: ExposureInfo,
	a: string,
	s: SelectIR,
	lv: Level,
	one?: boolean
) => Fx<string[]> = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	s: SelectIR,
	lv: Level,
	one: boolean = false
) {
	const key = c.model.key;
	for (const field of key) b.touch(c.model.name, field);
	const fields =
		s.fields ??
		(b.scope !== undefined ? default_fields(c, one || s.whole === true) : stored_fields(c.model));
	const readable = readableFields(c, lv),
		unread = (s.fields ?? []).filter(
			(f) => !key.includes(f) && !readable.includes(f) && s.relations[f] === undefined
		);
	if (unread.length > 1)
		return yield* invalid(
			`'${c.path}' has no readable fields ${unread.map((f) => `'${f}'`).join(', ')}; it exposes: ${readable.join(', ')}`
		);
	const out = [
		...key.map((k) => `${a}.${q(k)} AS ${q(k)}`),
		...(yield* Effect.forEach(
			fields.filter((f) => !key.includes(f) && s.relations[f] === undefined),
			(f) => item(b, c, a, f, lv)
		))
	];
	for (const [rel, r] of Object.entries(s.relations))
		out.push(`${yield* arm(b, c, a, rel, r, lv)} AS ${q(rel)}`);
	if (c.model.record_label?.stored === false) {
		const label = yield* recordLabel(b, c, a, lv);
		const fallback = key.length === 1 ? `${keyAt(b, c, a)}::text` : 'NULL::text';
		out.push(`coalesce(${label ?? 'NULL::text'}, ${fallback}) AS "$label"`);
	}
	return out;
});
/** The root level's select list, and the scope's own root columns over the same row. */
const root = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	s: SelectIR,
	lv: Level,
	one: boolean = false
) {
	const references = yield* labelReferences(b, c, a, lv);
	const link = c.model.label_link;
	const label =
		link === undefined ||
		(lv.exposed && ![link.model, link.record].every((f) => exposed_field(c, f)))
			? []
			: [
					`coalesce(${[...references.map((ref) => `(SELECT ${ref.label} FROM ${ref.from} WHERE ${ref.where} LIMIT 1)`), `${a}.${q(link.record)}::text`].join(', ')}) AS "$label"`
				];
	return [...(yield* items(b, c, a, s, lv, one)), ...label, ...(b.root?.(c.name, a) ?? [])];
});
const arm = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	rel: string,
	r: RelSelectIR,
	lv: Level
) {
	if (!r.many && r.targets !== undefined) {
		// whichever target the row holds (at most one arm column is set), its row tagged with its `model`
		const arms = yield* Effect.forEach(r.targets, (target) =>
			Effect.gen(function* () {
				const x = yield* relation(b, c, rel, target, lv);
				const t = b.alias();
				return `(SELECT to_jsonb(r) || jsonb_build_object('model', ${lit(target)}) FROM (SELECT ${(yield* items(b, x.t, t, r.targetSelects?.[target] ?? r.select, lv)).join(', ')} FROM ${b.from(x.t.model.name)} ${t} WHERE ${conj(yield* x.link(a, t), yield* scope(b, x.t, t, lv))}) r)`;
			})
		);
		return `COALESCE(${arms.join(', ')})`;
	}
	const x = yield* relation(b, c, rel, r.target, lv);
	const t = b.alias();
	// a ref layer's `where` nulls the row where it fails, as its scope does
	if (!r.many)
		return `(SELECT to_jsonb(r) FROM (SELECT ${(yield* items(b, x.t, t, r.select, lv)).join(', ')} FROM ${b.from(x.t.model.name)} ${t} WHERE ${conj(yield* x.link(a, t), yield* scope(b, x.t, t, lv), r.where === undefined ? null : yield* pred(b, x.t, t, r.where, lv))}) r)`;
	if (r.aggregate !== undefined) {
		const where = conj(
			yield* x.link(a, t),
			yield* scope(b, x.t, t, lv),
			r.where === undefined ? null : yield* pred(b, x.t, t, r.where, lv)
		);
		const m = yield* measures(b, x.t, t, r.aggregate, lv);
		const from = `FROM ${b.from(x.t.model.name)} ${t} WHERE ${where}`;
		if (m.groups.length === 0)
			return `(SELECT to_jsonb(r) FROM (SELECT ${m.cols.join(', ')} ${from}) r)`;
		const g = m.groups.map((k) => k.expr).join(', ');
		const take = r.page?._tag === 'Limit' ? r.page.limit : STORE_LIMITS.page.relationArm;
		return `(SELECT COALESCE(jsonb_agg(to_jsonb(r) - '$n' ORDER BY r."$n"), '[]'::jsonb) FROM (SELECT ${m.cols.join(', ')}, row_number() OVER (ORDER BY ${g}) AS "$n" ${from} GROUP BY ${g} ORDER BY ${g} LIMIT ${take}) r)`;
	}
	const p = r.page;
	if (p === undefined)
		return yield* invalid('a many-relation arm states { limit } or { all: true }');
	if (p._tag === 'Limit' && p.after !== undefined)
		return yield* invalid(`relation arm '${rel}' takes no cursor`);
	const limit = p._tag === 'All' ? STORE_LIMITS.page.relationArm + 1 : p.limit;
	const ord = (yield* order_by(b, x.t, t, r.order ?? [], lv))
		.map((k) => `${k.expr} ${k.dir}`)
		.join(', ');
	const where = conj(
		yield* x.link(a, t),
		yield* scope(b, x.t, t, lv),
		r.where === undefined ? null : yield* pred(b, x.t, t, r.where, lv)
	);
	return `(SELECT COALESCE(jsonb_agg(to_jsonb(r) - '$n' ORDER BY r."$n"), '[]'::jsonb) FROM (SELECT ${(yield* items(b, x.t, t, r.select, lv)).join(', ')}, row_number() OVER (ORDER BY ${ord}) AS "$n" FROM ${b.from(x.t.model.name)} ${t} WHERE ${where} ORDER BY ${ord} LIMIT ${limit}) r)`;
});

/** Great-circle metres from a `point` column to a point (haversine, mean Earth radius). */
function metres(b: Build, x: string, pt: { lat: number; lng: number }): string {
	const [lat, lng, plat, plng] = [
		`(${x})[1]`,
		`(${x})[0]`,
		b.bind(pt.lat, 'float8'),
		b.bind(pt.lng, 'float8')
	];
	return `(6371008.8 * 2 * asin(sqrt(power(sin(radians(${lat} - ${plat}) / 2), 2) + cos(radians(${plat})) * cos(radians(${lat})) * power(sin(radians(${lng} - ${plng}) / 2), 2))))`;
}
// ── order and keyset cursors ──
type Key = { expr: string; pg: string; dir: 'asc' | 'desc' };
const UNORDERED = new Set([...UNSORTABLE, 'daterange', 'tstzrange']);
/** The sort keys, then the primary key's columns: a total order, so a keyset cursor is exact. */
const order_by = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	o: Order,
	lv: Level,
	first: readonly Key[] = []
) {
	const keys = yield* Effect.forEach(o, ({ field, dir, near }) =>
		Effect.gen(function* () {
			const own = !field.includes('.');
			const [head = field, ...rest] = field.split('.');
			const inline = own ? undefined : c.model.fields.get(head);
			const leaf = inline?.shape === undefined ? undefined : inline_leaf(inline, rest);
			if (!own && leaf === undefined && lv.exposed) yield* readable(b, c, field, lv);
			// a related key is a scalar subselect over the same joins and scopes as a filter; a missing or unseen target is null
			const { expr, f } = own
				? { expr: yield* col(b, c, a, field, lv), f: yield* fieldOf(b, c, field, lv) }
				: leaf !== undefined
					? {
							expr: `((${yield* col(b, c, a, head, lv)} #>> ${json_path(rest)})${leaf.pg === 'text' ? '' : `::${leaf.pg}`})`,
							f: leaf
						}
					: yield* path(b, c, a, field, lv);
			// nearest first: the distance is the key, so a cursor pages by it like any number (a row without a point sorts last)
			// ponytail: haversine per row, no KNN index use; order by the GiST `<->` when a large table needs nearest-N fast
			if (near !== undefined) {
				if (f.kind !== 'point') return yield* invalid(`'${field}' is not a point`);
				const k: Key = { expr: metres(b, expr, near), pg: 'float8', dir: 'asc' };
				return k;
			}
			if (UNORDERED.has(f.kind) || UNORDERED.has(f.pg) || f.many === true)
				return yield* invalid(`'${field}' has no order`);
			const k: Key = { expr, pg: f.pg, dir };
			return k;
		})
	);
	for (const field of c.model.key) b.touch(c.model.name, field);
	const tail: Key[] = c.model.key.map((k) => ({
		expr: `${a}.${q(k)}`,
		pg: c.model.fields.get(k)?.pg ?? 'text',
		dir: 'asc'
	}));
	return [...first, ...keys, ...tail];
});
/** A related sort key (`account.name`): each hop an exposed one-relation into a level the reader reads, and the field
 * exposed there; else `invalid_input`. */
const readable = Effect.fnUntraced(function* (b: Build, c: ExposureInfo, p: string, lv: Level) {
	const bad = (why: string) =>
		Effect.fail(StoreError.of('invalid_input', 'decode', `order_by '${p}': ${why}`));
	const steps = p.split('.');
	let x = c;
	for (const s of steps.slice(0, -1)) {
		const rel = x.model.one.get(s);
		const [target] = rel?.targets ?? [];
		if (rel === undefined || target === undefined || rel.targets.length > 1)
			return yield* bad(`'${x.path}.${s}' is not a relation this caller reads`);
		const t = yield* level(b, x, s, target, lv).pipe(Effect.catch((error) => bad(error.message)));
		if (lv.scoped && b.scope?.rows(t.path, b.outputOf(t.path))?.length === 0)
			return yield* bad(`'${t.path}' is not read by this caller`);
		x = t;
	}
	const last = steps.at(-1) ?? p;
	if (!exposed_field(x, last))
		return yield* bad(`'${x.name}.${last}' is not a field this caller reads`);
});
/** FNV-1a over the query minus its page: a cursor is bound to the query it came from (`bad_cursor` otherwise). */
function hash(ir: unknown): string {
	let h = 0x811c9dc5;
	for (const ch of JSON.stringify(ir)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
	return (h >>> 0).toString(36);
}
const encodePayload = Schema.encodeSync(CursorPayload);
export function encode_cursor(h: string, values: readonly (string | null)[]): string {
	return encodePayload({ h, k: values });
}
const cursorPayload = Schema.decodeUnknownResult(CursorPayload);
const decodeCursor = (cursor: string, h: string, n: number): Fx<readonly (string | null)[]> => {
	const decoded = cursorPayload(cursor);
	return Result.isSuccess(decoded) && decoded.success.h === h && decoded.success.k.length === n
		? Effect.succeed(decoded.success.k)
		: Effect.fail(
				StoreError.of('bad_cursor', 'decode', 'the cursor does not belong to this query')
			);
};
/** Rows after the cursor position: ASC puts nulls last, DESC first, as Postgres orders by default. */
function seek(b: Build, keys: readonly Key[], values: readonly (string | null)[]): string {
	const branches: string[] = [];
	keys.forEach((k, i) => {
		const v = values[i] ?? null;
		if (k.dir === 'asc' && v === null) return;
		const eq = keys.slice(0, i).map((p, j) => {
			const at = values[j] ?? null;
			return at === null ? `${p.expr} IS NULL` : `${p.expr} = ${b.bind(at, p.pg)}`;
		});
		const after =
			k.dir === 'asc'
				? `(${k.expr} > ${b.bind(v, k.pg)} OR ${k.expr} IS NULL)`
				: v === null
					? `${k.expr} IS NOT NULL`
					: `${k.expr} < ${b.bind(v, k.pg)}`;
		branches.push(`(${[...eq, after].join(' AND ')})`);
	});
	return branches.length === 0 ? 'false' : `(${branches.join(' OR ')})`;
}

// ── statements ──
/**
 * A compiled read: the statement, how its rows answer (`rows` a page, `one` a row or none, `agg` one aggregate row),
 * its page limit, and the cursor hash and key count a page's `next` is encoded with.
 */
export type Compiled = {
	sql: Sql;
	kind: 'rows' | 'one' | 'agg';
	limit: number | 'all' | null;
	hash: string;
	keys: number;
	/** Compiler-produced proof; opaque root SQL makes it incomplete and unusable for prospective safety. */
	dependencies: {
		readonly models: ReadonlyMap<string, ReadonlySet<string>>;
		readonly complete: boolean;
	};
};
const start = Effect.fnUntraced(function* (
	base: Catalog,
	model: string,
	options: CompileOptions,
	output = DEFAULT_OUTPUT
) {
	const cat = yield* catalog_for(base, model, output);
	const c = yield* exposure_of(cat, model);
	const scoped = options.scope !== undefined;
	const lv: Level = { scoped, exposed: scoped };
	if (options.scope?.rows(model, output)?.length === 0)
		return yield* forbidden(
			`no held policy grants reading '${model}'${output === DEFAULT_OUTPUT ? '' : ` as its '${output}' output`}`
		);
	return { c, b: new Build(cat, options, { root: model, output }), lv };
});
const pageLimit = (p: PageIR): number | 'all' => (p._tag === 'All' ? 'all' : p.limit);
/** A probe resolved before compiling: the vector a similarity read orders by, and how many rows it takes. */
export type Probe = {
	field: string;
	vector: readonly number[];
	where?: Pred;
	take: number;
	from?: string;
};

/** `read`, `get`, `aggregate` or `similar` (with its probe resolved) as one statement. */
export const compile = Effect.fn('Store.compile')(function* (
	cat: Catalog,
	ir: ReadIR,
	options: CompileOptions = {},
	probe?: Probe
) {
	const { c, b, lv } = yield* start(cat, ir.model, options, ir.output);
	const a = b.alias();
	const table = `${b.from(c.model.name)} ${a}`;
	const one = (text: string): Fx<Compiled> =>
		Effect.map(b.sql(text), (sql): Compiled => ({
			sql,
			kind: 'one',
			limit: null,
			hash: '',
			keys: 0,
			dependencies: b.dependencies()
		}));
	const nearest = (text: string, take: number): Fx<Compiled> =>
		Effect.map(b.sql(text), (sql): Compiled => ({
			sql,
			kind: 'rows',
			limit: take,
			hash: '',
			keys: 0,
			dependencies: b.dependencies()
		}));
	if (ir.kind === 'get') {
		const id = c.model.fields.get('id');
		if (id === undefined)
			return yield* invalid(`'${c.name}' is keyed by its fields; read it by them`);
		if (id.pg === 'uuid' && !UUID_PATTERN.test(ir.id))
			return yield* one('SELECT NULL::jsonb AS j WHERE false');
		return yield* one(
			`SELECT to_jsonb(r) AS j FROM (SELECT ${(yield* root(b, c, a, ir.select, lv, true)).join(', ')} FROM ${table} WHERE ${conj(`${a}."id" = ${b.bind(ir.id, id.pg)}`, yield* scope(b, c, a, lv))}) r`
		);
	}
	if (ir.kind === 'similar' && probe?.field === SEMANTIC) {
		// `search.semantic`'s platform embedding, cosine, probed by an embedded text or by a readable record's own vector
		if (c.model.semantic === undefined)
			return yield* invalid(`'${c.name}' declares no search.semantic`);
		b.touch(c.model.name, EMBEDDING_COLUMN);
		const x = `${a}.${q(EMBEDDING_COLUMN)}`,
			s = b.alias();
		const to =
			probe.from === undefined
				? `${b.bind(`[${probe.vector.join(',')}]`, 'vector')}`
				: `(SELECT ${s}.${q(EMBEDDING_COLUMN)} FROM ${b.from(c.model.name)} ${s} WHERE ${conj(`${s}."id" = ${b.bind(probe.from, 'uuid')}`, yield* scope(b, c, s, lv))})`;
		const dist = `(${x} <=> ${to})`;
		const where = conj(
			yield* scope(b, c, a, lv),
			`${dist} IS NOT NULL`,
			probe.from === undefined ? null : `${a}."id" <> ${b.bind(probe.from, 'uuid')}`,
			ir.where === undefined ? null : yield* pred(b, c, a, ir.where, lv)
		);
		const sel = yield* root(b, c, a, ir.select ?? { fields: null, relations: {} }, lv);
		return yield* nearest(
			`SELECT to_jsonb(r) AS j FROM (SELECT ${sel.join(', ')}, ${dist}::float8 AS "$distance" FROM ${table} WHERE ${where} ORDER BY ${dist}, ${a}."id" LIMIT ${probe.take}) r`,
			probe.take
		);
	}
	if (ir.kind === 'similar') {
		if (probe === undefined) return yield* invalid(`'${ir.index}' was not probed before compiling`);
		const index = c.model.indexes[ir.index];
		if (index === undefined)
			return yield* invalid(`'${c.name}' declares no search index '${ir.index}'`);
		if (probe.vector.length !== index.dim || !probe.vector.every(Number.isFinite))
			return yield* invalid(`the probe is not ${index.dim} finite numbers`);
		if (index.field === undefined) b.touch(c.model.name, index_column(ir.index));
		const x =
			index.field === undefined
				? `${a}.${q(index_column(ir.index))}`
				: yield* col(b, c, a, index.field, lv);
		const dist = `(${x} ${index.metric === 'cosine' ? '<=>' : index.metric === 'ip' ? '<#>' : '<->'} ${b.bind(`[${probe.vector.join(',')}]`, 'vector')})`;
		const where = conj(
			yield* scope(b, c, a, lv),
			`${x} IS NOT NULL`,
			probe.where === undefined ? null : yield* pred(b, c, a, probe.where, lv),
			ir.where === undefined ? null : yield* pred(b, c, a, ir.where, lv)
		);
		const sel = yield* root(b, c, a, ir.select ?? { fields: null, relations: {} }, lv);
		return yield* nearest(
			`SELECT to_jsonb(r) AS j FROM (SELECT ${sel.join(', ')}, ${dist}::float8 AS "$distance" FROM ${table} WHERE ${where} ORDER BY ${dist}, ${a}."id" LIMIT ${probe.take}) r`,
			probe.take
		);
	}
	if (ir.kind === 'aggregate') return yield* aggregate(b, c, a, ir, lv);
	// read
	let search: string | null = null;
	let first: Key[] = [];
	if (ir.search !== undefined) {
		if (c.model.search.length === 0)
			return yield* invalid(`'${c.name}' declares no searchable fields`);
		// the term is folded and tokenized by the document's own functions (native words and CJK runs as prefixes,
		// romanized spellings, pinyin joins, Latin skeletons); a row meeting any lexeme is found, and one holding every
		// native word ranks first, then by how much of the query landed. A term of noise is no tsquery: no rows.
		const hybrid = probe?.field === SEMANTIC;
		const doc = yield* searchDoc(b, c, a, lv),
			term = b.bind(hybrid ? ir.search.replace(/^\/semantic\s+/, '') : ir.search, 'text');
		const any = `bolt_search_query(${term}, false)`;
		const linked = yield* searchLinks(b, c, a, ir.search, [], lv);
		const own = `coalesce(${doc} @@ ${any}, false)`;
		const match = linked.length === 0 ? own : `(${own} OR ${linked.join(' OR ')})`;
		const rank = `(coalesce(${doc} @@ bolt_search_query(${term}, true), false)::int * 2 + coalesce(ts_rank('{1,1,1,1}', ${doc}, ${any}), 0) + 0.1 / (1 + length(${doc})))`;
		search = match;
		if (hybrid && probe !== undefined) {
			// `/semantic`: the lexical and the embedding rankings fused by reciprocal rank (k = 60), so an exact hit always
			// outranks a row only the vector found; one page, no cursor (a window rank cannot be sought)
			if (c.model.semantic === undefined)
				return yield* invalid(`'${c.name}' declares no search.semantic`);
			if (ir.page._tag === 'Limit' && ir.page.after !== undefined)
				return yield* invalid('a /semantic search reads one page');
			b.touch(c.model.name, EMBEDDING_COLUMN);
			const x = `${a}.${q(EMBEDDING_COLUMN)}`,
				dist = `(${x} <=> ${b.bind(`[${probe.vector.join(',')}]`, 'vector')})`;
			search = `(${match} OR ${x} IS NOT NULL)`;
			first = [
				{
					expr: `((CASE WHEN ${match} THEN 1.0 / (60 + rank() OVER (ORDER BY ${match} DESC, ${rank} DESC)) ELSE 0 END
				+ CASE WHEN ${x} IS NOT NULL THEN 1.0 / (60 + rank() OVER (ORDER BY ${dist})) ELSE 0 END)::float8)`,
					pg: 'float8',
					dir: 'desc'
				}
			];
			const keys = yield* order_by(b, c, a, [], lv, first);
			const limit = pageLimit(ir.page),
				take = limit === 'all' ? STORE_LIMITS.page.all + 1 : limit;
			const where = conj(
				yield* scope(b, c, a, lv),
				ir.where === undefined ? null : yield* pred(b, c, a, ir.where, lv),
				search
			);
			const sql = yield* b.sql(
				counted(
					`SELECT to_jsonb(r) AS j FROM (SELECT ${(yield* root(b, c, a, ir.select, lv)).join(', ')} FROM ${table} WHERE ${where} ORDER BY ${keys.map((k) => `${k.expr} ${k.dir}`).join(', ')} LIMIT ${take}) r`,
					ir.total === true,
					table,
					where
				)
			);
			const compiled: Compiled = {
				sql,
				kind: 'rows',
				limit: 'all',
				hash: '',
				keys: 0,
				dependencies: b.dependencies()
			};
			return compiled;
		}
		if (ir.order === undefined || ir.order.length === 0)
			first = [{ expr: `(${rank}::float8)`, pg: 'float8', dir: 'desc' }];
	}
	const groups = ir.first_per ?? [];
	for (const field of groups) {
		if (lv.exposed && !exposed_field(c, field))
			return yield* invalid(`first_per '${field}' must be readable`);
	}
	const groupOrder: Order = groups.map((field) => ({
		field,
		dir: ir.order?.find((key) => key.field === field)?.dir ?? 'asc'
	}));
	const keys = yield* order_by(
		b,
		c,
		a,
		[...groupOrder, ...(ir.order ?? []).filter(({ field }) => !groups.includes(field))],
		lv,
		first
	);
	const { page, total: _total, ...rest } = ir;
	const h = hash(rest);
	const after =
		page._tag === 'Limit' && page.after !== undefined
			? seek(b, keys, yield* decodeCursor(page.after, h, keys.length))
			: null;
	const filter = conj(
		yield* scope(b, c, a, lv),
		ir.where === undefined ? null : yield* pred(b, c, a, ir.where, lv),
		search
	);
	const sort = keys.map((k) => `${k.expr} ${k.dir}`).join(', ');
	// Seek only after choosing each group's first row; seeking inside DISTINCT would resurrect older rows.
	const source =
		groups.length === 0
			? table
			: `(SELECT DISTINCT ON (${keys
					.slice(0, groups.length)
					.map((k) => k.expr)
					.join(', ')}) ${a}.* FROM ${table} WHERE ${filter} ORDER BY ${sort}) ${a}`;
	const where = groups.length === 0 ? conj(filter, after) : (after ?? 'true');
	const limit = pageLimit(page);
	const take = limit === 'all' ? STORE_LIMITS.page.all + 1 : limit + 1;
	const cursor =
		limit === 'all'
			? ''
			: `, jsonb_build_array(${keys.map((k) => `${k.expr}::text`).join(', ')}) AS "$k"`;
	const sql = yield* b.sql(
		counted(
			budgeted(
				`SELECT to_jsonb(r) AS j FROM (SELECT ${(yield* root(b, c, a, ir.select, lv)).join(', ')}${cursor} FROM ${source} WHERE ${where} ORDER BY ${sort} LIMIT ${take}) r`,
				limit === 'all' ? (options.allBytes ?? STORE_LIMITS.page.allBytes) : STORE_LIMITS.pageBytes
			),
			ir.total === true,
			source,
			// the cursor aside: a total counts every page
			groups.length === 0 ? filter : 'true'
		)
	);
	const compiled: Compiled = {
		sql,
		kind: 'rows',
		limit,
		hash: h,
		keys: keys.length,
		dependencies: b.dependencies()
	};
	return compiled;
});

/**
 * Concurrent `get`s of one model and select as one statement: the ids unnested with their ordinal and each row
 * as a lateral subquery — one row per id, in order, `j` null when not found.
 */
export const compile_gets = Effect.fn('Store.compile_gets')(function* (
	cat: Catalog,
	model: string,
	ids: readonly string[],
	select: SelectIR,
	options: CompileOptions = {},
	output?: string
) {
	const { c, b, lv } = yield* start(cat, model, options, output);
	const a = b.alias();
	const id = c.model.fields.get('id');
	if (id === undefined)
		return yield* invalid(`'${c.name}' is keyed by its fields; read it by them`);
	const list = b.bind(
		ids.map((x) => (id.pg !== 'uuid' || UUID_PATTERN.test(x) ? x : null)),
		`${id.pg}[]`
	);
	return yield* b.sql(`SELECT (SELECT to_jsonb(r) FROM (SELECT ${(yield* root(b, c, a, select, lv, true)).join(', ')} FROM ${b.from(c.model.name)} ${a} WHERE ${conj(`${a}."id" = v.id`, yield* scope(b, c, a, lv))}) r) AS j
	FROM unnest(${list}) WITH ORDINALITY v(id, n) ORDER BY v.n`);
});

const NUM = new Set(
	Object.entries(KIND)
		.filter(([, entry]) => entry.traits.summable)
		.map(([kind]) => kind)
);
/** A field reached by a one-relation path (`'account.region'`), each hop scoped. */
const path: (
	b: Build,
	c: ExposureInfo,
	a: string,
	p: string,
	lv: Level
) => Fx<{ expr: string; f: FieldInfo }> = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	p: string,
	lv: Level
) {
	const [head = '', ...tail] = p.split('.');
	if (tail.length === 0 || c.model.fields.get(p) !== undefined) {
		const f = yield* fieldOf(b, c, p, lv);
		return { expr: yield* col(b, c, a, p, lv), f };
	}
	const rel = c.model.one.get(head);
	const [target] = rel?.targets ?? [];
	if (rel === undefined || rel.targets.length > 1 || target === undefined)
		return yield* invalid(`'${head}' is not a one-relation of '${c.name}'`);
	const r = yield* relation(b, c, head, target, lv);
	const t = b.alias();
	const inner = yield* path(b, r.t, t, tail.join('.'), lv);
	return {
		expr: `(SELECT ${inner.expr} FROM ${b.from(r.t.model.name)} ${t} WHERE ${conj(yield* r.link(a, t), yield* scope(b, r.t, t, lv))})`,
		f: inner.f
	};
});
/** An aggregate's select list over the rows at alias `a`, and its bucket keys (`GROUP BY`). */
const measures = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	ir: Measures,
	lv: Level
) {
	const cols: string[] = [];
	const groups: Key[] = [];
	const key: string[] = [];
	for (const bucket of ir.by) {
		const { expr, f } = yield* path(b, c, a, bucket.field, lv);
		let g = expr;
		let pg = f.pg;
		if (bucket.unit !== undefined) {
			if (f.kind !== 'date' && f.kind !== 'instant')
				return yield* invalid(`'${bucket.field}' is not a date or instant`);
			g =
				f.kind === 'date'
					? `date_trunc('${bucket.unit}', ${expr})::date`
					: `(date_trunc('${bucket.unit}', ${expr}, ${b.bind(b.tz, 'text')}) AT TIME ZONE ${b.bind(b.tz, 'text')})::date`;
			pg = 'date';
		} else if (UNORDERED.has(f.kind) || UNORDERED.has(f.pg) || f.many === true)
			return yield* invalid(`'${bucket.field}' cannot be a bucket`);
		groups.push({ expr: g, pg, dir: 'asc' });
		key.push(
			`${lit(bucket.field)}, ${bucket.unit === undefined ? wire(f, g, a) : `to_jsonb(${g}::text)`}`
		);
	}
	if (key.length > 0) cols.push(`jsonb_build_object(${key.join(', ')}) AS "key"`);
	if (ir.count === true) cols.push('count(*) AS "count"');
	for (const fn of ['sum', 'avg', 'min', 'max'] as const) {
		const fields = ir[fn];
		if (fields === undefined || fields.length === 0) continue;
		const pairs = yield* Effect.forEach(fields, (name) =>
			Effect.gen(function* () {
				const { expr, f } = yield* path(b, c, a, name, lv);
				if ((fn === 'sum' || fn === 'avg') && !NUM.has(f.kind))
					return yield* invalid(`'${name}' is not numeric`);
				if (UNORDERED.has(f.kind) || UNORDERED.has(f.pg) || f.many === true)
					return yield* invalid(`'${name}' cannot be aggregated`);
				const agg = `${fn}(${expr})`;
				return `${lit(name)}, ${fn === 'sum' || fn === 'avg' ? dec(`${agg}::numeric`) : wire(f, agg, a)}`;
			})
		);
		cols.push(`jsonb_build_object(${pairs.join(', ')}) AS ${q(fn)}`);
	}
	if (cols.length === 0) return yield* invalid('an aggregate asks for something');
	return { cols, groups };
});
const aggregate = Effect.fnUntraced(function* (
	b: Build,
	c: ExposureInfo,
	a: string,
	ir: Extract<ReadIR, { kind: 'aggregate' }>,
	lv: Level
) {
	const { cols, groups } = yield* measures(b, c, a, ir, lv);
	const where = conj(
		yield* scope(b, c, a, lv),
		ir.where === undefined ? null : yield* pred(b, c, a, ir.where, lv)
	);
	const page = ir.page;
	if (groups.length === 0 || page === undefined) {
		const sql = yield* b.sql(
			`SELECT to_jsonb(r) AS j FROM (SELECT ${cols.join(', ')} FROM ${b.from(c.model.name)} ${a} WHERE ${where}) r`
		);
		const compiled: Compiled = {
			sql,
			kind: 'agg',
			limit: null,
			hash: '',
			keys: 0,
			dependencies: b.dependencies()
		};
		return compiled;
	}
	const { page: _, ...rest } = ir;
	const h = hash(rest);
	const having =
		page._tag === 'Limit' && page.after !== undefined
			? ` HAVING ${seek(b, groups, yield* decodeCursor(page.after, h, groups.length))}`
			: '';
	const limit = pageLimit(page);
	const take = limit === 'all' ? STORE_LIMITS.page.all + 1 : limit + 1;
	const cursor =
		limit === 'all'
			? ''
			: `, jsonb_build_array(${groups.map((k) => `${k.expr}::text`).join(', ')}) AS "$k"`;
	const sql = yield* b.sql(
		`SELECT to_jsonb(r) AS j FROM (SELECT ${cols.join(', ')}${cursor} FROM ${b.from(c.model.name)} ${a} WHERE ${where} GROUP BY ${groups.map((g) => g.expr).join(', ')}${having} ORDER BY ${groups.map((g) => g.expr).join(', ')} LIMIT ${take}) r`
	);
	const compiled: Compiled = {
		sql,
		kind: 'rows',
		limit,
		hash: h,
		keys: groups.length,
		dependencies: b.dependencies()
	};
	return compiled;
});

/** The ids a predicate admits, compiled raw (no scope, no exposure): a grant arm, with its holder's operands. */
export const grant_sql = Effect.fn('Store.grant_sql')(function* (
	cat: Catalog,
	model: string,
	p: Pred,
	options: Omit<CompileOptions, 'scope'> = {}
) {
	const c = yield* exposure_of(cat, model),
		b = new Build(cat, options),
		a = b.alias();
	return yield* b.sql(
		`SELECT ${a}."id" AS id FROM ${b.from(c.model.name)} ${a} WHERE ${yield* pred(b, c, a, p, RAW)} ORDER BY ${a}."id"`
	);
});
/** For the live router and tests: a predicate under the reader's scope, as the WHERE of `SELECT id FROM <c>`. */
export const where_sql = Effect.fn('Store.where_sql')(function* (
	cat: Catalog,
	model: string,
	p: Pred,
	options: CompileOptions = {},
	output?: string
) {
	const { c, b, lv } = yield* start(cat, model, options, output);
	const a = b.alias();
	return yield* b.sql(
		`SELECT ${a}."id" AS id FROM ${b.from(c.model.name)} ${a} WHERE ${conj(yield* scope(b, c, a, lv), yield* pred(b, c, a, p, lv))} ORDER BY ${a}."id"`
	);
});
