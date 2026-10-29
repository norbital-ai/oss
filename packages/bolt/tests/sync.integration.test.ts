import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Instant } from '@norbital-ai/std/date';
import { Context, Effect, Exit, Layer, Option, Schema, Scope } from 'effect';
import { afterAll } from 'vitest';
import { FacilityFailure } from '../src/decl/errors.ts';
import type { Json } from '../src/decl/values.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Identity, RunHandlers, Runs, Writes } from '../src/engine/services.ts';
import { Syncs, syncTriggers } from '../src/engine/sync/index.ts';
import { remoteVersionNewer } from '../src/engine/sync/read.ts';
import { retryDelay } from '../src/engine/sync/write.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		contacts: {
			description: 'Contacts',
			label: 'name',
			fields: { name: { kind: 'text' }, note: { kind: 'text', optional: true } }
		}
	},
	relationships: {},
	exposures: {
		contacts: {
			read: { contacts: { fields: 'all' } },
			create: { columns: { contacts: ['name', 'note'] } },
			update: { columns: { contacts: ['name', 'note'] } },
			delete: {},
			syncs: { crm: { with: 'crm', read: true, write: true } }
		}
	},
	integrations: {
		crm: { description: 'CRM', driver: 'http', http: { baseUrl: 'https://crm.example' } }
	},
	connections: { crm: { integration: 'crm' } },
	policies: {
		annotator: {
			description: 'Annotates a queried contact',
			grants: { contacts: { read: true, update: true } }
		}
	},
	automations: {
		annotate: {
			description: 'Writes from a guarded contact read',
			on: { cron: '* * * * *' },
			policies: ['annotator']
		}
	}
};
const source = `export default { model: { contacts: { bodies: { syncs: { crm: {
	read: function* ({cursor}, ctx) { return yield* ctx.request({method:'GET',path:'/contacts',query:{cursor:JSON.stringify(cursor)}}); },
	write: function* ({op,row,$id,$version,changed}, ctx) {
		if(op === 'update' && changed.every((field) => field === 'note')) return null;
		return yield* ctx.request({method:op === 'create' ? 'POST' : op === 'delete' ? 'DELETE' : 'PATCH',path:$id ? '/contacts/'+$id : '/contacts',headers:$version ? {'If-Match':$version} : {},body:{name:row.name}});
	}
} } } } }, automation: { annotate: { body: function* (_, ctx) {
	const page = yield* ctx.query({contacts:{where:{name:{eq:'Observed contact'}},fields:['name']}});
	const row = page.contacts.rows[0];
	if (row === undefined || row.$sync?.crm?.status !== 'pending') throw new Error('Missing pending contact');
	yield* ctx.progress({text:'Read contact'});
	const outcome = yield* ctx.act('contacts.update', [{target:row.id,set:{note:row.name}}]);
	return {kind:outcome.kind,seen:row.$sync.crm.status};
} } } };`;
const Op = Schema.Struct({
	method: Schema.String,
	headers: Schema.optionalKey(
		Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))
	),
	body: Schema.optionalKey(Schema.Struct({ name: Schema.String }))
});
/** Runs after each write that records a run's progress, while a case sets it: the moment between an automation's read and its write. */
let afterProgress: Effect.Effect<void, never, TenantDb> | undefined;
// One workspace for the file: each case names its own rows and starts with an empty CRM log.
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const setup = Effect.gen(function* () {
	const db = Context.get(yield* Layer.build(TestDb.layer(manifest)), TenantDb);
	const intercepted = TenantDb.typed({
		...db,
		write: (statement, lock) =>
			db
				.write(statement, lock)
				.pipe(
					Effect.tap(() =>
						afterProgress !== undefined && statement.text.includes('UPDATE sys_run SET progress')
							? afterProgress.pipe(Effect.provideService(TenantDb, db))
							: Effect.void
					)
				)
	});
	const context = yield* Layer.build(
		TestWorkspace.layer({
			manifest,
			guest: yield* program(source),
			db: Layer.succeed(TenantDb, intercepted),
			now: '2026-10-24T08:00:00.000Z'
		})
	);
	const t = Context.get(context, TestWorkspace),
		registry = Context.get(context, RunHandlers),
		writes = Context.get(context, Writes),
		syncs = Context.get(context, Syncs);
	const admin = t.admin;
	if (admin.actor.kind !== 'member') throw new Error('Expected member admin');
	yield* t.db.write({
		text: "INSERT INTO sys_user (id, name, kind, admin) VALUES ($1, 'Admin', 'staff', true) ON CONFLICT DO NOTHING",
		params: [admin.actor.id]
	});
	const authority = yield* Context.get(context, Identity).authority(admin);
	let page: { rows: readonly Json[]; cursor: Json; more: boolean } = {
		rows: [],
		cursor: null,
		more: false
	};
	let mode: 'ok' | 'timeout' | 'refuse' | 'conflict' | 'down' = 'ok';
	const calls: (typeof Op.Type)[] = [],
		accepted = new Map<string, { $id: string; $version: string }>();
	let remoteVersion = 0;
	t.fakes.links.answer = (_instance, input) =>
		Effect.gen(function* () {
			const op = yield* Schema.decodeUnknownEffect(Op)(input).pipe(
				Effect.mapError(() => new FacilityFailure({ kind: 'invalid', message: 'Bad fake request' }))
			);
			if (op.method === 'GET') return { status: 200, body: page };
			calls.push(op);
			if (mode === 'down')
				return yield* Effect.fail(
					new FacilityFailure({ kind: 'timeout', message: 'CRM unavailable' })
				);
			const key = String(op.headers?.['idempotency-key']),
				existing = accepted.get(key);
			if (existing !== undefined) return { status: 200, body: existing };
			if (mode === 'refuse') return { status: 422, body: 'Refused by CRM' };
			if (mode === 'conflict') return { status: 412, body: 'Version conflict' };
			// a remote id per create: the cases share one workspace, and a remote id maps to one row
			const n = ++remoteVersion,
				ack = { $id: `remote-contact-${n}`, $version: String(n) };
			accepted.set(key, ack);
			if (mode === 'timeout') {
				mode = 'ok';
				return yield* Effect.fail(
					new FacilityFailure({ kind: 'timeout', message: 'Acknowledgement lost' })
				);
			}
			return { status: 200, body: ack };
		});
	const handler = (name: string, input: Json = {}) =>
		Effect.gen(function* () {
			const h = yield* registry.handler(name);
			if (Option.isNone(h)) throw new Error(`Missing handler ${name}`);
			return yield* h.value(input, { id: randomUUID(), starter: null });
		}).pipe(Effect.provide(context));
	const act = (verb: 'create' | 'update' | 'delete', input: Json) => {
		const key = randomUUID(),
			now = t.clock.now();
		return writes.act({
			model: 'contacts',
			verb,
			input,
			authority,
			key,
			issuedAt: now,
			invocationId: key,
			mode: { _tag: 'Direct' },
			bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
		});
	};
	const rows = () =>
		t.db.rows(Schema.Struct({ id: Schema.String, name: Schema.String, revision: Schema.Number }), {
			text: 'SELECT id::text, name, revision FROM contacts ORDER BY id',
			params: []
		});
	return {
		/** A case starts with an empty fake CRM log (the workspace's rows stay; each case names its own). */
		fresh: () =>
			Effect.sync(() => {
				calls.length = 0;
				accepted.clear();
				mode = 'ok';
			}),
		t,
		context,
		syncs,
		calls,
		accepted,
		act,
		rows,
		handler,
		page: (value: typeof page) => {
			page = value;
		},
		mode: (value: typeof mode) => {
			mode = value;
		}
	};
}).pipe(Scope.provide(fileScope), Effect.cached, Effect.runSync);

describe('durable model sync', () => {
	it('compares versions exactly and caps retry delays', () => {
		expect(remoteVersionNewer('9007199254740993', '9007199254740992')).toBe(true);
		expect(remoteVersionNewer('9007199254740992', '9007199254740993')).toBe(false);
		expect(remoteVersionNewer('2026-10-24T08:01:00Z', '2026-10-24T08:02:00Z')).toBe(false);
		expect(retryDelay(8, 0.5)).toBe(3_600_000);
	});
	it.live(
		'retries a timed-out create with the same key, acknowledges once, and rolls back refused updates and conflicts',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* setup;
					yield* f.fresh();
					f.mode('timeout');
					yield* f.act('create', [{ name: 'Accepted' }]);
					yield* f.handler('sync.deliver');
					f.t.clock.advance('2min');
					yield* f.handler('sync.deliver');
					expect(f.accepted.size).toBe(1);
					expect(f.calls).toHaveLength(2);
					expect(f.calls[0]?.headers?.['idempotency-key']).toBe(
						f.calls[1]?.headers?.['idempotency-key']
					);
					const named = (name: string) =>
						f.rows().pipe(Effect.map((rows) => rows.filter((r) => r.name === name)));
					const [row] = yield* named('Accepted');
					if (row === undefined) throw new Error('Missing contact');
					f.mode('refuse');
					yield* f.act('update', [{ target: row.id, set: { name: 'Refused' } }]);
					yield* f.handler('sync.deliver');
					expect((yield* named('Accepted'))[0]?.name).toBe('Accepted');
					expect(f.calls.at(-1)?.headers?.['If-Match']).toBe('1');
					f.mode('conflict');
					yield* f.act('update', [{ target: row.id, set: { name: 'Conflicting' } }]);
					yield* f.handler('sync.deliver');
					expect((yield* named('Accepted'))[0]?.name).toBe('Accepted');
					expect(yield* f.syncs.health('crm')).toMatchObject({ failed: 2 });
				})
			)
	);
	it.live(
		'coalesces unattempted edits, bounds retries in dead letter, and replays the frozen write',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* setup;
					yield* f.fresh();
					yield* f.act('create', [{ name: 'First' }]);
					const [row] = (yield* f.rows()).filter((r) => r.name === 'First');
					if (row === undefined) throw new Error('Missing contact');
					yield* f.act('update', [{ target: row.id, set: { name: 'Latest' } }]);
					expect(
						yield* f.t.db.value(Schema.Number, {
							text: 'SELECT count(*)::int FROM sys_outbox WHERE record::text = $1',
							params: [row.id]
						})
					).toBe(1);
					f.mode('down');
					for (let attempt = 0; attempt < 8; attempt++) {
						yield* f.handler('sync.deliver');
						f.t.clock.advance('2h');
					}
					expect(yield* f.syncs.health('crm')).toMatchObject({ dead: 1, pending: 0 });
					expect(f.calls).toHaveLength(8);
					expect(f.calls[0]?.body?.name).toBe('Latest');
					const key = f.calls[0]?.headers?.['idempotency-key'];
					f.mode('ok');
					expect(yield* f.syncs.replay('crm').pipe(Effect.provide(f.context))).toEqual({
						replayed: 1
					});
					yield* f.handler('sync.deliver');
					expect(f.calls.at(-1)?.headers?.['idempotency-key']).toBe(key);
					expect(f.accepted.size).toBe(1);
					expect(yield* f.syncs.health('crm')).toMatchObject({ dead: 0, pending: 0 });
				})
			)
	);
	it.live(
		'commits a guarded automation when only advisory sync delivery metadata changes; its scheduled read dedupes hints and catches a lost one',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let advanced = 0;
					const deliveryError = { message: 'CRM delivery failed after the contact read' };
					afterProgress = Effect.gen(function* () {
						const result = yield* (yield* TenantDb).write({
							text: "UPDATE sys_outbox SET status = 'dead', error = $1::jsonb WHERE model = 'contacts' AND op = 'create' AND status = 'queued'",
							params: [deliveryError]
						});
						advanced += result.affected;
					}).pipe(Effect.orDie);
					yield* Effect.addFinalizer(() =>
						Effect.sync(() => {
							afterProgress = undefined;
						})
					);
					const f = yield* setup;
					yield* f.fresh();
					yield* f.act('create', [{ name: 'Observed contact' }]);
					expect(yield* Context.get(f.context, Runs).fire('annotate', f.t.clock.now())).toEqual({
						ran: true
					});
					expect(advanced).toBe(1);
					expect(
						yield* f.t.db.rows(
							Schema.Struct({
								state: Schema.String,
								output: Schema.Json,
								error: Schema.Json
							}),
							{
								text: "SELECT state, output, error FROM sys_run WHERE automation = 'annotate'",
								params: []
							}
						)
					).toEqual([
						{ state: 'succeeded', output: { kind: 'committed', seen: 'pending' }, error: null }
					]);
					expect(
						yield* f.t.db.rows(
							Schema.Struct({
								name: Schema.String,
								note: Schema.String,
								revision: Schema.Number
							}),
							{
								text: "SELECT name, note, revision FROM contacts WHERE name = 'Observed contact'",
								params: []
							}
						)
					).toEqual([{ name: 'Observed contact', note: 'Observed contact', revision: 2 }]);
					expect(
						yield* f.t.db.rows(
							Schema.Struct({
								status: Schema.String,
								error: Schema.Json
							}),
							{
								text: "SELECT o.status, o.error FROM sys_outbox o JOIN contacts c ON c.id::text = o.record::text WHERE o.op = 'create' AND c.name = 'Observed contact'",
								params: []
							}
						)
					).toEqual([{ status: 'dead', error: deliveryError }]);
					// the scheduled read: hints dedupe, older rows and deletes lose, a lost hint is caught up
					const count = (table: string) =>
						f.t.db.value(Schema.Number, { text: `SELECT count(*)::int FROM ${table}`, params: [] });
					const synced = () =>
						f
							.rows()
							.pipe(
								Effect.map((rows) =>
									rows
										.map((row) => row.name)
										.filter((name) => ['Current', 'Old', 'Caught up'].includes(name))
								)
							);
					const inbox = yield* count('sys_inbox'),
						outbox = yield* count('sys_outbox');
					f.page({
						rows: [
							{ $id: 'one', $version: '2', name: 'Current' },
							{ $id: 'one', $version: '1', name: 'Old' }
						],
						cursor: '2',
						more: false
					});
					const delivery = {
						kind: 'webhook' as const,
						id: 'delivery',
						at: Instant(f.t.clock.now()),
						headers: {},
						body: {}
					};
					yield* f.syncs.hint('crm', delivery);
					yield* f.syncs.hint('crm', delivery);
					expect(yield* count('sys_inbox')).toBe(inbox + 1);
					yield* f.handler('contacts.sync.crm');
					expect(yield* synced()).toEqual(['Current']);
					f.page({
						rows: [{ $id: 'one', $version: '1', $deleted: true }],
						cursor: '3',
						more: false
					});
					yield* f.handler('contacts.sync.crm');
					expect(yield* synced()).toEqual(['Current']);
					f.page({
						rows: [{ $id: 'one', $version: '3', name: 'Caught up' }],
						cursor: '4',
						more: false
					});
					expect(syncTriggers(manifest).map((cron) => cron.id)).toContain('contacts.sync.crm');
					yield* Context.get(f.context, Runs).fire('contacts.sync.crm', f.t.clock.now());
					expect(yield* synced()).toEqual(['Caught up']);
					// a read-in row queues no delivery
					expect(yield* count('sys_outbox')).toBe(outbox);
				})
			)
	);
});
