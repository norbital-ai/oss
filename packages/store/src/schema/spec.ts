// A schema is a value: its tables (fields of std's kind language, a key, opt-in audit columns, uniqueness, checks,
// indexes, computed columns, search), each relation a `ref` field of the table holding it. Every declaration decodes through these
// Schemas once, wherever it comes from (a `schema(…)` literal, Bolt's compiled models, a committed snapshot), and
// `SchemaSpec` checks that every name a relation or an index uses exists.
import { Predicate, Schema } from 'effect';
import * as ReadonlyArray from 'effect/Array';
import type { Kind } from '@norbital-ai/std/kind';

const Bool = Schema.optionalKey(Schema.Literal(true));
const Num = Schema.optionalKey(Schema.Number);
const Str = Schema.optionalKey(Schema.String);
const Strings = Schema.Array(Schema.String);
/** A where literal inside a declaration: an object here, decoded against the table by the where decoder when used. */
export const WhereLiteral = Schema.declare((u: unknown): u is object => Predicate.isObject(u), {
	identifier: 'WhereLiteral'
});
const DatePrecision = Schema.Literals(['year', 'month', 'week', 'day']);
const Precision = Schema.Literals(['year', 'month', 'week', 'day', 'hour', 'minute']);
/** What every kind takes: `was` names the field it renames (a migration hint). */
const common = {
	optional: Bool,
	default: Schema.optionalKey(Schema.Json),
	unique: Bool,
	label: Str,
	help: Str,
	hidden: Bool,
	was: Str,
	storage: Schema.optionalKey(Schema.Literal('int64'))
};

/** One field's kind: std's kind language (`@norbital-ai/std/kind`), `was` naming the field it renames. */
export type FieldSpec = Kind & { readonly storage?: 'int64' };
export type FieldKind = FieldSpec['kind'];
const arm = <K extends string, F extends Schema.Struct.Fields>(kind: K, fields: F) =>
	Schema.Struct({ kind: Schema.Literal(kind), ...common, ...fields });
const Nested = Schema.suspend((): Schema.Codec<FieldSpec> => FieldSpec);
const Fields = Schema.Record(Schema.String, Nested);
const ARMS = [
	arm('text', {
		format: Schema.optionalKey(
			Schema.Literals(['email', 'phone', 'url', 'zone', 'markdown', 'cel', 'team'])
		),
		max: Num,
		many: Bool
	}),
	arm('int', { min: Num, max: Num }),
	arm('number', { min: Num, max: Num }),
	arm('decimal', { scale: Schema.Number, precision: Num, min: Num, max: Num }),
	arm('money', { currency: Str, scale: Num }),
	arm('currency', {}),
	arm('bool', {}),
	arm('duration', {}),
	arm('point', {}),
	arm('date', { precision: Schema.optionalKey(DatePrecision) }),
	arm('instant', { precision: Schema.optionalKey(Precision) }),
	arm('time', { precision: Schema.optionalKey(Schema.Literals(['hour', 'minute'])) }),
	arm('period', { of: Schema.Literal('date'), precision: Schema.optionalKey(DatePrecision) }),
	arm('period', { of: Schema.Literal('instant'), precision: Schema.optionalKey(Precision) }),
	arm('enum', { values: Strings, many: Bool }),
	arm('state', {
		initial: Schema.String,
		states: Schema.Record(
			Schema.String,
			Schema.Struct({
				to: Schema.optionalKey(Strings),
				edit: Schema.optionalKey(Schema.Union([Schema.Literals(['all', 'none']), Strings]))
			})
		)
	}),
	arm('seq', { pattern: Str, per: Schema.optionalKey(Strings) }),
	arm('sum', {
		of: Schema.String,
		where: Schema.optionalKey(WhereLiteral),
		money: Schema.optionalKey(Schema.Struct({ currency: Str }))
	}),
	arm('count', { of: Schema.String, where: Schema.optionalKey(WhereLiteral) }),
	arm('json', { shape: Schema.optionalKey(Nested) }),
	arm('file', { accept: Strings, max: Schema.String, multiple: Bool }),
	arm('vector', { dim: Schema.Number, metric: Schema.Literals(['l2', 'cosine', 'ip']) }),
	arm('custom', { of: Schema.String, many: Bool }),
	arm('ref', {
		to: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
		inverse: Str,
		owned: Bool,
		onDelete: Schema.optionalKey(Schema.Literals(['restrict', 'cascade', 'setNull'])),
		where: Schema.optionalKey(WhereLiteral)
	}),
	arm('id', {
		of: Schema.String,
		where: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
	}),
	arm('list', { of: Nested, min: Num, max: Num, key: Str }),
	arm('object', { fields: Fields, rest: Schema.optionalKey(Nested) }),
	arm('union', { by: Schema.String, arms: Schema.Record(Schema.String, Fields) }),
	arm('union', { of: Schema.Array(Nested) }),
	arm('record', { of: Nested })
] as const;
export const FieldSpec: Schema.Codec<FieldSpec> = Schema.Union(ARMS);

/** The kinds a computed field's expression may produce. */
export const COMPUTED_KINDS = [
	'text',
	'int',
	'decimal',
	'money',
	'bool',
	'date',
	'instant'
] as const;
export type ComputedKind = (typeof COMPUTED_KINDS)[number];
type E = Expr;
/** A computed expression: an operator tree over the table's own fields. */
export type Expr =
	| { readonly field: string }
	| number
	| string
	| boolean
	| { readonly plus: readonly [E, E] }
	| { readonly minus: readonly [E, E] }
	| { readonly times: readonly [E, E] }
	| { readonly div: readonly [E, E] }
	| { readonly round: readonly [E, number] }
	| { readonly concat: readonly E[] }
	| { readonly plusDays: readonly [E, E] }
	| { readonly startOf: readonly [E, 'day' | 'week' | 'month' | 'quarter' | 'year'] }
	| { readonly text: E }
	| { readonly lower: E }
	| { readonly upper: E }
	| { readonly trim: E }
	| { readonly substring: readonly [E, E] | readonly [E, E, E] }
	| { readonly regexReplace: readonly [E, string, string] }
	/** A json field's member as text (`party->>'id'`). */
	| { readonly jsonText: readonly [E, string] }
	/** Number of items in a JSON array column, computed by the database. */
	| { readonly jsonLength: E }
	| { readonly eq: readonly [E, E] }
	| { readonly ne: readonly [E, E] }
	| { readonly gt: readonly [E, E] }
	| { readonly gte: readonly [E, E] }
	| { readonly lt: readonly [E, E] }
	| { readonly lte: readonly [E, E] }
	| { readonly and: readonly E[] }
	| { readonly or: readonly E[] }
	| { readonly not: E }
	| { readonly when: readonly [E, E, E] }
	| { readonly coalesce: readonly E[] };
const X = Schema.suspend((): Schema.Codec<Expr> => ExprSchema);
const Two = Schema.Tuple([X, X]);
const Xs = Schema.Array(X);
export const ExprSchema: Schema.Codec<Expr> = Schema.Union([
	Schema.Struct({ field: Schema.String }),
	Schema.Number,
	Schema.String,
	Schema.Boolean,
	Schema.Struct({ plus: Two }),
	Schema.Struct({ minus: Two }),
	Schema.Struct({ times: Two }),
	Schema.Struct({ div: Two }),
	Schema.Struct({ round: Schema.Tuple([X, Schema.Number]) }),
	Schema.Struct({ concat: Xs }),
	Schema.Struct({ plusDays: Two }),
	Schema.Struct({
		startOf: Schema.Tuple([X, Schema.Literals(['day', 'week', 'month', 'quarter', 'year'])])
	}),
	Schema.Struct({ text: X }),
	Schema.Struct({ lower: X }),
	Schema.Struct({ upper: X }),
	Schema.Struct({ trim: X }),
	Schema.Struct({ substring: Schema.Union([Two, Schema.Tuple([X, X, X])]) }),
	Schema.Struct({ regexReplace: Schema.Tuple([X, Schema.String, Schema.String]) }),
	Schema.Struct({ jsonText: Schema.Tuple([X, Schema.String]) }),
	Schema.Struct({ jsonLength: X }),
	Schema.Struct({ eq: Two }),
	Schema.Struct({ ne: Two }),
	Schema.Struct({ gt: Two }),
	Schema.Struct({ gte: Two }),
	Schema.Struct({ lt: Two }),
	Schema.Struct({ lte: Two }),
	Schema.Struct({ and: Xs }),
	Schema.Struct({ or: Xs }),
	Schema.Struct({ not: X }),
	Schema.Struct({ when: Schema.Tuple([X, X, X]) }),
	Schema.Struct({ coalesce: Xs })
]);

/**
 * A json path index: an expression index on one scalar path (`->>` cast to its kind), or a GIN `jsonb_path_ops` index
 * on the whole value for containment (`@>`) and list predicates.
 */
const PathIndex = Schema.Union([
	Schema.Struct({ field: Schema.String, path: Strings }),
	Schema.Struct({ field: Schema.String, gin: Schema.Literal(true) })
]);
export const TableSpec = Schema.Struct({
	fields: Fields,
	/**
	 * The primary key: these fields (composite or natural), or an `id` column of this type (`identity`: a bigint the
	 * database numbers). Absent: an `id` uuid.
	 */
	key: Schema.optionalKey(
		Schema.Union([
			Schema.Literals(['uuid', 'text', 'identity']),
			Schema.NonEmptyArray(Schema.String)
		])
	),
	/** The audit columns `revision created_at created_by updated_at updated_by`; `revision` is what writes observe. */
	audit: Bool,
	/** Physical schema revision, stamped by current constructors; absence identifies an immutable legacy snapshot. */
	nativeRules: Schema.optionalKey(Schema.Literals([1, 2])),
	/** Historical snapshot metadata: legacy writers expanded referential actions themselves. */
	managedDeletes: Bool,
	/** An `int` field the database numbers (`bigint generated by default as identity`). */
	identity: Str,
	/** A natural key: unique and never null, not deferred (an `on conflict` arbiter). */
	natural: Schema.optionalKey(Strings),
	unique: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({ fields: Strings, where: Schema.optionalKey(WhereLiteral), name: Str })
		)
	),
	index: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Strings]))),
	/** Indexes over fields or typed expressions, optionally unique and partial. */
	indexes: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				on: Schema.Array(
					Schema.Union([
						Schema.String,
						Schema.Struct({ lower: Schema.String }),
						Schema.Struct({ expr: ExprSchema })
					])
				),
				unique: Bool,
				where: Schema.optionalKey(WhereLiteral)
			})
		)
	),
	paths: Schema.optionalKey(Schema.Array(PathIndex)),
	check: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Union([Schema.Struct({ where: WhereLiteral, message: Schema.String }), WhereLiteral])
		)
	),
	noOverlap: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				key: Strings,
				period: Schema.String,
				where: Schema.optionalKey(WhereLiteral),
				name: Str
			})
		)
	),
	computed: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Struct({ kind: Schema.Literals(COMPUTED_KINDS), scale: Num, expr: ExprSchema })
		)
	),
	search: Schema.optionalKey(
		Schema.Struct({
			text: Strings,
			indexes: Schema.optionalKey(
				Schema.Record(
					Schema.String,
					Schema.Struct({
						description: Str,
						dim: Schema.Number,
						metric: Schema.Literals(['l2', 'cosine', 'ip']),
						field: Str,
						input: Schema.optionalKey(Fields),
						candidates: Num,
						rerank: Bool
					})
				)
			),
			semantic: Schema.optionalKey(
				Schema.Struct({ fields: Strings, model: Schema.String, dim: Schema.Number })
			)
		})
	),
	/**
	 * Many-to-many relations: `<name>` reaches `table`'s rows through a join table whose ref `from` points here and
	 * whose ref `to` points at the far side. The join's pair is unique, and indexed both ways.
	 */
	through: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Struct({ table: Schema.String, from: Schema.String, to: Schema.String })
		)
	),
	/** The table this one renames (a migration hint). */
	was: Str
});
export type TableSpec = typeof TableSpec.Type;

/** A ref field: a relation from its table. */
export type RefSpec = Extract<FieldSpec, { readonly kind: 'ref' }>;
const SchemaFields = Schema.Struct({
	tables: Schema.Record(Schema.String, TableSpec),
	/** The zone `{ today }` defaults and date buckets read; UTC when unset. */
	tz: Schema.String,
	/** The currency a `money` field without its own is checked against. */
	currency: Schema.NullOr(Schema.String)
});
type SchemaFields = typeof SchemaFields.Type;

const targetsOf = (r: RefSpec): readonly string[] => (typeof r.to === 'string' ? [r.to] : r.to);
const refsOf = (spec: TableSpec): [string, RefSpec][] =>
	Object.entries(spec.fields).flatMap(([f, k]): [string, RefSpec][] =>
		k.kind === 'ref' ? [[f, k]] : []
	);
/** Declaration references checked against their tables and states: the first fault, or none. */
function dangling(s: SchemaFields): string | undefined {
	for (const [t, spec] of Object.entries(s.tables)) {
		for (const [f, r] of refsOf(spec)) {
			if (r.onDelete === 'setNull' && r.optional !== true)
				return `relation '${t}.${f}': onDelete 'setNull' needs an optional ref`;
			const to = targetsOf(r);
			if (to.length === 0) return `'${t}.${f}' points at no table`;
			for (const target of to)
				if (s.tables[target] === undefined)
					return `'${t}.${f}' points at undeclared table '${target}'`;
		}
		for (const [name, m] of Object.entries(spec.through ?? {})) {
			const join = s.tables[m.table];
			const [from, to] = [join?.fields[m.from], join?.fields[m.to]];
			if (join === undefined) return `'${t}.${name}' goes through undeclared table '${m.table}'`;
			if (from?.kind !== 'ref' || !targetsOf(from).includes(t))
				return `'${t}.${name}': '${m.table}.${m.from}' is no ref to '${t}'`;
			if (to?.kind !== 'ref' || targetsOf(to).length !== 1)
				return `'${t}.${name}': '${m.table}.${m.to}' is no ref to one table`;
		}
		const own = new Set([...Object.keys(spec.fields), ...Object.keys(spec.computed ?? {})]);
		const keyed = ReadonlyArray.isArray<TableSpec['key']>(spec.key) ? spec.key : [];
		for (const f of [...keyed, ...(spec.natural ?? [])])
			if (!own.has(f)) return `'${t}' keys on unknown field '${f}'`;
		const editable = new Set(
			Object.entries(spec.fields)
				.filter(
					([name, kind]) => !name.includes('.') && !['seq', 'sum', 'count'].includes(kind.kind)
				)
				.map(([name]) => name)
		);
		for (const name of Object.keys(spec.through ?? {})) editable.add(name);
		for (const child of Object.values(s.tables))
			for (const [, ref] of refsOf(child))
				if (ref.inverse !== undefined && targetsOf(ref).includes(t)) editable.add(ref.inverse);
		for (const [f, kind] of Object.entries(spec.fields)) {
			if (kind.kind !== 'state') continue;
			if (!Object.hasOwn(kind.states, kind.initial))
				return `'${t}.${f}': initial '${kind.initial}' is not a declared state`;
			for (const [state, rule] of Object.entries(kind.states)) {
				for (const to of rule.to ?? [])
					if (!Object.hasOwn(kind.states, to))
						return `'${t}.${f}': state '${state}' moves to undeclared state '${to}'`;
				if (typeof rule.edit !== 'string')
					for (const field of rule.edit ?? [])
						if (!editable.has(field))
							return `'${t}.${f}': state '${state}' edits unknown or unwritable field or relation '${field}'`;
			}
		}
	}
	return undefined;
}

/** A whole schema: its tables, with every reference between them resolved. */
export const SchemaSpec = SchemaFields.check(
	Schema.makeFilter((s) => dangling(s), { identifier: 'SchemaSpec' })
);
export type SchemaSpec = typeof SchemaSpec.Type;
