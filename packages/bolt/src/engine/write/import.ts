import { Array as EffectArray, Effect, Result } from 'effect';
// Import: one atomic act of at most 10,000 rows through the ordinary per-verb callbacks. This file owns its options,
// references given by the target's key values and the `prune` read.
import { Predicate } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Authority, Bindings, Outcome, Reader } from '../contracts.ts';
import type { Pred } from '@norbital-ai/store';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { LIMITS } from '../contracts.ts';
import { type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { catalogOf } from '../access/pred.ts';
import { nullRowSql, q, type Catalog } from '@norbital-ai/store';
import { where as decodeWhere } from '@norbital-ai/store';
import { fromStore, storeSync } from '../../protocol/errors.ts';
import { readOptions } from '../query/reader.ts';
import { whereSql } from '@norbital-ai/store';
import { readComposed } from '../query/engine.ts';
import { composable } from '../query/reader.ts';
import type { Item } from './flatten.ts';
import { modelKey } from './flatten.ts';
import { databaseValue } from '@norbital-ai/store';
export type ImportPlan = {
	rows: readonly Json[];
	/** Required on a keyed model; `refuse` refuses a row already on file. */
	onConflict?: 'update' | 'keep' | 'refuse';
	/** `skip` only updates rows already on file (enrichment). */
	onMissing?: 'create' | 'skip';
	dryRun?: true;
	/** The ids to delete: caller-readable rows inside the `Where` whose key the import does not name. */
	prune?: (
		db: TenantDb,
		auth: Authority,
		b: Bindings,
		items: readonly Item[]
	) => Effect.Effect<string[] | Outcome, EngineError>;
};
type Obj = {
	readonly [k: string]: Json;
};
const bad = (message: string, field?: string): Outcome => ({
	kind: 'refused',
	code: 'invalidInput',
	message,
	...(field === undefined ? {} : { field })
});
/** Decodes `{ rows, onConflict?, onMissing?, prune?, dryRun? }` (final-models §2.4). */
export function importPlan(
	m: EngineManifest,
	model: string,
	input: Json,
	key: readonly string[]
): ImportPlan | Outcome {
	if (!Predicate.isObject(input) || !EffectArray.isArray<Json | undefined>(input['rows']))
		return bad('an import is { rows, onConflict?, onMissing?, prune?, dryRun? }');
	const { rows, onConflict, onMissing, prune, dryRun, ...rest } = input;
	const extra = Object.keys(rest)[0];
	if (extra !== undefined) return bad(`'${extra}' is not an import option`, extra);
	if (rows.length > LIMITS.changesPerAct)
		return {
			kind: 'refused',
			code: 'overflow',
			message: `An import writes at most ${LIMITS.changesPerAct} rows.`
		};
	if (
		key.length === 0 &&
		(onConflict !== undefined || onMissing !== undefined || prune !== undefined)
	)
		return bad(`${model} has no key: onConflict, onMissing and prune need one`);
	if (key.length > 0 && !['update', 'keep', 'refuse'].includes(onConflict as string))
		return bad('onConflict is required: update, keep or refuse', 'onConflict');
	if (onMissing !== undefined && onMissing !== 'create' && onMissing !== 'skip')
		return bad('onMissing is create or skip', 'onMissing');
	if (dryRun !== undefined && dryRun !== true) return bad('dryRun is true', 'dryRun');
	let where: Pred | undefined;
	if (prune !== undefined) {
		if (m.exposures[model]?.delete === undefined)
			return {
				kind: 'refused',
				code: 'forbidden',
				message: `${model} does not accept delete.`
			};
		const decoded = Result.try(() => storeSync(decodeWhere(catalogOf(m), model, prune)));
		if (Result.isFailure(decoded))
			return bad(
				decoded.failure instanceof Error ? decoded.failure.message : 'prune is a Where',
				'prune'
			);
		where = decoded.success;
	}
	return {
		rows,
		...(onConflict === undefined ? {} : { onConflict: onConflict as 'update' | 'keep' | 'refuse' }),
		...(onMissing === undefined ? {} : { onMissing }),
		...(dryRun === true ? { dryRun } : {}),
		...(where === undefined
			? {}
			: { prune: (db, auth, b, items) => pruned(m, model, key, where, db, auth, b, items) })
	};
}
const pruned = Effect.fn('Bolt.pruned')(function* (
	m: EngineManifest,
	c: string,
	key: readonly string[],
	where: Pred,
	db: TenantDb,
	auth: Authority,
	b: Bindings,
	items: readonly Item[]
) {
	const named = items
		.filter((i) => i.parent === undefined && 'values' in i.change)
		.map(
			(i) =>
				(
					i.change as {
						values: {
							readonly [f: string]: Json;
						};
					}
				).values
		);
	const keep: Pred =
		key.length === 1
			? {
					t: 'in',
					field: key[0]!,
					negated: true,
					args: named.map((v) => databaseValue(v[key[0]!] ?? null))
				}
			: {
					t: 'not',
					of: {
						t: 'or',
						of: named.map((v) => ({
							t: 'and',
							of: key.map((f): Pred => ({
								t: 'cmp',
								field: f,
								op: 'eq',
								arg: { _tag: 'Lit', value: databaseValue(v[f] ?? null) }
							}))
						}))
					}
				};
	const reader: Reader = { as: 'caller', authority: auth };
	const result = yield* Effect.result(
		whereSql(catalogOf(m), c, { t: 'and', of: [where, keep] }, readOptions(reader, b)).pipe(
			Effect.mapError(fromStore)
		)
	);
	if (result._tag === 'Failure') {
		if (result.failure.code === 'forbidden')
			return {
				kind: 'refused' as const,
				code: 'forbidden' as const,
				message: result.failure.message
			};
		return yield* Effect.fail(result.failure);
	}
	const sql = result.success;
	// its one `id` column (text) parses as its JSON: the read composes with the act's others
	const [res] = yield* db.read([composable(sql)]);
	return res!.rows.map((r) => String(r['id']));
});
/**
 * Rule 30: a ref column accepts an `Id` or the target's key values (`{ code: 'ACME' }`). One read per target resolves
 * every key-valued ref; one that names no row refuses `notFound { field, row }`.
 */
export const importRefs = Effect.fn('Bolt.importRefs')(function* (
	db: TenantDb,
	m: EngineManifest,
	cat: Catalog,
	model: string,
	rows: readonly Json[]
): Effect.fn.Return<readonly Json[] | Outcome, EngineError> {
	const wants = new Map<
		string,
		{
			fk: string;
			target: string;
			key: readonly string[];
			at: {
				row: number;
				v: Obj;
			}[];
		}
	>();
	for (const [fk, rel] of cat.models.get(model)!.one) {
		if (rel.targets.length !== 1) continue;
		const target = rel.targets[0]!;
		const at = rows.flatMap((row, i) => {
			const v = Predicate.isObject(row) ? row[fk] : undefined;
			return Predicate.isObject(v) && !Object.keys(v).some((x) => x.startsWith('$'))
				? [{ row: i, v }]
				: [];
		});
		if (at.length === 0) continue;
		const key = modelKey(m, target);
		if (key.length === 0)
			return {
				kind: 'refused',
				code: 'invalidInput',
				message: `${target} has no key; name it by id`,
				field: fk,
				row: at[0]!.row
			};
		wants.set(fk, { fk, target, key, at });
	}
	if (wants.size === 0) return [...rows];
	const list = [...wants.values()];
	// every column text: each read composes with the act's others (`readComposed`)
	const res = yield* readComposed(
		db,
		list.map((w) =>
			composable({
				text: `SELECT DISTINCT t.id::text AS id, ${w.key.map((f) => `t.${q(f)}::text AS ${q(f)}`).join(', ')} FROM ${q(w.target)} t
			JOIN jsonb_populate_recordset(${nullRowSql(w.target, cat.models.get(w.target)?.fields.keys() ?? [])}, $1::jsonb) r ON ${w.key.map((f) => `t.${q(f)} = r.${q(f)}`).join(' AND ')}`,
				params: [
					JSON.stringify(
						w.at.map(({ v }) =>
							Object.fromEntries(w.key.map((f) => [f, databaseValue(v[f] ?? null)]))
						)
					)
				]
			})
		)
	);
	const out = rows.map((r) => ({ ...(r as Obj) }) as Record<string, Json>);
	for (const [i, w] of list.entries())
		for (const { row, v } of w.at) {
			const hit = res[i]!.rows.find((x) =>
				w.key.every((f) => x[f] === String(databaseValue(v[f] ?? null)))
			);
			if (hit === undefined)
				return {
					kind: 'refused',
					code: 'notFound',
					message: `No ${w.target} has these key values.`,
					field: w.fk,
					row
				};
			out[row]![w.fk] = String(hit['id']);
		}
	return out;
});
