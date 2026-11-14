import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { catalog } from '../src/protocol/catalog.ts';
import { read_engine } from '../src/engine/query/engine.ts';
import { prospectiveBridge } from '../src/engine/write/prospective.ts';
import type { WriteEngine } from '../src/engine/write/act.ts';
import type { Item } from '../src/engine/write/flatten.ts';
import type { Bridge } from '../src/engine/services.ts';
import { admin, manifest, NOW, TODAY } from './write-fixture.ts';
import { open } from './write-p2.fixture.ts';
import { with_each } from './support/guest-each.ts';

it.effect(
	'a child-only prospective read ignores an unread staged parent sequence, while a read of it still refuses',
	() =>
		Effect.gen(function* () {
			const { db } = yield* open(manifest);
			const bindings = { now: NOW, today: TODAY, tz: 'UTC' };
			const reader = read_engine({ db, manifest });
			const original: Bridge = {
				cross: (calls) =>
					reader
						.run(
							calls.flatMap((call) => (call._tag === 'read' ? [call.read] : [])),
							{ as: 'workspace' },
							bindings
						)
						.pipe(
							Effect.map((answers) => answers.map((value) => ({ ok: true as const, value }))),
							Effect.orDie
						)
			};
			const engine: WriteEngine = {
				db,
				manifest,
				guest: with_each({
					invoke: () => Effect.die('No guest is invoked by a prospective read.'),
					invokeProgram: () => Effect.die('No program is invoked by a prospective read.')
				})
			};
			const order = '0199a000-0000-7000-8000-000000000001';
			const line = '0199a000-0000-7000-8000-000000000002';
			const staged: Item[] = [
				{
					change: {
						op: 'create',
						model: 'orders',
						id: order,
						path: [],
						values: { title: 'Parent' }
					},
					supplied: ['title'],
					refs: []
				},
				{
					change: {
						op: 'create',
						model: 'lines',
						id: line,
						path: [],
						values: { order, label: 'Child', amount: '2' }
					},
					supplied: ['order', 'label', 'amount'],
					refs: []
				}
			];
			const bridge = prospectiveBridge(
				engine,
				catalog(manifest),
				bindings,
				admin.actor,
				staged,
				new Map(),
				original
			);
			// an `as_of: 'act'` root of a read request: every row of the model as the act leaves it
			const act = (model: string, fields: readonly string[]) =>
				bridge.cross([
					{
						_tag: 'read',
						read: {
							kind: 'request',
							roots: [
								{
									root: model,
									prospective: true,
									read: {
										kind: 'read',
										model,
										where: { t: 'const', value: true },
										select: { fields, relations: {} },
										page: { _tag: 'All' }
									}
								}
							]
						}
					}
				]);
			const result = yield* act('lines', ['id', 'label']);
			expect(result).toMatchObject([{ ok: true, value: { lines: { rows: [{ id: line, label: 'Child' }] } } }]);
			// a workspace row holds no seq or roll-up: the read names the staged sequence to depend on it
			const generated = yield* act('orders', ['id', 'number']);
			expect(generated).toMatchObject([{ ok: false, error: { code: 'prepared_computed' } }]);
		})
);
