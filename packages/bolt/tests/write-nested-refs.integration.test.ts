// Typed IDs inside stored values must retain the reference admission of a relational child.
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import type { PGlite } from '@electric-sql/pglite';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { TenantDbShape as TenantDb } from '../src/engine/db/tenant-db.ts';
import type { Json } from '../src/decl/values.ts';
import { toPred } from '../src/engine/access/pred.ts';
import { PgliteDb, Pristine } from '../src/node/db/pglite.ts';
import { applyPlan, plan } from '../src/engine/schema/plan.ts';
import { act } from '../src/engine/write/act.ts';
import { admin, arm, authority, grants, manifest, NOW, TODAY, writeArm } from './write-fixture.ts';
const orderModel = manifest.models.orders,
	orderExposure = manifest.exposures.orders;
if (orderModel === undefined || orderExposure === undefined)
	throw new Error('The write fixture must contain orders.');
const m: EngineManifest = {
	...manifest,
	models: {
		...manifest.models,
		orders: {
			...orderModel,
			fields: {
				...orderModel.fields,
				preferences: { kind: 'custom', of: 'preferences', optional: true },
				metadata: {
					kind: 'json',
					optional: true,
					shape: {
						kind: 'object',
						fields: {
							groups: {
								kind: 'list',
								of: {
									kind: 'object',
									fields: {
										target: { kind: 'id', of: 'tags', optional: true }
									}
								}
							}
						}
					}
				}
			}
		}
	},
	exposures: {
		...manifest.exposures,
		orders: {
			...orderExposure,
			create: { columns: { orders: ['title', 'preferences', 'metadata'] } },
			update: { columns: { orders: ['preferences', 'metadata'] } }
		}
	},
	customFields: {
		preferences: {
			description: 'Ranked targets.',
			shape: { kind: 'list', max: 5, of: { kind: 'id', of: 'tags' } }
		}
	}
};
let pg: PGlite, db: TenantDb;
let n = 0;
const visible = authority({
	orders: grants('orders', {
		create: [writeArm({ orders: ['title', 'preferences', 'metadata'] })],
		update: [writeArm({ orders: ['preferences', 'metadata'] })]
	}),
	tags: grants('tags', { read: { tags: [arm(toPred(m, 'tags', { name: { eq: 'visible' } }))] } })
});
const run = (input: Json, verb: 'create' | 'update' = 'create', caller = visible) =>
	act(
		{ manifest: m, db },
		{
			model: 'orders',
			verb,
			input,
			mode: { _tag: 'Direct' },
			key: `nested-${n}`,
			invocationId: `nested-${n++}`,
			issuedAt: NOW,
			authority: caller,
			bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} }
		}
	);
let allowed: string, hidden: string;
const setup = Effect.fnUntraced(function* () {
	pg = yield* PgliteDb.open();
	db = PgliteDb.make(pg);
	yield* applyPlan(db, yield* plan(null, m), { accept: true });
	const tags = yield* act(
		{ manifest: m, db },
		{
			model: 'tags',
			verb: 'create',
			mode: { _tag: 'Direct' },
			input: [{ name: 'visible' }, { name: 'hidden' }],
			key: `tags-${n}`,
			invocationId: `tags-${n++}`,
			issuedAt: NOW,
			authority: admin,
			bindings: { now: NOW, today: TODAY, tz: 'UTC', params: {} }
		}
	);
	if (tags.outcome.kind !== 'committed')
		return yield* Effect.fail(new Error(JSON.stringify(tags.outcome)));
	const first = tags.outcome.records[0],
		second = tags.outcome.records[1];
	if (first === undefined || second === undefined)
		return yield* Effect.fail(new Error('Both reference targets must exist.'));
	allowed = first.id;
	hidden = second.id;
});
it.live('refuses unreadable and missing custom list targets without creating the parent', () =>
	Effect.gen(function* () {
		yield* setup();
		for (const id of [hidden, '0199a000-0000-7000-8000-0000000000ff']) {
			const result = yield* run({ title: 'blocked', preferences: [allowed, id] });
			expect(result.outcome).toMatchObject({
				kind: 'refused',
				code: 'notFound',
				field: 'preferences.1'
			});
			expect(result.captured).toEqual([]);
		}
		expect((yield* db.read([{ text: 'SELECT title FROM orders', params: [] }]))[0]?.rows).toEqual(
			[]
		);
	}).pipe(Effect.provide(Pristine.layer))
);
it.live('checks IDs nested in JSON objects and lists, preserving nullable targets', () =>
	Effect.gen(function* () {
		yield* setup();
		const denied = yield* run({
			title: 'blocked',
			metadata: { groups: [{ target: null }, { target: hidden }] }
		});
		expect(denied.outcome).toMatchObject({
			kind: 'refused',
			code: 'notFound',
			field: 'metadata.groups.1.target'
		});
		expect((yield* db.read([{ text: 'SELECT title FROM orders', params: [] }]))[0]?.rows).toEqual(
			[]
		);
		expect(
			(yield* run({
				title: 'accepted',
				metadata: { groups: [{ target: null }, { target: allowed }] }
			})).outcome.kind
		).toBe('committed');
		expect(
			(yield* db.read([{ text: 'SELECT metadata FROM orders', params: [] }]))[0]?.rows
		).toEqual([{ metadata: { groups: [{ target: null }, { target: allowed }] } }]);
	}).pipe(Effect.provide(Pristine.layer))
);
it.live('retains the existing value when an update supplies an unreadable reference', () =>
	Effect.gen(function* () {
		yield* setup();
		const created = yield* run({ title: 'accepted', preferences: [allowed] });
		if (created.outcome.kind !== 'committed')
			return yield* Effect.fail(new Error(JSON.stringify(created.outcome)));
		const row = created.outcome.records.find((record) => record.model === 'orders');
		if (row === undefined) return yield* Effect.fail(new Error('The booking must be committed.'));
		expect(
			(yield* run({ target: row.id, set: { preferences: [hidden] } }, 'update')).outcome
		).toMatchObject({ kind: 'refused', code: 'notFound', field: 'preferences.0' });
		expect(
			(yield* db.read([{ text: 'SELECT preferences, revision FROM orders', params: [] }]))[0]?.rows
		).toEqual([{ preferences: [allowed], revision: 1 }]);
	}).pipe(Effect.provide(Pristine.layer))
);
it.live('decodes a custom shape before reference admission and writes only valid values', () =>
	Effect.gen(function* () {
		yield* setup();
		expect((yield* run({ title: 'invalid', preferences: [17] })).outcome).toMatchObject({
			kind: 'refused',
			code: 'invalidInput',
			field: 'preferences'
		});
		expect((yield* db.read([{ text: 'SELECT title FROM orders', params: [] }]))[0]?.rows).toEqual(
			[]
		);
		expect((yield* run({ title: 'accepted', preferences: [allowed] })).outcome.kind).toBe(
			'committed'
		);
		expect(
			(yield* db.read([{ text: 'SELECT preferences FROM orders', params: [] }]))[0]?.rows
		).toEqual([{ preferences: [allowed] }]);
	}).pipe(Effect.provide(Pristine.layer))
);
