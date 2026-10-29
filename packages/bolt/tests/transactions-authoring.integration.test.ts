// Authored transaction generators refuse interactive admission on PGlite; the native PG17+ lease runs on deployed Neon.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { WebRead } from '../src/engine/ports.ts';
import { Callables, Writes } from '../src/engine/services.ts';
import type { Json } from '../src/decl/values.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { manifest as base } from './engine-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		accounts: {
			description: 'A ledger account',
			label: 'name',
			fields: { name: { kind: 'text' }, total: { kind: 'sum', of: 'entries.amount' } }
		},
		entries: {
			description: 'A ledger entry',
			label: 'memo',
			fields: { memo: { kind: 'text' }, amount: { kind: 'decimal', scale: 2 } }
		},
		markers: {
			description: 'A transaction marker',
			label: 'note',
			fields: { note: { kind: 'text' } }
		}
	},
	relationships: { 'entries.account': { to: 'accounts', inverse: 'entries' } },
	exposures: {
		accounts: {
			read: { accounts: { fields: 'all' } },
			create: { columns: { accounts: ['name'] } }
		},
		entries: {
			read: { entries: { fields: 'all' } },
			create: { columns: { entries: ['memo', 'amount', 'account'] } },
			update: { columns: { entries: ['memo', 'amount'] }, transform: true }
		},
		markers: { read: { markers: { fields: 'all' } }, create: { columns: { markers: ['note'] } } }
	},
	policies: {
		writer: {
			description: 'Writes the ledger',
			automations: ['transaction_probe'],
			grants: {
				accounts: { read: true, create: true },
				entries: { read: true, create: true, update: true },
				markers: { read: true, create: true }
			}
		},
		requester: {
			description: 'Submits a ledger adjustment',
			automations: ['transaction_probe'],
			grants: {
				accounts: { read: true },
				entries: { read: true, update: { check: true } },
				markers: { read: true, create: { check: true } }
			}
		},
		reviewer: {
			description: 'Reviews adjustments',
			grants: { accounts: { read: true }, entries: { read: true }, markers: { read: true } }
		}
	},
	teams: { Requesters: ['requester'], Reviewers: ['reviewer'] },
	automations: {
		transaction_probe: {
			description: 'Exercise an authored transaction',
			policies: ['writer'],
			output: { kind: 'json' },
			input: {
				scenario: { kind: 'text' },
				account: { kind: 'id', of: 'accounts' },
				entry: { kind: 'id', of: 'entries' }
			}
		}
	}
};
const guest = program(`import { Effect } from 'effect';
import { Refusal } from '@norbital-ai/bolt/errors';
export default {
 model:{entries:{bodies:{update:function*(changes,ctx){
  if(changes.some(({set})=>set.amount!==undefined && Number(set.amount.toString())<0))
   yield*ctx.refuse('Amount cannot be negative',{field:'amount',row:0});
  return changes.map(({set})=>set);
 }}}},
 policy:{requester:{grants:{
  entries:{update:{check:function*(_changes,ctx){return ctx.approve((flow)=>flow.step('Review',{teams:['Reviewers']}));}}},
  markers:{create:{check:function*(_rows,ctx){return ctx.approve((flow)=>flow.step('Review',{teams:['Reviewers']}));}}}
 }}},
 automation:{transaction_probe:{body:function*(input,ctx){
  const one=function*(q,model,id){return (yield*q.query({[model]:{where:{id:{eq:id}}}}))[model].rows[0]??null;};
  const work=function*(tx){
   if(input.scenario==='ledger'){
    const before=yield*one(tx,'accounts',input.account);
    const staged=yield*tx.act('entries.create',[{memo:'New entry',amount:'2',account:input.account}]);
    const id=staged.records[0].id;
    const made=yield*one(tx,'accounts',input.account);
    yield*tx.act('entries.update',[{target:id,set:{amount:'3'}}]);
    const once=yield*one(tx,'accounts',input.account);
    yield*tx.act('entries.update',[{target:id,set:{amount:'4'}}]);
    const twice=yield*one(tx,'accounts',input.account);
    return {totals:[before,made,once,twice].map(row=>Number(row.total.toString())),id,stagedKind:'kind' in staged};
   }
   yield*tx.act('markers.create',[{note:'Provisional'}]);
   if(input.scenario==='refusal') yield*tx.act('entries.update',[{target:input.entry,set:{amount:'-1'}}]);
   if(input.scenario==='businessRefusal') throw new Refusal({message:'Choose a valid amount',field:'amount'});
   if(input.scenario==='exception') throw new Error('transaction exception');
   if(input.scenario==='failure') yield*Effect.fail(new Error('transaction generator failure'));
   if(input.scenario==='facility') yield*ctx.web.read('https://example.test/transaction');
   if(input.scenario==='nested') yield*ctx.transaction(function*(nested){yield*one(nested,'entries',input.entry);});
   if(input.scenario==='conflict'){
    const before=yield*one(tx,'entries',input.entry);
    yield*tx.act('entries.update',[{target:input.entry,set:{amount:String(Number(before.amount.toString())+1)}}]);
   }else yield*tx.act('entries.update',[{target:input.entry,set:{amount:'25'}}]);
   return 'business result must not escape a failed or held transaction';
  };
  if(input.scenario==='concurrent') return yield*Effect.all([ctx.transaction(work),ctx.transaction(work)],{concurrency:2});
  return yield*ctx.transaction(work);
 }}}
};`);

const fixture = () =>
	Effect.gen(function* () {
		let webCalls = 0;
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				guest: yield* guest,
				ports: Layer.succeed(WebRead, {
					read: () =>
						Effect.sync(() => {
							webCalls++;
							return {
								url: 'https://example.test/transaction',
								title: null,
								text: 'Should not run'
							};
						})
				})
			})
		);
		const t = Context.get(context, TestWorkspace);
		const writes = Context.get(context, Writes),
			calls = Context.get(context, Callables);
		const create = (model: 'accounts' | 'entries', input: Json) => {
			const key = randomUUID(),
				now = t.clock.now();
			return writes
				.act({
					model,
					verb: 'create',
					input: [input],
					key,
					issuedAt: now,
					invocationId: key,
					authority: t.as(t.admin).authority,
					mode: { _tag: 'Direct' },
					bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
				})
				.pipe(Effect.map((reply) => reply.outcome));
		};
		const account = yield* create('accounts', { name: 'Ledger' });
		if (account.kind !== 'committed' || account.records[0] === undefined)
			throw new Error('Missing ledger account');
		const accountId = account.records[0].id;
		const entry = yield* create('entries', { memo: 'Initial', amount: '10', account: accountId });
		if (entry.kind !== 'committed' || entry.records[0] === undefined)
			throw new Error('Missing ledger entry');
		const entryId = entry.records[0].id;
		const writer = t.member(['writer']);
		const start = (scenario: string, who = writer) =>
			Effect.gen(function* () {
				const now = t.clock.now();
				const outcome = yield* calls.start({
					automation: 'transaction_probe',
					runs: [{ id: randomUUID(), input: { scenario, account: accountId, entry: entryId } }],
					authority: t.as(who).authority,
					bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
				});
				if (outcome.kind !== 'committed') throw new Error('Transaction probe did not enqueue');
				return yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
					outcome.output
				);
			});
		const run = (id: string) =>
			t.db.value(
				Schema.Struct({
					state: Schema.String,
					output: Schema.NullOr(Schema.Json),
					error: Schema.NullOr(Schema.Json)
				}),
				{
					text: "select jsonb_build_object('state',state,'output',output,'error',error) from sys_run where id=$1",
					params: [id]
				}
			);
		const markers = () =>
			t.db.value(Schema.Int, { text: 'select count(*)::integer from markers', params: [] });
		const amount = () =>
			t.db.value(Schema.Int, {
				text: 'select amount::integer from entries where id=$1',
				params: [entryId]
			});
		const noFalseCommit = () =>
			Effect.gen(function* () {
				expect(yield* markers()).toBe(0);
				expect(
					yield* t.db.value(Schema.Int, {
						text: "select count(*)::integer from bolt_history where collection='markers'",
						params: []
					})
				).toBe(0);
				expect(
					yield* t.db.value(Schema.Int, {
						text: "select count(*)::integer from bolt_idem_outcome where outcome->>'kind'='committed' and exists(select 1 from jsonb_array_elements(coalesce(outcome->'records','[]'::jsonb)) r where r->>'model'='markers')",
						params: []
					})
				).toBe(0);
			});
		return {
			context,
			t,
			accountId,
			entryId,
			start,
			run,
			markers,
			amount,
			noFalseCommit,
			webCalls: () => webCalls,
			outside: t.db
		};
	});

describe('authored transactions', () => {
	it.live('PGlite refuses interactive admission explicitly before any business write', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				const run = yield* f.start('ledger');
				yield* f.t.runDue();
				const ended = yield* f.run(run.id);
				expect(ended).toMatchObject({ state: 'failed', output: null });
				expect(JSON.stringify(ended.error)).toMatch(
					/unsupported|requires? (?:native )?PostgreSQL 17/i
				);
				expect(yield* f.amount()).toBe(10);
				yield* f.noFalseCommit();
			})
		)
	);
});
