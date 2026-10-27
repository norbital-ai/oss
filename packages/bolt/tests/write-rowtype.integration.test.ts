import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { act, type ActRequest } from '../src/engine/write/act.ts';
import { restoreSource, seed } from '../src/engine/write/seed.ts';
import { Pristine } from '../src/node/db/pglite.ts';
import { admin, manifest as base, NOW, TODAY } from './write-fixture.ts';
import { open } from './write-p2.fixture.ts';

const PARENT = '0199a000-0000-7000-8000-000000000001';
const CHILD = '0199a000-0000-7000-8000-000000000002';
const manifest: EngineManifest = {
	...base,
	models: {
		point: {
			description: 'A parent named after a PostgreSQL type, with its child roll-up.',
			label: 'code',
			key: ['code'],
			fields: { code: { kind: 'text' }, total: { kind: 'sum', of: 'lines.amount' } }
		},
		line: {
			description: 'A child named after a PostgreSQL type, with row alias collisions.',
			label: 'code',
			key: ['code'],
			fields: {
				code: { kind: 'text' },
				amount: { kind: 'int' },
				__store_row: { kind: 'text', default: 'first' },
				__store_row_: { kind: 'text', default: 'second' }
			}
		}
	},
	relationships: { 'line.point': { to: 'point', inverse: 'lines' } },
	exposures: {
		point: {
			read: { point: { fields: 'all' } },
			create: { columns: { point: ['code'] } },
			update: { columns: { point: ['code'] } }
		},
		line: {
			read: { line: { fields: 'all' } },
			create: { columns: { line: ['code', 'amount', 'point'] } },
			update: { columns: { line: ['code', 'amount'] } },
			delete: {}
		}
	}
};

it.effect('writes models named after Postgres types using their actual relation row types', () =>
	Effect.gen(function* () {
		const { db } = yield* open(manifest);
		yield* seed(
			manifest,
			db,
			restoreSource({
				point: [{ id: PARENT, code: 'P', total: 2 }],
				line: [{ id: CHILD, code: 'L', point: PARENT, amount: 2 }]
			}),
			NOW
		);
		let serial = 0;
		const run = (
			model: string,
			verb: ActRequest['verb'],
			input: Json,
			onConflict?: 'update' | 'keep'
		) =>
			act(
				{ manifest, db },
				{
					model,
					verb,
					input,
					onConflict,
					mode: { _tag: 'Direct' },
					key: `rowtype-${serial}`,
					invocationId: `rowtype-${serial++}`,
					issuedAt: NOW,
					authority: admin,
					bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} }
				}
			).pipe(
				Effect.map((result) => {
					expect(result.outcome.kind).toBe('committed');
					return result;
				})
			);
		yield* run('point', 'create', [{ code: 'Q' }]);
		yield* run('point', 'update', [{ target: PARENT, set: { code: 'P2' } }]);
		yield* run('line', 'create', [{ code: 'NEW', amount: 3, point: PARENT }]);
		yield* run('line', 'update', [{ target: CHILD, set: { amount: 4 } }]);
		yield* run('line', 'upsert', [{ code: 'L', amount: 5, point: PARENT }], 'update');
		yield* run('line', 'import', {
			rows: [{ code: 'IMPORTED', amount: 1, point: { code: 'P2' } }],
			onConflict: 'update'
		});
		yield* run('line', 'delete', [{ target: CHILD }]);
		expect(
			yield* db.rows(Schema.Struct({ total: Schema.String }), {
				text: 'SELECT total::text AS total FROM point WHERE id = $1',
				params: [PARENT]
			})
		).toEqual([{ total: '4' }]);
		expect(
			yield* db.rows(Schema.Struct({ first: Schema.String, second: Schema.String }), {
				text: 'SELECT __store_row AS first, __store_row_ AS second FROM line WHERE code = $1',
				params: ['IMPORTED']
			})
		).toEqual([{ first: 'first', second: 'second' }]);
	}).pipe(Effect.provide(Pristine.layer))
);
