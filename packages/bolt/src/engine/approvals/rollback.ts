// A rejected or withdrawn request's rollback (rules 44–46): every record it holds back to its checkpoint, as ordinary
// writes of the decision's own statement, recorded `restored` from the checkpoint revision (0: the request created it).
// A record it updated is restored (per-record restore, restore.ts); one it created is deleted; one it deleted is
// re-created from its history. A field restore must skip (a link to a since-deleted target) is reported, never fatal.
import { Array, Effect, Predicate, Schema } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Bindings } from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import { catalogOf } from '../access/pred.ts';
import { SYSTEM_COLUMNS } from '@norbital-ai/store';
import { readHistory } from '../query/history.ts';
import { k, readRows } from '../write/act.ts';
import type { Write } from '../write/commit.ts';
import { restorePreview } from '../write/restore.ts';

export type Checkpoint = {
	model: string;
	id: string;
	op: 'create' | 'update' | 'delete';
	before: number | null;
};
export type RolledBack = {
	model: string;
	id: string;
	action: 'restored' | 'removed' | 'recreated';
};
export type Skipped = { model: string; id: string; field: string; reason: string };

const SYSTEM = new Set<string>(SYSTEM_COLUMNS);
const stored = (v: Json): Json =>
	Predicate.isObject(v) && Object.keys(v).length === 1 && typeof v['$dec'] === 'string'
		? v['$dec']
		: v;

export const rollbackPlan = Effect.fn('Approvals.rollbackPlan')(function* (
	m: EngineManifest,
	db: TenantDbShape,
	records: readonly Checkpoint[],
	bindings: Bindings
): Effect.fn.Return<
	{
		writes: Write[];
		restored: { model: string; id: string; revision: number }[];
		rolledBack: RolledBack[];
		skipped: Skipped[];
		observations: readonly { model: string; id: string; revision: number | null }[];
	},
	EngineError
> {
	const cat = catalogOf(m);
	const first = new Map<string, Checkpoint>();
	for (const r of records)
		if (!first.has(k(r.model, r.id))) first.set(k(r.model, r.id), r);
	// a model a release removed has no rows to restore: reported, never fatal
	const entries = [...first.values()].filter((r) => cat.models.get(r.model) !== undefined);
	const removed = [...first.values()]
		.filter((r) => cat.models.get(r.model) === undefined)
		.map((r) => ({ model: r.model, id: r.id, field: '*', reason: 'modelRemoved' }));
	const live = yield* readRows(
		db,
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
	for (const r of entries) {
		if (r.before === null || live.has(k(r.model, r.id))) continue;
		const past = yield* readHistory(
			db,
			m,
			{
				kind: 'history',
				model: r.model,
				id: r.id,
				at: { _tag: 'Revision', revision: r.before },
				full: true
			},
			{ as: 'workspace' },
			bindings
		);
		if (!Predicate.isObject(past) || Array.isArray(past)) continue;
		const last = yield* db.rows(Schema.Struct({ n: Schema.Number }), {
			text: 'SELECT coalesce(max(revision), 0)::int AS n FROM bolt_history WHERE collection = $1 AND record = $2::uuid',
			params: [r.model, r.id]
		});
		recreations.set(k(r.model, r.id), {
			past,
			revision: (last[0]?.n ?? r.before) + 1
		});
	}
	const prospectiveTargets = new Set(recreations.keys());
	const writes: Write[] = [],
		restored: { model: string; id: string; revision: number }[] = [],
		rolledBack: RolledBack[] = [],
		skipped: Skipped[] = [...removed];
	for (const r of entries) {
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
			rolledBack.push({ model: r.model, id: r.id, action: 'removed' });
			continue;
		}
		if (now !== undefined) {
			if (Number(now['revision']) === r.before) continue;
			const previewed = yield* restorePreview(
				{ manifest: m, db },
				{ model: r.model, record: r.id, revision: r.before },
				null,
				bindings,
				prospectiveTargets
			);
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
			rolledBack.push({ model: r.model, id: r.id, action: 'restored' });
			continue;
		}
		// deleted inside the request: re-created at its next revision from its stored past
		const recreation = recreations.get(k(r.model, r.id));
		if (recreation === undefined) {
			skipped.push({ model: r.model, id: r.id, field: '*', reason: 'noHistory' });
			continue;
		}
		const model = cat.models.get(r.model)!;
		const values: Record<string, Json> = {};
		const links: (readonly [string, string, string])[] = [];
		for (const [column, value] of Object.entries(recreation.past)) {
			if (SYSTEM.has(column) || column.startsWith('bolt_')) continue;
			const f = model.fields.get(column);
			if (f !== undefined && (f.computed || f.kind === 'sum' || f.kind === 'count')) continue;
			const one = model.one.get(column);
			if (one !== undefined && typeof value === 'string')
				links.push([column, one.targets[0]!, value]);
			values[column] = stored(value);
		}
		const targets = yield* readRows(
			db,
			cat,
			links.map(([, target, id]) => [target, id] as const)
		);
		for (const [column, target, id] of links)
			if (!targets.has(k(target, id)) && !prospectiveTargets.has(k(target, id))) {
				values[column] = null;
				skipped.push({
					model: r.model,
					id: r.id,
					field: column,
					reason: 'deletedTarget'
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
		rolledBack.push({ model: r.model, id: r.id, action: 'recreated' });
	}
	return { writes, restored, rolledBack, skipped, observations };
});
