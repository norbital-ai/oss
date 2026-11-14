// A rejected request's rollback: every record it holds back to its checkpoint, as ordinary
// writes of the decision's own statement, recorded `restored` from the checkpoint revision (0: the request created it).
// A record it updated is restored (per-record restore, restore.ts); one it created is deleted; one it deleted is
// re-created from its history. A field restore must skip (a link to a since-deleted target) is reported, never fatal.
import { Array, Effect, Predicate, Schema } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import { coalescing } from '../query/engine.ts';
import { UUID_PATTERN } from '@norbital-ai/store/kind';
import type { Json } from '../../decl/values.ts';
import type { Bindings } from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { catalog_of } from '../access/pred.ts';
import { SYSTEM_COLUMN_SET } from '@norbital-ai/store';
import { storedRow } from '../db/stored.ts';
import { read_history } from '../query/history.ts';
import { k, readRows } from '../write/act.ts';
import type { Write } from '../write/commit.ts';
import { restorePreview } from '../write/restore.ts';
import { Checkpoint } from './snapshot.ts';

export type RolledBack = {
	model: string;
	id: string;
	action: 'restored' | 'removed' | 'recreated';
};
export type Skipped = { model: string; id: string; field: string; reason: string };


export const rollbackPlan = Effect.fn('Approvals.rollbackPlan')(function* (
	m: EngineManifest,
	db: TenantDbShape,
	records: readonly Checkpoint[],
	bindings: Bindings
): Effect.fn.Return<
	{
		writes: Write[];
		restored: { model: string; id: string; revision: number }[];
		rolled_back: RolledBack[];
		skipped: Skipped[];
		observations: readonly { model: string; id: string; revision: number | null }[];
	},
	EngineError
> {
	const cat = catalog_of(m);
	// each wave of reads below crosses once: concurrent reads of the coalescing reader share one round trip
	const own = yield* coalescing(db);
	const first = new Map<string, Checkpoint>();
	for (const r of records) if (!first.has(k(r.model, r.id))) first.set(k(r.model, r.id), r);
	// a model a release removed has no rows to restore: reported, never fatal
	const entries = [...first.values()].filter((r) => cat.models.get(r.model) !== undefined);
	const removed = [...first.values()]
		.filter((r) => cat.models.get(r.model) === undefined)
		.map((r) => ({ model: r.model, id: r.id, field: '*', reason: 'modelRemoved' }));
	const live = yield* readRows(
		own,
		cat,
		entries.map((r) => [r.model, r.id] as const)
	);
	const observations = entries.map((r) => {
		const now = live.get(k(r.model, r.id));
		return {
			model: r.model,
			id: r.id,
			revision: now === undefined ? null : Number(now['revision'])
		};
	});
	const recreations = new Map<
		string,
		{ readonly past: Readonly<Record<string, Json>>; readonly revision: number }
	>();
	// only a uuid-keyed record keeps history to re-create it from
	const gone = entries.filter((r) => r.before !== null && !live.has(k(r.model, r.id)) && UUID_PATTERN.test(r.id));
	const [pasts, lasts] = yield* Effect.all([
		Effect.forEach(gone, (r) => read_history(
			own,
			m,
			{
				kind: 'history',
				model: r.model,
				id: r.id,
				at: { _tag: 'Revision', revision: r.before ?? 0 },
				full: true
			},
			{ as: 'workspace' },
			bindings
		), { concurrency: 'unbounded' }),
		gone.length === 0
			? Effect.succeed([])
			: own.read([{
				text: `SELECT x.c, x.id, coalesce((SELECT max(h.revision) FROM bolt_history h WHERE h.collection = x.c AND h.record = x.id::uuid), 0)::int AS n
				FROM jsonb_to_recordset($1::jsonb) AS x(c text, id text)`,
				params: [JSON.stringify(gone.map((r) => ({ c: r.model, id: r.id })))]
			}]).pipe(Effect.flatMap(([rows]) => Schema.decodeUnknownEffect(
				Schema.Array(Schema.Struct({ c: Schema.String, id: Schema.String, n: Schema.Number }))
			)(rows?.rows ?? []).pipe(Effect.mapError((error) => BoltError.make('corrupt', 'decode', error.message, error)))))
	], { concurrency: 'unbounded' });
	const last = new Map(lasts.map((row) => [k(row.c, row.id), row.n]));
	for (const [index, r] of gone.entries()) {
		const past = pasts[index];
		if (!Predicate.isObject(past) || Array.isArray(past)) continue;
		recreations.set(k(r.model, r.id), {
			past: storedRow(cat, r.model, past),
			revision: (last.get(k(r.model, r.id)) ?? r.before ?? 0) + 1
		});
	}
	const prospectiveTargets = new Set(recreations.keys());
	const writes: Write[] = [],
		restored: { model: string; id: string; revision: number }[] = [],
		rolled_back: RolledBack[] = [],
		skipped: Skipped[] = [...removed];
	// every restore preview, and every recreated row's link targets, read in one wave each
	const previews = new Map(yield* Effect.forEach(
		entries.filter((r) => r.before !== null && live.has(k(r.model, r.id)) && Number(live.get(k(r.model, r.id))?.['revision']) !== r.before),
		(r) => Effect.map(restorePreview(
			{ manifest: m, db: own },
			{ model: r.model, record: r.id, revision: r.before ?? 0 },
			null,
			bindings,
			prospectiveTargets
		), (previewed) => [k(r.model, r.id), previewed] as const),
		{ concurrency: 'unbounded' }
	));
	const linked = [...recreations].flatMap(([key, { past }]) => {
		const r = first.get(key), model = r === undefined ? undefined : cat.models.get(r.model);
		return Object.entries(past).flatMap(([column, value]) => {
			const target = model?.one.get(column)?.targets[0];
			return target !== undefined && typeof value === 'string' ? [[target, value] as const] : [];
		});
	});
	const targets = yield* readRows(own, cat, linked);
	for (const r of entries) {
		const model = cat.models.get(r.model);
		if (model === undefined) continue;
		const now = live.get(k(r.model, r.id));
		if (r.before === null) {
			if (now === undefined) continue;
			writes.push({
				model: r.model,
				id: r.id,
				op: 'delete',
				revision: Number(now['revision'])
			});
			restored.push({ model: r.model, id: r.id, revision: 0 });
			rolled_back.push({ model: r.model, id: r.id, action: 'removed' });
			continue;
		}
		if (now !== undefined) {
			if (Number(now['revision']) === r.before) continue;
			const previewed = previews.get(k(r.model, r.id));
			if (previewed === undefined) continue;
			if (!previewed.ok) {
				skipped.push({
					model: r.model,
					id: r.id,
					field: '*',
					reason: previewed.outcome.message
				});
				continue;
			}
			for (const s of previewed.preview.skipped)
				skipped.push({ model: r.model, id: r.id, field: s.field, reason: s.reason });
			if (previewed.preview.changes.length === 0) continue;
			writes.push({
				model: r.model,
				id: r.id,
				op: 'update',
				set: Object.fromEntries(previewed.preview.changes.map((c) => [c.field, c.restored])),
				revision: Number(now['revision'])
			});
			restored.push({ model: r.model, id: r.id, revision: r.before });
			rolled_back.push({ model: r.model, id: r.id, action: 'restored' });
			continue;
		}
		// deleted inside the request: re-created at its next revision from its stored past
		const recreation = recreations.get(k(r.model, r.id));
		if (recreation === undefined) {
			skipped.push({ model: r.model, id: r.id, field: '*', reason: 'noHistory' });
			continue;
		}
		const values: Record<string, Json> = {};
		const links: (readonly [string, string, string])[] = [];
		for (const [column, value] of Object.entries(recreation.past)) {
			if (SYSTEM_COLUMN_SET.has(column) || column.startsWith('bolt_')) continue;
			const f = model.fields.get(column);
			if (f !== undefined && (f.computed || f.kind === 'sum' || f.kind === 'count')) continue;
			const one = model.one.get(column);
			const target = one?.targets[0];
			if (target !== undefined && typeof value === 'string')
				links.push([column, target, value]);
			values[column] = value;
		}
		for (const [column, target, id] of links)
			if (!targets.has(k(target, id)) && !prospectiveTargets.has(k(target, id))) {
				values[column] = null;
				skipped.push({
					model: r.model,
					id: r.id,
					field: column,
					reason: 'deleted_target'
				});
			}
		writes.push({
			model: r.model,
			id: r.id,
			op: 'create',
			values,
			revision: recreation.revision
		});
		restored.push({ model: r.model, id: r.id, revision: r.before });
		rolled_back.push({ model: r.model, id: r.id, action: 'recreated' });
	}
	return { writes, restored, rolled_back, skipped, observations };
});
