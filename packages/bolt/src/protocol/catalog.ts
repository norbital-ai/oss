// What the query compiler knows of a workspace (A4): per model, its columns by kind and its relations; per collection,
// its read exposure. Built once per manifest from pure data. Shared by the engine and the browser client, so it lives
// outside `engine/` (L-BOLT-1000).
//
// Physical naming, shared with the schema area (§5.2): a model's table is its name, a field's column is its name, a
// relationship's FK column is its field name, and each arm of an exclusive arc is its own column `<fk>__<arm>`.
// A `period` is a `daterange` (`[from, to+1)`, X-11) or `tstzrange`; a `point` is a Postgres `point` (x = lng, y = lat); a
// list field is `text[]`; the lexical search document is the generated `bolt_search` tsvector ('simple').
import type { TableSpec } from '../decl/model.ts';
import type { EngineManifest } from '../engine/manifest.ts';
import { BoltError } from './errors.ts';
import { SYSTEM } from '../system/index.ts';

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
	/** Declared enum values or state names (rule 11a membership); the model an id points at. */
	values?: readonly string[];
	of?: string;
	/** An exclusive arc: the arm models; its value is a `RecordRef`. */
	arms?: readonly string[];
	computed?: true;
	derived?: true;
};
export type OneRel = { name: string; targets: readonly string[] };
type ManyRel = { name: string; child: string; column: string };
export type ModelInfo = {
	name: string;
	fields: ReadonlyMap<string, FieldInfo>;
	one: ReadonlyMap<string, OneRel>;
	many: ReadonlyMap<string, ManyRel>;
	search: readonly string[];
	/** `search.semantic` (rule 16): the platform embedding `bolt_embedding`, the model class that fills it, and the width both must agree on. */
	semantic?: { model: string; dim: number; fields: readonly string[] };
};
export type CollectionInfo = {
	name: string;
	model: ModelInfo;
	fields: 'all' | ReadonlySet<string>;
	relations: 'all' | ReadonlySet<string>;
	similarity: { readonly [name: string]: { candidates?: number } };
};
export type Catalog = {
	models: ReadonlyMap<string, ModelInfo>;
	collections: ReadonlyMap<string, CollectionInfo>;
};

export const SEARCH_COLUMN = 'bolt_search';
/** The platform embedding `search.semantic` keeps (rule 16), and the probe name that reads it (L-BOLT-123). */
export const EMBEDDING_COLUMN = 'bolt_embedding',
	SEMANTIC = '$semantic';
export const SYSTEM_COLUMNS = [
	'id',
	'revision',
	'created_at',
	'created_by',
	'updated_at',
	'updated_by'
] as const;
/** A field kind literal as the catalog reads it: a model's `FieldKind` and the browser exposure's alike. */
type KindSpec = {
	readonly kind: string;
	readonly many?: boolean;
	readonly format?: string;
	readonly of?: unknown;
	readonly metric?: 'l2' | 'cosine' | 'ip';
	readonly dim?: number;
	readonly pattern?: string;
	readonly values?: readonly string[];
	readonly states?: { readonly [s: string]: unknown };
};
/** What the catalog reads of a model: its fields and computed fields, a system table's key, and its search. */
type CatalogModel = {
	readonly fields: { readonly [name: string]: KindSpec };
	readonly computed?: { readonly [name: string]: { readonly kind: string } } | undefined;
	readonly table?: { readonly primary: TableSpec['primary'] } | undefined;
	readonly search?:
		| {
				readonly text?: readonly string[] | undefined;
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
/** A relationship keyed `<model>.<fk>`: its target model (several: an exclusive arc) and the inverse it names on them. */
type CatalogRelationship = {
	readonly to: string | readonly string[];
	readonly inverse?: string | undefined;
};
/** What the catalog reads of a collection: its read exposure and similarity searches. */
type CatalogCollection = {
	readonly read: {
		readonly fields: 'all' | readonly string[];
		readonly relations?: 'all' | readonly string[] | undefined;
	};
	readonly similarity?: CollectionInfo['similarity'] | undefined;
};

/** The Postgres type of a model's `id`: a workspace row's uuid, a system table's own key (`table.primary`). */
const idPg = (spec: CatalogModel | undefined): string => {
	const p = spec?.table?.primary;
	return spec === undefined
		? 'text'
		: p === undefined
			? 'uuid'
			: p === 'identity'
				? 'int8'
				: typeof p === 'object'
					? 'text'
					: p;
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

function field(name: string, k: KindSpec, extra: Partial<FieldInfo> = {}): FieldInfo {
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
		...(kind === 'id' && typeof k.of === 'string' ? { of: k.of } : {}),
		...extra
	};
}

/** The query model of a workspace and the built-in layer (`src/system`), whose models and collections are declared alike. */
export function catalog(m: EngineManifest): Catalog {
	return catalogOf(m.models, m.relationships, m.collections);
}
/** The query model of these models, relationships and collections, with the built-in layer's beside them. */
export function catalogOf(
	models: { readonly [model: string]: CatalogModel },
	relationships: { readonly [key: string]: CatalogRelationship },
	collections: { readonly [collection: string]: CatalogCollection }
): Catalog {
	const specs: { readonly [model: string]: CatalogModel } = { ...SYSTEM.models, ...models };
	const fields = new Map<string, Map<string, FieldInfo>>();
	const one = new Map<string, Map<string, OneRel>>();
	const many = new Map<string, Map<string, ManyRel>>();
	for (const [name, spec] of Object.entries(specs)) {
		const f = new Map<string, FieldInfo>();
		// a workspace row carries every system column (`created_by`/`updated_by` hold an actor id, not always a uuid); a
		// system row its key alone (`table`), its `revision`, `created_at` and the like being its own fields
		if (spec.table === undefined)
			for (const s of SYSTEM_COLUMNS)
				f.set(
					s,
					field(
						s,
						s === 'id'
							? { kind: 'id', of: name }
							: s === 'revision'
								? { kind: 'int' }
								: s.endsWith('_by')
									? { kind: 'text' }
									: { kind: 'instant' },
						s.endsWith('_by') ? { of: 'sys_user' } : {}
					)
				);
		else if (typeof spec.table.primary !== 'object')
			f.set('id', { ...field('id', { kind: 'id', of: name }), pg: idPg(spec) });
		for (const [n, k] of Object.entries(spec.fields)) f.set(n, field(n, k));
		for (const [n, c] of Object.entries(spec.computed ?? {}))
			f.set(n, field(n, { kind: c.kind }, { computed: true }));
		fields.set(name, f);
		one.set(name, new Map());
		many.set(name, new Map());
	}
	for (const [key, rel] of Object.entries({ ...SYSTEM.relationships, ...relationships })) {
		const [from, fk] = key.split('.') as [string, string];
		const targets = typeof rel.to === 'string' ? [rel.to] : [...rel.to];
		if (!fields.has(from))
			throw BoltError.make('invalid', 'decode', `relationship '${key}' is on an unknown model`);
		fields
			.get(from)!
			.set(
				fk,
				targets.length > 1
					? { name: fk, kind: 'ref', column: fk, pg: 'uuid', arms: targets }
					: { ...field(fk, { kind: 'id', of: targets[0]! }), pg: idPg(specs[targets[0]!]) }
			); // hook:schema — as ddl `fkType`
		for (const t of targets)
			if (targets.length > 1)
				fields.get(from)!.set(`${fk}.${t}`, {
					...field(`${fk}.${t}`, { kind: 'id', of: t }),
					column: `${fk}__${t}`
				});
		one.get(from)!.set(fk, { name: fk, targets });
		if (rel.inverse !== undefined)
			for (const t of targets)
				many.get(t)?.set(rel.inverse, {
					name: rel.inverse,
					child: from,
					column: targets.length > 1 ? `${fk}__${t}` : fk
				});
	}
	const byName = new Map<string, ModelInfo>(
		[...fields].map(([name, f]) => [
			name,
			{
				name,
				fields: f,
				one: one.get(name)!,
				many: many.get(name)!,
				search: specs[name]?.search?.text ?? [],
				...(specs[name]?.search?.semantic === undefined
					? {}
					: {
							semantic: {
								model: specs[name]!.search!.semantic!.model,
								dim: specs[name]!.search!.semantic!.dim,
								fields: specs[name]!.search!.semantic!.fields ?? []
							}
						})
			}
		])
	);
	const exposed = new Map<string, CollectionInfo>();
	const expose = (name: string, spec: CatalogCollection) => {
		const model = byName.get(name);
		if (model === undefined)
			throw BoltError.make('invalid', 'decode', `collection '${name}' has no model`);
		const f = spec.read.fields;
		const r = spec.read.relations ?? (f === 'all' ? 'all' : []);
		exposed.set(name, {
			name,
			model,
			fields: f === 'all' ? 'all' : new Set(f),
			relations: r === 'all' ? 'all' : new Set(r),
			similarity: spec.similarity ?? {}
		});
	};
	for (const [name, spec] of Object.entries({ ...SYSTEM.collections, ...collections }))
		expose(name, spec);
	return { models: byName, collections: exposed };
}

/** Kinds that compare with each other through a `{ field }` operand (`Family` in `decl/where.ts`). */
export function family(f: FieldInfo): string {
	if (['int', 'decimal', 'money', 'sum', 'count', 'number'].includes(f.kind)) return 'num';
	if (['text', 'enum', 'state', 'currency'].includes(f.kind)) return 'text';
	return f.kind === 'id' ? `id:${f.of ?? ''}` : f.kind;
}

/** What the browser knows of the caller's collections (the shell boot's `catalog`): readable fields as declared, the
 * one-relations it may use (with their inverse names) and the many-relations it exposes. `bolt.decode` checks against it. */
export type BrowserCatalog = {
	readonly [c: string]: {
		fields: { readonly [f: string]: KindSpec };
		relations?: { readonly [fk: string]: { targets: readonly string[]; inverse?: string } };
		many?: readonly string[];
		/** `search.text`'s fields and whether `search.semantic` is declared: where `$search` and `$similar` decode. */
		search?: readonly string[];
		semantic?: true;
	};
};
export function browserCatalog(b: BrowserCatalog): Catalog {
	const exposed = Object.entries(b);
	return catalogOf(
		Object.fromEntries(
			exposed.map(([c, x]): [string, CatalogModel] => [
				c,
				{
					fields: x.fields,
					search:
						x.search === undefined
							? undefined
							: {
									text: x.search,
									semantic: x.semantic === true ? { fields: [], model: '', dim: 0 } : undefined
								}
				}
			])
		),
		Object.fromEntries(
			exposed.flatMap(([c, x]) =>
				Object.entries(x.relations ?? {}).map(([fk, r]): [string, CatalogRelationship] => [
					`${c}.${fk}`,
					{ to: r.targets, inverse: r.inverse }
				])
			)
		),
		Object.fromEntries(
			exposed.map(([c, x]): [string, CatalogCollection] => [
				c,
				{
					read: { fields: 'all', relations: [...Object.keys(x.relations ?? {}), ...(x.many ?? [])] }
				}
			])
		)
	);
}

/** Quotes an identifier; every name reaching SQL has been checked against the catalog first. */
export const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export function collectionOf(cat: Catalog, name: string): CollectionInfo {
	const c = cat.collections.get(name);
	if (c === undefined) throw BoltError.make('invalid', 'decode', `unknown collection '${name}'`);
	return c;
}

/** Whether a caller may name `field` of collection `c` (rule 10): system columns always, else the read exposure. */
export function exposedField(c: CollectionInfo, name: string): boolean {
	if ((SYSTEM_COLUMNS as readonly string[]).includes(name)) return true;
	const base = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
	return c.fields === 'all' ? c.model.fields.has(base) : c.fields.has(base);
}
export function exposedRelation(c: CollectionInfo, rel: string): boolean {
	return c.relations === 'all'
		? c.model.one.has(rel) || c.model.many.has(rel)
		: c.relations.has(rel);
}
const HEAVY = new Set(['json', 'custom', 'file']);
/** A caller's default projection (X-33: a list leaves out `json`, `custom`, `file` values; a single record keeps them; no arc arm pseudo-fields). */
export function defaultFields(c: CollectionInfo, heavy = false): string[] {
	return [...c.model.fields.values()]
		.filter(
			(f) => !f.name.includes('.') && (heavy || !HEAVY.has(f.kind)) && exposedField(c, f.name)
		)
		.map((f) => f.name);
}
/** A transform's stored row (rule 10): stored fields and FKs plus system columns; no seq, roll-up or computed field. */
export function storedFields(m: ModelInfo): string[] {
	return [...m.fields.values()]
		.filter((f) => !f.name.includes('.') && !f.computed && !f.derived)
		.map((f) => f.name);
}
