// The Effect test kit: scoped acquisition and typed refusal failures, with no Promise facet.
import { Context, Effect, Layer, Schema } from 'effect';
import { it } from '@effect/vitest';
import { inputSchema } from '@norbital-ai/std/kind';
import type { EngineManifest } from '../../bolt/src/engine/manifest.ts';
import { expect, KitInvalid, TestWorkspace, type Kit } from '../src/test/index.ts';
import { program } from '../src/test/guest.ts';
import { actReply, routeFixture } from '../../bolt/tests/support/route-fixture.ts';
import { uuidv7 } from '../../bolt/src/protocol/wire.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		// one schema for every case: each workspace below loads the same checkpoint
		customers: {
			description: 'A customer',
			label: 'name',
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
				party_id: { kind: 'text', expr: { jsonText: [{ field: 'party' }, 'id'] } },
				email_lower: {
					kind: 'text',
					expr: { regexReplace: [{ field: 'email' }, '[^0-9]', ''] }
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
			read: { customers: { fields: 'all' } },
			create: { columns: { customers: ['name'] } }
		}
	},
	policies: { reader: { description: 'Reads customers', grants: { customers: { read: true } } } },
	automations: {},
	// connections are part of the schema checkpoint: every case declares both, so every workspace loads one checkpoint
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
	connections: { calendar: { integration: 'calendar' }, ledger: { integration: 'ledger' } },
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} },
	needs: []
} satisfies EngineManifest;

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
			create: function* (rows) { return rows.map((row) => ({...row,name:'created:'+row.name})); },
			update: function* (changes) { return changes.map(({set}) => ({...set,name:'updated:'+set.name})); },
			delete: function* (_, ctx) { return yield* ctx.refuse('Keep this fixture.'); }
		} } } };`);
			const transforms = (function* () {
				yield 'customers.create';
				yield 'customers.update';
				yield 'customers.delete';
			})();
			const t = Context.get(
				yield* Layer.build(TestWorkspace.layer({ manifest: callbacks, guest, transforms })),
				TestWorkspace
			);
			const caller = t.as(t.admin);
			const created = yield* caller.act('customers.create', [{ name: 'Acme' }]);
			if (created.kind !== 'committed') throw new Error('The fixture did not commit.');
			const record = created.records.find((row) => row.model === 'customers');
			if (record === undefined) throw new Error('The fixture returned no customer.');
			// the one customer this fixture holds
			const customer = { customers: { limit: 1 } } as const;
			expect((yield* caller.query(customer)).customers.rows[0]).toMatchObject({
				name: 'created:Acme'
			});
			yield* caller.act('customers.update', [{ target: record.id, set: { name: 'Edited' } }]);
			expect((yield* caller.query(customer)).customers.rows[0]).toMatchObject({
				name: 'updated:Edited'
			});
			const batch = yield* t.bodyActs(t.admin).many([
				{
					callable: 'customers.upsert',
					input: [{ id: record.id, name: 'Batch' }],
					onConflict: 'update'
				},
				{ callable: 'customers.create', input: [{ name: 'Other' }] }
			]);
			if (batch.kind !== 'committed') throw new Error('The fixture batch is held for approval.');
			expect(batch.output).toEqual([[record.id], null]);
			expect(
				yield* Effect.flip(caller.act('customers.delete', [{ target: record.id }]))
			).toMatchObject({ _tag: 'ActRefused', message: 'Keep this fixture.' });
			expect(t.manifest.exposures['customers']).toMatchObject({
				create: { transform: true },
				update: { transform: true },
				delete: { check: true }
			});
			expect(callbacks.exposures.customers).toEqual({
				read: { customers: { fields: 'all' } },
				create: { columns: { customers: ['name'] } },
				update: { columns: { customers: ['name'] } },
				delete: {}
			});
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
					return_row: { description: 'One recorded row', input: {}, output: row, policies: ['reader'] }
				}
			} satisfies EngineManifest;
			const guest = yield* program(
				`export default { automation: { return_row: { body: function* (_, ctx) { return (yield* ctx.query({ customers: { where: { id: { eq: '${id}' } } } })).customers.rows[0]; } } } };`
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
				id: Schema.toType(inputSchema({ kind: 'id', of: 'customers' })),
				balance: Schema.toType(inputSchema({ kind: 'decimal', scale: 2 })),
				document: Schema.Struct({ note: Schema.String })
			});
			const caller = t.as(t.admin);
			const page = Schema.Struct({ rows: Schema.Array(nativeRow), next: Schema.Null });
			const request = { customers: { limit: 1 } } as const;
			expect(Schema.is(page)((yield* caller.query(request)).customers)).toBe(true);
			expect(Schema.is(page)((yield* t.storedQuery(request)).customers)).toBe(true);
			// computed NULL values decode without widening required computed strings, for every exposed field
			const selected = { customers: {} } as const;
			expect((yield* caller.query(selected)).customers.rows[0]).toMatchObject({
				name: 'Acme',
				email_lower: null,
				name_upper: 'ACME',
				email_label: ' contact',
				email_default: 'unknown',
				email_chain: null
			});
			expect((yield* t.as(t.member(['reader'])).query(selected)).customers.rows[0]).toMatchObject({
				email_lower: null,
				name_upper: 'ACME',
				email_default: 'unknown',
				email_chain: null
			});
			expect((yield* caller.query({ sys_user: {} })).sys_user.rows[0]).toMatchObject({
				party_id: null,
				phone_key: null
			});
			const result = (yield* actReply(yield* routeFixture(context), caller.authority, {
				callable: 'start',
				input: { automation: 'return_row', id: uuidv7(Date.parse(t.clock.now())), input: {} },
				issuedAt: t.clock.now()
			})).outcome;
			if (result.kind !== 'committed') throw new Error(JSON.stringify(result));
			const run = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
				result.output
			);
			expect(
				yield* t.db.value(Schema.String, {
					text: 'select state from sys_run where id=$1',
					params: [run.id]
				})
			).toBe('queued');
			yield* t.runDue();
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
						balance: { $dec: '12.34' },
						document: { note: 'Kept' }
					})
				}
			]);
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
				yield* Layer.build(TestWorkspace.layer({ manifest: synced, guest })),
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
				(yield* t.as(t.admin).act('customers.create', [{ name: 'Local customer' }])).kind
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
				Layer.build(TestWorkspace.layer({ manifest, seed: { customers: [{ id, name }] } })).pipe(
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
