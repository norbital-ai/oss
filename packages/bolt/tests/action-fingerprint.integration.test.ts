import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { Callables } from '../src/engine/services.ts';
import { routeFixture } from './support/route-fixture.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';
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
		narrow: {
			description: 'Own labels only',
			automations: ['inspect'],
			grants: { quota: { read: { quota: { where: { name: { eq: 'quota' } }, fields: ['name'] } } } }
		},
		starteronly: {
			description: 'Start without a write grant',
			automations: ['outer', 'place'],
			grants: { orders: { read: true }, quota: { read: true } }
		},
		noquery: {
			description: 'Start without a read grant on the source',
			automations: ['queryplace'],
			grants: { orders: { read: true, create: true } }
		},
		operator: {
			description: 'Synthetic operator',
			automations: ['outer', 'place', 'fail', 'queryplace', 'readplace'],
			grants: {
				quota: { read: true },
				orders: { read: true, create: true }
			}
		}
	},
	apps: {},
	automations: {
		inspect: {
			description: 'Caller evidence',
			input: {},
			output: { kind: 'text' },
			runAs: 'trigger'
		},
		outer: {
			description: 'Local nested helpers',
			input: { title: { kind: 'text' } },
			runAs: 'trigger'
		},
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
		readplace: {
			description: 'Caller read pricing',
			input: { title: { kind: 'text' } },
			runAs: 'trigger'
		},
		fail: {
			description: 'Atomic generated batch refusal',
			input: { title: { kind: 'text' } },
			runAs: 'trigger'
		}
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
const nested = (input,ctx) => place(input,ctx);
export default {
 model:{orders:{bodies:{
  create:function*(inputs,ctx){
   if(inputs.some(input=>input.title==='refuse'))return yield* ctx.refuse('late failure');
   if(inputs.every(input=>input.title==='querypriced'))return inputs.map(input=>({...input,derived:'priced'}));
   const {quota:source}=yield* ctx.db.query({quota:{fields:['cap']}});
   if(source.rows[0].cap===0)return yield* ctx.refuse('source changed');
   return inputs.map(input=>({...input,derived:input.title==='giant'?'x'.repeat(4194304):String(source.rows[0].cap)}));
  }
 }}},
 automation:{
  inspect:{body:function*(input,ctx){
   return JSON.stringify((yield* ctx.query({quota:{fields:['name','cap']}})).quota.rows);
  }},
  outer:{body:function*(input,ctx){return yield* conflict(nested(input,ctx));}},
  place:{body:function*(input,ctx){return yield* conflict(place(input,ctx));}},
  queryplace:{body:function*(input,ctx){
   const {quota}=yield* ctx.query({quota:{fields:['cap']}});
   if(quota.rows[0].cap===0)return 'source changed';
   return yield* conflict(ctx.act('orders.create',[{title:'querypriced'}]));
  }},
  readplace:{body:function*(input,ctx){
   const source=(yield* ctx.query({quota:{fields:['cap']}})).quota;
   if(source.rows[0].cap===0)return 'source changed';
   return yield* conflict(ctx.act('orders.create',[{title:'querypriced'}]));
  }},
  fail:{body:function*(input,ctx){return yield* ctx.act.many([
   {callable:'orders.create',input:[{title:input.title}]},
   {callable:'orders.create',input:[{title:'refuse'}]}
  ]);}}
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
const Committed = Schema.Struct({
	kind: Schema.Literal('committed'),
	records: Schema.Array(
		Schema.Struct({ model: Schema.String, id: Schema.String, revision: Schema.Number })
	)
});
const required = <A>(value: A | undefined): A => {
	if (value === undefined) throw new Error('Missing fingerprint fixture row');
	return value;
};
const fixture = (mutateSource = false) =>
	Effect.gen(function* () {
		let armed = false,
			moved = false,
			sourcePasses = 0;
		const baseContext = yield* Layer.build(PgliteDb.layer());
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
		const act = (callable: string, input: Json, authority = caller.authority) =>
			route.dispatch({ callable, input, key: randomUUID(), issuedAt: t.clock.now() }, authority);
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
		const start = (automation: string, input: Json, authority = caller.authority) =>
			Effect.gen(function* () {
				const id = randomUUID();
				const outcome = yield* calls.start({
					automation,
					runs: [{ id, input }],
					authority,
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
		armed = mutateSource;
		return {
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
	'direct callbacks conflict on a changed source; generated batches replay and recheck it',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const direct = yield* fixture(true);
				assert.equal(
					(yield* direct.act('orders.create', [{ title: 'priced against old source' }])).outcome.kind,
					'conflict'
				);
				assert.equal(direct.moved(), true);
				assert.equal(direct.sourcePasses(), 1, 'the direct replay retains its first read answer');
				assert.equal(yield* direct.count(), 0);
				const batch = yield* fixture(true);
				const result = yield* batch.batch([
					{ model: 'orders', verb: 'create', input: [{ title: 'first' }] },
					{ model: 'orders', verb: 'create', input: [{ title: 'second' }] }
				]);
				assert.equal(batch.moved(), true);
				assert.equal(result.outcome.kind, 'refused');
				if (result.outcome.kind !== 'refused') throw new Error(JSON.stringify(result.outcome));
				assert.equal(result.outcome.message, 'source changed');
				assert.equal(batch.sourcePasses(), 2, 'the atomic batch rechecks the current source once');
				assert.deepEqual(result.captured, []);
				assert.equal(yield* batch.count(), 0);
			})
		)
);

it.live(
	'queued workflows retain callback and prior-query fingerprints through generated writes',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				for (const automation of ['place', 'outer', 'queryplace', 'readplace']) {
					const f = yield* fixture(true);
					const started = yield* f.start(automation, { title: 'priced against old source' });
					assert.equal(started.outcome.kind, 'committed');
					assert.equal(required(yield* f.run(started.id)).state, 'queued');
					assert.equal(yield* f.count(), 0);
					yield* f.t.runDue();
					const run = required(yield* f.run(started.id));
					assert.equal(f.moved(), true, 'mutation must occur after the actual source read');
					assert.equal(run.state, 'succeeded');
					assert.equal(run.error, null);
					const output = yield* Schema.decodeUnknownEffect(Conflict)(run.output);
					assert.deepEqual(output.records, []);
					assert.equal(yield* f.count(), 0);
				}
			})
		)
);

it.live('large callback results and later generated-batch refusals leave no partial rows', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const large = yield* fixture();
			const result = yield* large.act('orders.create', [{ title: 'small' }, { title: 'giant' }]);
			assert.equal(result.outcome.kind, 'refused');
			if (result.outcome.kind !== 'refused') throw new Error(JSON.stringify(result.outcome));
			assert.equal(result.outcome.code, 'tooLarge');
			assert.match(result.outcome.message, /result is over .* bytes/);
			assert.equal(yield* large.count(), 0);
			const native = yield* fixture();
			const refused = yield* native.batch([
				{ model: 'orders', verb: 'create', input: [{ title: 'planned first' }] },
				{ model: 'orders', verb: 'create', input: [{ title: 'refuse' }] }
			]);
			assert.equal(refused.outcome.kind, 'refused');
			if (refused.outcome.kind !== 'refused') throw new Error(JSON.stringify(refused.outcome));
			assert.equal(refused.outcome.message, 'late failure');
			assert.deepEqual(refused.captured, []);
			assert.equal(yield* native.count(), 0);
			const queued = yield* fixture();
			const started = yield* queued.start('fail', { title: 'planned first' });
			assert.equal(started.outcome.kind, 'committed');
			assert.equal(required(yield* queued.run(started.id)).state, 'queued');
			yield* queued.t.runDue();
			const run = required(yield* queued.run(started.id));
			assert.equal(run.state, 'failed');
			assert.equal(run.output, null);
			assert.equal(run.error?.code, 'refused');
			assert.equal(run.error?.message, 'late failure');
			assert.equal(yield* queued.count(), 0);
		})
	)
);

it.live(
	'queued helper workflows retain caller write and read grants',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				const started = yield* f.start('outer', { title: 'valid' });
				assert.equal(started.outcome.kind, 'committed');
				assert.equal(required(yield* f.run(started.id)).state, 'queued');
				yield* f.t.runDue();
				const success = required(yield* f.run(started.id));
				assert.equal(success.state, 'succeeded');
				assert.equal(
					(yield* Schema.decodeUnknownEffect(Committed)(success.output)).records.length,
					1
				);
				assert.equal(yield* f.count(), 1);
				const before = yield* f.count();
				const starter = f.t.as(f.t.member(['starteronly']));
				const deniedWrite = yield* f.start(
					'outer',
					{ title: 'forbidden child' },
					starter.authority
				);
				assert.equal(deniedWrite.outcome.kind, 'committed');
				yield* f.t.runDue();
				const deniedWriteRun = required(yield* f.run(deniedWrite.id));
				assert.equal(deniedWriteRun.state, 'failed');
				assert.equal(deniedWriteRun.error?.code, 'forbidden');
				assert.equal(yield* f.count(), before);
				const noQuery = f.t.as(f.t.member(['noquery']));
				const deniedQuery = yield* f.start(
					'queryplace',
					{ title: 'forbidden query' },
					noQuery.authority
				);
				assert.equal(deniedQuery.outcome.kind, 'committed');
				yield* f.t.runDue();
				// a root the starter may not read answers no rows: the run fails before it writes
				const deniedQueryRun = required(yield* f.run(deniedQuery.id));
				assert.equal(deniedQueryRun.state, 'failed');
				assert.equal(yield* f.count(), before);
				const outsider = f.t.as(f.t.member([]));
				const deniedStart = yield* f.start('place', { title: 'forbidden' }, outsider.authority);
				assert.equal(deniedStart.outcome.kind, 'refused');
				assert.equal(yield* f.run(deniedStart.id), undefined);
				assert.equal(yield* f.count(), before);
			})
		)
);

it.live('queued caller reads retain row scope and monetary-style field masks', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture();
			const caller = f.t.as(f.t.member(['narrow']));
			const started = yield* f.start('inspect', {}, caller.authority);
			assert.equal(started.outcome.kind, 'committed');
			assert.equal(required(yield* f.run(started.id)).state, 'queued');
			yield* f.t.runDue();
			const run = required(yield* f.run(started.id));
			assert.equal(run.state, 'succeeded');
			assert.equal(run.error, null);
			const text = yield* Schema.decodeUnknownEffect(Schema.String)(run.output);
			const rows = yield* Schema.decodeUnknownEffect(
				Schema.fromJsonString(
					Schema.Array(Schema.Struct({ name: Schema.String, cap: Schema.Json }))
				)
			)(text);
			assert.equal(rows.length, 1);
			assert.equal(rows[0]?.name, 'quota');
			assert.deepEqual(rows[0]?.cap, { $masked: true });
			assert.equal(text.includes('999'), false);
			assert.equal(yield* f.count(), 0);
		})
	)
);
