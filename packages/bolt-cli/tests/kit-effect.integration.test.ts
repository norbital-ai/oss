// The Effect test kit: scoped acquisition and typed refusal failures, with no Promise facet.
import { Context, Effect, Layer, Schema } from 'effect';
import { it } from '@effect/vitest';
import { expectTypeOf } from 'vitest';
import { input_schema } from '@norbital-ai/store/kind';
import { id_of } from '@norbital-ai/bolt';
import { dynamic_read } from '@norbital-ai/bolt';
import { uuidv7 } from '@norbital-ai/host-api';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';
import { expect, JobResult, KitInvalid, TestWorkspace, type Kit } from '../src/test/index.ts';
import { program } from '../src/test/guest.ts';

const pageOf = <A>(row: Schema.Decoder<A>) => Schema.Struct({
	rows: Schema.Array(row),
	next: Schema.optionalKey(Schema.NullOr(Schema.String)),
	total: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
});
const CustomerPage = Schema.Struct({
	customers: pageOf(Schema.Struct({ id: id_of('customers'), revision: Schema.Int, name: Schema.String }))
});

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		// one schema for every case: each workspace below loads the same checkpoint
		customers: {
			description: 'A customer',
			record_label: 'record.name',
			fields: {
				name: { kind: 'text' },
				balance: { kind: 'decimal', scale: 2, optional: true },
				document: {
					kind: 'json',
					optional: true,
					shape: { kind: 'object', fields: { note: { kind: 'text' } } }
				},
				email: { kind: 'text', optional: true },
				party: { kind: 'json', optional: true }
			},
			computed: {
				party_id: { kind: 'text', expr: { json_text: [{ field: 'party' }, 'id'] } },
				email_lower: {
					kind: 'text',
					expr: { regex_replace: [{ field: 'email' }, '[^0-9]', ''] }
				},
				name_upper: { kind: 'text', expr: { upper: { field: 'name' } } },
				email_label: { kind: 'text', expr: { concat: [{ field: 'email' }, ' contact'] } },
				email_default: { kind: 'text', expr: { coalesce: [{ field: 'email' }, 'unknown'] } },
				email_chain: { kind: 'text', expr: { upper: { field: 'email_lower' } } }
			}
		}
	},
	relationships: {},
	exposures: {
		customers: {
			outputs: { default: { customers: { fields: 'all' } } },
			create: { columns: { customers: ['name'] } }
		}
	},
	policies: {
		reader: {
			description: 'Reads customers',
			grants: { customers: { outputs: { default: {} } } }
		}
	},
	automations: {},
	// Every case shares integration definitions; accounts are runtime seed rows.
	integrations: {
		calendar: {
			description: 'A pushed remote catalogue',
			driver: 'calendar',
			configuration: {
				calendars: { kind: 'text', many: true, default: ['primary', 'secondary'] }
			}
		},
		ledger: {
			description: 'Ledger',
			driver: 'http',
			configuration: { lag: { kind: 'int', default: 15 } }
		}
	},
	teams: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;
const accounts = [
	{ id: 'calendar', integration: 'calendar', name: 'Calendar', owner: null, active: true, configuration: { calendars: ['primary', 'secondary'] } },
	{ id: 'ledger', integration: 'ledger', name: 'Ledger', owner: null, active: true, configuration: { lag: 15 } }
];

it.live(
	'explicit callback names activate per-verb markers without mutating a shared manifest',
	() =>
		Effect.gen(function* () {
			const callbacks = {
				...manifest,
				exposures: {
					customers: {
						...manifest.exposures.customers,
						update: { columns: { customers: ['name'] } },
						delete: {}
					}
				}
			} satisfies EngineManifest;
			const guest = yield* program(`export default { model: { customers: { bodies: {
			create: function* (changes) { return changes.map(({set}) => ({...set,name:'created:'+set.name})); },
			update: function* (changes) { return changes.map(({set}) => ({...set,name:'updated:'+set.name})); }
		} } } };`);
			const transforms = (function* () {
				yield 'customers.create';
				yield 'customers.update';
			})();
			const t = Context.get(
				yield* Layer.build(TestWorkspace.layer({ manifest: callbacks, guest, transforms })),
				TestWorkspace
			);
			const caller = yield* t.as(t.admin);
			const created = yield* caller.act({ 'customers.create': [{ name: 'Acme' }] });
			if (created.kind !== 'committed') throw new Error('The fixture did not commit.');
			const record = created.records.find((row) => row.model === 'customers');
			if (record === undefined) throw new Error('The fixture returned no customer.');
			// the one customer this fixture holds
			const customer = { customers: { fields: ['name', 'revision'], limit: 1 } } as const;
			const readCustomer = () => caller.query(customer).pipe(Effect.flatMap(Schema.decodeUnknownEffect(CustomerPage)));
			expect((yield* readCustomer()).customers.rows[0]).toMatchObject({
				name: 'created:Acme'
			});
			const target = { id: yield* Schema.decodeUnknownEffect(id_of('customers'))(record.id), revision: record.revision };
			yield* caller.act({ 'customers.update': [{ target, set: { name: 'Edited' } }] });
			expect((yield* readCustomer()).customers.rows[0]).toMatchObject({
				name: 'updated:Edited'
			});
			const selected = (yield* readCustomer()).customers.rows[0];
			if (selected === undefined) throw new Error('Missing updated customer.');
			const batch = yield* (yield* t.body_acts(t.admin))({
				'customers.update': [{ target: selected, set: { name: 'Batch' } }],
				'customers.create': [{ name: 'Other' }]
			});
			if (batch.kind !== 'committed') throw new Error('The fixture batch is held for approval.');
			expect(batch.output).toEqual({ 'customers.update': null, 'customers.create': null });
			const retained = (yield* readCustomer()).customers.rows[0];
			if (retained === undefined) throw new Error('Missing retained customer.');
			expect(yield* caller.act({ 'customers.delete': [{ target: retained }] })).toMatchObject({ kind: 'committed' });
			expect(t.manifest.exposures['customers']).toMatchObject({
				create: { transform: true },
				update: { transform: true },
				delete: {}
			});
			expect(callbacks.exposures.customers).toEqual({
				outputs: { default: { customers: { fields: 'all' } } },
				create: { columns: { customers: ['name'] } },
				update: { columns: { customers: ['name'] } },
				delete: {}
			});
		}).pipe(Effect.scoped)
);

it.live('a clock set back finds the crons it passed ahead of it again', () =>
	Effect.gen(function* () {
		const nightly = {
			...manifest,
			automations: {
				nightly: {
					description: 'Runs at two',
					input: {},
					policies: ['reader'],
					on: [{ cron: '0 2 * * *' }]
				}
			}
		} satisfies EngineManifest;
		// a run that fails is one the kit reports; a quiet one leaves no row to count
		const guest = yield* program(
			`export default { automation: { nightly: { body: function* () { throw new Error('ran'); } } } }`
		);
		const t = Context.get(
			yield* Layer.build(TestWorkspace.layer({ manifest: nightly, guest })),
			TestWorkspace
		);
		t.clock.set('2026-11-02T02:00:00.000Z');
		expect((yield* t.run_due()).failed).toHaveLength(1);
		// a file's tests share one workspace: an earlier test's date is no reason for this one to run nothing
		t.clock.set('2026-10-01T02:00:00.000Z');
		expect((yield* t.run_due()).failed).toHaveLength(1);
	}).pipe(Effect.scoped)
);
it.live('fixture callbacks require explicit existing write verbs', () =>
	Effect.gen(function* () {
		for (const name of ['customers', 'customers.delete', 'missing.create']) {
			const failure = yield* Effect.flip(
				Layer.build(
					TestWorkspace.layer({
						manifest,
						transforms: [name]
					})
				)
			);
			expect(failure).toBeInstanceOf(KitInvalid);
			expect(failure.message).toContain(name);
		}
	}).pipe(Effect.scoped)
);

it.live(
	'read requests revive native values, computed NULLs decode, and typed queued automation outputs persist',
	() =>
		Effect.gen(function* () {
			const id = '0199a000-0000-4000-8000-000000000001';
			const row = { kind: 'row', of: 'customers' } as const;
			const outputs = {
				...manifest,
				automations: {
					customers_return_row: {
						description: 'One recorded row',
						input: {},
						output: row,
						policies: ['reader']
					}
				}
			} satisfies EngineManifest;
			const guest = yield* program(
				`export default { automation: { customers_return_row: { body: function* (_, ctx) { return (yield* ctx.query({ customers: { where: { id: { eq: '${id}' } } } })).customers.rows[0]; } } } };`
			);
			const context = yield* Layer.build(
				TestWorkspace.layer({
					manifest: outputs,
					guest,
					seed: {
						customers: [{ id, name: 'Acme', balance: '12.34', document: { note: 'Kept' } }]
					}
				})
			);
			const t = Context.get(context, TestWorkspace);
			const nativeRow = Schema.Struct({
				id: Schema.toType(input_schema({ kind: 'ref', to: 'customers' })),
				balance: Schema.toType(input_schema({ kind: 'decimal', scale: 2 })),
				document: Schema.Struct({ note: Schema.String })
			});
			const caller = yield* t.as(t.admin);
			const nativeAnswer = Schema.Struct({ customers: pageOf(nativeRow) });
			const request = { customers: { limit: 1 } } as const;
			const called = yield* caller.query(request).pipe(Effect.flatMap(Schema.decodeUnknownEffect(nativeAnswer)));
			const stored = yield* t.stored_query(request).pipe(Effect.flatMap(Schema.decodeUnknownEffect(nativeAnswer)));
			expect(called.customers.rows[0]?.balance).toBeTypeOf('string');
			expect(stored.customers.rows[0]?.balance).toBeTypeOf('string');
			expect(called.customers.next).toBeNull();
			expect(stored.customers.next).toBeNull();
			expect(called.customers.total).toBe(1);
			expect(stored.customers.total).toBe(1);
			// computed NULL values decode without widening required computed strings, for every exposed field
			const selected = { customers: {} } as const;
			const computed = Schema.Struct({ customers: pageOf(Schema.Struct({
				name: Schema.String,
				email_lower: Schema.Null,
				name_upper: Schema.String,
				email_label: Schema.String,
				email_default: Schema.String,
				email_chain: Schema.Null
			})) });
			const own = yield* caller.query(selected).pipe(Effect.flatMap(Schema.decodeUnknownEffect(computed)));
			expect(own.customers.rows[0]).toMatchObject({
				name: 'Acme',
				email_lower: null,
				name_upper: 'ACME',
				email_label: ' contact',
				email_default: 'unknown',
				email_chain: null
			});
			const readable = yield* (yield* t.as(t.member(['reader']))).query(selected).pipe(Effect.flatMap(Schema.decodeUnknownEffect(computed)));
			expect(readable.customers.rows[0]).toMatchObject({
				email_lower: null,
				name_upper: 'ACME',
				email_default: 'unknown',
				email_chain: null
			});
			const members = yield* caller.query({ sys_user: {} }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(
				Schema.Struct({ sys_user: pageOf(Schema.Struct({ party_id: Schema.Null, phone_key: Schema.Null })) })
			)));
			expect(members.sys_user.rows[0]).toMatchObject({
				party_id: null,
				phone_key: null
			});
			const result = yield* caller.run('customers_return_row', {}, JobResult);
			if (result.kind !== 'committed') throw new Error(JSON.stringify(result));
			const run = result.output;
			expect(
				yield* t.db.value(Schema.String, {
					text: 'select state from sys_run where id=$1',
					params: [run.id]
				})
			).toBe('queued');
			yield* t.run_due();
			expect(
				yield* t.db.rows(Schema.Struct({ state: Schema.String, output: Schema.Json }), {
					text: 'select state,output from sys_run where id=$1',
					params: [run.id]
				})
			).toEqual([
				{
					state: 'succeeded',
					output: expect.objectContaining({
						id,
						balance: '12.34',
						document: { note: 'Kept' }
					})
				}
			]);
		}).pipe(Effect.scoped)
);

it.live('computed JSON array lengths retain NULL propagation and the native operand restriction', () =>
	Effect.gen(function* () {
		const lengths = {
			...manifest,
			models: {
				customers: {
					...manifest.models.customers,
					fields: {
						...manifest.models.customers.fields,
						required_values: { kind: 'json', shape: { kind: 'int', many: true }, default: [] },
						optional_values: { kind: 'json', shape: { kind: 'int', many: true }, optional: true }
					},
					computed: {
						...manifest.models.customers.computed,
						required_length: { kind: 'int', expr: { json_length: { field: 'required_values' } } },
						optional_length: { kind: 'int', expr: { json_length: { field: 'optional_values' } } },
						plus_one: { kind: 'int', expr: { plus: [{ json_length: { field: 'optional_values' } }, 1] } },
						safe_length: { kind: 'int', expr: { coalesce: [{ json_length: { field: 'optional_values' } }, 0] } },
						chosen_length: { kind: 'int', expr: { when: [false, { json_length: { field: 'optional_values' } }, { json_length: { field: 'required_values' } }] } }
					}
				}
			}
		} satisfies EngineManifest;
		const t = Context.get(yield* Layer.build(TestWorkspace.layer({
			manifest: lengths,
			seed: { customers: [
				{ id: '0199a000-0000-4000-8000-000000000001', name: 'Missing', required_values: [1, 2, 3], optional_values: null },
				{ id: '0199a000-0000-4000-8000-000000000002', name: 'Present', required_values: [], optional_values: [5, 6] }
			] }
		})), TestWorkspace);
		const Answer = Schema.Struct({ customers: pageOf(Schema.Struct({
			name: Schema.String,
			required_length: Schema.Int,
			optional_length: Schema.NullOr(Schema.Int),
			plus_one: Schema.NullOr(Schema.Int),
			safe_length: Schema.Int,
			chosen_length: Schema.Int
		})) });
		const answer = yield* (yield* t.as(t.admin)).query(dynamic_read({ customers: {
			fields: ['name', 'required_length', 'optional_length', 'plus_one', 'safe_length', 'chosen_length'],
			order_by: 'name'
		} })).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Answer)));
		expect(answer.customers.rows).toEqual([
			{ name: 'Missing', required_length: 3, optional_length: null, plus_one: null, safe_length: 0, chosen_length: 3 },
			{ name: 'Present', required_length: 0, optional_length: 2, plus_one: 3, safe_length: 2, chosen_length: 0 }
		]);
		for (const expr of [
			{ json_length: { field: 'name' } },
			{ json_length: { coalesce: [{ field: 'optional_values' }, { field: 'required_values' }] } }
		] as const) {
			const invalid = {
				...lengths,
				models: { customers: { ...lengths.models.customers, computed: {
					...lengths.models.customers.computed,
					invalid_length: { kind: 'int', expr }
				} } }
			} satisfies EngineManifest;
			const failure = yield* Effect.flip(Layer.build(TestWorkspace.layer({ manifest: invalid })));
			expect(failure.message).toContain('json_length reads a JSON array column');
		}
	}).pipe(Effect.scoped)
);

it.live('run requires a real result decoder for queued receipts and native call outputs', () =>
	Effect.gen(function* () {
		const automation = {
			...manifest,
			automations: {
				sweep: { description: 'A queued calculation', policies: ['reader'] },
				trig: {
					description: 'An immediate calculation',
					mode: 'call',
					policies: ['reader'],
					output: { kind: 'object', fields: {
						amount: { kind: 'decimal', scale: 2 },
						at: { kind: 'instant' }
					} }
				}
			}
		} satisfies EngineManifest;
		const guest = yield* program(`export default { automation: {
			sweep: { body: function* () {} },
			trig: { body: function* () { return { amount: '12.50', at: '2026-09-25T10:00:00.000Z' }; } }
		} };`);
		const t = Context.get(yield* Layer.build(TestWorkspace.layer({ manifest: automation, guest })), TestWorkspace);
		const caller = yield* t.as(t.admin);
		const id = uuidv7(Date.parse(t.clock.now()));
		const queued = yield* caller.run('sweep', {}, JobResult, { id });
		expectTypeOf(queued).toEqualTypeOf<JobResult>();
		if (queued.kind !== 'committed') throw new Error('The queued calculation was held.');
		expect(queued.output).toEqual({ id, automation: 'sweep' });
		expect(yield* t.db.value(Schema.String, { text: 'SELECT state FROM sys_run WHERE id=$1', params: [id] })).toBe('queued');

		const NativeOutput = Schema.Struct({
			amount: Schema.String,
			at: Schema.String
		});
		const output = yield* caller.run('trig', {}, NativeOutput);
		expectTypeOf(output).toEqualTypeOf<typeof NativeOutput.Type>();
		expect(Number(output.amount) + 0.5).toBe(13);
		expect(output.at).toBe('2026-09-25T10:00:00.000Z');
		const wrong = yield* Effect.flip(caller.run('trig', {}, Schema.Struct({ amount: Schema.Number, at: Schema.String })));
		expect(wrong._tag).toBe('SchemaError');
		expect(yield* t.db.value(Schema.Int, {
			text: "SELECT count(*)::int FROM sys_run WHERE automation='trig'", params: []
		})).toBe(0);
	}).pipe(Effect.scoped)
);

it.live(
	'sync controls read one selected partition and drain writes without firing scheduled runs',
	() =>
		Effect.gen(function* () {
			const synced = {
				...manifest,
				exposures: {
					customers: {
						...manifest.exposures.customers,
						syncs: {
							remote: { with: 'calendar', partitions: 'calendars', read: true, write: true }
						}
					}
				}
			} satisfies EngineManifest;
			const guest =
				yield* program(`export default { model: { customers: { bodies: { syncs: { remote: {
			read: function* ({items}) { return {rows:items.map((item) => ({$id:item.id,name:item.name}))}; },
			write: function* ({row}, ctx) { return yield* ctx.request({method:'POST',path:'/customers',body:{name:row.name}}); }
		} } } } } };`);
			const t = Context.get(
				yield* Layer.build(TestWorkspace.layer({ manifest: synced, guest, seed: { sys_integration: accounts } })),
				TestWorkspace
			);
			const reads: { instance: string; sync: string; partition: string }[] = [];
			t.fakes.links.page = (instance, sync, partition) =>
				Effect.sync(() => {
					reads.push({ instance, sync, partition });
					return {
						items: [{ id: 'remote-1', name: 'Remote customer' }],
						cursor: 'next',
						more: false
					};
				});
			t.fakes.links.answer = () =>
				Effect.succeed({ status: 200, body: { $id: 'local-1', $version: '1' } });
			expect(
				yield* t.syncs.read('customers.sync.remote', {
					instance: 'calendar',
					partition: 'secondary'
				})
			).toEqual({ pages: 1 });
			expect(reads).toEqual([
				{ instance: 'calendar', sync: 'customers.remote', partition: 'secondary' }
			]);
			expect(yield* t.syncs.deliver()).toEqual({ delivered: 0 });
			expect(
				(yield* (yield* t.as(t.admin)).act({ 'customers.create': [{ name: 'Local customer' }] })).kind
			).toBe('committed');
			expect(yield* t.syncs.deliver()).toEqual({ delivered: 1 });
			expect(yield* t.syncs.deliver()).toEqual({ delivered: 0 });
			expect(yield* Effect.flip(t.syncs.read('customers.sync.missing'))).toBeInstanceOf(KitInvalid);
		}).pipe(Effect.scoped)
);

it.live(
	'a later workspace of the same schema starts from the checkpoint, not from what an earlier one wrote',
	() =>
		Effect.gen(function* () {
			const id = '0199a000-0000-4000-8000-000000000001';
			const acquire = (name: string) =>
				Layer.build(TestWorkspace.layer({ manifest, seed: { customers: [{ id, name }], sys_integration: accounts } })).pipe(
					Effect.map((context) => Context.get(context, TestWorkspace))
				);
			const connection = (t: Kit) =>
				t.db.rows(Schema.Struct({ configuration: Schema.Json }), {
					text: `SELECT configuration FROM sys_integration WHERE id = 'ledger'`,
					params: []
				});
			yield* Effect.scoped(
				Effect.gen(function* () {
					const a = yield* acquire('Acme');
					expect(yield* connection(a)).toEqual([{ configuration: { lag: 15 } }]);
					yield* a.db.write({
						text: 'UPDATE sys_integration SET configuration = $1::jsonb WHERE id = $2',
						params: ['{"lag":99}', 'ledger']
					});
					expect(
						yield* Effect.flip(
							a.db.write({
								text: "INSERT INTO customers (id, name) VALUES ($1, 'Duplicate')",
								params: [id]
							})
						)
					).toMatchObject({ _tag: 'DbError', sqlstate: '23505' });
				})
			);
			const b = yield* acquire('Beta');
			expect(yield* connection(b)).toEqual([{ configuration: { lag: 15 } }]);
			expect(
				yield* b.db.rows(Schema.Struct({ name: Schema.String }), {
					text: 'SELECT name FROM customers',
					params: []
				})
			).toEqual([{ name: 'Beta' }]);
		}).pipe(Effect.scoped)
);
