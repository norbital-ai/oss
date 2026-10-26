// The Effect test kit: scoped acquisition and typed refusal failures, with no Promise facet.
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { PGlite } from '@electric-sql/pglite';
import { it, vi } from '@effect/vitest';
import { Pristine } from '../src/node/db/pglite.ts';
import { ActRefused } from '../src/decl/errors.ts';
import { inputSchema } from '@norbital-ai/std/kind';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { expect, KitInvalid, layer, TestWorkspace } from '../src/test/index.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import { uuidv7 } from '../src/protocol/wire.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		customers: { description: 'A customer', label: 'name', fields: { name: { kind: 'text' } } }
	},
	relationships: {},
	collections: { customers: { read: { fields: 'all' }, create: { input: { columns: ['name'] } } } },
	policies: { reader: { description: 'Reads customers', grants: { customers: { read: true } } } },
	automations: {},
	integrations: {},
	teams: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;

it.live(
	'explicit callback names activate per-verb markers without mutating a shared manifest',
	() =>
		Effect.gen(function* () {
			const callbacks = {
				...manifest,
				collections: {
					customers: {
						...manifest.collections.customers,
						update: { input: { columns: ['name'] } },
						delete: {}
					}
				}
			} satisfies EngineManifest;
			const guest = yield* program(`export default { collection: { customers: { bodies: {
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
			const created = yield* caller.act('customers.create', { name: 'Acme' });
			if (created.kind !== 'committed') throw new Error('The fixture did not commit.');
			const record = created.records.find((row) => row.collection === 'customers');
			if (record === undefined) throw new Error('The fixture returned no customer.');
			expect(yield* caller.query('customers', { id: record.id })).toMatchObject({
				name: 'created:Acme'
			});
			yield* caller.act('customers.update', { target: record.id, set: { name: 'Edited' } });
			expect(yield* caller.query('customers', { id: record.id })).toMatchObject({
				name: 'updated:Edited'
			});
			const batch = yield* t.bodyActs(t.admin).many([
				{
					callable: 'customers.upsert',
					input: { id: record.id, name: 'Batch' },
					onConflict: 'update'
				},
				{ callable: 'customers.create', input: { name: 'Other' } }
			]);
			if (batch.kind !== 'committed') throw new Error('The fixture batch is held for approval.');
			expect(batch.output).toEqual([[record.id], null]);
			expect(
				yield* Effect.flip(caller.act('customers.delete', { target: record.id }))
			).toMatchObject({ _tag: 'ActRefused', message: 'Keep this fixture.' });
			expect(t.manifest.collections['customers']).toMatchObject({
				create: { transform: true },
				update: { transform: true },
				delete: { check: true }
			});
			expect(callbacks.collections.customers).toEqual({
				read: { fields: 'all' },
				create: { input: { columns: ['name'] } },
				update: { input: { columns: ['name'] } },
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
	'declared row outputs revive query values and persist typed queued automation outputs',
	() =>
		Effect.gen(function* () {
			const id = '0199a000-0000-4000-8000-000000000001';
			const row = { kind: 'row', of: 'customers' } as const;
			const outputs = {
				...manifest,
				models: {
					customers: {
						...manifest.models.customers,
						fields: {
							name: { kind: 'text' },
							balance: { kind: 'decimal', scale: 2 },
							document: {
								kind: 'json',
								shape: { kind: 'object', fields: { note: { kind: 'text' } } }
							}
						}
					}
				},
				collections: {
					customers: {
						...manifest.collections.customers,
						queries: {
							one: { description: 'One native row', input: {}, output: row },
							nested: {
								description: 'Rows inside each composite output',
								input: {},
								output: {
									kind: 'object',
									fields: {
										row,
										rows: { kind: 'list', of: row },
										by: { kind: 'record', of: row },
										choice: { kind: 'union', by: 'kind', arms: { one: { row } } }
									}
								}
							}
						}
					}
				},
				automations: {
					return_row: { description: 'One recorded row', input: {}, output: row, runAs: 'trigger' }
				}
			} satisfies EngineManifest;
			const guest = yield* program(`export default { collection: { customers: { bodies: {
			queries: {
				one: function* (_, ctx) { return yield* ctx.query('customers', {id:'${id}'}); },
				nested: function* (_, ctx) {
					const row = yield* ctx.query('customers', {id:'${id}'});
					return {row, rows:[row], by:{acme:row}, choice:{kind:'one',row}};
				}
			}
		} } }, automation: { return_row: { body: function* (_, ctx) { return yield* ctx.query('customers', {id:'${id}'}); } } } };`);
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
			expect(Schema.is(nativeRow)(yield* caller.query('customers.one', {}))).toBe(true);
			expect(
				Schema.is(
					Schema.Struct({
						row: nativeRow,
						rows: Schema.Array(nativeRow),
						by: Schema.Record(Schema.String, nativeRow),
						choice: Schema.Struct({ kind: Schema.Literal('one'), row: nativeRow })
					})
				)(yield* caller.query('customers.nested', {}))
			).toBe(true);
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
				collections: {
					customers: {
						...manifest.collections.customers,
						syncs: {
							remote: { with: 'calendar', partitions: 'calendars', read: true, write: true }
						}
					}
				},
				integrations: {
					calendar: {
						description: 'A pushed remote catalogue',
						driver: 'calendar',
						configuration: {
							calendars: { kind: 'text', many: true, default: ['primary', 'secondary'] }
						}
					}
				},
				connections: { calendar: { integration: 'calendar' } }
			} satisfies EngineManifest;
			const guest =
				yield* program(`export default { collection: { customers: { bodies: { syncs: { remote: {
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
			expect((yield* t.as(t.admin).act('customers.create', { name: 'Local customer' })).kind).toBe(
				'committed'
			);
			expect(yield* t.syncs.deliver()).toEqual({ delivered: 1 });
			expect(yield* t.syncs.deliver()).toEqual({ delivered: 0 });
			expect(yield* Effect.flip(t.syncs.read('customers.sync.missing'))).toBeInstanceOf(KitInvalid);
		}).pipe(Effect.scoped)
);

it.live('computed NULL values decode without widening required computed strings', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const computed = {
				...manifest,
				models: {
					customers: {
						...manifest.models.customers,
						fields: {
							name: { kind: 'text' },
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
				}
			} satisfies EngineManifest;
			const t = Context.get(
				yield* Layer.build(
					TestWorkspace.layer({
						manifest: computed,
						seed: { customers: [{ id: '0199a000-0000-4000-8000-000000000001', name: 'Acme' }] }
					})
				),
				TestWorkspace
			);
			const selected = {
				select: {
					name: true,
					email_lower: true,
					name_upper: true,
					email_label: true,
					email_default: true,
					email_chain: true
				},
				all: true
			} satisfies { select: Record<string, true>; all: true };
			expect((yield* t.as(t.admin).query('customers', selected)).rows[0]).toMatchObject({
				name: 'Acme',
				email_lower: null,
				name_upper: 'ACME',
				email_label: ' contact',
				email_default: 'unknown',
				email_chain: null
			});
			expect(
				(yield* t.as(t.member(['reader'])).query('customers', selected)).rows[0]
			).toMatchObject({
				email_lower: null,
				name_upper: 'ACME',
				email_default: 'unknown',
				email_chain: null
			});
			expect(
				(yield* t
					.as(t.admin)
					.query('sys_user', { select: { party_id: true, phone_key: true }, all: true })).rows[0]
			).toMatchObject({ party_id: null, phone_key: null });
		})
	)
);

it.live('schema images are shared across isolated copies and change with the declaration', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const pristine = yield* Pristine.pipe(Effect.flatten, Effect.provide(Pristine.layer));
			const create = vi.spyOn(PGlite, 'create');
			return yield* Effect.gen(function* () {
				const id = '0199a000-0000-4000-8000-000000000001';
				const connected = {
					...manifest,
					integrations: {
						ledger: {
							description: 'Ledger',
							driver: 'http',
							configuration: { lag: { kind: 'int', default: 15 } }
						}
					},
					connections: { ledger: { integration: 'ledger' } }
				} satisfies EngineManifest;
				const contexts = yield* Effect.all(
					['Acme', 'Beta'].map((name) =>
						Layer.build(
							TestWorkspace.layer({ manifest: connected, seed: { customers: [{ id, name }] } })
						)
					),
					{ concurrency: 'unbounded' }
				);
				const first = contexts[0],
					second = contexts[1];
				if (first === undefined || second === undefined)
					throw new Error('Both workspaces are acquired.');
				const a = Context.get(first, TestWorkspace),
					b = Context.get(second, TestWorkspace);
				const dumpOptions = Schema.decodeUnknownOption(
					Schema.Struct({ loadDataDir: Schema.instanceOf(Blob) })
				);
				const images = create.mock.calls
					.flatMap(([options]) => {
						const decoded = dumpOptions(options);
						return Option.isSome(decoded) ? [decoded.value.loadDataDir] : [];
					})
					.slice(-2);
				expect(images).toHaveLength(2);
				expect(images[0]).toBe(images[1]);
				expect(images[0]).not.toBe(pristine);
				const connection = (t: typeof a) =>
					t.db.rows(
						Schema.Struct({ id: Schema.String, named: Schema.Boolean, configuration: Schema.Json }),
						{ text: 'SELECT id, named, configuration FROM sys_integration', params: [] }
					);
				expect(yield* connection(a)).toEqual([
					{ id: 'ledger', named: true, configuration: { lag: 15 } }
				]);
				yield* a.db.write({
					text: 'UPDATE sys_integration SET configuration = $1::jsonb WHERE id = $2',
					params: ['{"lag":99}', 'ledger']
				});
				expect(yield* connection(b)).toEqual([
					{ id: 'ledger', named: true, configuration: { lag: 15 } }
				]);
				expect(
					yield* Effect.flip(
						a.db.write({
							text: "INSERT INTO customers (id, name) VALUES ($1, 'Duplicate')",
							params: [id]
						})
					)
				).toMatchObject({ _tag: 'DbError', sqlstate: '23505' });
				yield* a.db.write({
					text: 'UPDATE customers SET name = $1 WHERE id = $2',
					params: ['Changed', id]
				});
				expect(
					yield* b.db.rows(Schema.Struct({ name: Schema.String }), {
						text: 'SELECT name FROM customers',
						params: []
					})
				).toEqual([{ name: 'Beta' }]);
				const extended = {
					...connected,
					models: {
						customers: {
							...manifest.models.customers,
							fields: {
								...manifest.models.customers.fields,
								marked: { kind: 'bool', default: false }
							}
						}
					}
				} satisfies EngineManifest;
				const changed = Context.get(
					yield* Layer.build(
						TestWorkspace.layer({
							manifest: extended,
							seed: { customers: [{ id, name: 'Gamma', marked: true }] }
						})
					),
					TestWorkspace
				);
				expect(
					yield* changed.db.rows(Schema.Struct({ name: Schema.String, marked: Schema.Boolean }), {
						text: 'SELECT name, marked FROM customers',
						params: []
					})
				).toEqual([{ name: 'Gamma', marked: true }]);
			}).pipe(Effect.ensuring(Effect.sync(() => create.mockRestore())));
		})
	)
);

layer(TestWorkspace.layer({ manifest }))('TestWorkspace', (it) => {
	it.effect('a caller commits through act, and a refused act fails with ActRefused', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const created = yield* t.as(t.admin).act('customers.create', { name: 'Acme' });
			expect(created.kind).toBe('committed');
			const refused = yield* Effect.flip(
				t.as(t.member(['reader'])).act('customers.create', { name: 'Beta' })
			);
			expect(refused).toBeInstanceOf(ActRefused);
			expect(refused).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
		})
	);

	it.effect('an act exposes only its Effect and fails with the original refusal', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const act = t.as(t.member(['reader'])).act('customers.create', { name: 'Beta' });
			expect(Effect.isEffect(act)).toBe(true);
			expect('then' in act).toBe(false);
			expect(yield* Effect.flip(act)).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
		})
	);
});
