// Writes → one statement each: a `WITH` chain whose data-modifying pieces return their rows, then one select that
// projects them exactly as a read would (the same columns in wire form, the same relations). Many rows of one write
// are one chain; a revision the writer observed, or a condition, decides in the database which rows change.
import { Effect } from 'effect';
import type { Json } from '../values.ts';
import type { Order, Pred, SelectIR } from '../ir.ts';
import { StoreError } from '../errors.ts';
import { collectionOf, q, type Catalog, type CollectionInfo, type FieldInfo } from '../catalog.ts';
import { Build, items, pred, RAW, type Sql } from '../read/sql.ts';
import { cells } from '../read/values.ts';
import { nullRowSql } from './row.ts';

type Fx<A> = Effect.Effect<A, StoreError>;
/** A row's values in wire form, by field (a polymorphic ref as `{ collection, id }`, a decimal as `{ $dec }`). */
export type WireRow = { readonly [field: string]: Json };
/**
 * An atomic change of an inline value, sent as the field's value: `$patch` merges an object at its paths (absent
 * paths are created), `$append` adds a list's items, `$remove` drops the items equal to any it names.
 */
export type InlineChange =
	| { readonly $patch: { readonly [key: string]: Json } }
	| { readonly $append: readonly Json[] }
	| { readonly $remove: readonly Json[] };
/** What a write sets: each field to a value, or an inline change. */
export type WireSet = { readonly [field: string]: Json };

export type WriteIR =
	| {
			readonly kind: 'updateMany';
			readonly table: string;
			readonly rows: readonly {
				readonly key: WireRow;
				readonly match: WireRow;
				readonly set: WireSet;
			}[];
			readonly select: SelectIR;
	  }
	| {
			readonly kind: 'create';
			readonly table: string;
			readonly rows: readonly WireRow[];
			readonly select: SelectIR;
	  }
	| {
			readonly kind: 'update';
			readonly table: string;
			readonly where: Pred;
			readonly set: WireSet;
			readonly now?: readonly string[] | undefined;
			readonly observed?: number | undefined;
			readonly select: SelectIR;
	  }
	| {
			readonly kind: 'delete';
			readonly table: string;
			readonly where: Pred;
			readonly observed?: number | undefined;
			readonly keep?: { readonly order: Order; readonly limit: number } | undefined;
			readonly absent?:
				| {
						readonly table: string;
						readonly on: Readonly<Record<string, string | undefined>>;
						readonly where?: Pred | undefined;
				  }
				| undefined;
	  }
	| {
			readonly kind: 'upsert';
			readonly table: string;
			readonly rows: readonly WireRow[];
			/** The unique field set a conflict is found on. */
			readonly on: readonly string[];
			/** The fields an existing row takes from the new one, or `keep` it as it is. */
			readonly update: readonly string[] | 'keep';
			readonly merge?: Readonly<Record<string, 'add' | 'max' | undefined>> | undefined;
			readonly limits?:
				| readonly { readonly by: readonly string[]; readonly sum: string; readonly max: number }[]
				| undefined;
			/** Declared instant fields set to the database clock on conflict only. */
			readonly now?: readonly string[] | undefined;
			/** Only an existing row this holds for is updated (the conflict's own row). */
			readonly when?: Pred | undefined;
			readonly select: SelectIR;
	  };
/** Who writes, for an audited table's `created_by` / `updated_by`. */
export type WriteOptions = { readonly actor?: string | undefined };
/**
 * A compiled write: its statement answers one row `{ matched, j }`, `j` the written rows (a delete's keys) as a json
 * array and `matched` the rows its condition found before any revision check — more than were written is `stale`.
 */
export type CompiledWrite = {
	readonly sql: Sql;
	readonly observed: boolean;
	/** A non-null `refused` result indexes the admission failure; every mutation was gated off. */
	readonly refusals: readonly {
		readonly code: 'invalidInput' | 'forbidden';
		readonly message: string;
	}[];
};

const invalid = (message: string) => Effect.fail(StoreError.of('invalid', 'decode', message));
const isChange = (v: Json): v is InlineChange =>
	v !== null &&
	typeof v === 'object' &&
	!Array.isArray(v) &&
	Object.keys(v).length === 1 &&
	('$patch' in v || '$append' in v || '$remove' in v);
const isObject = (v: Json): v is { readonly [key: string]: Json } =>
	v !== null && typeof v === 'object' && !Array.isArray(v);

/** A field a write may set: stored, not computed or derived; a table's key and audit columns are the store's. */
const writable = (c: CollectionInfo, name: string): Fx<FieldInfo> => {
	const f = c.model.fields.get(name);
	return f === undefined || f.computed === true || f.derived === true || name.includes('.')
		? invalid(`'${c.name}' has no writable field '${name}'`)
		: audited(c) &&
			  ['revision', 'created_at', 'created_by', 'updated_at', 'updated_by'].includes(name)
			? invalid(`'${name}' is written by the store`)
			: Effect.succeed(f);
};
/** One row's columns: each field's cells (a polymorphic ref spreads over its arm columns). */
const columnsOf = (c: CollectionInfo, row: WireRow): Fx<[string, Json][]> =>
	Effect.map(
		Effect.forEach(Object.entries(row), ([name, v]) =>
			name === 'id' && c.model.fields.get('id') !== undefined
				? Effect.succeed<[string, Json][]>([['id', v]])
				: Effect.map(writable(c, name), (f) => cells(f.column, v, f))
		),
		(xs) => xs.flat()
	);
const audited = (c: CollectionInfo) => c.model.audit === true;
/** Clock assignment is separate from literal row data and cannot target keys, computed or managed audit fields. */
const clockFields = (c: CollectionInfo, names: readonly string[]): Fx<readonly FieldInfo[]> =>
	Effect.forEach([...new Set(names)], (name) => {
		const f = c.model.fields.get(name);
		return f === undefined ||
			f.kind !== 'instant' ||
			f.many === true ||
			f.computed === true ||
			f.derived === true ||
			c.model.key.includes(name) ||
			name.includes('.') ||
			(audited(c) &&
				['revision', 'created_at', 'created_by', 'updated_at', 'updated_by'].includes(name))
			? invalid(`'${c.name}.${name}' is not a declared writable instant field`)
			: Effect.succeed(f);
	});

const nullRow = (c: CollectionInfo): string =>
	nullRowSql(
		c.model.name,
		Array.from(c.model.fields.values(), (field) => field.column)
	);
/** Required JSON admits JSON null; jsonb_populate_record otherwise turns that value into SQL NULL. */
const incomingValue = (f: FieldInfo | undefined, column: string) => {
	const value = `v.${q(column)}`;
	return f?.kind === 'json' && f.shape?.optional !== true
		? `coalesce(${value}, 'null'::jsonb)`
		: value;
};

/** Rows of one column set, as `jsonb_populate_recordset` reads them; the key `id` is minted where absent. */
const insertPiece = (
	b: Build,
	c: CollectionInfo,
	cols: readonly string[],
	rows: readonly { readonly [column: string]: Json }[],
	options: WriteOptions
) => {
	const minted = c.model.fields.get('id')?.pg === 'uuid';
	const values = rows.map((r) => Object.fromEntries(cols.map((k) => [k, r[k] ?? null])));
	const names = [...cols, ...(minted && !cols.includes('id') ? ['id'] : [])];
	const actor =
		audited(c) && options.actor !== undefined
			? ['created_by', 'updated_by'].filter((k) => !names.includes(k))
			: [];
	const select = [
		...names.map((k) =>
			k === 'id' && minted
				? `coalesce(v."id", gen_random_uuid())`
				: incomingValue(c.model.fields.get(k), k)
		),
		...actor.map(() => b.bind(options.actor ?? null, 'text'))
	];
	return {
		columns: [...names, ...actor],
		source: `SELECT ${select.join(', ')} FROM jsonb_populate_recordset(${nullRow(c)}, ${b.bind(values, 'jsonb')}) v`
	};
};
/** The written rows' projection: the read's own select list over the returned rows, as one json array. */
const projected = Effect.fnUntraced(function* (
	b: Build,
	c: CollectionInfo,
	source: string,
	select: SelectIR
) {
	const a = b.alias();
	const list = yield* items(b, c, a, select, RAW, true);
	return `coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT ${list.join(', ')} FROM ${source} ${a}) r), '[]'::jsonb)`;
});
/** `path` set in `json`, creating every object on the way that is absent. */
function setPath(json: string, path: readonly string[], value: string, b: Build): string {
	let out = json;
	for (let i = 1; i < path.length; i++) {
		const at = path.slice(0, i);
		out = `jsonb_set(${out}, ${b.bind(at, 'text[]')}, coalesce(nullif(${out} #> ${b.bind(at, 'text[]')}, 'null'::jsonb), '{}'::jsonb), true)`;
	}
	return `jsonb_set(${out}, ${b.bind(path, 'text[]')}, ${value}, true)`;
}
const leaves = (
	o: { readonly [key: string]: Json },
	at: readonly string[] = []
): [string[], Json][] =>
	Object.entries(o).flatMap(([k, v]) =>
		isObject(v) && Object.keys(v).length > 0 ? leaves(v, [...at, k]) : [[[...at, k], v]]
	);
/** One assignment of an update: a value, or an inline change applied to the column as it is. */
const assignedValue = (b: Build, f: FieldInfo, column: string, v: Json): Fx<string> => {
	const C = `a.${q(column)}`;
	if (!isChange(v)) return Effect.succeed(incomingValue(f, column));
	if (f.pg !== 'jsonb') return invalid(`'${f.name}' is no inline value; set it whole`);
	if ('$patch' in v)
		return Effect.succeed(
			`${leaves(v.$patch).reduce(
				(json, [path, x]) => setPath(json, path, b.bind(JSON.stringify(x), 'jsonb'), b),
				`coalesce(nullif(${C}, 'null'::jsonb), '{}'::jsonb)`
			)}`
		);
	if ('$append' in v)
		return Effect.succeed(
			`coalesce(${C}, '[]'::jsonb) || ${b.bind(JSON.stringify(v.$append), 'jsonb')}`
		);
	return Effect.succeed(
		`(SELECT coalesce(jsonb_agg(e ORDER BY n), '[]'::jsonb) FROM jsonb_array_elements(coalesce(${C}, '[]'::jsonb)) WITH ORDINALITY x(e, n) WHERE NOT e IN (SELECT jsonb_array_elements(${b.bind(JSON.stringify(v.$remove), 'jsonb')})))`
	);
};

/** A write as one statement over the schema's catalog. */
export const compileWrite = Effect.fn('Store.compileWrite')(function* (
	cat: Catalog,
	w: WriteIR,
	options: WriteOptions = {}
) {
	const c = yield* collectionOf(cat, w.table);
	const b = new Build(cat);
	const T = b.from(c.model.name);
	const key = c.model.key;
	const clocks =
		w.kind === 'update' || w.kind === 'upsert' ? yield* clockFields(c, w.now ?? []) : [];
	const states = [...c.model.fields.values()].filter((field) => field.kind === 'state');
	const refusals: CompiledWrite['refusals'][number][] = [];
	for (const field of states)
		if (field.state === undefined)
			return yield* invalid(`'${c.name}.${field.name}' lacks its state declaration`);
	const done = (text: string, observed: boolean): Fx<CompiledWrite> =>
		Effect.map(b.sql(text), (sql) => ({ sql, observed, refusals }));
	if (w.kind === 'updateMany') {
		if (states.length > 0)
			return yield* invalid(`stateful '${c.name}' uses guarded update operations in a transaction`);
		if (w.rows.length === 0) return yield* done(`SELECT 0 AS matched, '[]'::jsonb AS j`, false);
		const names = [...new Set(w.rows.flatMap((row) => Object.keys(row.set)))];
		const fields = yield* Effect.forEach(names, (name) =>
			Effect.gen(function* () {
				const field = yield* writable(c, name);
				if (
					key.includes(name) ||
					field.many ||
					![
						'int',
						'number',
						'decimal',
						'money',
						'text',
						'bool',
						'date',
						'instant',
						'enum',
						'time'
					].includes(field.kind)
				)
					return yield* invalid(`'${c.name}.${name}' is not a mutable scalar field`);
				return field;
			})
		);
		if (fields.length === 0) return yield* invalid(`an update of '${c.name}' sets something`);
		const ids = new Set<string>();
		const values = yield* Effect.forEach(w.rows, (row) =>
			Effect.gen(function* () {
				const id = JSON.stringify(key.map((name) => row.key[name]));
				if (ids.has(id)) return yield* invalid(`a set-based update names each key once`);
				ids.add(id);
				for (const [name, value] of Object.entries(row.match)) {
					const field = yield* writable(c, name);
					if (field.many || field.pg === 'jsonb' || isChange(value))
						return yield* invalid(`'${c.name}.${name}' is not a scalar fence`);
				}
				return {
					key: Object.fromEntries(yield* columnsOf(c, row.key)),
					match: Object.fromEntries(yield* columnsOf(c, row.match)),
					set: Object.fromEntries(yield* columnsOf(c, row.set))
				};
			})
		);
		const input = b.bind(values, 'jsonb');
		const sets = fields.map(
			(field) =>
				`${q(field.column)} = CASE WHEN v.data->'set' ? ${b.bind(field.column, 'text')} THEN (v.s).${q(field.column)} ELSE a.${q(field.column)} END`
		);
		if (audited(c))
			sets.push(
				`revision = a.revision + 1`,
				'updated_at = now()',
				...(options.actor === undefined ? [] : [`updated_by = ${b.bind(options.actor, 'text')}`])
			);
		return yield* done(
			`WITH v AS (
			SELECT data, jsonb_populate_record(${nullRow(c)}, data->'key') AS k,
			jsonb_populate_record(${nullRow(c)}, data->'match') AS m,
			jsonb_populate_record(${nullRow(c)}, data->'set') AS s
			FROM jsonb_array_elements(${input}) AS input(data)
		), w AS (UPDATE ${T} a SET ${sets.join(', ')} FROM v
			WHERE ${key.map((name) => `a.${q(name)} = (v.k).${q(name)}`).join(' AND ')}
			AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v.data->'match') AS f(name) WHERE to_jsonb(a)->f.name IS DISTINCT FROM to_jsonb(v.m)->f.name)
			RETURNING a.*)
			SELECT 0 AS matched, ${yield* projected(b, c, 'w', w.select)} AS j`,
			false
		);
	}
	if (w.kind === 'create' || w.kind === 'upsert') {
		if (w.rows.length === 0) return yield* done(`SELECT 0 AS matched, '[]'::jsonb AS j`, false);
		if (w.kind === 'upsert' && states.length > 0 && (w.update !== 'keep' || clocks.length > 0))
			return yield* Effect.fail(
				StoreError.of(
					'invalidInput',
					'admission',
					`an upsert of stateful '${c.name}' must use update: 'keep'; use create or update in a transaction for state transitions and edit locks`
				)
			);
		if (w.kind === 'upsert' && w.update === 'keep' && clocks.length > 0)
			return yield* invalid(`an upsert with update: 'keep' cannot assign the database clock`);
		const merged: { readonly field: FieldInfo; readonly mode: 'add' | 'max' }[] = [];
		if (w.kind === 'upsert')
			for (const [name, mode] of Object.entries(w.merge ?? {})) {
				if (mode === undefined) continue;
				const field = yield* writable(c, name);
				if (
					w.update === 'keep' ||
					key.includes(name) ||
					!['int', 'number', 'decimal', 'money'].includes(field.kind) ||
					(mode !== 'add' && mode !== 'max')
				)
					return yield* invalid(`'${c.name}.${name}' cannot use this numeric conflict merge`);
				if (w.rows.some((row) => row[name] === undefined || row[name] === null))
					return yield* invalid(
						`a conflict merge requires an incoming '${name}' value in every row`
					);
				merged.push({ field, mode });
			}
		for (const row of w.rows)
			for (const field of states)
				if (row[field.name] !== undefined && row[field.name] !== field.state?.initial)
					return yield* Effect.fail(
						StoreError.of(
							'invalidInput',
							'admission',
							`a new '${c.name}' row starts with '${field.name}' = '${field.state?.initial}'`
						)
					);
		// rows group by their column set: a column a row leaves out takes its default, never null
		const rows = yield* Effect.forEach(w.rows, (r) =>
			Effect.map(columnsOf(c, r), (cs) => Object.fromEntries(cs))
		);
		const groups = [
			...Map.groupBy(rows, (r) => Object.keys(r).sort().join('\u0000')).values()
		].flatMap((group) =>
			Object.keys(group[0] ?? {}).length === 0 && c.model.fields.get('id')?.pg !== 'uuid'
				? group.map((row) => [row])
				: [group]
		);
		const capacity: string[] = [];
		if (w.kind === 'upsert' && w.limits !== undefined && w.limits.length > 0) {
			if (
				w.rows.length !== 1 ||
				w.update === 'keep' ||
				merged.length > 0 ||
				w.on.length !== key.length ||
				!key.every((name) => w.on.includes(name))
			)
				return yield* invalid(
					'group budgets require one primary-key candidate and replacement conflict updates'
				);
			for (const limit of w.limits) {
				const field = yield* writable(c, limit.sum),
					existing = b.alias();
				if (
					!['int', 'number', 'decimal', 'money'].includes(field.kind) ||
					!w.update.includes(limit.sum) ||
					!Number.isFinite(limit.max) ||
					limit.max < 0 ||
					limit.by.length === 0 ||
					limit.by.length > 4
				)
					return yield* invalid(
						'a group budget bounds an incoming numeric field over one to four scalar group keys'
					);
				const group = yield* Effect.forEach(limit.by, (name) =>
					Effect.gen(function* () {
						const f = yield* writable(c, name);
						if (f.many || f.pg === 'jsonb' || w.rows[0]?.[name] === undefined)
							return yield* invalid(
								'a group budget requires each scalar group value in the candidate'
							);
						return `${existing}.${q(f.column)} IS NOT DISTINCT FROM v.${q(f.column)}`;
					})
				);
				if (w.rows[0]?.[limit.sum] === undefined || w.rows[0]?.[limit.sum] === null)
					return yield* invalid('a group budget requires its incoming numeric value');
				const own = key
					.map((name) => `${existing}.${q(name)} IS NOT DISTINCT FROM v.${q(name)}`)
					.join(' AND ');
				capacity.push(
					`(SELECT coalesce(sum(${existing}.${q(field.column)}), 0) FROM ${T} ${existing} WHERE ${group.join(' AND ')} AND NOT (${own})) + v.${q(field.column)} <= ${b.bind(limit.max, 'numeric')}`
				);
			}
		}
		const pieces: string[] = [];
		for (const [i, group] of groups.entries()) {
			const cols = Object.keys(group[0] ?? {}).sort();
			const piece =
				cols.length === 0 &&
				c.model.fields.get('id')?.pg !== 'uuid' &&
				!(audited(c) && options.actor !== undefined)
					? { columns: [], source: 'DEFAULT VALUES' }
					: insertPiece(b, c, cols, group, options);
			let conflict = '';
			if (w.kind === 'upsert') {
				const on = (yield* Effect.forEach(w.on, (f) => writable(c, f))).flatMap((f) =>
					f.arms === undefined ? [f.column] : f.arms.map((arm) => `${f.column}__${arm}`)
				);
				const sets =
					w.update === 'keep'
						? []
						: (yield* Effect.forEach(w.update, (f) => writable(c, f)))
								.flatMap((f) =>
									f.arms === undefined ? [f.column] : f.arms.map((arm) => `${f.column}__${arm}`)
								)
								.filter(
									(col) =>
										piece.columns.includes(col) &&
										!clocks.some((f) => f.column === col) &&
										!merged.some(({ field }) => field.column === col)
								)
								.map((col) => `${q(col)} = excluded.${q(col)}`);
				sets.push(...clocks.map((f) => `${q(f.column)} = now()`));
				sets.push(
					...merged.map(({ field, mode }) => {
						const current = `${T}.${q(field.column)}`,
							incoming = `excluded.${q(field.column)}`;
						return `${q(field.column)} = ${mode === 'add' ? `${current} + ${incoming}` : `greatest(${current}, ${incoming})`}`;
					})
				);
				if (sets.length === 0) conflict = ` ON CONFLICT (${on.map(q).join(', ')}) DO NOTHING`;
				else {
					const audit = audited(c)
						? [
								`revision = ${T}.revision + 1`,
								'updated_at = now()',
								...(options.actor === undefined
									? []
									: [`updated_by = ${b.bind(options.actor, 'text')}`])
							]
						: [];
					const when = w.when === undefined ? '' : ` WHERE ${yield* pred(b, c, T, w.when, RAW)}`;
					conflict = ` ON CONFLICT (${on.map(q).join(', ')}) DO UPDATE SET ${[...sets, ...audit].join(', ')}${when}`;
				}
			}
			pieces.push(
				`w${i} AS (INSERT INTO ${T}${piece.columns.length === 0 ? '' : ` (${piece.columns.map(q).join(', ')})`} ${piece.source}${capacity.length === 0 ? '' : ` WHERE ${capacity.map((condition) => `(${condition})`).join(' AND ')}`}${conflict} RETURNING *)`
			);
		}
		const all = groups.map((_, i) => `SELECT * FROM w${i}`).join(' UNION ALL ');
		return yield* done(
			`WITH ${pieces.join(',\n')}\nSELECT 0 AS matched, ${yield* projected(b, c, `(${all})`, w.select)} AS j`,
			false
		);
	}
	const a = 'a';
	const filter = (alias: string) =>
		Effect.gen(function* () {
			let result = yield* pred(b, c, alias, w.where, RAW);
			if (w.kind === 'delete' && w.absent !== undefined) {
				const target = yield* collectionOf(cat, w.absent.table),
					other = b.alias();
				const links = yield* Effect.forEach(Object.entries(w.absent.on), ([left, right]) => {
					const l = c.model.fields.get(left),
						r = right === undefined ? undefined : target.model.fields.get(right);
					return l === undefined || r === undefined || l.pg !== r.pg || l.many || r.many
						? invalid('an absence condition links compatible declared scalar fields')
						: Effect.succeed(`${alias}.${q(l.column)} = ${other}.${q(r.column)}`);
				});
				if (links.length === 0)
					return yield* invalid('an absence condition declares its join fields');
				const where =
					w.absent.where === undefined
						? 'true'
						: yield* pred(b, target, other, w.absent.where, RAW);
				result = `(${result}) AND NOT EXISTS (SELECT 1 FROM ${b.from(target.model.name)} ${other} WHERE ${links.join(' AND ')} AND (${where}))`;
			}
			return result;
		});
	let condition = yield* filter(a);
	if (w.kind === 'delete' && w.keep !== undefined) {
		const kept = b.alias();
		const order = yield* Effect.forEach(w.keep.order, ({ field, dir }) => {
			const info = c.model.fields.get(field);
			return info === undefined ||
				info.many ||
				![
					'text',
					'enum',
					'int',
					'number',
					'decimal',
					'money',
					'date',
					'instant',
					'time',
					'seq'
				].includes(info.kind)
				? invalid('retention orders by declared scalar fields')
				: Effect.succeed(`${kept}.${q(info.column)} ${dir === 'desc' ? 'DESC' : 'ASC'}`);
		});
		const keys = key.map((name) => `${kept}.${q(name)}`);
		condition = `(${condition}) AND (${key.map((name) => `${a}.${q(name)}`).join(', ')}) NOT IN (SELECT ${keys.join(', ')} FROM ${T} ${kept} WHERE ${yield* filter(kept)} ORDER BY ${[...order, ...keys].join(', ')} LIMIT ${b.bind(w.keep.limit, 'int4')})`;
	}
	const seen = `seen AS (SELECT count(*) AS n FROM ${T} ${a} WHERE ${condition})`;
	const revision =
		w.observed === undefined
			? ''
			: audited(c)
				? w.kind === 'update' && states.length > 0
					? ''
					: ` AND ${a}.revision = ${b.bind(w.observed, 'int8')}`
				: yield* invalid(`'${c.name}' keeps no revision to observe`);
	if (w.kind === 'delete')
		return yield* done(
			`WITH ${seen}, w AS (DELETE FROM ${T} ${a} WHERE ${condition}${revision} RETURNING ${key.map((k) => `${a}.${q(k)}`).join(', ')})
SELECT (SELECT n FROM seen) AS matched, coalesce((SELECT jsonb_agg(to_jsonb(w)) FROM w), '[]'::jsonb) AS j`,
			w.observed !== undefined
		);
	const entries = Object.entries(w.set);
	if (entries.length === 0 && clocks.length === 0)
		return yield* invalid(`an update of '${c.name}' sets something`);
	const plain: { [column: string]: Json } = {};
	const sets: string[] = [];
	const changes = new Map<string, string[]>();
	for (const field of clocks) {
		if (Object.hasOwn(w.set, field.name))
			return yield* invalid(
				`'${c.name}.${field.name}' cannot take both a value and the database clock`
			);
		sets.push(`${q(field.column)} = now()`);
		changes.set(field.name, [`a.${q(field.column)} IS DISTINCT FROM now()`]);
	}
	for (const [name, v] of entries) {
		const f = yield* writable(c, name);
		if (key.includes(name))
			return yield* invalid(`'${name}' is the key of '${c.name}'; it is not updated`);
		for (const [column, cell] of isChange(v) ? [[f.column, v] as const] : cells(f.column, v, f)) {
			if (!isChange(cell)) plain[column] = cell;
			const value = yield* assignedValue(b, f, column, cell);
			sets.push(`${q(column)} = ${value}`);
			const changed = changes.get(name) ?? [];
			changed.push(`a.${q(column)} IS DISTINCT FROM ${value}`);
			changes.set(name, changed);
		}
	}
	const audit = audited(c)
		? [
				`revision = ${a}.revision + 1`,
				'updated_at = now()',
				...(options.actor === undefined ? [] : [`updated_by = ${b.bind(options.actor, 'text')}`])
			]
		: [];
	if (states.length > 0) {
		const unique = (base: string) => {
			let name = base;
			while (cat.models.has(name)) name += '_';
			return q(name);
		};
		const targets = unique('__store_state_targets');
		const blocked = unique('__store_state_blocked');
		const values = `jsonb_populate_record(${nullRow(c)}, ${b.bind(plain, 'jsonb')}) v`;
		const checks: string[] = [];
		const refuse = (code: 'invalidInput' | 'forbidden', message: string, condition: string) => {
			const reason = refusals.length;
			refusals.push({ code, message });
			checks.push(
				`SELECT ${reason} AS reason FROM ${targets} a CROSS JOIN ${values} WHERE ${condition}`
			);
		};
		for (const field of states) {
			const spec = field.state;
			if (spec === undefined) continue;
			const current = `a.${q(field.column)}`;
			if (Object.hasOwn(w.set, field.name)) {
				const next = `v.${q(field.column)}`;
				const allowed = [`${current} IS NOT DISTINCT FROM ${next}`];
				for (const [from, state] of Object.entries(spec.states))
					if (state.to !== undefined && state.to.length > 0)
						allowed.push(
							`(${current} = ${b.bind(from, 'text')} AND ${next} IN (${state.to.map((to) => b.bind(to, 'text')).join(', ')}))`
						);
				refuse(
					'invalidInput',
					`'${c.name}.${field.name}' cannot move along an undeclared state edge`,
					`NOT coalesce((${allowed.join(' OR ')}), false)`
				);
			}
			for (const [from, state] of Object.entries(spec.states)) {
				const edit = state.edit ?? 'all';
				if (edit === 'all') continue;
				const locked = [...changes]
					.filter(([name]) => name !== field.name && (edit === 'none' || !edit.includes(name)))
					.flatMap(([, changed]) => changed);
				if (locked.length > 0)
					refuse(
						'forbidden',
						`'${c.name}' is locked while '${field.name}' is '${from}'`,
						`${current} = ${b.bind(from, 'text')} AND (${locked.join(' OR ')})`
					);
			}
		}
		const admitted = `NOT EXISTS (SELECT 1 FROM ${blocked})`;
		const observed =
			w.observed === undefined
				? ''
				: ` AND NOT EXISTS (SELECT 1 FROM ${targets} WHERE revision IS DISTINCT FROM ${b.bind(w.observed, 'int8')})`;
		const join = key.map((column) => `a.${q(column)} = s.${q(column)}`).join(' AND ');
		return yield* done(
			`WITH ${targets} AS MATERIALIZED (SELECT a.* FROM ${T} a WHERE ${condition} FOR UPDATE),
${blocked} AS MATERIALIZED (${checks.length === 0 ? 'SELECT NULL::int AS reason WHERE false' : checks.join(' UNION ALL ')}),
w AS (UPDATE ${T} a SET ${[...sets, ...audit].join(', ')} FROM ${targets} s CROSS JOIN ${values} WHERE ${join} AND ${admitted}${observed} RETURNING a.*)
SELECT (SELECT count(*) FROM ${targets}) AS matched, (SELECT min(reason) FROM ${blocked}) AS refused, ${yield* projected(b, c, 'w', w.select)} AS j`,
			w.observed !== undefined
		);
	}
	return yield* done(
		`WITH ${seen}, w AS (UPDATE ${T} ${a} SET ${[...sets, ...audit].join(', ')} FROM jsonb_populate_record(${nullRow(c)}, ${b.bind(plain, 'jsonb')}) v WHERE ${condition}${revision} RETURNING ${a}.*)
SELECT (SELECT n FROM seen) AS matched, ${yield* projected(b, c, 'w', w.select)} AS j`,
		w.observed !== undefined
	);
});
