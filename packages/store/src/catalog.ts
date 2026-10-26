// What the query compiler knows of a schema: per model (table), its columns by kind and its relations; per collection,
// its read exposure (a plain schema exposes each table whole). Built once per schema from pure data; browser-safe.
//
// Physical naming, shared with the DDL: a model's table is its name, a field's column is its name, a relation's FK
// column is its field name, and each arm of a polymorphic relation is its own column `<fk>__<arm>`. A `period` is a
// `daterange` (`[from, to+1)`) or `tstzrange`; a `point` is a Postgres `point` (x = lng, y = lat); a list field is
// `text[]`; the lexical search document is the generated `bolt_search` tsvector ('simple').
import { Effect } from 'effect';
import * as ReadonlyArray from 'effect/Array';
import { StoreError } from './errors.ts';

export type FieldInfo = {
	name: string;
	kind: string;
	column: string;
	pg: string;
	many?: true;
	email?: true;
	phone?: true;
	/** A source team handle (`format: 'team'`): `actor.teams` / `actor.teamTree` compare it. */
	team?: true;
	periodOf?: 'date' | 'instant';
	metric?: 'l2' | 'cosine' | 'ip';
	dim?: number;
	/** Declared enum values or state names (membership); the model an id points at. */
	values?: readonly string[];
	/** A standalone writer enforces these state edges and edit locks over the stored pre-image. */
	state?: {
		readonly initial: string;
		readonly states: {
			readonly [name: string]: {
				readonly to?: readonly string[];
				readonly edit?: 'all' | 'none' | readonly string[];
			};
		};
	};
	of?: string;
	/** An exclusive arc: the arm models; its value is a `RecordRef`. */
	arms?: readonly string[];
	computed?: true;
	derived?: true;
	/** An inline value's declared shape (`json`, `list`, `object`, `record`): what its path predicates walk. */
	shape?: KindSpec;
};
export type OneRel = { name: string; targets: readonly string[] };
/**
 * A many-relation: rows of `child` whose `column` holds this row's key, or with `through`, the rows of `child` a join
 * table pairs with this one (`through.from` holds this row's key, `through.to` the child's).
 */
export type ManyRel = {
	name: string;
	child: string;
	column: string;
	through?: { readonly table: string; readonly from: string; readonly to: string };
};
export type ModelInfo = {
	name: string;
	audit?: true;
	fields: ReadonlyMap<string, FieldInfo>;
	one: ReadonlyMap<string, OneRel>;
	many: ReadonlyMap<string, ManyRel>;
	/** The primary key's columns: `id`, or the declared key fields. */
	key: readonly string[];
	search: readonly string[];
	/** `search.semantic`: the platform embedding `bolt_embedding`, the model class that fills it, and its width. */
	semantic?: { model: string; dim: number; fields: readonly string[] };
	indexes: { readonly [name: string]: IndexInfo };
};
export type IndexInfo = {
	readonly dim: number;
	readonly metric: 'l2' | 'cosine' | 'ip';
	readonly field?: string | undefined;
	readonly candidates?: number | undefined;
	readonly rerank?: true | undefined;
};
export type CollectionInfo = {
	name: string;
	model: ModelInfo;
	fields: 'all' | ReadonlySet<string>;
	relations: 'all' | ReadonlySet<string>;
};
export type Catalog = {
	models: ReadonlyMap<string, ModelInfo>;
	collections: ReadonlyMap<string, CollectionInfo>;
};

export const SEARCH_COLUMN = 'bolt_search';
/** The platform embedding `search.semantic` keeps, and the probe name that reads it. */
export const EMBEDDING_COLUMN = 'bolt_embedding',
	SEMANTIC = '$semantic';
/** The hidden vector column maintained by a host's custom search index. */
export const indexColumn = (index: string): string => `$idx_${index}`;
/** The audit columns (`audit: true`), every write's revision first. */
export const AUDIT_COLUMNS = [
	'revision',
	'created_at',
	'created_by',
	'updated_at',
	'updated_by'
] as const;
/** The columns a reader always names: the key `id` and the audit columns. */
export const SYSTEM_COLUMNS = ['id', ...AUDIT_COLUMNS] as const;
/** A field kind literal as the catalog reads it: a table's `FieldSpec` and the browser exposure's alike. */
export type KindSpec = {
	readonly kind: string;
	readonly optional?: boolean;
	/** A ref's target, or several (polymorphic). */
	readonly to?: string | readonly string[];
	/** A ref's many side on each target. */
	readonly inverse?: string;
	readonly many?: boolean;
	readonly format?: string;
	readonly of?: unknown;
	readonly metric?: 'l2' | 'cosine' | 'ip';
	readonly dim?: number;
	readonly pattern?: string;
	readonly values?: readonly string[];
	readonly initial?: string;
	readonly states?: {
		readonly [s: string]: {
			readonly to?: readonly string[];
			readonly edit?: 'all' | 'none' | readonly string[];
		};
	};
	/** An object's fields, a json value's shape, an object's other keys: an inline value's structure. */
	readonly fields?: { readonly [name: string]: KindSpec };
	readonly shape?: KindSpec;
	readonly rest?: KindSpec;
};
const INLINE = new Set(['json', 'list', 'object', 'record']);
/** What the catalog reads of a table: its fields and computed fields, its key and audit columns, and its search. */
export type CatalogTable = {
	readonly fields: { readonly [name: string]: KindSpec };
	readonly computed?: { readonly [name: string]: { readonly kind: string } } | undefined;
	readonly key?: 'uuid' | 'text' | 'identity' | readonly [string, ...string[]] | undefined;
	readonly audit?: true | undefined;
	readonly through?:
		| {
				readonly [name: string]: {
					readonly table: string;
					readonly from: string;
					readonly to: string;
				};
		  }
		| undefined;
	readonly search?:
		| {
				readonly text?: readonly string[] | undefined;
				readonly indexes?: { readonly [name: string]: IndexInfo } | undefined;
				readonly semantic?:
					| {
							readonly model: string;
							readonly dim: number;
							readonly fields?: readonly string[] | undefined;
					  }
					| undefined;
		  }
		| undefined;
};
/** What the catalog reads of a schema: its tables (each ref field a relation). */
export type CatalogSchema = { readonly tables: { readonly [table: string]: CatalogTable } };
/** What the catalog reads of a collection: its read exposure. */
export type CatalogCollection = {
	readonly read: {
		readonly fields: 'all' | readonly string[];
		readonly relations?: 'all' | readonly string[] | undefined;
	};
};

const PG: { readonly [kind: string]: string } = {
	text: 'text',
	enum: 'text',
	state: 'text',
	currency: 'text',
	int: 'int8',
	count: 'int8',
	duration: 'int8',
	number: 'float8',
	decimal: 'numeric',
	money: 'numeric',
	sum: 'numeric',
	bool: 'bool',
	date: 'date',
	instant: 'timestamptz',
	time: 'time',
	id: 'uuid',
	json: 'jsonb',
	list: 'jsonb',
	object: 'jsonb',
	file: 'jsonb',
	custom: 'jsonb',
	point: 'point',
	vector: 'vector'
};

/** A field of kind `k` as the compilers read it: its column, Postgres type and options. */
export function fieldInfo(name: string, k: KindSpec, extra: Partial<FieldInfo> = {}): FieldInfo {
	const kind = k.kind === 'seq' ? (k.pattern === undefined ? 'int' : 'text') : k.kind;
	const pg =
		kind === 'period'
			? k.of === 'date'
				? 'daterange'
				: 'tstzrange'
			: k.many
				? 'text[]'
				: (PG[kind] ?? 'text');
	return {
		name,
		kind,
		column: name,
		pg,
		...(k.many ? { many: true } : {}),
		...(k.format === 'email' ? { email: true } : {}),
		...(k.format === 'phone' ? { phone: true } : {}),
		...(k.format === 'team' ? { team: true } : {}),
		...(kind === 'period' ? { periodOf: k.of === 'date' ? 'date' : 'instant' } : {}),
		...(kind === 'vector'
			? { metric: k.metric ?? 'l2', ...(k.dim === undefined ? {} : { dim: k.dim }) }
			: {}),
		...(k.kind === 'seq' || k.kind === 'sum' || k.kind === 'count' ? { derived: true } : {}),
		...(k.values !== undefined
			? { values: k.values }
			: k.states !== undefined
				? { values: Object.keys(k.states) }
				: {}),
		...(kind === 'state' && k.initial !== undefined && k.states !== undefined
			? { state: { initial: k.initial, states: k.states } }
			: {}),
		...(kind === 'id' && typeof k.of === 'string' ? { of: k.of } : {}),
		...(INLINE.has(kind) ? { shape: k } : {}),
		...extra
	};
}

/** The Postgres type of a table's single key column, as an FK to it is typed. */
export const keyPg = (spec: CatalogTable | undefined): string => {
	const k = spec?.key;
	if (spec === undefined || k === 'text') return 'text';
	if (k === undefined || k === 'uuid') return 'uuid';
	if (k === 'identity') return 'int8';
	const f = spec.fields[k[0]];
	return f === undefined ? 'text' : fieldInfo(k[0], f).pg;
};

/**
 * The query model of a schema. Pure: a `SchemaSpec` has every reference resolved, so a name here always names a table.
 * Without `collections`, every table is exposed whole.
 */
export function catalogOf(
	schema: CatalogSchema,
	collections: { readonly [collection: string]: CatalogCollection } = Object.fromEntries(
		Object.keys(schema.tables).map((t): [string, CatalogCollection] => [
			t,
			{ read: { fields: 'all' } }
		])
	)
): Catalog {
	const specs = schema.tables;
	const fields = new Map<string, Map<string, FieldInfo>>();
	const one = new Map<string, Map<string, OneRel>>();
	const many = new Map<string, Map<string, ManyRel>>();
	for (const [name, spec] of Object.entries(specs)) {
		const f = new Map<string, FieldInfo>();
		// a declared key is fields of its own; else the key is an `id` column of the declared type
		if (!ReadonlyArray.isArray<CatalogTable['key']>(spec.key))
			f.set('id', { ...fieldInfo('id', { kind: 'id', of: name }), pg: keyPg(spec) });
		if (spec.audit === true)
			for (const s of AUDIT_COLUMNS)
				f.set(
					s,
					fieldInfo(
						s,
						s === 'revision'
							? { kind: 'int' }
							: s.endsWith('_by')
								? { kind: 'text' }
								: { kind: 'instant' },
						s.endsWith('_by') ? { of: 'sys_user' } : {}
					)
				);
		for (const [n, k] of Object.entries(spec.fields))
			if (k.kind !== 'ref') f.set(n, fieldInfo(n, k));
		for (const [n, c] of Object.entries(spec.computed ?? {}))
			f.set(n, fieldInfo(n, { kind: c.kind }, { computed: true }));
		fields.set(name, f);
		one.set(name, new Map());
		many.set(name, new Map());
	}
	for (const [from, spec] of Object.entries(specs))
		for (const [fk, rel] of Object.entries(spec.fields)) {
			if (rel.kind !== 'ref' || rel.to === undefined) continue;
			const own = fields.get(from);
			if (own === undefined) continue;
			const targets = typeof rel.to === 'string' ? [rel.to] : [...rel.to];
			own.set(
				fk,
				targets.length > 1
					? { name: fk, kind: 'ref', column: fk, pg: 'uuid', arms: targets }
					: { ...fieldInfo(fk, { kind: 'id', of: targets[0] }), pg: keyPg(specs[targets[0] ?? '']) }
			);
			if (targets.length > 1)
				for (const t of targets)
					own.set(`${fk}.${t}`, {
						...fieldInfo(`${fk}.${t}`, { kind: 'id', of: t }),
						pg: keyPg(specs[t]),
						column: `${fk}__${t}`
					});
			one.get(from)?.set(fk, { name: fk, targets });
			if (rel.inverse !== undefined)
				for (const t of targets)
					many.get(t)?.set(rel.inverse, {
						name: rel.inverse,
						child: from,
						column: targets.length > 1 ? `${fk}__${t}` : fk
					});
		}
	for (const [from, spec] of Object.entries(specs))
		for (const [name, m] of Object.entries(spec.through ?? {})) {
			const target = specs[m.table]?.fields[m.to]?.to;
			if (typeof target === 'string')
				many.get(from)?.set(name, { name, child: target, column: m.to, through: m });
		}
	const byName = new Map<string, ModelInfo>(
		[...fields].map(([name, f]) => {
			const spec = specs[name];
			const semantic = spec?.search?.semantic;
			return [
				name,
				{
					name,
					...(spec?.audit === true ? { audit: true as const } : {}),
					fields: f,
					one: one.get(name) ?? new Map(),
					many: many.get(name) ?? new Map(),
					key: ReadonlyArray.isArray<CatalogTable['key']>(spec?.key) ? spec.key : ['id'],
					search: spec?.search?.text ?? [],
					indexes: spec?.search?.indexes ?? {},
					...(semantic === undefined
						? {}
						: {
								semantic: {
									model: semantic.model,
									dim: semantic.dim,
									fields: semantic.fields ?? []
								}
							})
				}
			];
		})
	);
	const exposed = new Map<string, CollectionInfo>();
	for (const [name, spec] of Object.entries(collections)) {
		const model = byName.get(name);
		if (model === undefined) continue;
		const f = spec.read.fields;
		const r = spec.read.relations ?? (f === 'all' ? 'all' : []);
		exposed.set(name, {
			name,
			model,
			fields: f === 'all' ? 'all' : new Set(f),
			relations: r === 'all' ? 'all' : new Set(r)
		});
	}
	return { models: byName, collections: exposed };
}

/** Kinds that compare with each other through a `{ field }` operand (`Family` in `decl/where.ts`). */
export function family(f: FieldInfo): string {
	if (['int', 'decimal', 'money', 'sum', 'count', 'number'].includes(f.kind)) return 'num';
	if (['text', 'enum', 'state', 'currency'].includes(f.kind)) return 'text';
	return f.kind === 'id' ? `id:${f.of ?? ''}` : f.kind;
}

/** Quotes an identifier; every name reaching SQL has been checked against the catalog first. */
export const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** The collection a read names; an unknown name is `invalid`. */
export const collectionOf = (
	cat: Catalog,
	name: string
): Effect.Effect<CollectionInfo, StoreError> => {
	const c = cat.collections.get(name);
	return c === undefined
		? Effect.fail(StoreError.of('invalid', 'decode', `unknown collection '${name}'`))
		: Effect.succeed(c);
};

/** Whether a reader may name `field` of collection `c`: the key and audit columns always, else the read exposure. */
export function exposedField(c: CollectionInfo, name: string): boolean {
	if (SYSTEM_COLUMNS.some((column) => column === name)) return true;
	const base = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
	return c.fields === 'all' ? c.model.fields.has(base) : c.fields.has(base);
}
export function exposedRelation(c: CollectionInfo, rel: string): boolean {
	return c.relations === 'all'
		? c.model.one.has(rel) || c.model.many.has(rel)
		: c.relations.has(rel);
}
const HEAVY = new Set(['json', 'custom', 'file']);
/** A scoped reader's default projection: a list leaves out `json`, `custom`, `file` values; a single record keeps them; no polymorphic arm pseudo-fields. */
export function defaultFields(c: CollectionInfo, heavy = false): string[] {
	return [...c.model.fields.values()]
		.filter(
			(f) => !f.name.includes('.') && (heavy || !HEAVY.has(f.kind)) && exposedField(c, f.name)
		)
		.map((f) => f.name);
}
/** An unscoped default row: stored fields and FKs plus the key and audit columns; no seq, roll-up or computed field. */
export function storedFields(m: ModelInfo): string[] {
	return [...m.fields.values()]
		.filter((f) => !f.name.includes('.') && !f.computed && !f.derived)
		.map((f) => f.name);
}
