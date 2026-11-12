// Import: one atomic act through the ordinary per-verb callbacks. This file owns its options,
// references given by the target's key values and the `prune` read.
import { Array as EffectArray, Effect, Option, Predicate, Result, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Authority, Bindings, Outcome, Reader } from '../contracts.ts';
import type { Pred } from '@norbital-ai/store';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { LIMITS } from '../contracts.ts';
import { type EngineError } from '../errors.ts';
import { catalog_of } from '../access/pred.ts';
import { null_row_sql, q, type Catalog } from '@norbital-ai/store';
import { where as decodeWhere } from '@norbital-ai/store';
import { BoltError, from_store } from '../../protocol/errors.ts';
import { readOptions } from '../query/reader.ts';
import { where_sql } from '@norbital-ai/store';
import { read_composed } from '../query/engine.ts';
import { composable } from '../query/reader.ts';
import type { Item } from './flatten.ts';
import { modelKey } from './flatten.ts';
import { database_value } from '@norbital-ai/store';
const ImportConflict = Schema.Literals(['update', 'keep', 'refuse']);
const decodeConflict = Schema.decodeUnknownOption(ImportConflict);

export type ImportPlan = {
	rows: readonly Json[];
	/** Required on a keyed model; `refuse` refuses a row already on file. */
	on_conflict?: typeof ImportConflict.Type;
	/** `skip` only updates rows already on file (enrichment). */
	on_missing?: 'create' | 'skip';
	dry_run?: true;
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
	code: 'invalid_input',
	message,
	...(field === undefined ? {} : { field })
});
/** Decodes `{ rows, on_conflict?, on_missing?, prune?, dry_run? }`. */
export const importPlan = Effect.fnUntraced(function* (
	m: EngineManifest,
	model: string,
	input: Json,
	key: readonly string[]
): Effect.fn.Return<ImportPlan | Outcome> {
	if (!Predicate.isObject(input) || !EffectArray.isArray<Json | undefined>(input['rows']))
		return bad('an import is { rows, on_conflict?, on_missing?, prune?, dry_run? }');
	const { rows, on_conflict, on_missing, prune, dry_run, ...rest } = input;
	const extra = Object.keys(rest)[0];
	if (extra !== undefined) return bad(`'${extra}' is not an import option`, extra);
	if (rows.length > LIMITS.act.rows)
		return {
			kind: 'refused',
			code: 'overflow',
			message: `An import writes at most ${LIMITS.act.rows} rows.`
		};
	const conflict = decodeConflict(on_conflict);
	if (Option.isNone(conflict))
		return bad('on_conflict is required: update, keep or refuse', 'on_conflict');
	if (on_missing !== undefined && on_missing !== 'create' && on_missing !== 'skip')
		return bad('on_missing is create or skip', 'on_missing');
	if (dry_run !== undefined && dry_run !== true) return bad('dry_run is true', 'dry_run');
	let where: Pred | undefined;
	if (prune !== undefined) {
		if (m.exposures[model]?.delete === undefined)
			return {
				kind: 'refused',
				code: 'forbidden',
				message: `${model} does not accept delete.`
			};
		const decoded = yield* Effect.result(decodeWhere(catalog_of(m), model, prune));
		if (Result.isFailure(decoded)) return bad(decoded.failure.message, 'prune');
		where = decoded.success;
	}
	return {
		rows,
		...(Option.isSome(conflict) ? { on_conflict: conflict.value } : {}),
		...(on_missing === undefined ? {} : { on_missing }),
		...(dry_run === true ? { dry_run } : {}),
		...(where === undefined
			? {}
			: { prune: (db, auth, b, items) => pruned(m, model, key, where, db, auth, b, items) })
	};
});
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
	const named = items.flatMap((i) =>
		i.parent === undefined && 'values' in i.change ? [i.change.values] : []
	);
	const field = key.length === 1 ? key[0] : undefined;
	const keep: Pred =
		field !== undefined
			? {
					t: 'in',
					field,
					negated: true,
					args: named.map((v) => database_value(v[field] ?? null))
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
								arg: { _tag: 'Lit', value: database_value(v[f] ?? null) }
							}))
						}))
					}
				};
	const reader: Reader = { as: 'caller', authority: auth };
	const result = yield* Effect.result(
		where_sql(catalog_of(m), c, { t: 'and', of: [where, keep] }, readOptions(reader, b)).pipe(
			Effect.mapError(from_store)
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
	if (res === undefined)
		return yield* BoltError.make('corrupt', 'decode', 'The import prune query returned no result.');
	return res.rows.map((r) => String(r['id']));
});
/**
 * Rule 30: a ref column accepts an `Id` or the target's key values (`{ code: 'ACME' }`). One read per target resolves
 * every key-valued ref; one that names no row refuses `not_found { field, row }`.
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
	const own = cat.models.get(model);
	if (own === undefined)
		return yield* BoltError.make('invalid_input', 'decode', `Unknown import model '${model}'.`);
	for (const [fk, rel] of own.one) {
		if (rel.targets.length !== 1) continue;
		const [target] = rel.targets;
		if (target === undefined)
			return yield* BoltError.make('corrupt', 'decode', `The import relation '${model}.${fk}' has no target.`);
		const at = rows.flatMap((row, i) => {
			const v = Predicate.isObject(row) ? row[fk] : undefined;
			return Predicate.isObject(v) && !Object.keys(v).some((x) => x.startsWith('$'))
				? [{ row: i, v }]
				: [];
		});
		const [first] = at;
		if (first === undefined) continue;
		const key = modelKey(m, target);
		if (key.length === 0)
			return {
				kind: 'refused',
				code: 'invalid_input',
				message: `${target} has no import key; name it by id`,
				field: fk,
				row: first.row
			};
		wants.set(fk, { fk, target, key, at });
	}
	if (wants.size === 0) return [...rows];
	const list = [...wants.values()];
	// every column text: each read composes with the act's others (`read_composed`)
	const res = yield* read_composed(
		db,
		list.map((w) =>
			composable({
				text: `SELECT DISTINCT t.id::text AS id, ${w.key.map((f) => `t.${q(f)}::text AS ${q(f)}`).join(', ')} FROM ${q(w.target)} t
			JOIN jsonb_populate_recordset(${null_row_sql(w.target, cat.models.get(w.target)?.fields.keys() ?? [])}, $1::jsonb) r ON ${w.key.map((f) => `t.${q(f)} = r.${q(f)}`).join(' AND ')}`,
				params: [
					JSON.stringify(
						w.at.map(({ v }) =>
							Object.fromEntries(w.key.map((f) => [f, database_value(v[f] ?? null)]))
						)
					)
				]
			})
		)
	);
	const out = rows.map((row) => Predicate.isObject(row) ? { ...row } : row);
	for (const [i, w] of list.entries()) {
		const result = res[i];
		if (result === undefined)
			return yield* BoltError.make('corrupt', 'decode', `The import reference query for '${w.target}' returned no result.`);
		for (const { row, v } of w.at) {
			const hit = result.rows.find((x) =>
				w.key.every((f) => x[f] === String(database_value(v[f] ?? null)))
			);
			if (hit === undefined)
				return {
					kind: 'refused',
					code: 'not_found',
					message: `No ${w.target} has these key values.`,
					field: w.fk,
					row
				};
			const item = out[row];
			if (!Predicate.isObject(item))
				return yield* BoltError.make('corrupt', 'decode', 'The import reference no longer names an object row.');
			item[w.fk] = String(hit['id']);
		}
	}
	return out;
});
