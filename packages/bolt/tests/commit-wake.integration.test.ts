import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { Live, Links, Wake } from '../src/engine/services.ts';
import { committed, executeCommit, type Commit } from '../src/engine/write/commit.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TestDb } from '../src/test/database.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import { manifest as base, NOW, TODAY } from './write-fixture.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';

it.effect(
	'a commit wakes its exact queued due time and reconciles only its changed instances',
	() =>
		Effect.gen(function* () {
			const due: string[] = [],
				changed: string[] = [];
			let published = 0;
			const layer = Layer.mergeAll(
				Layer.mock(Wake, {
					at: (at) =>
						Effect.sync(() => {
							due.push(at);
						})
				}),
				Layer.mock(Links, {
					changed: (instance) =>
						Effect.sync(() => {
							changed.push(instance);
						})
				}),
				Layer.mock(Live, { publish: () => ++published, syncChanged: () => ++published })
			);
			const at = '2026-10-14T22:05:00.000Z';
			expect(
				yield* committed({ captured: [], next_due: at, changed_instances: ['calendar'] }).pipe(
					Effect.provide(layer)
				)
			).toBe(1);
			expect(due).toEqual([at]);
			expect(changed).toEqual(['calendar']);
			yield* committed({ captured: [], next_due: null, changed_instances: [] }).pipe(
				Effect.provide(layer)
			);
			expect(due).toEqual([at]);
			expect(changed).toEqual(['calendar']);
		})
);

it.effect('a mixed commit purges only erased history and triggers only ordinary changes', () =>
	Effect.gen(function* () {
		const manifest: EngineManifest = {
			...base,
			automations: {
				changed: { description: 'Changed orders', on: { updated: 'orders' }, runAs: 'trigger' }
			}
		};
		const pg = yield* TestDb.open(manifest),
			db = PgliteDb.make(pg);
		const first = '0199a000-0000-4000-8000-000000000071',
			second = '0199a000-0000-4000-8000-000000000072';
		const common: Omit<Commit, 'writes'> = {
			key: 'seed',
			digest: 'seed',
			issuedAt: NOW,
			now: NOW,
			today: TODAY,
			actor: { kind: 'system', run: 'test', by: { automation: 'changed' } },
			owned: [],
			rate: [],
			runs: [],
			notices: [],
			output: null
		};
		yield* executeCommit(db, manifest, catalogOf(manifest), {
			...common,
			writes: [
				{
					model: 'orders',
					id: first,
					op: 'create',
					values: { title: 'erase', note: 'personal' }
				},
				{
					model: 'orders',
					id: second,
					op: 'create',
					values: { title: 'ordinary', note: 'retained' }
				}
			]
		});
		const [answer] = yield* executeCommit(db, manifest, catalogOf(manifest), {
			...common,
			key: 'mixed',
			digest: 'mixed',
			writes: [
				{
					model: 'orders',
					id: first,
					op: 'update',
					revision: 1,
					set: { note: null },
					erased: true
				},
				{
					model: 'orders',
					id: second,
					op: 'update',
					revision: 1,
					set: { title: 'ordinary changed' },
					erased: false
				}
			],
			erasures: [{ mode: 'anonymise', model: 'orders', ids: [first], purge: ['note'] }]
		});
		expect(answer?.captured.map((row) => ({ id: row.id, cause: row.cause }))).toEqual([
			{ id: first, cause: 'erased' },
			{ id: second, cause: 'direct' }
		]);
		const runs = yield* db.read([{ text: 'SELECT input FROM sys_run ORDER BY id', params: [] }]);
		expect(runs[0]?.rows).toEqual([{ input: { model: 'orders', ids: [second] } }]);
		const history = yield* db.read([
			{
				text: 'SELECT record::text AS id, changes FROM bolt_history WHERE revision = 1 ORDER BY record',
				params: []
			}
		]);
		expect(history[0]?.rows[0]?.['changes']).not.toHaveProperty('note');
		expect(history[0]?.rows[1]?.['changes']).toHaveProperty('note', 'retained');
	})
);
