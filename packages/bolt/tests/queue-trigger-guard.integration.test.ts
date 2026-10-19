import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { PgliteDb, Pristine } from '../src/engine/db/pglite.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { queueTriggered } from '../src/engine/runs/queue.ts';
import { Chain } from '../src/engine/write/sql.ts';
import { manifest as base, NOW } from './write-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';

// A named integration slot (`field_ops_whatsapp`) is keyed by text: a filtered trigger on another collection must not
// cast its image into that collection's row type (uuid id), or every status write of the slot fails.
it.effect("a filtered trigger never casts another collection's row image", () =>
	Effect.gen(function* () {
		const manifest: EngineManifest = {
			...base,
			automations: {
				unnoted: {
					description: 'Orders without a note',
					on: { updated: 'orders', fields: ['title'], where: { note: { isNull: true } } },
					runAs: 'trigger'
				}
			}
		};
		const db = PgliteDb.make(yield* PgliteDb.open());
		yield* applyPlan(db, plan(null, manifest), { accept: true });
		const order = '0199a000-0000-4000-8000-000000000091';
		const c = new Chain();
		c.cte(
			'source',
			`SELECT * FROM (VALUES
				('tags'::text, 'named_slot'::text, 'update'::text, '{"id":"named_slot","title":"a"}'::jsonb, '{"id":"named_slot","title":"b"}'::jsonb),
				('orders', '${order}', 'update', '{"id":"${order}","title":"a"}', '{"id":"${order}","title":"b"}')
			) AS x(c, id, op, o, n)`
		);
		queueTriggered(manifest, c, NOW, 'system', 'source');
		yield* db.write(c.sql('1 AS ok'));
		const [queued] = yield* db.read([
			{ text: `SELECT automation, input->'ids' AS ids FROM sys_run`, params: [] }
		]);
		expect(queued?.rows).toEqual([{ automation: 'unnoted', ids: [order] }]);
	}).pipe(Effect.scoped, Effect.provide(Pristine.layer))
);
