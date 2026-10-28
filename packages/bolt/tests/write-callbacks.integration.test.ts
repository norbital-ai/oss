// The common native act planner: every path splits and chunks by verb, children run after parents, one commit.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import { LIMITS, type Invocation } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { act, type ActRequest, type WriteEngine } from '../src/engine/write/act.ts';
import { Pristine } from '../src/node/db/pglite.ts';
import { admin, manifest as base, NOW, TODAY } from './write-fixture.ts';
import { open } from './write-p2.fixture.ts';

const manifest: EngineManifest = {
	...base,
	exposures: Object.fromEntries(
		Object.entries(base.exposures).map(([name, model]) => [
			name,
			{
				...model,
				...(model.create === undefined
					? {}
					: { create: { ...model.create, transform: true as const } }),
				...(model.update === undefined
					? {}
					: { update: { ...model.update, transform: true as const } }),
				...(model.delete === undefined ? {} : { delete: { check: true as const } })
			}
		])
	)
};
const Row = Schema.Record(Schema.String, Schema.Json);
const Rows = Schema.Array(Row);
const Updates = Schema.Array(Schema.Struct({ before: Row, set: Row }));
const setup = Effect.gen(function* () {
	const { db } = yield* open(manifest),
		calls: Invocation[] = [];
	let writes = 0,
		serial = 0;
	const database = TenantDb.typed({
		read: db.read,
		write: (sql, lock) => {
			writes++;
			return db.write(sql, lock);
		},
		transaction: (batch) =>
			Effect.suspend(() => {
				if (batch.rollback !== true) writes++;
				return db.transaction(batch);
			}),
		session: db.session
	});
	const engine: WriteEngine = {
		manifest,
		db: database,
		guest: {
			invokeProgram: () => Effect.die('This fixture executes native write callbacks only.'),
			invoke: (invocation) =>
				Effect.gen(function* () {
					calls.push(invocation);
					const rows: readonly (typeof Row.Type)[] =
						invocation.kind === 'update'
							? (yield* Schema.decodeUnknownEffect(Updates)(invocation.input).pipe(
									Effect.orDie
								)).map((change) => change.set)
							: yield* Schema.decodeUnknownEffect(Rows)(invocation.input).pipe(Effect.orDie);
					if (invocation.kind === 'delete') return { kind: 'ok' as const, output: null };
					return {
						kind: 'ok' as const,
						output: rows.map((values) => {
							return invocation.target === 'orders'
								? { ...values, note: 'parent callback' }
								: { ...values, label: String(values['label']).toUpperCase() };
						})
					};
				})
		}
	};
	const run = (request: Pick<ActRequest, 'verb' | 'input'> & Partial<ActRequest>) =>
		act(engine, {
			model: 'orders',
			mode: { _tag: 'Direct' },
			key: `callback-${serial}`,
			invocationId: `callback-${serial++}`,
			issuedAt: NOW,
			authority: admin,
			bindings: { now: NOW, today: TODAY, tz: 'UTC' },
			...request
		});
	return { db, calls, run, writes: () => writes };
});
// Check an outcome before using its ids so a refusal fails the edge case test at its original boundary.
const ids = (result: Effect.Success<ReturnType<typeof act>>) => {
	if (result.outcome.kind !== 'committed') throw new Error(JSON.stringify(result.outcome));
	return result.outcome.records;
};

describe('per-verb write callbacks', () => {
	it.effect(
		'runs a nested child after its parent and gives updates their actual before image',
		() =>
			Effect.gen(function* () {
				const { run, calls, db, writes } = yield* setup;
				const created = ids(
					yield* run({
						verb: 'create',
						input: [{ title: 'desk', lines: [{ label: 'tile', amount: '2' }] }]
					})
				);
				expect(calls.map((call) => [call.target, call.kind])).toEqual([
					['orders', 'create'],
					['lines', 'create']
				]);
				expect(writes()).toBe(1);
				const order = created.find((record) => record.model === 'orders');
				if (order === undefined)
					return yield* Effect.die('The native create omitted its root row.');
				ids(
					yield* run({ verb: 'update', input: [{ target: order.id, set: { title: 'measured' } }] })
				);
				const update = yield* Schema.decodeUnknownEffect(Rows)(calls.at(-1)?.input).pipe(
					Effect.orDie
				);
				expect(update).toMatchObject([
					{ before: { id: order.id, title: 'desk' }, set: { title: 'measured' } }
				]);
				expect(
					yield* db.rows(Schema.Struct({ label: Schema.String }), {
						text: 'SELECT label FROM lines',
						params: []
					})
				).toEqual([{ label: 'TILE' }]);
				ids(yield* run({ verb: 'delete', input: [{ target: order.id }] }));
				expect(calls.at(-1)?.kind).toBe('delete');
				expect(calls.at(-1)?.input).toMatchObject([{ id: order.id, title: 'measured' }]);
			}).pipe(Effect.provide(Pristine.layer))
	);

	it.effect(
		'splits a keyed import into creates and updates, while a kept match invokes no callback',
		() =>
			Effect.gen(function* () {
				const { run, calls } = yield* setup;
				ids(yield* run({ verb: 'create', input: [{ title: 'desk' }] }));
				calls.length = 0;
				const result = yield* run({
					verb: 'import',
					input: {
						rows: [{ title: 'desk', note: 'changed' }, { title: 'new' }],
						onConflict: 'update'
					}
				});
				ids(result);
				expect(calls.map((call) => call.kind).sort()).toEqual(['create', 'update']);
				expect(result.outcome).toMatchObject({
					output: {
						rows: [
							{ index: 0, action: 'updated' },
							{ index: 1, action: 'created' }
						]
					}
				});
				calls.length = 0;
				ids(
					yield* run({ verb: 'import', input: { rows: [{ title: 'desk' }], onConflict: 'keep' } })
				);
				expect(calls).toEqual([]);
			}).pipe(Effect.provide(Pristine.layer))
	);

	it.effect('creates a Sync id-map row under its named identity and runs its create callback', () =>
		Effect.gen(function* () {
			const { run, calls } = yield* setup;
			const id = '0199a000-0000-7000-8000-000000000011';
			const result = yield* run({
				verb: 'upsert',
				input: [{ id, title: 'remote' }],
				onConflict: 'update',
				mode: {
					_tag: 'Sync',
					sync: 'orders.sync.remote',
					instance: 'instance',
					fields: ['title', 'note'],
					deletes: [],
					pieces: () => {}
				}
			});
			expect(ids(result)).toContainEqual(expect.objectContaining({ id, model: 'orders' }));
			expect(calls.map((call) => call.kind)).toEqual(['create']);
		}).pipe(Effect.provide(Pristine.layer))
	);

	it.effect(
		'records callback results into the action sink without writing before the owner commits',
		() =>
			Effect.gen(function* () {
				const { run, calls, writes } = yield* setup;
				const planned: Json[] = [];
				ids(
					yield* run({
						verb: 'create',
						input: [{ title: 'recorded' }],
						mode: {
							_tag: 'Record',
							pending: new Map(),
							sink: (plan) => planned.push(plan.commit.output)
						}
					})
				);
				expect(calls.map((call) => call.kind)).toEqual(['create']);
				expect(planned).toHaveLength(1);
				expect(writes()).toBe(0);
			}).pipe(Effect.provide(Pristine.layer))
	);

	it.effect(
		'chunks a 4,000-row import into four calls, each with its own write budget, and one native commit',
		() =>
			Effect.gen(function* () {
				const { run, calls, writes } = yield* setup;
				const started = performance.now();
				ids(
					yield* run({
						verb: 'import',
						input: {
							rows: Array.from({ length: 4_000 }, (_, i) => ({ title: `bulk-${i}` })),
							onConflict: 'update'
						}
					})
				);
				expect(calls).toHaveLength(4);
				expect(
					calls.every(
						(call) =>
							Array.isArray(call.input) &&
							call.input.length === LIMITS.writeChunk &&
							call.budget.crossings === LIMITS.crossings.write
					)
				).toBe(true);
				expect(new Set(calls.map((call) => call.ctx.seed)).size).toBe(4);
				expect(writes()).toBe(1);
				expect(performance.now() - started).toBeLessThan(30_000);
			}).pipe(Effect.provide(Pristine.layer)),
		60_000
	);
});
