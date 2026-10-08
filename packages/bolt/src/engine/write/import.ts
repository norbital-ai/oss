// Import and export (rule 30). `import` is one atomic act of ≤ 10,000 rows through the act pipeline (the transform runs
// over the batch like any create or upsert); this file holds what only an import has: its options, refs given by the
// target's key values, and the `prune` read. `export` is `read({ all: true })` under the caller's scope and masks,
// encoded host-side (`std/sheet`) into a file.
import type { Json } from '../../decl/values.ts';
import type { Authority, Bindings, EngineManifest, Outcome, Pred, ReadEngine, Reader, TenantDb } from '../contracts.ts';
import { BoltError, LIMITS } from '../contracts.ts';
import { catalogOf } from '../access/pred.ts';
import { q, type Catalog } from '../../protocol/catalog.ts';
import * as ir from '../../protocol/ir.ts';
import { whereSql } from '../query/sql.ts';
import { composable, readComposed } from '../query/engine.ts';
import type { Item } from './flatten.ts';
import { modelKey } from './flatten.ts';
import { untag } from './sql.ts';

export type ImportPlan = {
	rows: readonly Json[];
	/** Required on a keyed collection; `refuse` refuses a row already on file. */
	onConflict?: 'update' | 'keep' | 'refuse';
	/** `skip` only updates rows already on file (enrichment). */
	onMissing?: 'create' | 'skip';
	dryRun?: true;
	/** The ids to delete: caller-readable rows inside the `Where` whose key the import does not name. */
	prune?: (db: TenantDb, auth: Authority, b: Bindings, items: readonly Item[]) => Promise<string[] | Outcome>;
};

type Obj = { readonly [k: string]: Json };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (message: string, field?: string): Outcome => ({ kind: 'refused', code: 'invalidInput', message, ...(field === undefined ? {} : { field }) });

/** Decodes `{ rows, onConflict?, onMissing?, prune?, dryRun? }` (final-collections §2.4). */
export function importPlan(m: EngineManifest, collection: string, input: Json, key: readonly string[]): ImportPlan | Outcome {
	if (!isObj(input) || !Array.isArray(input['rows'])) return bad('an import is { rows, onConflict?, onMissing?, prune?, dryRun? }');
	const { rows, onConflict, onMissing, prune, dryRun, ...rest } = input;
	const extra = Object.keys(rest)[0];
	if (extra !== undefined) return bad(`'${extra}' is not an import option`, extra);
	if (rows.length > LIMITS.changesPerAct) return { kind: 'refused', code: 'overflow', message: `An import writes at most ${LIMITS.changesPerAct} rows.` };
	if (key.length === 0 && (onConflict !== undefined || onMissing !== undefined || prune !== undefined))
		return bad(`${collection} has no key: onConflict, onMissing and prune need one`);
	if (key.length > 0 && !['update', 'keep', 'refuse'].includes(onConflict as string)) return bad('onConflict is required: update, keep or refuse', 'onConflict');
	if (onMissing !== undefined && onMissing !== 'create' && onMissing !== 'skip') return bad('onMissing is create or skip', 'onMissing');
	if (dryRun !== undefined && dryRun !== true) return bad('dryRun is true', 'dryRun');
	let where: Pred | undefined;
	if (prune !== undefined) {
		if (m.collections[collection]?.delete === undefined) return { kind: 'refused', code: 'forbidden', message: `${collection} does not accept delete.` };
		try { where = ir.where(catalogOf(m), collection, prune); } catch (e) { return bad(e instanceof Error ? e.message : 'prune is a Where', 'prune'); }
	}
	return {
		rows,
		...(onConflict === undefined ? {} : { onConflict: onConflict as 'update' | 'keep' | 'refuse' }),
		...(onMissing === undefined ? {} : { onMissing }), ...(dryRun === true ? { dryRun } : {}),
		...(where === undefined ? {} : { prune: (db, auth, b, items) => pruned(m, collection, key, where, db, auth, b, items) }),
	};
}

async function pruned(m: EngineManifest, c: string, key: readonly string[], where: Pred, db: TenantDb, auth: Authority, b: Bindings,
	items: readonly Item[]): Promise<string[] | Outcome> {
	const named = items.filter((i) => i.parent === undefined && 'values' in i.change).map((i) => (i.change as { values: { readonly [f: string]: Json } }).values);
	const keep: Pred = key.length === 1
		? { t: 'in', field: key[0]!, negated: true, args: named.map((v) => untag(v[key[0]!] ?? null)) }
		: { t: 'not', of: { t: 'or', of: named.map((v) => ({ t: 'and', of: key.map((f): Pred => ({ t: 'cmp', field: f, op: 'eq', arg: { lit: untag(v[f] ?? null) } })) })) } };
	const reader: Reader = { as: 'caller', authority: auth };
	let sql;
	try {
		sql = whereSql(catalogOf(m), c, { t: 'and', of: [where, keep] }, reader, b);
	} catch (e) {
		if (e instanceof BoltError && e.code === 'forbidden') return { kind: 'refused', code: 'forbidden', message: e.message };
		throw e;
	}
	// its one `id` column (text) parses as its JSON: the read composes with the act's others
	const [res] = await db.read([composable(sql)]);
	return res!.rows.map((r) => String(r['id']));
}

/**
 * Rule 30: a ref column accepts an `Id` or the target's key values (`{ code: 'ACME' }`). One read per target resolves
 * every key-valued ref; one that names no row refuses `notFound { field, row }`.
 */
export async function importRefs(db: TenantDb, m: EngineManifest, cat: Catalog, collection: string, rows: readonly Json[]): Promise<Json[] | Outcome> {
	const wants = new Map<string, { fk: string; target: string; key: readonly string[]; at: { row: number; v: Obj }[] }>();
	for (const [fk, rel] of cat.models.get(collection)!.one) {
		if (rel.targets.length !== 1) continue;
		const target = rel.targets[0]!;
		const at = rows.flatMap((row, i) => {
			const v = isObj(row) ? row[fk] : undefined;
			return isObj(v) && !Object.keys(v).some((x) => x.startsWith('$')) ? [{ row: i, v }] : [];
		});
		if (at.length === 0) continue;
		const key = modelKey(m, target);
		if (key.length === 0) return { kind: 'refused', code: 'invalidInput', message: `${target} has no key; name it by id`, field: fk, row: at[0]!.row };
		wants.set(fk, { fk, target, key, at });
	}
	if (wants.size === 0) return [...rows];
	const list = [...wants.values()];
	// every column text: each read composes with the act's others (`readComposed`)
	const res = await readComposed(db, list.map((w) => composable({
		text: `SELECT DISTINCT t.id::text AS id, ${w.key.map((f) => `t.${q(f)}::text AS ${q(f)}`).join(', ')} FROM ${q(w.target)} t
			JOIN jsonb_populate_recordset(null::${q(w.target)}, $1::jsonb) r ON ${w.key.map((f) => `t.${q(f)} = r.${q(f)}`).join(' AND ')}`,
		params: [JSON.stringify(w.at.map(({ v }) => Object.fromEntries(w.key.map((f) => [f, untag(v[f] ?? null)]))))],
	})));
	const out = rows.map((r) => ({ ...(r as Obj) }) as Record<string, Json>);
	for (const [i, w] of list.entries()) for (const { row, v } of w.at) {
		const hit = res[i]!.rows.find((x) => w.key.every((f) => x[f] === String(untag(v[f] ?? null))));
		if (hit === undefined) return { kind: 'refused', code: 'notFound', message: `No ${w.target} has these key values.`, field: w.fk, row };
		out[row]![w.fk] = String(hit['id']);
	}
	return out;
}

/** `export`: every row the caller may read, masked, handed to the host's encoder (`std/sheet`); `TooLarge` past the cap. */
export async function exportRows<F>(read: ReadEngine['run'], cat: Catalog, collection: string, options: { where?: Json; select?: Json; orderBy?: Json },
	reader: Reader, bindings: Bindings, encode: (rows: readonly Json[]) => Promise<F>): Promise<F> {
	const [page] = await read([ir.read(cat, collection, { ...options, all: true })], reader, bindings);
	return encode((page as { rows: Json[] }).rows);
}
