// `Store<S>`: the typed face of the store over one schema value. Every call is pure: it answers a `Statement` — the
// SQL, its stable shape key, and the decoder of the rows it answers — and the caller executes it with its own
// connection (Bolt's engine, a host's control store). A statement's rows decode once, by Effect Schema codecs built
// from the declaration (std's kind codecs: Decimal, PlainDate, Instant, periods, points, inline values), and the
// decoded value is checked against that codec's own type side before it is handed back as `Row<S, T, Q>`.
import { Array as EffectArray, Effect, Predicate, Schema } from 'effect';
import { inputSchema, type Kind } from '@norbital-ai/std/kind';
import { Decimal } from '@norbital-ai/std/decimal';
import { encodeWire, type Wired } from '@norbital-ai/std/wire';
import { catalogOf, exposureOf, q, type Catalog } from './catalog.ts';
import {
	aggregate as decodeAggregate,
	read as decodeRead,
	where as decodeWhere
} from './decode.ts';
import { StoreError } from './errors.ts';
import { sha256Hex } from './hash.ts';
import type { ListRead, Pred, SelectIR } from './ir.ts';
import { budgeted, Build, compile, items, OVER, pred, RAW, wire, type Sql } from './read/sql.ts';
import { STORE_LIMITS } from './limits.ts';
import { compileRollup } from './read/rollup.ts';
import { answer } from './read/page.ts';
import { SchemaSpec, type TableSpec } from './schema/spec.ts';
import type {
	AggregateQuery,
	AggregateResult,
	Absent,
	AnySchema,
	BulkPatch,
	ClockColumn,
	ColumnOrder,
	Insert,
	Key,
	JoinOn,
	Many,
	NumericColumn,
	OrderBy,
	Page,
	Patch,
	Refs,
	Row,
	ScalarColumn,
	RollupQuery,
	RollupResult,
	Select,
	Sortable,
	SourceValue,
	TableName,
	Upsert,
	ValueSource,
	Where,
	With
} from './types.ts';
import type { Json } from './values.ts';
import { compileWrite, type WireRow, type WriteIR } from './write/sql.ts';

/** One row as a driver answers it: column → its JSON value. */
export type ResultRow = { readonly [column: string]: Json };
/** A compiled statement; its private type member prevents callers constructing arbitrary SQL statements. */
export type Statement<A> = PreparedStatement<A>;
class PreparedStatement<A> {
	declare private readonly compiled: void;
	readonly sql: Sql;
	/** Native SQL carries every admission guard; no decoded refusal must be interpreted before another write. */
	readonly batchable: boolean;
	/** The statement's shape (its text, which carries no parameter, hashed): a host's prepared-statement key. */
	readonly shape: string;
	readonly decode: (rows: readonly ResultRow[]) => Effect.Effect<A, StoreError>;
	constructor(
		sql: Sql,
		decode: (rows: readonly ResultRow[]) => Effect.Effect<A, StoreError>,
		batchable: boolean
	) {
		this.sql = sql;
		this.shape = sha256Hex(sql.text).slice(0, 32);
		this.decode = decode;
		this.batchable = batchable;
	}
}

// ── declarations ──
type RefTargets<Tables> = {
	readonly [T in keyof Tables]: Tables[T] extends { readonly fields: infer F }
		? {
				readonly fields: {
					readonly [P in keyof F]: F[P] extends { readonly kind: 'ref' }
						? { readonly to: (keyof Tables & string) | readonly (keyof Tables & string)[] }
						: unknown;
				};
			}
		: unknown;
};
/** A table: its fields (std's kind language; relations are `ref` fields), its key, and its constraints and indexes. */
export const table = <const T extends TableSpec>(
	spec: T
): Omit<T, 'nativeRules'> & { readonly nativeRules: 2 } => ({
	...spec,
	nativeRules: 2
});
/**
 * A schema: its tables by name. Each ref names a declared table (a type error otherwise); `tz` is the zone of
 * `{ today }` defaults and date buckets (UTC), `currency` what a `money` field without its own is checked against.
 */
export const schema = <const Tables extends { readonly [name: string]: TableSpec }>(
	tables: Tables & RefTargets<Tables>,
	options: { readonly tz?: string; readonly currency?: string } = {}
): { readonly tables: Tables; readonly tz: string; readonly currency: string | null } => ({
	tables: Object.assign(
		{},
		tables,
		Object.fromEntries(
			Object.entries(tables).map(([name, spec]): [string, TableSpec] => {
				const currentSpec: TableSpec = spec;
				return [name, { ...currentSpec, nativeRules: currentSpec.nativeRules ?? 2 }];
			})
		)
	),
	tz: options.tz ?? 'UTC',
	currency: options.currency ?? null
});

// ── decoders ──
type Codec = Schema.Codec<unknown, unknown>;
const AUDIT: { readonly [column: string]: Kind } = {
	revision: { kind: 'int' },
	created_at: { kind: 'instant' },
	created_by: { kind: 'text', optional: true },
	updated_at: { kind: 'instant' },
	updated_by: { kind: 'text', optional: true }
};
const COMPUTED: { readonly [kind: string]: Kind } = {
	text: { kind: 'text', optional: true },
	int: { kind: 'int', optional: true },
	decimal: { kind: 'decimal', scale: 0, optional: true },
	money: { kind: 'money', optional: true },
	bool: { kind: 'bool', optional: true },
	date: { kind: 'date', optional: true },
	instant: { kind: 'instant', optional: true }
};
/** A column's kind: a declared field, an audit column, or a computed field (null where its inputs are). */
const kindOf = (t: TableSpec, name: string): Kind | undefined => {
	const computed = t.computed?.[name];
	return (
		t.fields[name] ??
		(t.audit === true ? AUDIT[name] : undefined) ??
		(computed === undefined ? undefined : COMPUTED[computed.kind])
	);
};
/** Ref values use their target's actual single key, including natural text and identity keys. */
function fieldCodec(s: SchemaSpec, cat: Catalog, k: Kind): Codec {
	if (k.kind !== 'ref') return inputSchema(k);
	const targetCodec = (name: string): Codec => {
		const target = s.tables[name];
		const key = cat.models.get(name)?.key[0] ?? 'id';
		const kind = target === undefined ? undefined : kindOf(target, key);
		return kind === undefined
			? target?.key === 'identity'
				? Schema.Number
				: Schema.String
			: inputSchema(kind);
	};
	const targets = typeof k.to === 'string' ? [k.to] : k.to;
	const [first] = targets;
	const codec =
		targets.length > 1
			? Schema.Union(
					targets.map((name) =>
						Schema.Struct({ model: Schema.Literal(name), id: targetCodec(name) })
					)
				)
			: targetCodec(first ?? '');
	return k.optional === true ? Schema.NullOr(codec) : codec;
}
/** The fields of one row of `table` as `sel` projects it: its key, its fields, its relations. */
function rowFields(
	s: SchemaSpec,
	cat: Catalog,
	table: string,
	sel: SelectIR
): { [name: string]: Codec } {
	const t = s.tables[table];
	const model = cat.models.get(table);
	const fields: { [name: string]: Codec } = {};
	if (t === undefined || model === undefined) return fields;
	for (const k of model.key) {
		const declared = kindOf(t, k);
		fields[k] =
			declared !== undefined
				? fieldCodec(s, cat, declared)
				: t.key === 'identity'
					? Schema.Number
					: Schema.String;
	}
	const names =
		sel.fields ??
		[...model.fields.values()]
			.filter((f) => !f.name.includes('.') && f.computed !== true && f.derived !== true)
			.map((f) => f.name);
	for (const name of names) {
		const k = kindOf(t, name);
		if (fields[name] === undefined && k !== undefined) fields[name] = fieldCodec(s, cat, k);
	}
	for (const [rel, r] of Object.entries(sel.relations))
		fields[rel] = r.many
			? Schema.Array(Schema.Struct(rowFields(s, cat, r.target, r.select)))
			: r.targets !== undefined
				? Schema.NullOr(
						Schema.Union(
							r.targets.map((target) =>
								Schema.Struct({
									...rowFields(s, cat, target, r.targetSelects?.[target] ?? r.select),
									model: Schema.Literal(target)
								})
							)
						)
					)
				: Schema.NullOr(Schema.Struct(rowFields(s, cat, r.target, r.select)));
	return fields;
}
/**
 * The decoder of a value as `A`: `codec` decodes it, and the decoded value is `A` only if `codec`'s type side holds of
 * it — the guard is the declaration's own Schema, so the type a caller gets is the one the declaration proves.
 */
function decoder<A>(codec: Codec, what: string): (value: unknown) => Effect.Effect<A, StoreError> {
	const holds = Schema.is(Schema.toType(codec));
	const isA = (u: unknown): u is A => holds(u);
	return Effect.fnUntraced(function* (value: unknown) {
		const decoded = yield* Schema.decodeUnknownEffect(codec)(value).pipe(
			Effect.mapError((e) =>
				StoreError.of('internal', 'decode', `a ${what} row is malformed: ${e.message}`)
			)
		);
		if (!isA(decoded))
			return yield* Effect.fail(StoreError.of('internal', 'decode', `a ${what} row is malformed`));
		return decoded;
	});
}
const statement = <A>(sql: Sql, decode: Statement<A>['decode'], batchable = true): Statement<A> =>
	new PreparedStatement(sql, decode, batchable);
const column = (
	rows: readonly ResultRow[],
	name: string
): Effect.Effect<readonly Json[], StoreError> =>
	Effect.forEach(rows, (row) => {
		const value = row[name];
		return value !== null && typeof value === 'object' && !EffectArray.isArray<typeof value>(value)
			? Effect.succeed(value)
			: Effect.fail(StoreError.of('internal', 'decode', `a result row lacks its '${name}' object`));
	});
/** The input boundary admits decoded decimals; encoded results admit JSON alone. Both reject non-finite numbers. */
const isValue = (value: unknown, decoded: boolean): boolean =>
	value === undefined || value instanceof Decimal
		? decoded
		: value === null ||
			typeof value === 'string' ||
			typeof value === 'boolean' ||
			(typeof value === 'number' && Number.isFinite(value)) ||
			(EffectArray.isArray(value) && value.every((child) => isValue(child, decoded))) ||
			(Predicate.isObject(value) && Object.values(value).every((child) => isValue(child, decoded)));
const isJson = (value: unknown): value is Json => isValue(value, false);
const isWired = (value: unknown): value is Wired => isValue(value, true);
const isChange = (v: unknown): v is { readonly [key: string]: unknown } =>
	Predicate.isObject(v) &&
	Object.keys(v).length === 1 &&
	('$patch' in v || '$append' in v || '$remove' in v);
const literalEntries = (value: object): readonly (readonly [string, unknown])[] => {
	const fields: Readonly<Record<string, unknown>> = { ...value };
	return Object.entries(fields);
};
const invalid = (message: string) => Effect.fail(StoreError.of('invalid', 'decode', message));
/** A merge admits absent members, while each supplied leaf keeps its declared nullability and codec. */
function patchCodec(k: Kind): Codec {
	if (k.kind === 'json' && k.shape !== undefined) return patchCodec(k.shape);
	if (k.kind === 'record') return Schema.Record(Schema.String, patchCodec(k.of));
	if (k.kind !== 'object') return inputSchema(k);
	const fields = Object.fromEntries(
		Object.entries(k.fields).map(([name, child]): [string, Codec] => {
			const codec = patchCodec(child);
			return [name, Schema.optionalKey(child.optional === true ? Schema.NullOr(codec) : codec)];
		})
	);
	const object = Schema.Struct(fields);
	return k.rest === undefined
		? object
		: Schema.StructWithRest(object, [
				Schema.Record(
					Schema.String.check(Schema.makeFilter((name) => !Object.hasOwn(k.fields, name))),
					patchCodec(k.rest)
				)
			]);
}

// ── query literals ──
type Paged =
	| { readonly limit: number; readonly after?: string; readonly all?: never }
	| { readonly all: true; readonly limit?: never; readonly after?: never };
/** `L` with every key `Shape` lacks made `never`: a literal naming one is refused where it is written. */
type Only<L, Shape> = L & { readonly [K in Exclude<keyof L, keyof Shape>]: never };
type Target<S extends AnySchema, T, R> = R extends keyof Refs<S, T>
	? Refs<S, T>[R] extends { to: infer To }
		? To extends readonly (infer A)[]
			? A
			: To
		: never
	: R extends keyof Many<S, T>
		? Many<S, T>[R]
		: never;
type Arm<S extends AnySchema, T, A, Allowed extends string = 'select' | 'with'> = A extends true
	? true
	: {
			readonly [K in keyof A]: K extends 'select'
				? Only<A[K], Select<S, T>>
				: K extends 'with'
					? Only<A[K], With<S, T>> & Arms<S, T, A[K]>
					: K extends Allowed
						? A[K]
						: never;
		};
/** Each `with` arm held to its own target: an arm's `select` names that table's fields, its `with` its relations. */
type Arms<S extends AnySchema, T, W> = {
	readonly [R in keyof W]: W[R] extends true
		? true
		: R extends keyof Refs<S, T>
			? {
					readonly [K in keyof W[R]]: K extends Target<S, T, R>
						? Arm<S, K, W[R][K]>
						: K extends 'select'
							? Only<W[R][K], Select<S, Target<S, T, R>>>
							: K extends 'with'
								? Only<W[R][K], With<S, Target<S, T, R>>> & Arms<S, Target<S, T, R>, W[R][K]>
								: never;
				}
			: Arm<S, Target<S, T, R>, W[R], 'select' | 'with' | 'where' | 'orderBy' | 'limit' | 'all'>;
};
type Projection<S extends AnySchema, T, Sel, W> = {
	readonly select?: Only<Sel, Select<S, T>>;
	readonly with?: Only<W, With<S, T>> & Arms<S, T, W>;
};
type Target2<S extends AnySchema, T> =
	| { readonly key: NoInfer<Key<S, T>>; readonly where?: never }
	| { readonly where: NoInfer<Where<S, T>>; readonly key?: never };

/** The store over `s`: its catalog built once, every call a statement. */
export function store<const S extends SchemaSpec & AnySchema>(s: S) {
	const cat = catalogOf(s);
	const NONE: SelectIR = { fields: null, relations: {} };
	const keyOf = (table: string): readonly string[] => cat.models.get(table)?.key ?? ['id'];
	/** A key object → `key = …` on each of its fields. */
	const keyed = (table: string, key: object): Effect.Effect<Pred, StoreError> => {
		const held: Readonly<Record<string, unknown>> = { ...key };
		const entries = Object.entries(held);
		const names = keyOf(table);
		if (entries.length !== names.length || !entries.every(([k]) => names.includes(k)))
			return invalid(`'${table}' is keyed by ${names.join(', ')}`);
		return decodeWhere(
			cat,
			table,
			Object.fromEntries(
				entries.map(([name, value]): [string, { readonly eq: unknown }] => [name, { eq: value }])
			)
		);
	};
	const target = (table: string, t: { readonly key?: object; readonly where?: object }) =>
		t.key !== undefined ? keyed(table, t.key) : decodeWhere(cat, table, t.where ?? {});
	/** A row's values as the wire carries them, each validated by its kind first; an inline change as it is. */
	const wired = (
		table: string,
		row: object,
		changes = false
	): Effect.Effect<WireRow, StoreError> => {
		const t = s.tables[table];
		const held: Readonly<Record<string, unknown>> = { ...row };
		return Effect.map(
			Effect.forEach(Object.entries(held), ([name, value]) =>
				Effect.gen(function* () {
					const k: Kind | undefined =
						t?.fields[name] ??
						(name === 'id' && !EffectArray.isArray<TableSpec['key']>(t?.key)
							? t?.key === 'identity'
								? { kind: 'int' }
								: { kind: 'text' }
							: undefined);
					if (k === undefined) return yield* invalid(`'${table}' has no field '${name}'`);
					const change = isChange(value) ? Object.entries(value)[0] : undefined;
					let codec: Codec = fieldCodec(s, cat, k);
					let input: unknown = value;
					if (change !== undefined) {
						if (!changes)
							return yield* invalid(`'${table}.${name}': atomic changes require update`);
						const [op, payload] = change;
						const shape = k.kind === 'json' ? k.shape : k;
						if (
							op === '$patch' &&
							(shape?.kind === 'object' || shape?.kind === 'record') &&
							Predicate.isObject(payload)
						)
							codec = patchCodec(shape);
						else if (
							op === '$patch' &&
							k.kind === 'json' &&
							k.shape === undefined &&
							Predicate.isObject(payload)
						)
							codec = Schema.Record(Schema.String, Schema.Json);
						else if ((op === '$append' || op === '$remove') && shape?.kind === 'list')
							codec = Schema.Array(inputSchema(shape.of));
						else return yield* invalid(`'${table}.${name}' does not take ${op}`);
						input = payload;
					}
					if (!isWired(input))
						return yield* invalid(`'${table}.${name}' does not encode as a wire value`);
					const wire = yield* Schema.decodeUnknownEffect(codec, { onExcessProperty: 'error' })(
						encodeWire(input)
					).pipe(
						Effect.flatMap((v) => Schema.encodeEffect(codec)(v)),
						Effect.mapError((e) =>
							StoreError.of('invalid', 'decode', `'${table}.${name}': ${e.message}`)
						)
					);
					if (!isJson(wire)) return yield* invalid(`'${table}.${name}' does not encode as JSON`);
					const entry: readonly [string, Json] = [
						name,
						change === undefined ? wire : { [change[0]]: wire }
					];
					return entry;
				})
			),
			(entries) => Object.fromEntries(entries)
		);
	};
	/** Decode the private unknown boundary without recursively expanding the public row's schema-derived type. */
	const wireList = (table: string, input: unknown) =>
		Effect.forEach(EffectArray.isArray(input) ? input : [input], (row) =>
			Predicate.isObject(row) ? wired(table, row) : invalid(`'${table}' rows must be objects`)
		);

	const rows = <A>(table: string, sel: SelectIR) =>
		decoder<A>(Schema.Array(Schema.Struct(rowFields(s, cat, table, sel))), table);
	/** A `select` and `with` as the projection a write answers its rows by. */
	const projection = (table: string, p: { readonly select?: object; readonly with?: object }) =>
		p.select === undefined && p.with === undefined
			? Effect.succeed(NONE)
			: Effect.map(decodeRead(cat, table, { ...p, all: true }), (ir) =>
					ir.kind === 'read' ? ir.select : NONE
				);
	/** A read compiled, its answer the page its rows make. */
	const paged = <A>(ir: ListRead) =>
		Effect.map(compile(cat, ir), (compiled) => {
			const decode = rows<A>(ir.model, ir.select);
			return statement(compiled.sql, (answered) =>
				Effect.gen(function* () {
					const page = yield* answer(ir, compiled, yield* column(answered, 'j'));
					const listed =
						Predicate.isObject(page) && EffectArray.isArray(page['rows']) ? page['rows'] : [];
					const next =
						Predicate.isObject(page) && typeof page['next'] === 'string' ? page['next'] : null;
					return { rows: yield* decode(listed), next };
				})
			);
		});
	const listRead = (table: string, literal: object) =>
		Effect.flatMap(decodeRead(cat, table, { ...literal }), (ir) =>
			ir.kind === 'read' ? Effect.succeed(ir) : invalid(`'${table}' is read as a list`)
		);
	/** A write compiled; its one answer row is `{ matched, j }`, and an observed revision that moved is `stale`. */
	const written = <A>(
		w: WriteIR,
		actor: string | undefined,
		decode: (j: Json) => Effect.Effect<A, StoreError>
	) =>
		Effect.flatMap(
			Schema.decodeUnknownEffect(SchemaSpec)(s).pipe(
				Effect.mapError((error) => StoreError.of('schemaInvalid', 'decode', error.message))
			),
			() =>
				Effect.map(compileWrite(cat, w, { actor }), (c) =>
					statement(
						c.sql,
						(answered) =>
							Effect.gen(function* () {
								const [row] = answered;
								const refused = row?.['refused'];
								if (refused !== undefined && refused !== null) {
									const reason = typeof refused === 'number' ? c.refusals[refused] : undefined;
									return yield* Effect.fail(
										reason === undefined
											? StoreError.of(
													'internal',
													'decode',
													'a write returned an unknown state refusal'
												)
											: StoreError.of(reason.code, 'admission', reason.message)
									);
								}
								const j = row?.['j'] ?? [];
								const count = EffectArray.isArray<typeof j>(j) ? j.length : 0;
								if (c.observed && Number(row?.['matched'] ?? 0) > count)
									return yield* Effect.fail(
										StoreError.of(
											'stale',
											'commit',
											`a '${w.table}' row changed since the revision its writer read`
										)
									);
								return yield* decode(j);
							}),
						!c.observed && c.refusals.length === 0
					)
				)
		);
	type T = TableName<S>;
	/**
	 * One page of `table`: `where` filters, `select` names fields (the key always comes), `with` adds relations (each
	 * a correlated subquery bounded by its own order and limit: one statement at any depth), `orderBy` sorts (the key
	 * ends every order, so cursors are exact), and a `limit` (with the `next` a page gave back) or `all` bounds it.
	 */
	function read<
		Tb extends T,
		const Sel extends Select<S, NoInfer<Tb>> = {},
		const W extends With<S, NoInfer<Tb>> = {}
	>(
		table: Tb,
		query: Projection<S, NoInfer<Tb>, Sel, W> & {
			readonly where?: NoInfer<Where<S, Tb>>;
			readonly orderBy?: NoInfer<OrderBy<S, Tb>>;
			/** One row per group, chosen by `orderBy` then primary key. Group keys lead the result order. */
			readonly firstPer?: readonly NoInfer<Sortable<S, Tb>>[];
		} & Paged
	): Effect.Effect<Statement<Page<Row<S, Tb, { select: Sel; with: W }>>>, StoreError> {
		return Effect.fn('Store.read')(() =>
			Effect.flatMap(listRead(table, query), (ir) =>
				paged<readonly Row<S, Tb, { select: Sel; with: W }>[]>(ir)
			)
		)();
	}
	/** The row with this key, or `null`. */
	function get<
		Tb extends T,
		const Sel extends Select<S, NoInfer<Tb>> = {},
		const W extends With<S, NoInfer<Tb>> = {}
	>(
		table: Tb,
		key: NoInfer<Key<S, Tb>>,
		query: Projection<S, NoInfer<Tb>, Sel, W> = {}
	): Effect.Effect<Statement<Row<S, Tb, { select: Sel; with: W }> | null>, StoreError> {
		return Effect.fn('Store.get')(function* () {
			const ir = yield* listRead(table, { ...query, limit: 1 });
			const page = yield* paged<readonly Row<S, Tb, { select: Sel; with: W }>[]>({
				...ir,
				where: yield* keyed(table, key)
			});
			return statement(page.sql, (answered) =>
				Effect.map(page.decode(answered), (p) => p.rows[0] ?? null)
			);
		})();
	}
	/** Counts, sums, averages and extremes of the rows `where` finds. */
	function related<From extends T, To extends T, const Sel extends Select<S, To> = {}>(
		from: From,
		query: {
			readonly to: To;
			readonly on: NoInfer<JoinOn<S, From, To>>;
			readonly where?: NoInfer<Where<S, From>>;
			readonly select?: Only<Sel, Select<S, To>>;
			readonly limit: number;
		}
	): Effect.Effect<Statement<readonly Row<S, To, { select: Sel }>[]>, StoreError> {
		return Effect.gen(function* () {
			const source = yield* exposureOf(cat, from),
				target = yield* exposureOf(cat, query.to);
			const ir = yield* listRead(query.to, { select: query.select, limit: query.limit });
			const b = new Build(cat),
				a = b.alias(),
				t = b.alias();
			const links = yield* Effect.forEach(literalEntries(query.on), ([left, right]) => {
				const l = source.model.fields.get(left),
					r = typeof right === 'string' ? target.model.fields.get(right) : undefined;
				return l === undefined || r === undefined || l.pg !== r.pg || l.many || r.many
					? invalid('a join links compatible declared scalar fields')
					: Effect.succeed(`${a}.${q(l.column)} = ${t}.${q(r.column)}`);
			});
			if (links.length === 0) return yield* invalid('a related read declares its join fields');
			const condition =
				query.where === undefined
					? 'true'
					: yield* pred(b, source, a, yield* decodeWhere(cat, from, query.where), RAW);
			const selected = yield* items(b, target, t, ir.select, RAW);
			const text = `SELECT to_jsonb(r) AS j FROM (SELECT ${selected.join(', ')} FROM ${b.from(from)} ${a} JOIN ${b.from(query.to)} ${t} ON ${links.join(' AND ')} WHERE ${condition} LIMIT ${b.bind(query.limit, 'int4')}) r`;
			const sql = yield* b.sql(budgeted(text, STORE_LIMITS.pageBytes));
			const decode = rows<readonly Row<S, To, { select: Sel }>[]>(query.to, ir.select);
			return statement(sql, (answered) =>
				Effect.flatMap(column(answered, 'j'), (values) => {
					const last = values.at(-1);
					if (Predicate.isObject(last) && last[OVER] === true)
						return Effect.fail(
							StoreError.of('tooLarge', 'deliver', 'the related read exceeds its byte budget')
						);
					return decode(values);
				})
			);
		});
	}
	function union<const Q extends readonly ValueSource<S>[]>(
		sources: Q & {
			readonly [K in keyof Q]: Only<Q[K], { table: unknown; field: unknown; where?: unknown }>;
		}
	): Effect.Effect<Statement<readonly SourceValue<S, Q[number]>[]>, StoreError> {
		return Effect.gen(function* () {
			const choices: Q = sources;
			const b = new Build(cat),
				codecs: Codec[] = [];
			const parts = yield* Effect.forEach(choices, (source) =>
				Effect.gen(function* () {
					const c = yield* exposureOf(cat, source.table),
						a = b.alias();
					const f = c.model.fields.get(source.field),
						spec = s.tables[source.table];
					const kind = spec === undefined ? undefined : kindOf(spec, source.field);
					if (f === undefined || kind === undefined)
						return yield* invalid(`'${source.table}.${source.field}' is not a declared field`);
					codecs.push(fieldCodec(s, cat, kind));
					const condition =
						source.where === undefined
							? 'true'
							: yield* pred(b, c, a, yield* decodeWhere(cat, source.table, source.where), RAW);
					return `SELECT ${wire(f, `${a}.${q(f.column)}`, a)} AS j FROM ${b.from(source.table)} ${a} WHERE ${condition}`;
				})
			);
			const values = `${parts.length === 0 ? 'SELECT NULL::jsonb AS j WHERE false' : parts.join(' UNION ')} LIMIT ${STORE_LIMITS.page.all + 1}`;
			const sql = yield* b.sql(budgeted(values, STORE_LIMITS.page.allBytes));
			const decode = decoder<readonly SourceValue<S, Q[number]>[]>(
				Schema.Array(codecs.length === 0 ? Schema.Never : Schema.Union(codecs)),
				'union'
			);
			return statement(sql, (answered) => {
				if (
					answered.length > STORE_LIMITS.page.all ||
					answered.some((row) => Predicate.isObject(row['j']) && row['j'][OVER] === true)
				)
					return Effect.fail(
						StoreError.of('tooLarge', 'deliver', 'the union exceeds the all-read budget')
					);
				return decode(answered.map((row) => row['j'] ?? null));
			});
		});
	}
	/** Counts, sums, averages and extremes of the rows `where` finds. */
	function rollup<
		Tb extends T,
		const Q extends RollupQuery<S, NoInfer<Tb>, readonly Sortable<S, NoInfer<Tb>>[]>
	>(
		table: Tb,
		query: Only<Q, RollupQuery<S, Tb, readonly Sortable<S, Tb>[]>>
	): Effect.Effect<Statement<readonly RollupResult<S, Tb, Q>[]>, StoreError> {
		return Effect.gen(function* () {
			const sql = yield* compileRollup(cat, {
				...query,
				table,
				where: query.where === undefined ? undefined : yield* decodeWhere(cat, table, query.where)
			});
			const spec = s.tables[table];
			const fields: Record<string, Codec> = Object.fromEntries(
				query.by.map((name): [string, Codec] => {
					const kind = spec === undefined ? undefined : kindOf(spec, name);
					return [name, kind === undefined ? Schema.Never : fieldCodec(s, cat, kind)];
				})
			);
			const decode = decoder<readonly RollupResult<S, Tb, Q>[]>(
				Schema.Array(
					Schema.Struct({
						key: Schema.Struct(fields),
						at:
							query.stepMillis !== undefined || query.carry !== undefined
								? Schema.Number
								: Schema.Null,
						peak: Schema.Number,
						total: Schema.Number,
						latest: Schema.Number
					})
				),
				'measurement rollup'
			);
			return statement(sql, (answered) => {
				if (
					answered.length > STORE_LIMITS.page.all ||
					answered.some((row) => Predicate.isObject(row['j']) && row['j'][OVER] === true)
				)
					return Effect.fail(
						StoreError.of('tooLarge', 'deliver', 'the rollup exceeds the all-read budget')
					);
				return decode(answered.map((row) => row['j'] ?? null));
			});
		});
	}
	/** Counts, sums, averages and extremes of the rows `where` finds. */
	function aggregate<Tb extends T, const Q extends AggregateQuery<S, NoInfer<Tb>>>(
		table: Tb,
		query: Only<Q, AggregateQuery<S, Tb>>
	): Effect.Effect<Statement<AggregateResult<S, Tb, Q>>, StoreError> {
		return Effect.fn('Store.aggregate')(function* () {
			const ir = yield* decodeAggregate(cat, table, { ...query });
			const compiled = yield* compile(cat, ir);
			const fields: { [name: string]: Codec } = {};
			const codecOf = (path: string): Codec => {
				const steps = path.split('.');
				let target: string = table;
				for (const name of steps.slice(0, -1))
					target = cat.models.get(target)?.one.get(name)?.targets[0] ?? '';
				const t = s.tables[target];
				const kind = t === undefined ? undefined : kindOf(t, steps.at(-1) ?? path);
				return kind === undefined ? Schema.NullOr(Schema.String) : Schema.NullOr(inputSchema(kind));
			};
			if (ir.count === true) fields['count'] = Schema.Number;
			for (const fn of ['sum', 'avg', 'min', 'max'] as const) {
				const names = ir[fn];
				if (names !== undefined)
					fields[fn] = Schema.Struct(
						Object.fromEntries(
							names.map((name): [string, Codec] => [
								name,
								fn === 'sum' || fn === 'avg'
									? inputSchema({ kind: 'decimal', scale: 0, optional: true })
									: codecOf(name)
							])
						)
					);
			}
			if (ir.by.length > 0)
				fields['key'] = Schema.Struct(
					Object.fromEntries(
						ir.by.map((bucket): [string, Codec] => [
							bucket.field,
							bucket.unit === undefined
								? codecOf(bucket.field)
								: inputSchema({ kind: 'date', optional: true })
						])
					)
				);
			const row = Schema.Struct(fields);
			const decode = decoder<AggregateResult<S, Tb, Q>>(
				ir.by.length === 0
					? row
					: Schema.Struct({
							rows: Schema.Array(row),
							next: Schema.NullOr(Schema.String)
						}),
				table
			);
			return statement(compiled.sql, (answered) =>
				Effect.flatMap(column(answered, 'j'), (values) =>
					Effect.flatMap(answer(ir, compiled, values), decode)
				)
			);
		})();
	}
	/** Rows created, as one statement; each answered as `select` projects it. */
	function create<Tb extends T, const Sel extends Select<S, Tb> = {}>(
		table: Tb,
		list: NoInfer<Insert<S, Tb>> | readonly NoInfer<Insert<S, Tb>>[],
		options: { readonly select?: Only<Sel, Select<S, Tb>>; readonly actor?: string } = {}
	): Effect.Effect<Statement<readonly Row<S, Tb, { select: Sel }>[]>, StoreError> {
		return Effect.fn('Store.create')(function* () {
			const wire = yield* wireList(table, list);
			const select = yield* projection(table, options);
			return yield* written(
				{ kind: 'create', table, rows: wire, select },
				options.actor,
				rows<readonly Row<S, Tb, { select: Sel }>[]>(table, select)
			);
		})();
	}
	/**
	 * The rows `key` or `where` finds, set (an inline value may change in place: `$patch`, `$append`, `$remove`).
	 * `now` sets declared instant fields to the database clock. `observed` is the revision the writer read: if the
	 * row moved since, nothing is written and it fails `stale`.
	 */
	function update<Tb extends T, const Sel extends Select<S, Tb> = {}>(
		table: Tb,
		change: Target2<S, Tb> & {
			readonly set: NoInfer<Patch<S, Tb>>;
			readonly now?: readonly NoInfer<ClockColumn<S, Tb>>[];
			readonly observed?: number;
			readonly select?: Only<Sel, Select<S, Tb>>;
			readonly actor?: string;
		}
	): Effect.Effect<Statement<readonly Row<S, Tb, { select: Sel }>[]>, StoreError> {
		return Effect.fn('Store.update')(function* () {
			const select = yield* projection(table, change);
			return yield* written(
				{
					kind: 'update',
					table,
					where: yield* target(table, change),
					set: yield* wired(table, change.set, true),
					now: change.now,
					observed: change.observed,
					select
				},
				change.actor,
				rows<readonly Row<S, Tb, { select: Sel }>[]>(table, select)
			);
		})();
	}
	/** The rows `key` or `where` finds, deleted (an `observed` revision as for `update`); their keys answered. */
	function updateMany<Tb extends T, const Sel extends Select<S, Tb> = {}>(
		table: Tb,
		changes: readonly {
			readonly key: NoInfer<Key<S, Tb>>;
			readonly match?: NoInfer<BulkPatch<S, Tb>>;
			readonly set: NoInfer<BulkPatch<S, Tb>>;
		}[],
		options: { readonly select?: Only<Sel, Select<S, Tb>>; readonly actor?: string } = {}
	): Effect.Effect<Statement<readonly Row<S, Tb, { select: Sel }>[]>, StoreError> {
		return Effect.gen(function* () {
			const select = yield* projection(table, options);
			const values = yield* Effect.forEach(changes, (change) =>
				Effect.gen(function* () {
					yield* keyed(table, change.key);
					return {
						key: yield* wired(table, change.key),
						match: yield* wired(table, change.match ?? {}),
						set: yield* wired(table, change.set)
					};
				})
			);
			return yield* written(
				{ kind: 'updateMany', table, rows: values, select },
				options.actor,
				rows<readonly Row<S, Tb, { select: Sel }>[]>(table, select)
			);
		});
	}
	/** The rows `key` or `where` finds, deleted (an `observed` revision as for `update`); their keys answered. */
	function remove<Tb extends T>(
		table: Tb,
		t: Target2<S, Tb> & {
			readonly observed?: number;
			readonly keep?: { readonly orderBy: NoInfer<ColumnOrder<S, Tb>>; readonly limit: number };
			readonly absent?: NoInfer<Absent<S, Tb>>;
		}
	): Effect.Effect<Statement<readonly Key<S, Tb>[]>, StoreError> {
		return Effect.fn('Store.delete')(function* () {
			const keys = Schema.Array(
				Schema.Struct(rowFields(s, cat, table, { fields: [], relations: {} }))
			);
			const kept =
				t.keep === undefined
					? undefined
					: yield* listRead(table, { orderBy: t.keep.orderBy, limit: t.keep.limit });
			const absent =
				t.absent === undefined
					? undefined
					: {
							table: t.absent.table,
							on: t.absent.on,
							where:
								t.absent.where === undefined
									? undefined
									: yield* decodeWhere(cat, t.absent.table, t.absent.where)
						};
			return yield* written(
				{
					kind: 'delete',
					table,
					where: yield* target(table, t),
					observed: t.observed,
					keep:
						kept === undefined ? undefined : { order: kept.order ?? [], limit: t.keep?.limit ?? 0 },
					absent
				},
				undefined,
				decoder<readonly Key<S, Tb>[]>(keys, table)
			);
		})();
	}
	/**
	 * Rows created; one that conflicts on `on` (the key, unless named) updates the row there with `update` (every
	 * field sent, unless named; `keep` leaves it) — and only where `when` holds of that row. `now` sets instant fields
	 * only on conflict to the database clock; insert values and omitted defaults stay as declared. A stateful table
	 * permits only `update: 'keep'`: use create/update in a transaction for a mutating conflict, so state rules remain atomic.
	 */
	function upsert<Tb extends T, const Sel extends Select<S, Tb> = {}>(
		table: Tb,
		list: NoInfer<Upsert<S, Tb>> | readonly NoInfer<Upsert<S, Tb>>[],
		options: {
			readonly on?: readonly (keyof NoInfer<Upsert<S, Tb>> & string)[];
			readonly update?: readonly (keyof NoInfer<Upsert<S, Tb>> & string)[] | 'keep';
			/** Combine the stored numeric field with its incoming value inside ON CONFLICT. */
			readonly merge?: Partial<Readonly<Record<NoInfer<NumericColumn<S, Tb>>, 'add' | 'max'>>>;
			/** Native group budgets for one candidate. The executor serializes writers of each group. */
			readonly limits?: readonly {
				readonly by: readonly NoInfer<ScalarColumn<S, Tb>>[];
				readonly sum: NoInfer<NumericColumn<S, Tb>>;
				readonly max: number;
			}[];
			readonly now?: readonly NoInfer<ClockColumn<S, Tb>>[];
			readonly when?: NoInfer<Where<S, Tb>>;
			readonly select?: Only<Sel, Select<S, Tb>>;
			readonly actor?: string;
		} = {}
	): Effect.Effect<Statement<readonly Row<S, Tb, { select: Sel }>[]>, StoreError> {
		return Effect.fn('Store.upsert')(function* () {
			const wire = yield* wireList(table, list);
			const select = yield* projection(table, options);
			const on = options.on ?? keyOf(table);
			const update =
				options.update ??
				[...new Set(wire.flatMap((r) => Object.keys(r)))].filter((f) => !on.includes(f));
			const when =
				options.when === undefined ? undefined : yield* decodeWhere(cat, table, options.when);
			return yield* written(
				{
					kind: 'upsert',
					table,
					rows: wire,
					on,
					update,
					merge: options.merge,
					limits: options.limits,
					now: options.now,
					when,
					select
				},
				options.actor,
				rows<readonly Row<S, Tb, { select: Sel }>[]>(table, select)
			);
		})();
	}
	return {
		schema: s,
		catalog: cat,
		read,
		get,
		related,
		union,
		rollup,
		aggregate,
		create,
		update,
		updateMany,
		delete: remove,
		upsert
	};
}
/** The store over one schema: what `store(s)` answers. */
export type Store<S extends SchemaSpec & AnySchema> = ReturnType<typeof store<S>>;
