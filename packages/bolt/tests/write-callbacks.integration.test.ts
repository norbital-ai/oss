// The common native act planner: every path splits and chunks by verb, children run after parents, one commit.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Invocation } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { act, type ActRequest, type WriteEngine } from '../src/engine/write/act.ts';
import { admin, manifest as base, NOW, TODAY } from './write-fixture.ts';
import { open } from './write-p2.fixture.ts';

const order_model = base.models.orders;
if (order_model === undefined) throw new Error('The callback fixture needs the orders model.');
const manifest: EngineManifest = {
	...base,
	models: { ...base.models, orders: { ...order_model, key: ['title'], unique: [{ fields: ['title'], name: 'orders_title_key', import_key: true }] } },
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
			}
		])
	)
};
const Row = Schema.Record(Schema.String, Schema.Json);
const Changes = Schema.Array(Schema.Struct({ before: Schema.NullOr(Row), set: Row, after: Row }));
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
			})
	});
	const engine: WriteEngine = {
		manifest,
		db: database,
		guest: {
			invokeProgram: () => Effect.die('This fixture executes native write callbacks only.'),
			invoke: (invocation) =>
				Effect.gen(function* () {
					calls.push(invocation);
                    const rows = (yield* Schema.decodeUnknownEffect(Changes)(invocation.input).pipe(Effect.orDie)).map((change) => change.set);
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
                const changes = yield* Schema.decodeUnknownEffect(Changes)(calls[0]?.input).pipe(Effect.orDie);
                const root = changes[0];
                if (root === undefined) throw new Error('The root callback needs its change.');
                expect(root.before).toBeNull();
                expect(root.set).toMatchObject({ title: 'desk', lines: [{ label: 'tile' }] });
                expect(root.after).toMatchObject({ id: expect.any(String), title: 'desk', lines: [{ id: expect.any(String), label: 'tile' }] });
                expect(root.after['number']).toBeUndefined();
                expect(root.after['total']).toBeUndefined();
                const children = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(root.after['lines']).pipe(Effect.orDie);
                expect(children[0]).not.toHaveProperty('revision');
				expect(writes()).toBe(1);
				const order = created.find((record) => record.model === 'orders');
				if (order === undefined)
					return yield* Effect.die('The native create omitted its root row.');
				ids(
					yield* run({ verb: 'update', input: [{ target: order.id, set: { title: 'measured' } }] })
				);
				const update = yield* Schema.decodeUnknownEffect(Changes)(calls.at(-1)?.input).pipe(
					Effect.orDie
				);
				expect(update).toMatchObject([
					{ before: { id: order.id, title: 'desk', lines: [{ label: 'TILE' }] }, set: { title: 'measured' }, after: { id: order.id, title: 'measured', lines: [{ label: 'TILE' }] } }
				]);
				expect(
					yield* db.rows(Schema.Struct({ label: Schema.String }), {
						text: 'SELECT label FROM lines',
						params: []
					})
				).toEqual([{ label: 'TILE' }]);
				const callback_count = calls.length;
				ids(yield* run({ verb: 'delete', input: [{ target: order.id }] }));
				expect(calls).toHaveLength(callback_count);
				expect(yield* db.rows(Schema.Struct({ id: Schema.String }), { text: 'SELECT id FROM orders UNION ALL SELECT id FROM lines', params: [] })).toEqual([]);
			})
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
						on_conflict: 'update'
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
					yield* run({ verb: 'import', input: { rows: [{ title: 'desk' }], on_conflict: 'keep' } })
				);
				expect(calls).toEqual([]);
			})
	);

	it.effect('creates a Sync id-map row under its named identity and runs its create callback', () =>
		Effect.gen(function* () {
			const { run, calls } = yield* setup;
			const id = '0199a000-0000-7000-8000-000000000011';
			const result = yield* run({
				verb: 'upsert',
				input: [{ id, title: 'remote' }],
				on_conflict: 'update',
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
		})
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
			})
	);

	it.effect(
		'a nested child update through its parent runs the child update callback with its before image',
		() =>
			Effect.gen(function* () {
				const { run, calls } = yield* setup;
				const created = ids(
					yield* run({
						verb: 'create',
						input: [{ title: 'desk', lines: [{ label: 'tile', amount: '2' }] }]
					})
				);
				const order = created.find((record) => record.model === 'orders');
				const line = created.find((record) => record.model === 'lines');
				if (order === undefined || line === undefined)
					return yield* Effect.die('The native create omitted a row.');
				ids(
					yield* run({
						verb: 'update',
						input: [
							{
								target: order.id,
								set: { lines: { update: [{ target: line.id, set: { label: 'oak' } }] } }
							}
						]
					})
				);
				const child = calls.find((call) => call.target === 'lines' && call.kind === 'update');
				expect(child?.input).toMatchObject([
					{ before: { id: line.id, label: 'TILE' }, set: { label: 'oak' }, after: { id: line.id, label: 'oak' } }
				]);
			})
	);
 it.effect('a changed native callback input conflicts even when the callback makes no query', () =>
  Effect.gen(function* () {
   const {db} = yield* open(manifest);
   let armed=false, moved=false;
   const engine: WriteEngine={manifest,db,guest:{
    invokeProgram:()=>Effect.die('This case invokes only native callbacks.'),
    invoke:(inv)=>Effect.gen(function*(){
     const changes=yield* Schema.decodeUnknownEffect(Changes)(inv.input).pipe(Effect.orDie);
     // An independent writer commits after the native input snapshot has crossed into the guest.
     if(armed&&!moved){
      moved=true;
      yield* db.write({text:"UPDATE orders SET note='concurrent',revision=revision+1",params:[]}).pipe(Effect.orDie);
     }
     return {kind:'ok',output:changes.map(({set})=>set)};
    })
   }};
   const write=(verb:'create'|'update',input:Json,key:string)=>act(engine,{
    model:'orders',verb,input,key,invocationId:key,issuedAt:NOW,authority:admin,
    mode:{_tag:'Direct'},bindings:{now:NOW,today:TODAY,tz:'UTC'}
   });
   const made=ids(yield* write('create',[{title:'snapshot'}],'input-baseline'));
   const order=made.find(({model})=>model==='orders');
   if(order===undefined)throw new Error('The baseline order is required.');
   armed=true;
   expect((yield* write('update',[{target:order.id,set:{title:'stale proposal'}}],'input-race')).outcome).toMatchObject({kind:'conflict'});
   expect(moved).toBe(true);
   expect(yield* db.rows(Schema.Struct({title:Schema.String,note:Schema.String}),{text:'SELECT title,note FROM orders',params:[]})).toEqual([{title:'snapshot',note:'concurrent'}]);
  })
 );

});
