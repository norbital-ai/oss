// Seed mode (rule 70, X-13): a restore. Stored values go in as given (kept ids of any uuid version, non-initial states,
// `seq` values, sealed rows) in relationship order, one statement per collection per ≤ 4 MiB chunk, in one transaction;
// the database's constraints apply; roll-ups are derived and compared with any given value (`SeedDrift`); each `seq`
// counter is raised to the highest seeded value. No transform, trigger, run, outbox row, approval route or rate limit.
import type { Json } from '../../decl/values.ts';
import type { EngineManifest, RowData, TenantDb } from '../contracts.ts';
import { BoltError, DbError } from '../contracts.ts';
import { catalogOf } from '../access/pred.ts';
import { q } from '../../protocol/catalog.ts';
import { constraintIndex } from '../schema/ddl.ts';
import { schemaSlice } from '../schema/plan.ts';
import { rollups, seqParts, seqScope } from './commit.ts';
import { cells, decided, ownPredSql, Chain, untag } from './sql.ts';

/** Rows per collection, as a seed pack's `seed/<collection>.json` holds them. */
export type SeedPack = { readonly [collection: string]: readonly RowData[] };
const CHUNK = 4 * 1024 * 1024;

/** Seed decode (rule 70): throws `seedDecode` on the first bad row. hook:callables — `bolt check` runs it at build. */
export function decodeSeed(m: EngineManifest, pack: SeedPack): void {
	const cat = catalogOf(m);
	// decode: every key a stored field, FK or system column; computed values are the database's (GENERATED)
	for (const [c, rows] of Object.entries(pack)) {
		const model = cat.models.get(c);
		if (model === undefined || m.models[c] === undefined) throw new BoltError('seedDecode', 'decode', `seed: unknown collection '${c}'`);
		rows.forEach((row, i) => {
			if (typeof row['id'] !== 'string') throw new BoltError('seedDecode', 'decode', `seed ${c}[${i}]: every row carries its id`);
			for (const [f, v] of Object.entries(row)) {
				const info = model.fields.get(f);
				if (info === undefined || info.computed) throw new BoltError('seedDecode', 'decode', `seed ${c}[${i}].${f}: not a stored field`);
				const k = m.models[c]!.fields[f];
				if (k?.kind === 'state' && !Object.hasOwn(k.states, String(v))) throw new BoltError('seedDecode', 'decode', `seed ${c}[${i}].${f}: '${String(v)}' is not a state`);
			}
		});
	}
}

export async function seed(m: EngineManifest, db: TenantDb, pack: SeedPack, now: string): Promise<{ inserted: number }> {
	const cat = catalogOf(m);
	decodeSeed(m, pack);
	const order = topological(m, Object.keys(pack));
	const constraints = constraintIndex(schemaSlice(m));
	try {
		return await db.transaction(async (tx) => {
			let inserted = 0;
			for (const c of order) {
				const derivedHere = new Set(rollups(m, cat, c).map((r) => r.field));
				const fields = cat.models.get(c)!.fields;
				const rows = pack[c]!.map((row) => Object.fromEntries(Object.entries(row).filter(([f]) => !derivedHere.has(f)).flatMap(([f, v]) => cells(f, v, fields.get(f)))));
				for (const chunk of chunks(rows)) {
					// hook:packaging-ui — a key a row omits takes its column's default, never null: one recordset per key
					// shape, the shapes one statement
					const shapes = new Map<string, Record<string, Json>[]>();
					for (const r of chunk) { const k = Object.keys(r).sort().join('\0'); shapes.set(k, [...shapes.get(k) ?? [], r]); }
					const lists = [...shapes.values()];
					const inserts = lists.map((list, i) => { const cols = Object.keys(list[0]!);
						return `ins${i} AS (INSERT INTO ${q(c)} (${cols.map(q).join(', ')})
						SELECT ${cols.map((f) => `r.${q(f)}`).join(', ')} FROM jsonb_populate_recordset(null::${q(c)}, $${i + 3}::jsonb) r
						ON CONFLICT (id) DO NOTHING RETURNING *)`; });
					const res = await tx.query({ text: `WITH ${inserts.join(', ')}
					, ins AS (${lists.map((_, i) => `SELECT * FROM ins${i}`).join(' UNION ALL ')})
					, hist AS (INSERT INTO bolt_history (collection, record, revision, at, actor, op, cause, changes)
						SELECT $1, id, revision, $2::timestamptz, 'system:seed', 'create', 'seed', to_jsonb(ins) FROM ins)
					SELECT count(*)::int AS n FROM ins`, params: [c, now, ...lists.map((l) => JSON.stringify(l))] });
					inserted += Number(res.rows[0]!['n']);
				}
			}
			// roll-ups, children first (a roll-up may sum another), derived by the statement and compared with every given value
			for (const c of [...order].reverse()) for (const r of rollups(m, cat, c)) {
				const ch = new Chain();
				const where = r.where === undefined ? 'true' : ownPredSql(r.where, 'c', ch);
				const agg = r.kind === 'count' ? 'count(*)' : `coalesce(sum(c.${q(r.childField!)}), 0)`;
				await tx.query({ text: `UPDATE ${q(c)} p SET ${q(r.field)} = (SELECT ${agg} FROM ${q(r.child)} c WHERE c.${q(r.fk)} = p.id AND ${where})`, params: ch.params });
				const given = (pack[c] ?? []).filter((row) => row[r.field] !== undefined);
				if (given.length === 0) continue;
				const res = await tx.query({ text: `SELECT p.id::text AS id, p.${q(r.field)}::text AS v FROM ${q(c)} p
					JOIN jsonb_populate_recordset(null::${q(c)}, $1::jsonb) g ON g.id = p.id WHERE p.${q(r.field)} IS DISTINCT FROM g.${q(r.field)}`,
				params: [JSON.stringify(given.map((row) => ({ id: row['id'], [r.field]: untag(row[r.field]!) })))] });
				const bad = res.rows[0];
				if (bad !== undefined) {
					const row = pack[c]!.findIndex((x) => x['id'] === bad['id']);
					throw new BoltError('SeedDrift', 'derive', `seed ${c}[${row}].${r.field}: given ${JSON.stringify(pack[c]![row]![r.field])}, derived ${String(bad['v'])}`);
				}
			}
			// each `seq` counter to the highest seeded value of its period and scope
			const counters = new Map<string, { model: string; field: string; scope: string; value: number }>();
			for (const c of order) for (const [field, k] of Object.entries(m.models[c]!.fields)) {
				if (k.kind !== 'seq') continue;
				for (const row of pack[c]!) {
					const got = seqValue(k.pattern, row[field] ?? null);
					if (got === null) continue;
					const { pre, post } = seqParts(k.pattern, got.date);
					const scope = seqScope(pre, post, (k.per ?? []).map((p) => row[p] ?? null));
					const key = JSON.stringify([c, field, scope]);
					if ((counters.get(key)?.value ?? 0) < got.n) counters.set(key, { model: c, field, scope, value: got.n });
				}
			}
			if (counters.size > 0) await tx.query({ text: `INSERT INTO bolt_seq (model, field, scope, value)
				SELECT v.model, v.field, v.scope, v.value FROM jsonb_to_recordset($1::jsonb) AS v(model text, field text, scope text, value int)
				ON CONFLICT (model, field, scope) DO UPDATE SET value = greatest(bolt_seq.value, excluded.value)`, params: [JSON.stringify([...counters.values()])] });
			return { inserted };
		});
	} catch (e) {
		if (!(e instanceof DbError)) throw e;
		const d = decided(e, constraints).outcome;
		throw new BoltError('seedRefused', 'commit', `seed: ${'message' in d ? d.message : d.kind}`, e);
	}
}

/** A seeded `seq` value → its counter and the period it was drawn in (`'PO-2026-0042'` under `'PO-{yyyy}-{0000}'`). */
function seqValue(pattern: string | undefined, v: Json): { n: number; date: { yyyy: string; mm: string } } | null {
	if (v === null) return null;
	if (pattern === undefined) return typeof v === 'number' ? { n: v, date: { yyyy: '', mm: '' } } : null;
	const groups: string[] = [];
	const re = pattern.replace(/\{(yyyy|yy|mm|0+)\}|[.*+?^${}()|[\]\\]/g, (t, token: string | undefined) => {
		if (token === undefined) return `\\${t}`;
		groups.push(token);
		return token === 'yyyy' ? '(\\d{4})' : token === 'yy' || token === 'mm' ? '(\\d{2})' : '(\\d+)';
	});
	const match = new RegExp(`^${re}$`).exec(String(v));
	if (match === null) return null;
	const at = (t: string) => { const i = groups.indexOf(t); return i < 0 ? undefined : match[i + 1]; };
	const yyyy = at('yyyy') ?? (at('yy') === undefined ? '' : `20${at('yy')}`);
	return { n: Number(match[groups.findIndex((g) => /^0+$/.test(g)) + 1]), date: { yyyy, mm: at('mm') ?? '' } };
}

/** Relationship order: a collection after every other collection its required refs name (self-refs go in one statement). */
function topological(m: EngineManifest, collections: readonly string[]): string[] {
	const out: string[] = [];
	const visit = (c: string, path: Set<string>) => {
		if (out.includes(c) || path.has(c)) return;
		path.add(c);
		for (const [key, rel] of Object.entries(m.relationships)) {
			const [from] = key.split('.');
			if (from !== c) continue;
			for (const t of typeof rel.to === 'string' ? [rel.to] : rel.to) if (t !== c && collections.includes(t)) visit(t, path);
		}
		out.push(c);
	};
	for (const c of collections) visit(c, new Set());
	return out;
}

function chunks(rows: readonly Record<string, Json>[]): Record<string, Json>[][] {
	const out: Record<string, Json>[][] = [[]];
	let size = 0;
	for (const r of rows) {
		const n = JSON.stringify(r).length;
		if (size + n > CHUNK && out.at(-1)!.length > 0) { out.push([]); size = 0; }
		out.at(-1)!.push(r);
		size += n;
	}
	return out.filter((c) => c.length > 0);
}
