// `attaches`: a create payload sets an existing row's optional ref to the new row, in the same commit, without an inverse.
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { PGlite } from '@electric-sql/pglite';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { TenantDbShape as TenantDb } from '../src/engine/db/tenant-db.ts';
import type { Json } from '../src/decl/values.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { act, k, readRows } from '../src/engine/write/act.ts';
import { catalogOf } from '../src/engine/access/pred.ts';
import { admin, authority, grants, manifest, NOW, TODAY, writeArm } from './write-fixture.ts';

const base = manifest.exposures.orders;
if (base?.create === undefined) throw new Error('The write fixture must expose orders.create.');
const m: EngineManifest = {
	...manifest,
	exposures: {
		...manifest.exposures,
		orders: {
			...base,
			create: { ...base.create, attaches: { tags: { model: 'tags', field: 'order' } } }
		}
	}
};
const caller = authority({
	orders: grants('orders', { create: [writeArm({ orders: ['title'] })] }),
	tags: grants('tags', { update: [writeArm({ tags: ['order'] })] })
});
const sealed = authority({
	orders: grants('orders', { create: [writeArm({ orders: ['title'] })] })
});
let pg: PGlite, db: TenantDb;
let n = 0;
const run = (model: string, input: Json, who = caller) =>
	act(
		{ manifest: m, db },
		{
			model,
			verb: 'create',
			input: [input],
			mode: { _tag: 'Direct' },
			key: `attaches-${n}`,
			invocationId: `attaches-${n++}`,
			issuedAt: NOW,
			authority: who,
			bindings: { now: NOW, today: TODAY, tz: 'UTC' }
		}
	);
const setup = Effect.fnUntraced(function* () {
	pg = yield* TestDb.open(m);
	db = PgliteDb.make(pg);
});
const createTag = Effect.fnUntraced(function* () {
	const tag = yield* run('tags', { name: 'free' }, admin);
	if (tag.outcome.kind !== 'committed')
		return yield* Effect.fail(new Error('The attach target must exist.'));
	const id = tag.outcome.records[0]?.id;
	if (id === undefined) return yield* Effect.fail(new Error('The attach target must exist.'));
	return id;
});

it.live('attaches an existing optional ref in the same commit', () =>
	Effect.gen(function* () {
		yield* setup();
		const tag = yield* createTag();
		const order = yield* run('orders', { title: 'one', attaches: { tags: [tag] } });
		if (order.outcome.kind !== 'committed')
			return yield* Effect.fail(new Error(JSON.stringify(order.outcome)));
		const id = order.outcome.records[0]?.id;
		expect(id).toBeDefined();
		const rows = yield* readRows(db, catalogOf(m), [['tags', tag]]);
		expect(rows.get(k('tags', tag))?.['order']).toBe(id);
	})
);
it.live('refuses a target that is already attached', () =>
	Effect.gen(function* () {
		yield* setup();
		const tag = yield* createTag();
		expect((yield* run('orders', { title: 'one', attaches: { tags: [tag] } })).outcome.kind).toBe(
			'committed'
		);
		const again = yield* run('orders', { title: 'two', attaches: { tags: [tag] } });
		expect(again.outcome).toMatchObject({ kind: 'refused', code: 'invalidInput' });
		const orders = yield* db.read([{ text: 'SELECT title FROM orders', params: [] }]);
		expect(orders[0]?.rows).toEqual([{ title: 'one' }]);
	})
);
it.live('refuses a caller that may not write the target ref', () =>
	Effect.gen(function* () {
		yield* setup();
		const tag = yield* createTag();
		const order = yield* run('orders', { title: 'one', attaches: { tags: [tag] } }, sealed);
		expect(order.outcome).toMatchObject({ kind: 'refused', code: 'forbidden' });
		const rows = yield* readRows(db, catalogOf(m), [['tags', tag]]);
		expect(rows.get(k('tags', tag))?.['order']).toBeNull();
	})
);
