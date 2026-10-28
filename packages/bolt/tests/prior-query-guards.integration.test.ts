import { randomUUID } from 'node:crypto';
import { expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Layer, Schema } from 'effect';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { Callables } from '../src/engine/services.ts';
import { PgliteDb } from '../src/node/db/pglite.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { manifest as base } from './write-fixture.ts';
import { program } from './support/guest-fixture.ts';

const ACCOUNT = '0199a000-0000-7000-8000-000000000001';
const input = {
	account: { kind: 'id', of: 'accounts' },
	amount: { kind: 'int' },
	label: { kind: 'text' }
} satisfies NonNullable<EngineManifest['automations'][string]['input']>;
const manifest: EngineManifest = {
	...base,
	models: {
		accounts: {
			description: 'Balances guarded by prior native reads',
			label: 'name',
			fields: { name: { kind: 'text' }, balance: { kind: 'int' } }
		},
		ledger: {
			description: 'The atomic debit evidence',
			label: 'label',
			fields: {
				label: { kind: 'text' },
				amount: { kind: 'int' },
				balance_before: { kind: 'int' },
				balance_after: { kind: 'int' }
			}
		}
	},
	relationships: { 'ledger.account': { to: 'accounts', inverse: 'ledger' } },
	exposures: {
		accounts: {
			read: { accounts: { fields: 'all' } },
			update: { columns: { accounts: ['balance'] } }
		},
		ledger: {
			read: { ledger: { fields: 'all' } },
			create: {
				columns: { ledger: ['account', 'label', 'amount', 'balance_before', 'balance_after'] }
			}
		}
	},
	policies: {
		debit: {
			description: 'Start and execute debits',
			automations: ['debitA', 'debitB', 'reread', 'fanout'],
			grants: {
				accounts: { read: true, update: true },
				ledger: { read: true, create: true }
			}
		}
	},
	automations: {
		debitA: { description: 'First concurrent debit', input, runAs: 'trigger' },
		debitB: { description: 'Second concurrent debit', input, runAs: 'trigger' },
		reread: {
			description: 'A changed repeated read poisons later writes',
			input,
			runAs: 'trigger'
		},
		fanout: { description: 'Independent writes after one shared read', input, runAs: 'trigger' }
	}
};
const guest = program(`import { Effect } from 'effect';
const operations = (input,balance) => [
 {callable:'accounts.update',input:[{target:input.account,set:{balance:balance-input.amount}}]},
 {callable:'ledger.create',input:[{
  account:input.account,label:input.label,amount:input.amount,
  balance_before:balance,balance_after:balance-input.amount
 }]}
];
function* debit(input,ctx){
 const {accounts:page}=yield* ctx.query({accounts:{
  where:{id:{eq:input.account}},fields:['balance']
 }});
 const account=page.rows[0];
 if(account===undefined)throw new Error('The debit account is missing');
 return yield* ctx.act.many(operations(input,account.balance)).pipe(
  Effect.map(outcome=>({result:outcome.kind,readBalance:account.balance,label:input.label})),
  Effect.catchTag('ActConflict',error=>Effect.succeed({
   result:error._tag,readBalance:account.balance,label:input.label
  }))
 );
}
export default {automation:{
 debitA:{body:debit},
 debitB:{body:debit},
 fanout:{body:function*(input,ctx){
  const {accounts:page}=yield* ctx.query({accounts:{fields:['balance']}});
  return yield* Effect.all(page.rows.map(account=>ctx.act('accounts.update',[{
   target:account.id,set:{balance:account.balance-input.amount}
  }]).pipe(Effect.map(outcome=>outcome.kind))),{concurrency:'unbounded'});
 }},
 reread:{body:function*(input,ctx){
  const query={accounts:{where:{id:{eq:input.account}},fields:['balance']}};
  const first=yield* ctx.query(query);
  const account=first.accounts.rows[0];
  if(account===undefined)throw new Error('The reread account is missing');
  let secondReturned=false;
  const readCode=yield* ctx.query(query).pipe(
   Effect.map(()=>{secondReturned=true;return 'returned';}),
   Effect.catchTag('ReadFailed',error=>Effect.succeed(error.code))
  );
  const write=yield* ctx.act.many(operations(input,account.balance)).pipe(
   Effect.map(outcome=>outcome.kind),
   Effect.catchTag('ActConflict',error=>Effect.succeed(error._tag))
  );
  return {firstBalance:account.balance,secondReturned,readCode,write};
 }}
}};`);
const RunRow = Schema.Struct({
	state: Schema.String,
	input: Schema.Json,
	output: Schema.Json,
	error: Schema.Json
});
const DebitResult = Schema.Struct({
	result: Schema.Literals(['committed', 'ActConflict']),
	readBalance: Schema.Number,
	label: Schema.String
});
const LedgerRow = Schema.Struct({
	label: Schema.String,
	amount: Schema.Number,
	balance_before: Schema.Number,
	balance_after: Schema.Number
});
const required = <A>(value: A | undefined): A => {
	if (value === undefined) throw new Error('Missing prior-read fixture row');
	return value;
};
const fixture = (mode: 'concurrent' | 'aba') =>
	Effect.gen(function* () {
		const bothRead = yield* Deferred.make<void>();
		let armed = false,
			passes = 0;
		const observations: number[] = [];
		const dbContext = yield* Layer.build(PgliteDb.layer());
		const db = Context.get(dbContext, TenantDb);
		const balance = () =>
			db.value(Schema.Number, {
				text: 'select balance from accounts where id=$1::uuid',
				params: [ACCOUNT]
			});
		const intercepted = TenantDb.typed({
			session: db.session,
			read: (statements) =>
				Effect.gen(function* () {
					const result = yield* db.read(statements);
					if (
						armed &&
						passes < 2 &&
						statements.some((statement) => /FROM\s+"?accounts"?\b/i.test(statement.text))
					) {
						const pass = ++passes;
						observations.push(yield* balance());
						if (mode === 'concurrent') {
							if (pass === 2) yield* Deferred.succeed(bothRead, undefined);
							yield* Deferred.await(bothRead);
						} else {
							// The second result contains 200, but the database is back at its original value before delivery.
							yield* db.write({
								text: 'update accounts set balance=$1,revision=revision+1 where id=$2::uuid',
								params: [pass === 1 ? 200 : 100, ACCOUNT]
							});
						}
					}
					return result;
				}).pipe(
					Effect.mapError((error) =>
						error instanceof DbError ? error : DbError.make('XX000', error.message)
					)
				),
			write: db.write,
			transaction: db.transaction
		});
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				guest: yield* guest,
				db: Layer.succeed(TenantDb, intercepted),
				seed: { accounts: [{ id: ACCOUNT, name: 'Main', balance: 100 }] }
			})
		);
		const t = Context.get(context, TestWorkspace),
			calls = Context.get(context, Callables);
		const authority = t.as(t.member(['debit'])).authority;
		const start = (automation: string, label: string) =>
			Effect.gen(function* () {
				const id = randomUUID();
				const outcome = yield* calls.start({
					automation,
					runs: [{ id, input: { account: ACCOUNT, amount: 10, label } }],
					authority,
					bindings: { now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC' }
				});
				return { id, outcome };
			});
		const run = (id: string) =>
			t.db
				.rows(RunRow, {
					text: 'select state,input,output,error from sys_run where id=$1',
					params: [id]
				})
				.pipe(Effect.map((rows) => required(rows[0])));
		const ledger = () =>
			t.db.rows(LedgerRow, {
				text: 'select label,amount,balance_before,balance_after from ledger',
				params: []
			});
		return {
			t,
			start,
			run,
			balance,
			ledger,
			arm: () => {
				armed = true;
			},
			passes: () => passes,
			observations: () => observations
		};
	});

it.live(
	'independent writes after a shared query do not conflict with their own earlier commit',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture('concurrent');
				yield* f.t.db.write({
					text: 'insert into accounts(id,name,balance) values ($1,$2,$3)',
					params: ['0199a000-0000-7000-8000-000000000002', 'Other', 100]
				});
				const started = yield* f.start('fanout', 'independent');
				expect(started.outcome.kind).toBe('committed');
				yield* f.t.runDue();
				expect(yield* f.run(started.id)).toMatchObject({
					state: 'succeeded',
					output: ['committed', 'committed'],
					error: null
				});
				expect(
					yield* f.t.db.rows(Schema.Struct({ balance: Schema.Number }), {
						text: 'select balance from accounts order by name',
						params: []
					})
				).toEqual([{ balance: 90 }, { balance: 90 }]);
			})
		)
);

it.live(
	'concurrent queued debits retain their shared prior balance and commit one atomic ledger entry',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture('concurrent');
				const first = yield* f.start('debitA', 'first');
				const second = yield* f.start('debitB', 'second');
				expect(first.outcome.kind).toBe('committed');
				expect(second.outcome.kind).toBe('committed');
				expect((yield* f.run(first.id)).state).toBe('queued');
				expect((yield* f.run(second.id)).state).toBe('queued');
				f.arm();
				yield* f.t.runDue();
				const results: (typeof DebitResult.Type)[] = [];
				for (const id of [first.id, second.id]) {
					const run = yield* f.run(id);
					expect(run.state).toBe('succeeded');
					expect(run.error).toBeNull();
					results.push(yield* Schema.decodeUnknownEffect(DebitResult)(run.output));
				}
				expect(f.passes()).toBe(2);
				expect(f.observations()).toEqual([100, 100]);
				expect(results.map((result) => result.readBalance)).toEqual([100, 100]);
				expect(results.map((result) => result.result).sort()).toEqual(['ActConflict', 'committed']);
				expect(yield* f.balance()).toBe(90);
				const rows = yield* f.ledger();
				expect(rows).toHaveLength(1);
				expect(required(rows[0])).toEqual({
					label: required(results.find((result) => result.result === 'committed')).label,
					amount: 10,
					balance_before: 100,
					balance_after: 90
				});
			})
		)
);

it.live(
	'a changed repeated query fails before delivery and poisons a later batch after ABA restoration',
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture('aba');
				const started = yield* f.start('reread', 'must not commit');
				expect(started.outcome.kind).toBe('committed');
				expect((yield* f.run(started.id)).state).toBe('queued');
				f.arm();
				yield* f.t.runDue();
				const run = yield* f.run(started.id);
				expect(run.state).toBe('succeeded');
				expect(run.error).toBeNull();
				expect(run.output).toEqual({
					firstBalance: 100,
					secondReturned: false,
					readCode: 'conflict',
					write: 'ActConflict'
				});
				expect(f.passes()).toBe(2);
				expect(f.observations()).toEqual([100, 200]);
				expect(yield* f.balance()).toBe(100);
				expect(yield* f.ledger()).toEqual([]);
			})
		)
);
