import { Effect, Stream } from 'effect';
import { inputSchema } from '@norbital-ai/std/kind';
import { encodeWire } from '@norbital-ai/std/wire';
import { Schema } from 'effect';
// Seed mode (rule 70, X-13): a restore. Stored values go in as given (kept ids of any uuid version, non-initial states,
// `seq` values, sealed rows) in relationship order, one statement per model per ≤ 4 MiB chunk, each chunk a step
// of its own (`restorer`); the database's constraints apply; roll-ups are derived and compared with any given value (`SeedDrift`); each `seq`
// counter is raised to the highest seeded value. No transform, trigger, run, outbox row, approval route or rate limit.
import type { Json } from '../../decl/values.ts';
import type { RowData, Sql } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { DbError } from '../errors.ts';
import { BoltError, storeSync } from '../../protocol/errors.ts';
import { catalogOf } from '../access/pred.ts';
import { nullRowSql, q } from '@norbital-ai/store';
import { constraintIndex } from '../schema/plan.ts';
import { historyPiece, rollups, seqParts, seqScope } from './commit.ts';
import { cells, ownPredSql, databaseValue } from '@norbital-ai/store';
import { decided, Chain } from './sql.ts';
import { captureFinish, captureStart } from './capture.ts';
/** Rows per model, as a seed pack's `seed/<model>.json` holds them. */
export type SeedPack = {
	readonly [model: string]: readonly RowData[];
};
/** One pack statement's rows: a chunk must stay inside a single call's database wall (20 s), not its byte cap alone. */
const CHUNK = 1024 * 1024;
/** Seed decode (rule 70): throws `seedDecode` on the first bad row. hook:callables — `bolt check` runs it at build. */
export function decodeSeed(m: EngineManifest, pack: SeedPack): void {
	const cat = catalogOf(m);
	for (const [c, rows] of Object.entries(pack))
		rows.forEach((row, i) => decodeSeedRow(m, cat, c, row, i));
	for (const c of Object.keys(pack)) decodeSeedRow(m, cat, c, undefined, 0);
}
/** One row (or, without one, its model): every key a stored field, FK or system column; computed values are the database's (GENERATED). */
function decodeSeedRow(
	m: EngineManifest,
	cat: ReturnType<typeof catalogOf>,
	c: string,
	row: RowData | undefined,
	i: number
): void {
	const model = cat.models.get(c);
	if (model === undefined || m.models[c] === undefined)
		throw BoltError.make('seedDecode', 'decode', `seed: unknown model '${c}'`);
	if (row === undefined) return;
	if (typeof row['id'] !== 'string')
		throw BoltError.make('seedDecode', 'decode', `seed ${c}[${i}]: every row carries its id`);
	for (const [f, v] of Object.entries(row)) {
		const info = model.fields.get(f);
		if (info === undefined || info.computed)
			throw BoltError.make('seedDecode', 'decode', `seed ${c}[${i}].${f}: not a stored field`);
		const k = m.models[c]!.fields[f];
		if (k?.kind === 'state' && !Object.hasOwn(k.states, String(v)))
			throw BoltError.make(
				'seedDecode',
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
export const restoreSource = (pack: SeedPack): RestoreSource => ({
	models: Object.keys(pack),
	rows: (model, from) => Stream.fromIterable((pack[model] ?? []).slice(from))
});
const decodeFailure = (error: unknown) =>
	error instanceof BoltError ? error : BoltError.make('seedDecode', 'decode', String(error));
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
 * A restore in bounded steps, each one unit of work (compute model §3, "Limits and liveness"): one model, or one
 * ≤ 4 MiB chunk of a large one, per step in relationship order; then one last step derives the roll-ups (compared with
 * every given value the steps kept) and raises the `seq` counters. Each step is its own transaction, so a failed restore
 * keeps the steps before it: a host restores into a branch it drops on failure. `step` answers `true` while steps remain.
 */
export const restorer = Effect.fn('Bolt.restorer')(function* (
	m: EngineManifest,
	db: TenantDb,
	source: RestoreSource,
	now: string
) {
	const cat = catalogOf(m);
	const { order, constraints } = yield* Effect.try({
		try: () => {
			for (const c of source.models) decodeSeedRow(m, cat, c, undefined, 0);
			return {
				order: topological(m, source.models),
				constraints: constraintIndex(m)
			};
		},
		catch: decodeFailure
	});
	/** The row the seed gave for a decoded value: its list or object fields as the wire holds them. */
	const normalized = (model: string, row: RowData) =>
		Effect.gen(function* () {
			const values: Record<string, Json> = { ...row };
			for (const [field, value] of Object.entries(row)) {
				const kind = m.models[model]?.fields[field];
				if (value === null || (kind?.kind !== 'list' && kind?.kind !== 'object')) continue;
				const decoded = yield* Schema.decodeUnknownEffect(inputSchema(kind))(value).pipe(
					Effect.mapError((error) =>
						BoltError.make(
							'seedDecode',
							'decode',
							`seed ${model}.${field}: ${error.message}`,
							error
						)
					)
				);
				values[field] = encodeWire(decoded);
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
		const shapes = new Map<string, Record<string, Json>[]>();
		for (const r of chunk) {
			const k = Object.keys(r).sort().join('\0');
			shapes.set(k, [...(shapes.get(k) ?? []), r]);
		}
		const lists = [...shapes.values()];
		const chain = new Chain();
		const inserts = lists.map((list, i) => {
			const cols = Object.keys(list[0]!);
			return chain.cte(
				`ins${i}`,
				`INSERT INTO ${q(c)} (${cols.map(q).join(', ')})
                            SELECT ${cols.map((f) => `r.${q(f)}`).join(', ')} FROM jsonb_populate_recordset(${nullRowSql(c, cat.models.get(c)?.fields.keys() ?? [])}, ${chain.p(list)}::jsonb) r
                            ON CONFLICT (id) DO NOTHING RETURNING *`
			);
		});
		chain.cte('ins', inserts.map((name) => `SELECT * FROM ${name}`).join(' UNION ALL '));
		chain.cte(
			'seed_changes',
			`SELECT ${chain.p(c)}::text AS c, id, revision,
                        ${chain.p(now)}::timestamptz AS at, 'system:seed'::text AS actor, 'create'::text AS op,
                        'seed'::text AS cause, false AS erased, NULL::jsonb AS o, to_jsonb(ins) AS n FROM ins`
		);
		if (m.models[c]?.table !== undefined) historyPiece(chain, 'seed_changes');
		const token = `seed:${c}:${inserted}`;
		return [
			...captureStart(
				{ token, now, actor: 'system:seed', direct: [], erased: [], mode: 'seed' },
				null
			),
			chain.sql('(SELECT count(*)::int FROM ins) AS n'),
			captureFinish(token, false)
		];
	};
	/** Rows of `c` from row `from`, read and decoded until 4 MiB, in one statement: the row the next step starts at, or
	 * `undefined` once `c` is in. A row past the 4 MiB is read again by the next step; one larger alone is its own chunk. */
	const chunkOf = (c: string, from: number) =>
		Effect.gen(function* () {
			const derived = rollups(m, cat, c).map((r) => r.field);
			const fields = cat.models.get(c)!.fields;
			const seqs = Object.entries(m.models[c]!.fields).filter(([, k]) => k.kind === 'seq');
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
					const cell = Object.fromEntries(
						Object.entries(values)
							.filter(([f]) => !derived.includes(f))
							.flatMap(([f, v]) => cells(f, v, fields.get(f)))
					);
					const n = JSON.stringify(cell).length;
					if (size + n > CHUNK && chunk.length > 0) {
						full = true;
						return false;
					}
					for (const field of derived)
						if (values[field] !== undefined) {
							const key = `${c}\0${field}`;
							pendingGiven.set(key, [
								...(pendingGiven.get(key) ?? []),
								{ id: values['id']!, value: values[field]!, at }
							]);
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
	const finish = (): readonly Sql[] => {
		const token = `seed:derived:${now}`;
		const statements: Sql[] = [
			...captureStart(
				{ token, now, actor: 'system:seed', direct: [], erased: [], mode: 'seed' },
				null
			)
		];
		// roll-ups, children first (a roll-up may sum another), derived by the statement and compared with every given value
		for (const c of [...order].reverse())
			for (const r of rollups(m, cat, c)) {
				const ch = new Chain();
				const where = r.where === undefined ? 'true' : storeSync(ownPredSql(r.where, 'c', ch));
				const agg = r.kind === 'count' ? 'count(*)' : `coalesce(sum(c.${q(r.childField!)}), 0)`;
				statements.push({
					text: `UPDATE ${q(c)} p SET ${q(r.field)} = (SELECT ${agg} FROM ${q(r.child)} c WHERE c.${q(r.fk)} = p.id AND ${where})
					WHERE p.${q(r.field)} IS DISTINCT FROM (SELECT ${agg} FROM ${q(r.child)} c WHERE c.${q(r.fk)} = p.id AND ${where})`,
					params: ch.params
				});
				const values = given.get(`${c}\0${r.field}`) ?? [];
				if (values.length === 0) continue;
				// A mismatch must abort all derivations and counters in this batch before it commits.
				statements.push({
					text: `SELECT bolt_assert(false, 'SeedDrift', jsonb_build_object('model', $2::text, 'field', $3::text, 'id', p.id::text, 'value', p.${q(r.field)}::text)::text)
					FROM ${q(c)} p JOIN jsonb_populate_recordset(${nullRowSql(c, cat.models.get(c)?.fields.keys() ?? [])}, $1::jsonb) g ON g.id = p.id
					WHERE p.${q(r.field)} IS DISTINCT FROM g.${q(r.field)} LIMIT 1`,
					params: [
						JSON.stringify(
							values.map(({ id, value }) => ({ id, [r.field]: databaseValue(value) }))
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
		return [...statements, captureFinish(token, false)];
	};
	/** The next step: model `next` of `order` from row `from`; at `order.length` the last step; past it, none. */
	let next = 0,
		from = 0;
	const step = Effect.suspend(() =>
		Effect.gen(function* () {
			if (next > order.length) return false;
			const c = order[next];
			if (c === undefined) {
				const statements = yield* Effect.try({ try: finish, catch: decodeFailure });
				if (statements.length > 0) yield* db.transaction({ statements });
				next++;
				return false;
			}
			// Source streaming, normalization and SQL construction finish before the transaction opens.
			const plan = yield* chunkOf(c, from);
			if (plan.statement !== undefined) {
				const results = yield* db.transaction({ statements: plan.statement });
				const result = yield* Schema.decodeUnknownEffect(Inserted)(
					results[plan.statement.length - 2]?.rows[0]
				).pipe(
					Effect.mapError((error) =>
						BoltError.make('badAnswer', 'commit', `seed ${c}: ${error.message}`, error)
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
				if (e.sqlstate === 'BA001' && e.message.startsWith('SeedDrift ')) {
					const detail = yield* Schema.decodeUnknownEffect(Drift)(
						e.message.slice('SeedDrift '.length)
					).pipe(
						Effect.mapError((error) => BoltError.make('badAnswer', 'derive', error.message, error))
					);
					const row = given
						.get(`${detail.model}\0${detail.field}`)
						?.find((value) => value.id === detail.id);
					return yield* Effect.fail(
						BoltError.make(
							'SeedDrift',
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
					BoltError.make('seedRefused', 'commit', `seed: ${'message' in d ? d.message : d.kind}`, e)
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
