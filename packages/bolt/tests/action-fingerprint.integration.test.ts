import assert from 'node:assert/strict';
import { test } from 'vitest';
import { openPglite } from '../src/engine/index.ts';
import { testWorkspace } from '../src/test/index.ts';

import type { EngineManifest, TenantDb } from '../src/engine/contracts.ts';
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
	channels: {},
	connections: {},
	envoys: {},
	mcp: {},
	agent: { skills: {} }
};
const guest = {
	source: `export default {collection:{orders:{bodies:{
 queries:{price:async(input,ctx)=>{const source=await ctx.read('quota',{all:true,select:{cap:true}});if(source.rows[0].cap===0)ctx.refuse('source changed');return source.rows[0].cap;},illegal:async(input,ctx)=>{await ctx.act('orders.create',{title:'illegal'});return 'bad';}},
 transform:async(inputs,ctx)=>{
  if(inputs[0].title==='querypriced')return inputs.map(input=>({...input,derived:'priced'}));
  const source=await ctx.db.read('quota',{all:true,select:{cap:true}});
  if(source.rows[0].cap===0)ctx.refuse('source changed');
  return inputs.map(input=>({...input,derived:input.title==='giant'?'x'.repeat(4194304):String(source.rows[0].cap)}));
 },actions:{
  inspect:async(input,ctx)=>JSON.stringify((await ctx.read('quota',{all:true,select:{name:true,cap:true}})).rows),
  outer:async(input,ctx)=>{await ctx.act('orders.nested',input);},
  nested:async(input,ctx)=>{await ctx.act('orders.place',input);},
  queryplace:async(input,ctx)=>{try{await ctx.query('orders','price',{});}catch(error){ctx.refuse(error.message);}await ctx.act('orders.create',{title:'querypriced'});},
  readplace:async(input,ctx)=>{const source=await ctx.read('quota',{all:true,select:{cap:true}});if(source.rows[0].cap===0)ctx.refuse('source changed');await ctx.act('orders.create',{title:'querypriced'});},
  illegalplace:async(input,ctx)=>{await ctx.query('orders','illegal',{});},
  place:async(input,ctx)=>{await ctx.act('orders.create',input);},
  fail:async(input,ctx)=>{await ctx.act('orders.create',input);ctx.refuse('late failure');},
 }
}}}};`
};
async function fixture(mutateSource = false) {
	const { pg, db } = await openPglite();
	let armed = false,
		moved = false;
	const intercepted = {
		...db,
		async read(...args: Parameters<TenantDb['read']>) {
			const [statements] = args;
			const result = await db.read(...args);
			if (armed && !moved && statements.some((s) => /FROM\s+"?quota"?\b/i.test(s.text))) {
				moved = true;
				await db.write({ text: 'UPDATE quota SET cap=0', params: [] });
			}
			return result;
		}
	};
	const t = await testWorkspace({
		manifest,
		guest,
		transforms: ['orders'],
		db: intercepted,
		seed: {
			quota: [
				{ id: '00000000-0000-4000-8000-000000000001', name: 'quota', cap: 1 },
				{ id: '00000000-0000-4000-8000-000000000002', name: 'other', cap: 999 }
			]
		}
	});
	const caller = t.as(t.member(['operator']));
	armed = mutateSource;
	return {
		t,
		caller,
		pg,
		moved: () => moved,
		count: async () =>
			Number(
				(await db.read([{ text: 'SELECT count(*)::int AS n FROM orders', params: [] }]))[0]?.rows[0]
					?.n
			)
	};
}

test('direct and ActionCtx child transforms both refuse changed preaction source', async () => {
	for (const [callable, expected, count] of [
		['orders.create', 'refused', 0],
		['orders.place', 'refused', 0],
		['orders.outer', 'refused', 0],
		['orders.queryplace', 'refused', 0],
		['orders.readplace', 'refused', 0]
	] as const) {
		const f = await fixture(true);
		try {
			const outcome = await f.caller.act(callable, { title: 'priced against old source' });
			assert.equal(f.moved(), true, 'mutation must occur after actual source read');
			assert.equal(outcome.kind, expected, JSON.stringify(outcome));
			assert.equal(await f.count(), count);
			console.log(JSON.stringify({ case: callable, outcome, rows: await f.count() }));
		} finally {
			await f.pg.close();
		}
	}
});
test('final large transform refuses without partial rows; late action refusal also atomic', async () => {
	for (const [callable, title] of [
		['orders.place', 'giant'],
		['orders.fail', 'small']
	] as const) {
		const f = await fixture();
		try {
			const outcome = await f.caller.act(callable, { title });
			assert.notEqual(outcome.kind, 'committed', JSON.stringify(outcome));
			assert.equal(await f.count(), 0);
			if (title === 'giant')
				assert.match(JSON.stringify(outcome), /4194304|result.*over|too large/i);
			else assert.match(JSON.stringify(outcome), /late failure/);
			console.log(JSON.stringify({ case: callable, title, outcome, rows: await f.count() }));
		} finally {
			await f.pg.close();
		}
	}
});

test('valid nested server action retains grants; nested query stays read-only', async () => {
	const f = await fixture();
	try {
		assert.equal(
			(await f.caller.act('orders.nested', { title: 'valid' })).kind,
			'refused',
			'internal action cannot be called from client'
		);
		assert.equal((await f.caller.act('orders.outer', { title: 'valid' })).kind, 'committed');
		const before = await f.count();
		await assert.rejects(f.caller.act('orders.illegalplace', {}), /ctx.act is not a function/);
		assert.equal(await f.count(), before);
		const actionOnly = f.t.as(f.t.member(['actiononly']));
		assert.equal(
			(await actionOnly.act('orders.outer', { title: 'forbidden child' })).kind,
			'refused'
		);
		const noQuery = f.t.as(f.t.member(['noquery']));
		assert.equal(
			(await noQuery.act('orders.queryplace', { title: 'forbidden query' })).kind,
			'refused'
		);
		const outsider = f.t.as(f.t.member([]));
		assert.equal((await outsider.act('orders.place', { title: 'forbidden' })).kind, 'refused');
		assert.equal(await f.count(), before);
	} finally {
		await f.pg.close();
	}
});

test('action dependency recording retains caller row scope and monetary-style field masks', async () => {
	const f = await fixture();
	try {
		const caller = f.t.as(f.t.member(['narrow']));
		const outcome = await caller.act('orders.inspect', {});
		assert.equal(outcome.kind, 'committed');
		if (outcome.kind !== 'committed') throw new Error(JSON.stringify(outcome));
		assert.equal(typeof outcome.output, 'string');
		if (typeof outcome.output !== 'string') throw new Error('Missing caller evidence');
		const rows: readonly { name: string; cap: unknown }[] = JSON.parse(outcome.output);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]?.name, 'quota');
		assert.deepEqual(rows[0]?.cap, { $masked: true });
		assert.equal(outcome.output.includes('999'), false);
		assert.equal(await f.count(), 0);
	} finally {
		await f.pg.close();
	}
});
