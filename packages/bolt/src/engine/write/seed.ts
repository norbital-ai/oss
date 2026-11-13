import { Effect, Stream } from 'effect';
import { input_schema } from '@norbital-ai/store/kind';

import { Schema } from 'effect';
// Seed mode (X-13): a restore. Stored values go in as given (kept ids of any uuid version, non-initial states,
// `seq` values, sealed rows) in relationship order, one statement per model per ≤ 1 MiB chunk, each chunk a step
// of its own (`restorer`) in one statement; the database's constraints apply; roll-ups are derived and compared with any given value (`seed_drift`); each `seq`
// counter is raised to the highest seeded value. No transform, trigger, run, outbox row, approval route or rate limit.
import type { Json } from '../../decl/values.ts';
import { LIMITS, utf8Bytes, type RowData, type Sql } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { DbError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { catalog_of, toOwnSql } from '../access/pred.ts';
import { null_row_sql, q } from '@norbital-ai/store';
import { literal } from '@norbital-ai/store';
import { constraintIndex } from '../schema/plan.ts';
import { history_piece, rollups, seqParts, seqScope } from './commit.ts';
import { cells, database_value } from '@norbital-ai/store';
import { decided, Chain } from './sql.ts';
/** Rows per model, as a seed pack's `seed/<model>.json` holds them. */
export type SeedPack = {
	readonly [model: string]: readonly RowData[];
};
/** Seed decode: throws `seed_decode` on the first bad row. hook:callables — `bolt check` runs it at build. */
export function decode_seed(m: EngineManifest, pack: SeedPack): void {
	const cat = catalog_of(m);
	for (const [c, rows] of Object.entries(pack))
		rows.forEach((row, i) => decodeSeedRow(m, cat, c, row, i));
	for (const c of Object.keys(pack)) decodeSeedRow(m, cat, c, undefined, 0);
}
/** One row (or, without one, its model): every key a stored field, FK or system column; computed values are the database's (GENERATED). */
function decodeSeedRow(
	m: EngineManifest,
	cat: ReturnType<typeof catalog_of>,
	c: string,
	row: RowData | undefined,
	i: number
): void {
	const model = cat.models.get(c);
	const declaration = m.models[c];
	if (model === undefined || declaration === undefined)
		throw BoltError.make('seed_decode', 'decode', `seed: unknown model '${c}'`);
	if (row === undefined) return;
	if (typeof row['id'] !== 'string')
		throw BoltError.make('seed_decode', 'decode', `seed ${c}[${i}]: every row carries its id`);
	for (const [f, v] of Object.entries(row)) {
		const info = model.fields.get(f);
		if (info === undefined || info.computed)
			throw BoltError.make('seed_decode', 'decode', `seed ${c}[${i}].${f}: not a stored field`);
		const k = declaration.fields[f];
		if (k?.kind === 'state' && !Object.hasOwn(k.states, String(v)))
			throw BoltError.make(
				'seed_decode',
				'decode',
				`seed ${c}[${i}].${f}: '${String(v)}' is not a state`
			);
	}
}
/** A seed's models, each streamed only when it is restored, from row `from` on: no model is ever in memory whole. */
export type RestoreSource = {
	readonly models: readonly string[];
	readonly rows: (model: string, from: number) => Stream.Stream<RowData, BoltError>;
};
export const restore_source = (pack: SeedPack): RestoreSource => ({
	models: Object.keys(pack),
	rows: (model, from) => Stream.fromIterable((pack[model] ?? []).slice(from))
});
const decodeFailure = (error: unknown) =>
	error instanceof BoltError ? error : BoltError.make('seed_decode', 'decode', String(error));
const Inserted = Schema.Struct({ n: Schema.Int });
const Drift = Schema.fromJsonString(
	Schema.Struct({
		model: Schema.String,
		field: Schema.String,
		id: Schema.String,
		value: Schema.NullOr(Schema.String)
	})
);
/**
 * A restore in bounded steps, each one unit of work ("Limits and liveness"): one model, or one
 * chunk within the shared seed byte budget, per step in relationship order; then one last step derives the roll-ups (compared with
 * every given value the steps kept) and raises the `seq` counters. Each step is its own transaction, so a failed restore
 * keeps the steps before it: a host restores into a branch it drops on failure. `step` answers `true` while steps remain.
 */
export const restorer = Effect.fn('Bolt.restorer')(function* (
	m: EngineManifest,
	db: TenantDb,
	source: RestoreSource,
	now: string
) {
	const cat = catalog_of(m);
	const order = yield* Effect.try({
		try: () => {
			for (const c of source.models) decodeSeedRow(m, cat, c, undefined, 0);
			return topological(m, source.models);
		},
		catch: decodeFailure
	});
	const constraints = yield* constraintIndex(m);
	/** The row the seed gave for a decoded value: its list or object fields as the wire holds them. */
	const normalized = (model: string, row: RowData) =>
		Effect.gen(function* () {
			const values: Record<string, Json> = { ...row };
			for (const [field, value] of Object.entries(row)) {
				const kind = m.models[model]?.fields[field];
				if (value === null || (kind?.many !== true && kind?.kind !== 'object')) continue;
				const decoded = yield* Schema.decodeUnknownEffect(input_schema(kind))(value).pipe(
					Effect.mapError((error) =>
						BoltError.make(
							'seed_decode',
							'decode',
							`seed ${model}.${field}: ${error.message}`,
							error
						)
					)
				);
				values[field] = decoded;
			}
			return values;
		});
	let inserted = 0;
	/** Given roll-up values, kept across steps to compare with what the last step derives: by model and field. */
	const given = new Map<string, { id: Json; value: Json; at: number }[]>();
	const counters = new Map<
		string,
		{ model: string; field: string; scope: string; value: number }
	>();
	const insert = (c: string, chunk: readonly Record<string, Json>[]): readonly Sql[] => {
		// hook:packaging-ui — a key a row omits takes its column's default, never null: one recordset per key
		// shape, the shapes one statement
		const shapes = new Map<string, [Record<string, Json>, ...Record<string, Json>[]]>();
		for (const r of chunk) {
			const k = Object.keys(r).sort().join('\0');
			const list = shapes.get(k);
			if (list === undefined) shapes.set(k, [r]);
			else list.push(r);
		}
		const lists = [...shapes.values()];
		const chain = new Chain();
		const context = seedContext(chain);
		const inserts = lists.map((list, i) => {
			const cols = Object.keys(list[0]);
			return chain.cte(
				`ins${i}`,
				`INSERT INTO ${q(c)} (${cols.map(q).join(', ')})
                            SELECT ${cols.map((f) => `r.${q(f)}`).join(', ')} FROM jsonb_populate_recordset(${null_row_sql(c, cat.models.get(c)?.fields.keys() ?? [])}, ${chain.p(list)}::jsonb) r
                            WHERE EXISTS (SELECT 1 FROM ${context}) ON CONFLICT (id) DO NOTHING RETURNING *`
			);
		});
		chain.cte('ins', inserts.map((name) => `SELECT * FROM ${name}`).join(' UNION ALL '));
		seedHistory(chain, c, 'create', 'NULL::jsonb', 'to_jsonb(ins)', 'ins');
		return [chain.sql('(SELECT count(*)::int FROM ins) AS n')];
	};
	/** A seed statement's write context: trusted stamps for the row trigger, and its own history (no raw-SQL trigger). */
	const seedContext = (chain: Chain) =>
		chain.cte(
			'context',
			`SELECT set_config('store.write', jsonb_build_object('mode', 'seed', 'actor', NULL, 'at', ${chain.shared('now', now)}::timestamptz)::text, true),
	set_config('bolt.write', statement_timestamp()::text, true)`
		);
	/** The history of a seed piece's rows, from its own RETURNING images. */
	const seedHistory = (chain: Chain, c: string, op: 'create' | 'update', o: string, n: string, rows: string) => {
		chain.cte(
			'seed_changes',
			`SELECT ${literal(c)}::text AS c, id::text AS id, revision, ${chain.shared('now', now)}::timestamptz AS at, 'system:seed'::text AS actor,
	'${op}'::text AS op, 'seed'::text AS cause, false AS erased, ${o} AS o, ${n} AS n FROM ${rows}`
		);
		history_piece(chain, 'seed_changes', cat.models.get(c)?.fields.get('id')?.pg === 'uuid' ? { uuid: true } : {});
	};
	/** Rows of `c` from row `from`, decoded within the shared byte budget: the next step's row, or `undefined` once `c`
	 * is in. A row past the budget is read again by the next step; one larger alone is its own chunk. */
	const chunkOf = (c: string, from: number) =>
		Effect.gen(function* () {
			const derived = rollups(m, cat, c).map((r) => r.field);
			const model = cat.models.get(c), declaration = m.models[c];
			if (model === undefined || declaration === undefined)
				return yield* BoltError.make('seed_decode', 'decode', `seed: unknown model '${c}'`);
			const fields = model.fields;
			const seqs = Object.entries(declaration.fields).filter(([, k]) => k.kind === 'seq');
			const chunk: Record<string, Json>[] = [];
			const pendingGiven: typeof given = new Map();
			const pendingCounters: typeof counters = new Map();
			let size = 0,
				at = from,
				full = false;
			yield* Stream.runForEachWhile(source.rows(c, from), (row) =>
				Effect.gen(function* () {
					yield* Effect.try({ try: () => decodeSeedRow(m, cat, c, row, at), catch: decodeFailure });
					const values = yield* normalized(c, row);
					const id = values['id'];
					if (typeof id !== 'string')
						return yield* BoltError.make('seed_decode', 'decode', `seed ${c}[${at}]: every row carries its id`);
					const cell = Object.fromEntries(
						Object.entries(values)
							.filter(([f]) => !derived.includes(f))
							.flatMap(([f, v]) => cells(f, v, fields.get(f)))
					);
					const n = utf8Bytes(JSON.stringify(cell));
					if (size + n > LIMITS.seedChunkBytes && chunk.length > 0) {
						full = true;
						return false;
					}
					for (const field of derived) {
						const value = values[field];
						if (value !== undefined) {
							const key = `${c}\0${field}`;
							pendingGiven.set(key, [
								...(pendingGiven.get(key) ?? []),
								{ id, value, at }
							]);
						}
					}
					for (const [field, k] of seqs) {
						if (k.kind !== 'seq') continue;
						const got = seqValue(k.pattern, values[field] ?? null);
						if (got === null) continue;
						const { pre, post } = seqParts(k.pattern, got.date);
						const scope = seqScope(
							pre,
							post,
							(k.per ?? []).map((p) => values[p] ?? null)
						);
						const key = JSON.stringify([c, field, scope]);
						if ((pendingCounters.get(key)?.value ?? counters.get(key)?.value ?? 0) < got.n)
							pendingCounters.set(key, { model: c, field, scope, value: got.n });
					}
					chunk.push(cell);
					size += n;
					at++;
					return true;
				})
			);
			return {
				statement: chunk.length === 0 ? undefined : insert(c, chunk),
				resume: full ? at : undefined,
				given: pendingGiven,
				counters: pendingCounters
			};
		});
	const finish = Effect.fnUntraced(function* () {
		const statements: Sql[] = [];
		// roll-ups, children first (a roll-up may sum another), derived by the statement and compared with every given value
		for (const c of [...order].reverse())
			for (const r of yield* Effect.try({ try: () => rollups(m, cat, c), catch: decodeFailure })) {
				const ch = new Chain();
				const where = r.where === undefined ? 'true' : yield* toOwnSql(m, r.child, r.where, 'c', ch);
				const agg = r.kind === 'count' ? 'count(*)' : `coalesce(sum(c.${q(r.childField)}), 0)`;
				const context = seedContext(ch);
				ch.cte(
					'derived',
					`UPDATE ${q(c)} p SET ${q(r.field)} = (SELECT ${agg} FROM ${q(r.child)} c WHERE c.${q(r.fk)} = p.id AND ${where})
					WHERE p.${q(r.field)} IS DISTINCT FROM (SELECT ${agg} FROM ${q(r.child)} c WHERE c.${q(r.fk)} = p.id AND ${where})
					AND EXISTS (SELECT 1 FROM ${context}) RETURNING new.id, new.revision, to_jsonb(old) AS o, to_jsonb(new) AS n`
				);
				seedHistory(ch, c, 'update', 'derived.o', 'derived.n', 'derived');
				statements.push(ch.sql('(SELECT count(*)::int FROM derived) AS n'));
				const values = given.get(`${c}\0${r.field}`) ?? [];
				if (values.length === 0) continue;
				// A mismatch must abort all derivations and counters in this batch before it commits.
				statements.push({
					text: `SELECT bolt_assert(false, 'seed_drift', jsonb_build_object('model', $2::text, 'field', $3::text, 'id', p.id::text, 'value', p.${q(r.field)}::text)::text)
					FROM ${q(c)} p JOIN jsonb_populate_recordset(${null_row_sql(c, cat.models.get(c)?.fields.keys() ?? [])}, $1::jsonb) g ON g.id = p.id
					WHERE p.${q(r.field)} IS DISTINCT FROM g.${q(r.field)} LIMIT 1`,
					params: [
						JSON.stringify(
							values.map(({ id, value }) => ({ id, [r.field]: database_value(value) }))
						),
						c,
						r.field
					]
				});
			}
		// each `seq` counter to the highest seeded value of its period and scope
		if (counters.size > 0)
			statements.push({
				text: `INSERT INTO bolt_seq (model, field, scope, value)
				SELECT v.model, v.field, v.scope, v.value FROM jsonb_to_recordset($1::jsonb) AS v(model text, field text, scope text, value int)
				ON CONFLICT (model, field, scope) DO UPDATE SET value = greatest(bolt_seq.value, excluded.value)`,
				params: [JSON.stringify([...counters.values()])]
			});
		return statements;
	});
	/** The next step: model `next` of `order` from row `from`; at `order.length` the last step; past it, none. */
	let next = 0,
		from = 0;
	const step = Effect.suspend(() =>
		Effect.gen(function* () {
			if (next > order.length) return false;
			const c = order[next];
			if (c === undefined) {
				const statements = yield* finish();
				if (statements.length > 0) yield* db.transaction({ statements });
				next++;
				return false;
			}
			// Source streaming, normalization and SQL construction finish before the transaction opens.
			const plan = yield* chunkOf(c, from);
			if (plan.statement !== undefined) {
				const results = yield* db.transaction({ statements: plan.statement });
				const result = yield* Schema.decodeUnknownEffect(Inserted)(
					results[0]?.rows[0]
				).pipe(
					Effect.mapError((error) =>
						BoltError.make('bad_answer', 'commit', `seed ${c}: ${error.message}`, error)
					)
				);
				inserted += result.n;
			}
			for (const [key, values] of plan.given)
				given.set(key, [...(given.get(key) ?? []), ...values]);
			for (const [key, value] of plan.counters) counters.set(key, value);
			if (plan.resume === undefined) {
				next++;
				from = 0;
			} else from = plan.resume;
			return true;
		})
	).pipe(
		Effect.catch((e) =>
			Effect.gen(function* () {
				if (!(e instanceof DbError)) return yield* Effect.fail(e);
				if (e.sqlstate === 'BA001' && e.message.startsWith('seed_drift ')) {
					const detail = yield* Schema.decodeUnknownEffect(Drift)(
						e.message.slice('seed_drift '.length)
					).pipe(
						Effect.mapError((error) => BoltError.make('bad_answer', 'derive', error.message, error))
					);
					const row = given
						.get(`${detail.model}\0${detail.field}`)
						?.find((value) => value.id === detail.id);
					return yield* Effect.fail(
						BoltError.make(
							'seed_drift',
							'derive',
							`seed ${detail.model}[${row?.at ?? -1}].${detail.field}: given ${JSON.stringify(row?.value)}, derived ${String(detail.value)}`
						)
					);
				}
				const d = yield* Effect.try({
					try: () => decided(e, constraints).outcome,
					catch: (error) =>
						error instanceof BoltError
							? error
							: BoltError.make('bug', 'commit', String(error), error)
				});
				return yield* Effect.fail(
					BoltError.make('seed_refused', 'commit', `seed: ${'message' in d ? d.message : d.kind}`, e)
				);
			})
		)
	);
	return { step, inserted: () => inserted };
});
/** A whole restore, its steps one after another (in-process hosts and test kits; a cell host runs each as its own entry). */
export const seed = Effect.fn('Bolt.seed')(function* (
	m: EngineManifest,
	db: TenantDb,
	source: RestoreSource,
	now: string
) {
	const restore = yield* restorer(m, db, source, now);
	let more = true;
	while (more) more = yield* restore.step;
	return { inserted: restore.inserted() };
});
/** A seeded `seq` value → its counter and the period it was drawn in (`'PO-2026-0042'` under `'PO-{yyyy}-{0000}'`). */
function seqValue(
	pattern: string | undefined,
	v: Json
): {
	n: number;
	date: {
		yyyy: string;
		mm: string;
	};
} | null {
	if (v === null) return null;
	if (pattern === undefined)
		return typeof v === 'number' ? { n: v, date: { yyyy: '', mm: '' } } : null;
	const groups: string[] = [];
	const re = pattern.replace(
		/\{(yyyy|yy|mm|0+)\}|[.*+?^${}()|[\]\\]/g,
		(t, token: string | undefined) => {
			if (token === undefined) return `\\${t}`;
			groups.push(token);
			return token === 'yyyy'
				? '(\\d{4})'
				: token === 'yy' || token === 'mm'
					? '(\\d{2})'
					: '(\\d+)';
		}
	);
	const match = new RegExp(`^${re}$`).exec(String(v));
	if (match === null) return null;
	const at = (t: string) => {
		const i = groups.indexOf(t);
		return i < 0 ? undefined : match[i + 1];
	};
	const yyyy = at('yyyy') ?? (at('yy') === undefined ? '' : `20${at('yy')}`);
	return {
		n: Number(match[groups.findIndex((g) => /^0+$/.test(g)) + 1]),
		date: { yyyy, mm: at('mm') ?? '' }
	};
}
/** Relationship order: a model after every other model its required refs name (self-refs go in one statement). */
function topological(m: EngineManifest, models: readonly string[]): string[] {
	const out: string[] = [];
	const visit = (c: string, path: Set<string>) => {
		if (out.includes(c) || path.has(c)) return;
		path.add(c);
		for (const [key, rel] of Object.entries(m.relationships)) {
			const [from] = key.split('.');
			if (from !== c) continue;
			for (const t of typeof rel.to === 'string' ? [rel.to] : rel.to)
				if (t !== c && models.includes(t)) visit(t, path);
		}
		out.push(c);
	};
	for (const c of models) visit(c, new Set());
	return out;
}
