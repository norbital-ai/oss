import assert from 'node:assert/strict';
import { it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { PgliteDb } from '../src/engine/db/pglite.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
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
	collections: {
		quota: { read: { fields: 'all' } },
		orders: {
			read: { fields: 'all' },
			create: { input: { columns: ['title'] } },
			queries: {
				price: { description: 'Source price', input: {}, output: { kind: 'int' } },
				illegal: { description: 'Read only', input: {}, output: { kind: 'text' } }
			},
			actions: {
				inspect: { description: 'Caller evidence', input: {}, output: { kind: 'text' } },
				outer: { description: 'External nested entry', input: { title: { kind: 'text' } } },
				nested: { description: 'Nested', input: { title: { kind: 'text' } }, internal: true },
				queryplace: { description: 'Query pricing', input: { title: { kind: 'text' } } },
				readplace: { description: 'Action pricing', input: { title: { kind: 'text' } } },
				illegalplace: { description: 'Query mutation control', input: {} },
				place: { description: 'Atomic wrapper', input: { title: { kind: 'text' } } },
				fail: { description: 'Late refusal', input: { title: { kind: 'text' } } }
			}
		}
	},
	policies: {
		narrow: {
			description: 'Own labels only',
			grants: {
				quota: { read: { where: { name: { eq: 'quota' } }, fields: ['name'] } },
				orders: { actions: ['inspect'] }
			}
		},
		actiononly: {
			description: 'Action without write grant',
			grants: {
				orders: { read: true, actions: ['outer', 'nested', 'place'] },
				quota: { read: true }
			}
		},
		noquery: {
			description: 'Action without query grant',
			grants: {
				orders: { read: true, create: true, actions: ['queryplace'] },
				quota: { read: true }
			}
		},
		operator: {
			description: 'Synthetic operator',
			grants: {
				quota: { read: true },
				orders: {
					read: true,
					create: true,
					queries: ['price', 'illegal'],
					actions: ['outer', 'place', 'fail', 'nested', 'queryplace', 'readplace', 'illegalplace']
				}
			}
		}
	},
	apps: {},
	automations: {},
	integrations: {},
	pipelines: {},
	teams: {},
	customFields: {},
	connections: {},
	envoys: {},
	mcp: {},
	agent: { skills: {} }
};
const guest = program(`import { Effect } from 'effect'; export default {collection:{orders:{bodies:{
 queries:{price:function* (input,ctx){const source=yield* ctx.read('quota',{all:true,select:{cap:true}});if(source.rows[0].cap===0)return yield* ctx.refuse('source changed');return source.rows[0].cap;},illegal:function* (input,ctx){yield* Effect.sync(()=>ctx.act('orders.create',{title:'illegal'}));return 'bad';}},
 transform:function* (inputs,ctx){
  if(inputs[0].title==='querypriced')return inputs.map(input=>({...input,derived:'priced'}));
  const source=yield* ctx.db.read('quota',{all:true,select:{cap:true}});
  if(source.rows[0].cap===0)return yield* ctx.refuse('source changed');
  return inputs.map(input=>({...input,derived:input.title==='giant'?'x'.repeat(4194304):String(source.rows[0].cap)}));
 },actions:{
  inspect:function* (input,ctx){return JSON.stringify((yield* ctx.read('quota',{all:true,select:{name:true,cap:true}})).rows);},
  outer:function* (input,ctx){yield* ctx.act('orders.nested',input);},
  nested:function* (input,ctx){yield* ctx.act('orders.place',input);},
  queryplace:function* (input,ctx){yield* ctx.query('orders','price',{});yield* ctx.act('orders.create',{title:'querypriced'});},
  readplace:function* (input,ctx){const source=yield* ctx.read('quota',{all:true,select:{cap:true}});if(source.rows[0].cap===0)return yield* ctx.refuse('source changed');yield* ctx.act('orders.create',{title:'querypriced'});},
  illegalplace:function* (input,ctx){yield* ctx.query('orders','illegal',{});},
  place:function* (input,ctx){yield* ctx.act('orders.create',input);},
  fail:function* (input,ctx){yield* ctx.act('orders.create',input);return yield* ctx.refuse('late failure');},
 }
}}}};`);
const GuestFault = Schema.Struct({
	outcome: Schema.Struct({ kind: Schema.Literal('unknown'), invocation: Schema.String }),
	captured: Schema.Array(Schema.Json),
	error: Schema.Struct({
		_tag: Schema.Literal('BoltError'),
		code: Schema.Literal('guestError'),
		phase: Schema.Literal('guest'),
		message: Schema.String
	})
});
const fixture = (mutateSource = false) =>
	Effect.gen(function* () {
		let armed = false,
			moved = false;
		const baseContext = yield* Layer.build(PgliteDb.layer());
		const db = Context.get(baseContext, TenantDb);
		const intercepted = TenantDb.typed({
			read: (statements) =>
				Effect.gen(function* () {
					const result = yield* db.read(statements);
					if (armed && !moved && statements.some((s) => /FROM\s+"?quota"?\b/i.test(s.text))) {
						moved = true;
						yield* db.write({ text: 'UPDATE quota SET cap=0, revision=revision+1', params: [] });
					}
					return result;
				}),
			write: db.write,
			transaction: db.transaction
		});
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				guest: yield* guest,
				transforms: ['orders'],
				db: Layer.succeed(TenantDb, intercepted),
				seed: {
					quota: [
						{ id: '00000000-0000-4000-8000-000000000001', name: 'quota', cap: 1 },
						{ id: '00000000-0000-4000-8000-000000000002', name: 'other', cap: 999 }
					]
				}
			})
		);
		const t = Context.get(context, TestWorkspace);
		const caller = t.as(t.member(['operator']));
		const route = yield* routeFixture(context);
		const act = (callable: string, input: Json, authority = caller.authority) =>
			route.dispatch(
				{ callable, input, key: crypto.randomUUID(), issuedAt: t.clock.now() },
				authority
			);
		armed = mutateSource;
		return {
			t,
			caller,
			act,
			moved: () => moved,
			count: () =>
				db
					.read([{ text: 'SELECT count(*)::int AS n FROM orders', params: [] }])
					.pipe(Effect.map((r) => Number(r[0]?.rows[0]?.['n'])))
		};
	});

it.live('direct and ActionCtx child transforms both conflict on changed preaction source', () =>
	Effect.scoped(
		Effect.gen(function* () {
			for (const [callable, expected, count] of [
				['orders.create', 'conflict', 0],
				['orders.place', 'conflict', 0],
				['orders.outer', 'conflict', 0],
				['orders.queryplace', 'conflict', 0],
				['orders.readplace', 'conflict', 0]
			] as const) {
				const f = yield* fixture(true);
				{
					const { outcome } = yield* f.act(callable, { title: 'priced against old source' });
					assert.equal(f.moved(), true, 'mutation must occur after actual source read');
					assert.equal(outcome.kind, expected, JSON.stringify(outcome));
					assert.equal(yield* f.count(), count);
					console.log(JSON.stringify({ case: callable, outcome, rows: yield* f.count() }));
				}
			}
		})
	)
);
it.live('final large transform refuses without partial rows; late action refusal also atomic', () =>
	Effect.scoped(
		Effect.gen(function* () {
			for (const [callable, title] of [
				['orders.place', 'giant'],
				['orders.fail', 'small']
			] as const) {
				const f = yield* fixture();
				{
					const { outcome } = yield* f.act(callable, { title });
					assert.notEqual(outcome.kind, 'committed', JSON.stringify(outcome));
					assert.equal(yield* f.count(), 0);
					if (title === 'giant')
						assert.match(JSON.stringify(outcome), /4194304|result.*over|too large/i);
					else assert.match(JSON.stringify(outcome), /late failure/);
					console.log(JSON.stringify({ case: callable, title, outcome, rows: yield* f.count() }));
				}
			}
		})
	)
);

it.live('valid nested server action retains grants; nested query stays read-only', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture();
			{
				assert.equal(
					(yield* f.act('orders.nested', { title: 'valid' })).outcome.kind,
					'refused',
					'internal action cannot be called from client'
				);
				assert.equal((yield* f.act('orders.outer', { title: 'valid' })).outcome.kind, 'committed');
				const before = yield* f.count();
				const illegal = yield* Schema.decodeUnknownEffect(GuestFault)(
					yield* f.act('orders.illegalplace', {})
				);
				assert.match(illegal.error.message, /\.act is not a function/);
				assert.deepEqual(illegal.captured, []);
				assert.equal(yield* f.count(), before);
				const actionOnly = f.t.as(f.t.member(['actiononly']));
				assert.equal(
					(yield* f.act('orders.outer', { title: 'forbidden child' }, actionOnly.authority)).outcome
						.kind,
					'refused'
				);
				const noQuery = f.t.as(f.t.member(['noquery']));
				// Query effects have no recoverable error channel; denied authority is a guest fault.
				const deniedQuery = yield* Schema.decodeUnknownEffect(GuestFault)(
					yield* f.act('orders.queryplace', { title: 'forbidden query' }, noQuery.authority)
				);
				assert.equal(deniedQuery.error.message, "You may not call 'orders.price'.");
				assert.deepEqual(deniedQuery.captured, []);
				assert.equal(yield* f.count(), before);
				const outsider = f.t.as(f.t.member([]));
				assert.equal(
					(yield* f.act('orders.place', { title: 'forbidden' }, outsider.authority)).outcome.kind,
					'refused'
				);
				assert.equal(yield* f.count(), before);
			}
		})
	)
);

it.live('action dependency recording retains caller row scope and monetary-style field masks', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const f = yield* fixture();
			{
				const caller = f.t.as(f.t.member(['narrow']));
				const { outcome } = yield* f.act('orders.inspect', {}, caller.authority);
				assert.equal(outcome.kind, 'committed');
				if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
				assert.equal(typeof outcome.output, 'string');
				if (typeof outcome.output !== 'string') throw new Error('Missing caller evidence');
				const rows = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(
						Schema.Array(Schema.Struct({ name: Schema.String, cap: Schema.Json }))
					)
				)(outcome.output);
				assert.equal(rows.length, 1);
				assert.equal(rows[0]?.name, 'quota');
				assert.deepEqual(rows[0]?.cap, { $masked: true });
				assert.equal(outcome.output.includes('999'), false);
				assert.equal(yield* f.count(), 0);
			}
		})
	)
);
