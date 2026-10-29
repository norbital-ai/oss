// `bolt.index`: a pack's rows are written past the acts that evaluate pure search vectors; this run fills each pure
// index's missing vectors after the load, a guest batch at a time, writing the vector column only (derived data: no
// audit, effect or notice).
import { Clock, Effect, Schema } from 'effect';
import { indexColumn, q } from '@norbital-ai/store';
import { LIMITS } from '../contracts.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { Guest, Manifest, Wake, type RunHandler } from '../services.ts';
import { catalogOf } from '../access/pred.ts';
import { bindingsAt } from '../query/reader.ts';
import { Chain } from './sql.ts';
import { enqueue } from '../runs/queue.ts';
import { iso } from '../runs/time.ts';
import { k, pureVectors, readRows } from './act.ts';

export const INDEX = 'bolt.index';
/** Rows one run evaluates before it queues its continuation, keeping a run inside its CPU budget. */
const RUN_ROWS = 5 * LIMITS.writeChunk;
const Cursor = Schema.Struct({ model: Schema.String, index: Schema.String, after: Schema.String });
const Pending = Schema.Struct({ id: Schema.String, revision: Schema.Number });

export const indexRun = Effect.gen(function* () {
	const manifest = yield* Manifest,
		db = yield* TenantDb,
		guest = yield* Guest,
		wake = yield* Wake;
	const cat = catalogOf(manifest);
	const run: RunHandler = (input, { id }) =>
		Effect.gen(function* () {
			const from = Schema.is(Cursor)(input) ? input : undefined;
			const indexes = Object.entries(manifest.models).flatMap(([model, spec]) =>
				Object.entries(spec.search?.indexes ?? {}).flatMap(([name, index]) =>
					index.field === undefined ? [{ model, name, dim: index.dim }] : []
				)
			);
			const start = Math.max(
				0,
				indexes.findIndex(({ model, name }) => model === from?.model && name === from?.index)
			);
			let indexed = 0,
				selected = 0;
			for (const { model, name, dim } of indexes.slice(start)) {
				const column = indexColumn(name);
				for (
					let after = from?.model === model && from.index === name ? from.after : '', batch = 0;
					;
					batch++
				) {
					if (selected >= RUN_ROWS) {
						const at = iso(yield* Clock.currentTimeMillis),
							c = new Chain();
						enqueue(c, [
							{
								automation: INDEX,
								input: { model, index: name, after },
								dueAt: at,
								cause: 'continue',
								depth: 0
							}
						]);
						yield* db.write(c.sql('NULL AS outcome'));
						yield* wake.at(at);
						return { indexed, continued: true };
					}
					const pending = yield* db.rows(Pending, {
						text: `SELECT id::text AS id, revision FROM ${q(model)} WHERE ${q(column)} IS NULL AND id::text > $1 ORDER BY id::text LIMIT ${LIMITS.writeChunk}`,
						params: [after]
					});
					const last = pending.at(-1);
					if (last === undefined) break;
					after = last.id;
					selected += pending.length;
					const rows = yield* readRows(
						db,
						cat,
						pending.map((row) => [model, row.id] as const)
					);
					const now = yield* Clock.currentTimeMillis;
					const g = yield* pureVectors(
						guest,
						model,
						name,
						dim,
						pending.map((row) => ({ ...rows.get(k(model, row.id)), id: row.id })),
						{
							actor: { kind: 'system', run: id, by: { platform: INDEX } },
							...bindingsAt(now, manifest.workspace.tz),
							seed: `${id}:vector:${model}:${name}:${batch}`
						}
					);
					if ('failed' in g) return yield* Effect.fail(g.failed);
					const set = pending.flatMap((row, position) => {
						const vector = g.vectors[position];
						return vector == null
							? []
							: [{ id: row.id, revision: row.revision, v: JSON.stringify(vector) }];
					});
					if (set.length === 0) continue;
					// a row written since it was read carries its own act's vector
					const result = yield* db.write({
						text: `UPDATE ${q(model)} t SET ${q(column)} = v.v::vector FROM jsonb_to_recordset($1::jsonb) AS v(id text, revision int, v text) WHERE t.id::text = v.id AND t.revision = v.revision AND t.${q(column)} IS NULL RETURNING t.id`,
						params: [JSON.stringify(set)]
					});
					indexed += result.rows.length;
				}
			}
			return { indexed };
		});
	return run;
});
