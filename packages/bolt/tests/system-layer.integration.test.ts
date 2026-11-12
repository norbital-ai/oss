import { seed_envoys } from './support/envoys.ts';
// The built-in layer's integration instances on PGlite: `sys_integration` written through ordinary acts and its
// engine-side transform, and the instance credential store's epoch fence.
import { randomBytes } from 'node:crypto';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { KeysPort } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { PgliteDb, type PgliteClient } from '../src/node/db/pglite.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { compile_authority } from '../src/engine/access/authority.ts';
import { toPred } from '../src/engine/access/pred.ts';
import { credentials } from '../src/engine/integrations/credentials.ts';
import { Keys } from '../src/engine/ports.ts';
import { Secrets } from '../src/engine/secrets.ts';
import { keys_port } from '../src/node/keys.ts';
import { act, record_capabilities, type ActRequest } from '../src/engine/write/act.ts';
import {
	load_pack,
	packLoader,
	source_of,
	type Pack,
	type PackStep
} from '../src/engine/write/pack.ts';
import {
	admin,
	arm,
	authority,
	delete_arm,
	grants,
	manifest as base,
	member,
	NOW,
	TODAY,
	write_arm
} from './write-fixture.ts';

const m: EngineManifest = {
	...base,
	integrations: {
		erp: {
			description: 'ERP',
			driver: 'http',
			configuration: { region: { kind: 'text' }, lag: { kind: 'int', default: 15 } }
		}
	}
};
const deskEnvoy = '0199a000-0000-7000-8000-0000000000e1';
const runtimeEnvoys = [
	{
		id: deskEnvoy,
		name: 'Desk',
		audience: 'private',
		policies: ['p'],
		delegation: 'disabled',
		task: 'Answer.'
	}
] satisfies Parameters<typeof seed_envoys>[1];

const ada = member.kind === 'member' ? member.id : '';
const Id = Schema.Struct({ id: Schema.String });
const Count = Schema.Struct({ n: Schema.Number });
const IdConfiguration = Schema.Struct({ id: Schema.String, configuration: Schema.Json });
const Instance = Schema.Struct({
	id: Schema.String,
	integration: Schema.String,
	name: Schema.String,
	owner: Schema.NullOr(Schema.String),
	active: Schema.Boolean,
	configuration: Schema.Json,
	revision: Schema.Number
});
const fixture = Effect.gen(function* () {
	const pg = yield* TestDb.open(m);
	const native = { active: 0, batches: 0, keyActive: 0, keyCalls: { seal: 0, open: 0 } };
	const client: PgliteClient = {
		query: (text, params) => pg.query(text, params),
		exec: (text) => pg.exec(text),
		execProtocol: pg.execProtocol.bind(pg),
		parsers: pg.parsers,
		transaction: (body) => {
			let entered = false;
			return pg
				.transaction(async (tx) => {
					expect(native.keyActive).toBe(0);
					entered = true;
					native.active++;
					native.batches++;
					return await body(tx);
				})
				.finally(() => {
					if (entered) native.active--;
				});
		}
	};
	const db = PgliteDb.make(client);
	yield* seed_envoys(db, runtimeEnvoys);
	yield* db.write({
		text: `insert into sys_user (id, name) values ($1, 'Ada'), ('u2', 'Bob')`,
		params: [ada]
	});
	yield* db.write({
		text: `INSERT INTO sys_integration (id, integration, name) VALUES ('mail', 'email', 'mail'), ('desk', 'whatsapp', 'desk')`,
		params: []
	});
	let n = 0;
	const read = <A>(schema: Schema.Decoder<A>, sql: string, params: readonly Json[] = []) =>
		db.rows(schema, { text: sql, params });
	const run = (over: Partial<ActRequest> & Pick<ActRequest, 'verb' | 'input'>) =>
		act(
			{ manifest: m, db },
			{
				model: 'sys_integration',
				mode: { _tag: 'Direct' },
				key: `key-${n}`,
				issuedAt: NOW,
				authority: admin,
				bindings: { now: NOW, today: TODAY, tz: 'UTC' },
				invocationId: `inv-${n++}`,
				...over
			}
		).pipe(Effect.map((answer) => answer.outcome));
	const created = Effect.fnUntraced(function* (input: Json) {
		const o = yield* run({ verb: 'create', input: [input] });
		if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
		const record = o.records[0];
		if (record === undefined) throw new Error('No created integration instance');
		return record.id;
	});
	const codec = () =>
		Effect.gen(function* () {
			const port = keys_port(randomBytes(32));
			const keyCall = async <A>(method: 'seal' | 'open', work: () => Promise<A>): Promise<A> => {
				expect(native.active).toBe(0);
				native.keyActive++;
				native.keyCalls[method]++;
				try {
					return await work();
				} finally {
					native.keyActive--;
					expect(native.active).toBe(0);
				}
			};
			const observed: KeysPort = {
				seal: (plain, aad, signal) => keyCall('seal', () => port.seal(plain, aad, signal)),
				open: (sealed, aad, signal) => keyCall('open', () => port.open(sealed, aad, signal))
			};
			const context = yield* Layer.build(
				Secrets.layer([]).pipe(Layer.provide(Keys.fromAbi(observed)))
			).pipe(Effect.provideService(TenantDb, db));
			return Context.get(context, Secrets);
		});
	return { db, read, run, created, codec, native };
});
class SystemFixture extends Context.Service<SystemFixture, Effect.Success<typeof fixture>>()(
	'test/SystemFixture'
) {}
const SystemFixtureLive = Layer.effect(SystemFixture, fixture).pipe(
	Layer.provideMerge(NodeCrypto.layer)
);

describe('sys_integration: ordinary acts and the engine transform', () => {
	it.effect(
		'refuses an unknown definition, an invalid configuration and a personal instance of a driver that syncs none; creates one with its configuration decoded and defaulted',
		() =>
			Effect.gen(function* () {
				const { read, run, created } = yield* SystemFixture;

				expect(
					yield* run({ verb: 'create', input: [{ integration: 'nope', name: 'x' }] })
				).toMatchObject({
					kind: 'refused',
					code: 'refused',
					rule: 'sys_integration.transform',
					field: 'integration'
				});
				expect(
					yield* run({
						verb: 'create',
						input: [{ integration: 'erp', name: 'x', configuration: { lag: 'soon' } }]
					})
				).toMatchObject({
					kind: 'refused',
					field: 'configuration',
					message: expect.stringMatching(/region is required.*lag Expected number \| null/)
				});
				expect(
					yield* run({
						verb: 'create',
						input: [{ integration: 'erp', name: 'x', owner: ada, configuration: { region: 'sg' } }]
					})
				).toMatchObject({ kind: 'refused', field: 'owner' });
				expect(
					yield* read(Count, `select count(*)::int as n from sys_integration where integration = 'erp'`)
				).toEqual([{ n: 0 }]);
				// a valid one is created, its configuration decoded and defaulted
				const id = yield* created({
					integration: 'erp',
					name: 'Ledger',
					configuration: { region: 'sg' }
				});
				expect(
					yield* read(
						Instance,
						`select id, integration, name, owner, active, configuration, revision from sys_integration order by name`
					)
				).toEqual([
					{
						id,
						integration: 'erp',
						name: 'Ledger',
						owner: null,
						active: true,
						configuration: { lag: 15, region: 'sg' },
						revision: 1
					},
					{
						id: 'desk',
						integration: 'whatsapp',
						name: 'desk',
						owner: null,
						active: true,
						configuration: {},
						revision: 1
					},
					{
						id: 'mail',
						integration: 'email',
						name: 'mail',
						owner: null,
						active: true,
						configuration: {},
						revision: 1
					}
				]);
				expect(
					yield* run({
						verb: 'update',
						input: [{ target: { id }, set: { configuration: { region: 'my', lag: 5 }, active: false } }]
					})
				).toMatchObject({ kind: 'committed' });
				expect(
					yield* read(
						Schema.Struct({
							configuration: Schema.Json,
							active: Schema.Boolean,
							revision: Schema.Number
						}),
						`select configuration, active, revision from sys_integration where id = $1`,
						[id]
					)
				).toEqual([{ configuration: { region: 'my', lag: 5 }, active: false, revision: 2 }]);
			}).pipe(Effect.provide(SystemFixtureLive), Effect.scoped)
	);

	it.effect(
		"deploys a runtime envoy only on a workspace conversation instance; preserves definition and owner; deletes ordinary runtime accounts",
		() =>
			Effect.gen(function* () {
				const { read, run, created } = yield* SystemFixture;
				const erp = yield* created({
					integration: 'erp',
					name: 'Ledger',
					configuration: { region: 'sg' }
				});
				const personal = yield* created({
					integration: 'whatsapp',
					name: "Ada's phone",
					owner: ada
				});
				expect(
					yield* run({ verb: 'update', input: [{ target: { id: erp }, set: { envoy: deskEnvoy } }] })
				).toMatchObject({
					kind: 'refused',
					field: 'envoy',
					message: expect.stringMatching(/conversation/)
				});
				expect(
					yield* run({ verb: 'update', input: [{ target: { id: personal }, set: { envoy: deskEnvoy } }] })
				).toMatchObject({
					kind: 'refused',
					field: 'envoy',
					message: expect.stringMatching(/personal/)
				});
				expect(
					yield* run({ verb: 'update', input: [{ target: { id: 'desk' }, set: { envoy: 'nope' } }] })
				).toMatchObject({ kind: 'refused', field: 'envoy' });
				expect(
					yield* run({ verb: 'update', input: [{ target: { id: 'desk' }, set: { envoy: deskEnvoy } }] })
				).toMatchObject({ kind: 'committed' });
				expect(
					yield* read(
						Schema.Struct({ envoy: Schema.NullOr(Schema.String) }),
						`select envoy from sys_integration where id = 'desk'`
					)
				).toEqual([{ envoy: deskEnvoy }]);

				expect(
					yield* run({
						verb: 'update',
						input: [{ target: { id: personal }, set: { integration: 'email' } }]
					})
				).toMatchObject({ kind: 'refused', code: 'invalid_input' });
				expect(
					yield* run({ verb: 'update', input: [{ target: { id: personal }, set: { owner: 'u2' } }] })
				).toMatchObject({ kind: 'refused', code: 'invalid_input' });
				expect(yield* run({ verb: 'delete', input: [{ target: { id: 'mail' } }] })).toMatchObject({
					kind: 'committed'
				});
				expect(yield* run({ verb: 'delete', input: [{ target: { id: personal } }] })).toMatchObject({
					kind: 'committed'
				});
				expect(
					(yield* read(Id, `select id from sys_integration where id in ('desk', 'mail', $1) order by id`, [
						personal
					])).map((r) => r['id'])
				).toEqual(['desk']);
			}).pipe(Effect.provide(SystemFixtureLive), Effect.scoped)
	);

	it.effect(
		"an administrator manages every instance (the bypass); identity stays the admin verbs'",
		() =>
			Effect.gen(function* () {
				const a = (yield* compile_authority(
					m,
					{ actor: admin.actor, policies: [], admin: true },
					'admin'
				)).models;
				expect([
					a['sys_integration']?.create.length,
					a['sys_integration']?.update.length,
					a['sys_integration']?.delete.length
				]).toEqual([1, 1, 1]);
				expect(a['sys_user']?.create).toEqual([]);
			})
	);

	it.effect(
		'a member reads the instances its read arm reaches and writes only the columns its arms admit',
		() =>
			Effect.gen(function* () {
				const { db, run, created } = yield* SystemFixture;
				const own = yield* toPred(m, 'sys_integration', { owner: { eq: { var: 'requestor.id' } } });
				// the kernel directory's staff read (an owner is a readable member), and the instances it owns
				const caller = authority({
					sys_user: grants('sys_user', { create: [], update: [], delete: [] }),
					sys_integration: grants('sys_integration', {
						read: { default: { sys_integration: [arm(own)] } },
						create: [write_arm({ sys_integration: ['integration', 'name', 'owner'] })],
						update: [write_arm({ sys_integration: ['name', 'active'] })],
						delete: [delete_arm()]
					})
				});
				const mine = yield* created({ integration: 'email', name: 'Ada mail', owner: ada });
				expect(
					yield* run({
						verb: 'create',
						input: [{ integration: 'whatsapp', name: 'My phone', owner: ada }],
						authority: caller
					})
				).toMatchObject({ kind: 'committed' });
				// a column outside the arm's `columns` is refused before any check
				expect(
					yield* run({
						verb: 'create',
						input: [{ integration: 'email', name: 'Bob mail', owner: ada, configuration: {} }],
						authority: caller
					})
				).toMatchObject({ kind: 'refused', code: 'forbidden', field: 'configuration' });
				expect(
					yield* run({
						verb: 'update',
						input: [{ target: { id: mine }, set: { configuration: { region: 'sg' } } }],
						authority: caller
					})
				).toMatchObject({ kind: 'refused', code: 'forbidden', field: 'configuration' });
				expect(
					yield* run({
						verb: 'update',
						input: [{ target: { id: mine }, set: { name: 'Work mail' } }],
						authority: caller
					})
				).toMatchObject({ kind: 'committed' });
				expect(
					yield* run({
						verb: 'update',
						input: [{ target: { id: 'mail' }, set: { name: 'Mine now' } }],
						authority: caller
					})
				).toMatchObject({ kind: 'refused', code: 'not_found' });
				// a native form (the shell's instance sheet) reads the same allowlist and grants as advice;
				// the record is the one the caller's read arm (`owner = actor`) reached
				const row = (_c: string, id: string) =>
					db
						.one(Instance, {
							text: `select id, integration, name, owner, active, configuration, revision from sys_integration where id = $1 and owner = $2`,
							params: [id, ada]
						})
						.pipe(Effect.map(Option.getOrNull));
				const advice = yield* record_capabilities(
					{ manifest: m, db },
					'sys_integration',
					mine,
					caller,
					{ now: NOW, today: TODAY, tz: 'UTC' },
					row
				);
				expect(
					Object.fromEntries(
						Object.entries(advice?.fields ?? {})
							.filter(([f]) => ['name', 'active', 'configuration', 'integration'].includes(f))
							.map(([f, x]) => [f, x.writable])
					)
				).toEqual({
					name: true,
					active: true,
					configuration: false,
					integration: false
				});
				expect(advice?.fields).not.toHaveProperty('envoy');
				expect(
					yield* record_capabilities(
						{ manifest: m, db },
						'sys_integration',
						'mail',
						caller,
						{ now: NOW, today: TODAY, tz: 'UTC' },
						row
					)
				).toBeNull();
			}).pipe(Effect.provide(SystemFixtureLive), Effect.scoped)
	);
});

describe('seed packs: runtime accounts are tenant data', () => {
	it.effect(
		'existing runtime accounts block restoration; an empty identity store loads the accounts and model rows once',
		() =>
			Effect.gen(function* () {
				const { db, read } = yield* SystemFixture;
				yield* db.write({ text: 'DELETE FROM sys_user', params: [] }); // no member rows either
				const id = '0199a000-0000-7000-8000-000000000042';
				const pack: Pack = {
					dir: '',
					meta: {
						format: 1,
						name: 'test',
						hash: '',
						start: [],
						assets: [],
						rows: { sys_integration: 1, tags: 1 }
					},
					rows: {
						sys_integration: [
							{ id, integration: 'erp', name: 'Ledger', configuration: { region: 'sg' } }
						],
						tags: [{ id: '0199a000-0000-7000-8000-000000000043', name: 'vip' }]
					}
				};
				expect(yield* (yield* packLoader(db, m, source_of(pack), NOW)).step).toBe('hadRows');
				expect(yield* read(IdConfiguration, 'select id, configuration from sys_integration order by id'))
					.toEqual([{ id: 'desk', configuration: {} }, { id: 'mail', configuration: {} }]);
				expect(yield* read(Count, 'select count(*)::int as n from tags')).toEqual([{ n: 0 }]);
				yield* db.write({ text: 'DELETE FROM sys_integration', params: [] });
				// it loads in steps: identity, each model, the last step; then the answer stays
				const loader = yield* packLoader(db, m, source_of(pack), NOW);
				let step: PackStep = 'more';
				for (let i = 0; i < 10 && step === 'more'; i++) step = yield* loader.step;
				expect(step).toBe('loaded');
				expect(yield* loader.step).toBe('loaded');
				expect(
					yield* read(
						IdConfiguration,
						`select id, configuration from sys_integration order by id`
					)
				).toEqual([
					{ id, configuration: { lag: 15, region: 'sg' } }
				]);
				expect(yield* read(Schema.Struct({ id: Schema.String, name: Schema.String }), 'select id, name from tags'))
					.toEqual([{ id: '0199a000-0000-7000-8000-000000000043', name: 'vip' }]);
				expect(yield* (yield* packLoader(db, m, source_of(pack), NOW)).step).toBe('hadRows');
				expect(yield* load_pack(db, m, source_of(pack), NOW)).toBe(false);
			}).pipe(Effect.provide(SystemFixtureLive), Effect.scoped)
	);
	it.effect('the same pack loader retries a failed identity batch before advancing', () =>
		Effect.gen(function* () {
			const { db, read } = yield* SystemFixture;
			yield* db.write({ text: 'DELETE FROM sys_integration', params: [] });
			yield* db.write({ text: 'DELETE FROM sys_user', params: [] });
			const id = '0199a000-0000-7000-8000-000000000055';
			const pack: Pack = {
				dir: '',
				meta: { format: 1, name: 'test', hash: '', start: [], assets: [], rows: { sys_user: 1 } },
				rows: { sys_user: [{ id, name: 'Retried member' }] }
			};
			const failure = DbError.make('57014', 'identity batch cancelled before execution');
			let attempts = 0;
			const once = TenantDb.typed({
				...db,
				transaction: (batch) =>
					Effect.suspend(() => (++attempts === 1 ? Effect.fail(failure) : db.transaction(batch)))
			});
			const loader = yield* packLoader(once, m, source_of(pack), NOW);
			expect(yield* Effect.flip(loader.step)).toBe(failure);
			expect(attempts).toBe(1);
			expect(yield* read(Id, 'select id from sys_user')).toEqual([]);
			expect(yield* loader.step).toBe('more');
			expect(attempts).toBe(2);
			expect(
				yield* read(
					Schema.Struct({ id: Schema.String, name: Schema.String }),
					'select id, name from sys_user'
				)
			).toEqual([{ id, name: 'Retried member' }]);
			// the last step has no roll-up or counter to derive, so it opens no transaction
			expect(yield* loader.step).toBe('loaded');
			expect(attempts).toBe(2);
			expect(yield* loader.step).toBe('loaded');
			expect(attempts).toBe(2);
		}).pipe(Effect.provide(SystemFixtureLive), Effect.scoped)
	);
});

describe('one configuration shape, however an instance is made', () => {
	it.effect('a seeded runtime account and a created instance both store the definition defaults', () =>
		Effect.gen(function* () {
			const { db, read, created } = yield* SystemFixture;
			yield* db.write({ text: 'DELETE FROM sys_integration', params: [] });
			yield* db.write({ text: 'DELETE FROM sys_user', params: [] });
			const pack: Pack = {
				dir: '',
				meta: { format: 1, name: 'test', hash: '', start: [], assets: [], rows: { sys_user: 2, sys_integration: 1 } },
				rows: {
					sys_user: [{ id: ada, name: 'Ada' }, { id: 'u2', name: 'Bob' }],
					sys_integration: [{ id: 'ledger', integration: 'erp', name: 'Ledger', configuration: { region: 'sg' } }]
				}
			};
			expect(yield* load_pack(db, m, source_of(pack), NOW)).toBe(true);
			const id = yield* created({
				integration: 'erp',
				name: 'Ledger 2',
				configuration: { region: 'sg' }
			});
			expect(
				yield* read(
					IdConfiguration,
					`select id, configuration from sys_integration where integration = 'erp' order by id`
				)
			).toEqual([
				{ id, configuration: { lag: 15, region: 'sg' } },
				{ id: 'ledger', configuration: { lag: 15, region: 'sg' } }
			]);
		}).pipe(Effect.provide(SystemFixtureLive), Effect.scoped)
	);
});

describe("instance credentials: sealed rows under the opener's epoch", () => {
	it.effect(
		'an opener loads what the previous one wrote; once it opens, the previous one is fenced; an envelope is bound to its instance and tenant key',
		() =>
			Effect.gen(function* () {
				const { db, read, codec, native } = yield* SystemFixture;
				const batches = native.batches;
				const store = yield* credentials(db, yield* codec());
				const a = yield* store.open('desk');
				expect(a.values.size).toBe(0);
				yield* store.write(
					'desk',
					a.epoch,
					new Map<string, Json>([
						['creds', { me: '+65 8000 0000' }],
						['key:1', 'k1']
					])
				);
				expect(
					(yield* read(
						Schema.Struct({ name: Schema.String, sealed: Schema.String }),
						`select name, sealed from bolt_credential order by name`
					)).every((r) => !String(r['sealed']).includes('8000'))
				).toBe(true);
				const b = yield* store.open('desk');
				expect(b.epoch).not.toBe(a.epoch);
				expect(Object.fromEntries(b.values)).toEqual({
					creds: { me: '+65 8000 0000' },
					'key:1': 'k1'
				});
				expect(
					yield* Effect.flip(store.write('desk', a.epoch, new Map([['key:2', 'k2']])))
				).toMatchObject({ _tag: 'Fenced' });
				yield* store.write(
					'desk',
					b.epoch,
					new Map([
						['key:1', null],
						['key:2', 'k2']
					])
				);
				expect(Object.fromEntries((yield* store.open('desk')).values)).toEqual({
					creds: { me: '+65 8000 0000' },
					'key:2': 'k2'
				});
				expect(yield* Effect.flip(store.open('nope'))).toMatchObject({ code: 'not_found' });
				expect(native.batches).toBeGreaterThan(batches);
				expect(native.keyCalls.seal).toBeGreaterThan(0);
				expect(native.keyCalls.open).toBeGreaterThan(0);
				expect(native.active).toBe(0);
				expect(native.keyActive).toBe(0);
				// an envelope is bound to its instance and name, and to the tenant key
				yield* db.write({
					text: `insert into bolt_credential (instance, name, sealed) select 'mail', name, sealed from bolt_credential where instance = 'desk'`,
					params: []
				});
				expect(yield* Effect.flip(store.open('mail'))).toMatchObject({ code: 'sealed' });
				expect(
					yield* Effect.flip((yield* credentials(db, yield* codec())).open('desk'))
				).toMatchObject({
					code: 'sealed'
				});
			}).pipe(Effect.provide(SystemFixtureLive), Effect.scoped)
	);

	it.effect(
		"a request link's write moves the epoch it read: of two calls that read the same credentials the second to write is fenced; a pairing fences both",
		() =>
			Effect.gen(function* () {
				const { db, codec } = yield* SystemFixture;
				const store = yield* credentials(db, yield* codec());
				const paired = yield* store.open('desk');
				yield* store.write('desk', paired.epoch, new Map([['token', 't0']]));
				const a = yield* store.read('desk'),
					b = yield* store.read('desk');
				expect(a.epoch).toBe(paired.epoch);
				const moved = yield* store.write('desk', a.epoch, new Map([['token', 't1']]), true);
				expect(moved).not.toBe(a.epoch);
				expect(
					yield* Effect.flip(store.write('desk', b.epoch, new Map([['token', null]]), true))
				).toMatchObject({ _tag: 'Fenced' });
				expect((yield* store.read('desk')).values.get('token')).toBe('t1');
				// the writer's next write goes under the epoch it moved to
				yield* store.write('desk', moved, new Map([['token', 't2']]), true);
				const c = yield* store.read('desk');
				yield* store.open('desk');
				expect(
					yield* Effect.flip(store.write('desk', c.epoch, new Map([['token', 't3']]), true))
				).toMatchObject({ _tag: 'Fenced' });
				expect((yield* store.read('desk')).values.get('token')).toBe('t2');
				expect(
					yield* Effect.flip(store.write('nope', null, new Map([['token', 'x']])))
				).toMatchObject({ code: 'not_found' });
			}).pipe(Effect.provide(SystemFixtureLive), Effect.scoped)
	);
});
