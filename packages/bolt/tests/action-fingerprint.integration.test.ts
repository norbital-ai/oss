import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { TestDb } from '../src/test/database.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Callables } from '../src/engine/services.ts';
import { routeFixture } from './support/route-fixture.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { program } from '../src/test/guest.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Json } from '../src/decl/values.ts';
import { manifest as base } from './write-fixture.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		quota: {
			description: 'Synthetic source',
			label: 'name',
			fields: { name: { kind: 'text' }, cap: { kind: 'int' } }
		},
		orders: {
			description: 'Synthetic derived rows',
			label: 'title',
			fields: { title: { kind: 'text' }, derived: { kind: 'text' } }
		}
	},
	relationships: {},
	exposures: {
		quota: { read: { quota: { fields: 'all' } } },
		orders: {
			read: { orders: { fields: 'all' } },
			create: { columns: { orders: ['title'] }, transform: true }
		}
	},
	policies: {
		operator: {
			description: 'Synthetic operator',
			automations: ['place', 'queryplace'],
			grants: {
				quota: { read: true },
				orders: { read: true, create: true }
			}
		}
	},
	apps: {},
	automations: {
		place: {
			description: 'Generated create',
			input: { title: { kind: 'text' } },
			runAs: 'trigger'
		},
		queryplace: {
			description: 'Read request pricing',
			input: { title: { kind: 'text' } },
			runAs: 'trigger'
		},
	},
	integrations: {},
	teams: {},
	customFields: {},
	connections: {},
	envoys: {},
	mcp: {},
	agent: { skills: {} }
};
const guest = program(`import { Effect } from 'effect';
const conflict = (effect) => effect.pipe(Effect.catchTag('ActConflict', error =>
 Effect.succeed({kind:'conflict',records:error.records})));
const place = (input,ctx) => ctx.act('orders.create',[input]);
export default {
 model:{orders:{bodies:{
  create:function*(inputs,ctx){
   if(inputs.every(input=>input.title==='querypriced'))return inputs.map(input=>({...input,derived:'priced'}));
   const {quota:source}=yield* ctx.db.query({quota:{fields:['cap']}});
   if(source.rows[0].cap===0)return yield* ctx.refuse('source changed');
   return inputs.map(input=>({...input,derived:String(source.rows[0].cap)}));
  }
 }}},
 automation:{
  place:{body:function*(input,ctx){return yield* conflict(place(input,ctx));}},
  queryplace:{body:function*(input,ctx){
   const {quota}=yield* ctx.query({quota:{fields:['cap']}});
   if(quota.rows[0].cap===0)return 'source changed';
   return yield* conflict(ctx.act('orders.create',[{title:'querypriced'}]));
  }}
 }
};`);
const RunRow = Schema.Struct({
	state: Schema.String,
	input: Schema.Json,
	output: Schema.Json,
	error: Schema.NullOr(Schema.Struct({ code: Schema.String, message: Schema.String }))
});
const Conflict = Schema.Struct({
	kind: Schema.Literal('conflict'),
	records: Schema.Array(Schema.Json)
});
const required = <A>(value: A | undefined): A => {
	if (value === undefined) throw new Error('Missing fingerprint fixture row');
	return value;
};
const fixture = () =>
	Effect.gen(function* () {
		let armed = false,
			moved = false,
			sourcePasses = 0;
		// the pooled checkpoint, read through a wrapper that moves the source after the first read of it once armed
		const baseContext = yield* Layer.build(TestDb.layer(manifest));
		const db = Context.get(baseContext, TenantDb);
		const intercepted = TenantDb.typed({
			read: (statements) =>
				Effect.gen(function* () {
					const result = yield* db.read(statements);
					if (armed && statements.some((statement) => /FROM\s+"?quota"?\b/i.test(statement.text))) {
						sourcePasses += 1;
						if (!moved) {
							moved = true;
							yield* db.write({ text: 'UPDATE quota SET cap=0, revision=revision+1', params: [] });
						}
					}
					return result;
				}),
			write: db.write,
			transaction: db.transaction,
			session: db.session
		});
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				guest: yield* guest,
				transforms: ['orders.create'],
				db: Layer.succeed(TenantDb, intercepted),
				seed: {
					quota: [
						{ id: '00000000-0000-4000-8000-000000000001', name: 'quota', cap: 1 },
						{ id: '00000000-0000-4000-8000-000000000002', name: 'other', cap: 999 }
					]
				}
			})
		);
		const t = Context.get(context, TestWorkspace),
			calls = Context.get(context, Callables);
		const caller = t.as(t.member(['operator']));
		const route = yield* routeFixture(context);
		const bindings = () => ({
			now: t.clock.now(),
			today: t.clock.now().slice(0, 10),
			tz: 'UTC'
		});
		const act = (callable: string, input: Json) =>
			route.dispatch({ callable, input, key: randomUUID(), issuedAt: t.clock.now() }, caller.authority);
		const batch = (acts: Parameters<typeof calls.acts>[0]['acts']) => {
			const key = randomUUID();
			return calls.acts({
				name: 'act.many',
				acts,
				authority: caller.authority,
				bindings: bindings(),
				key,
				invocationId: key,
				issuedAt: t.clock.now(),
				from: 'Server'
			});
		};
		const start = (automation: string, input: Json) =>
			Effect.gen(function* () {
				const id = randomUUID();
				const outcome = yield* calls.start({
					automation,
					runs: [{ id, input }],
					authority: caller.authority,
					bindings: bindings()
				});
				return { id, outcome };
			});
		const run = (id: string) =>
			t.db
				.rows(RunRow, {
					text: 'select state,input,output,error from sys_run where id=$1',
					params: [id]
				})
				.pipe(Effect.map((rows) => rows[0]));
		armed = true;
		/** Puts the source back and arms the move again, for the next act on the same workspace. */
		const rearm = Effect.gen(function* () {
			yield* db.write({ text: 'UPDATE quota SET cap=1, revision=revision+1', params: [] });
			armed = true;
			moved = false;
			sourcePasses = 0;
		});
		return {
			rearm,
			t,
			caller,
			act,
			batch,
			start,
			run,
			moved: () => moved,
			sourcePasses: () => sourcePasses,
			count: () => db.value(Schema.Number, { text: 'SELECT count(*)::int FROM orders', params: [] })
		};
	});

it.live(
	'a changed source conflicts: a direct callback, a generated batch, and queued callback and prior-query fingerprints',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				assert.equal(
					(yield* f.act('orders.create', [{ title: 'priced against old source' }])).outcome.kind,
					'conflict'
				);
				assert.equal(f.moved(), true);
				assert.equal(f.sourcePasses(), 1, 'the direct replay retains its first read answer');
				assert.equal(yield* f.count(), 0);
				yield* f.rearm;
				const result = yield* f.batch([
					{ model: 'orders', verb: 'create', input: [{ title: 'first' }] },
					{ model: 'orders', verb: 'create', input: [{ title: 'second' }] }
				]);
				assert.equal(f.moved(), true);
				if (result.outcome.kind !== 'refused') throw new Error(JSON.stringify(result.outcome));
				assert.equal(result.outcome.message, 'source changed');
				assert.equal(f.sourcePasses(), 2, 'the atomic batch rechecks the current source once');
				assert.deepEqual(result.captured, []);
				assert.equal(yield* f.count(), 0);
				// a callback fingerprint and a prior-query fingerprint
				for (const automation of ['place', 'queryplace']) {
					yield* f.rearm;
					const started = yield* f.start(automation, { title: 'priced against old source' });
					assert.equal(started.outcome.kind, 'committed');
					yield* f.t.runDue();
					const run = required(yield* f.run(started.id));
					assert.equal(f.moved(), true, 'mutation must occur after the actual source read');
					assert.equal(run.state, 'succeeded');
					assert.deepEqual((yield* Schema.decodeUnknownEffect(Conflict)(run.output)).records, []);
					assert.equal(yield* f.count(), 0);
				}
			})
		)
);
