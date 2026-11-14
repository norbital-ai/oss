import { randomUUID } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope } from 'effect';
import { afterAll } from 'vitest';
import { DbError, FacilityFailure, type RawDb } from '@norbital-ai/host-api';
import type { Json } from '../src/decl/values.ts';
import { TenantDb, type TenantDbShape } from '../src/engine/db/tenant-db.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Identity, RunHandlers, Runs, Callables } from '../src/engine/services.ts';
import { Syncs, syncTriggers } from '../src/engine/sync/index.ts';
import { remoteVersionNewer } from '../src/engine/sync/version.ts';
import { retryDelay } from '../src/engine/queue.ts';
import { TestDb } from '../../bolt-cli/src/test/database.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { manifest as base } from './write-fixture.ts';
import { one_act } from './support/act-one.ts';

const manifest: EngineManifest = {
	...base,
	models: {
		contacts: {
			description: 'Contacts',
			record_label: 'record.name',
			fields: { name: { kind: 'text' }, note: { kind: 'text', optional: true } }
		}
	},
	relationships: {},
	exposures: {
		contacts: {
			outputs: { default: { contacts: { fields: 'all' } } },
			create: { columns: { contacts: ['name', 'note'] } },
			update: { columns: { contacts: ['name', 'note'] } },
			delete: {},
			syncs: { crm: { with: 'crm', read: true, write: true } }
		}
	},
	integrations: {
		crm: { description: 'CRM', driver: 'http', http: { base_url: 'https://crm.example' } }
	},

	policies: {
		annotator: {
			description: 'Annotates a queried contact',
			grants: { contacts: { outputs: { default: {} }, update: {} } }
		}
	},
	automations: {
		annotate: {
			description: 'Writes from a guarded contact read',
			on: [{ cron: '* * * * *' }],
			output: { kind: 'json' },
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
	const page = yield* ctx.query({contacts:{where:{name:{eq:'Observed contact'}},fields:['name','revision']}});
	const row = page.contacts.rows[0];
	if (row === undefined || row.$sync?.crm?.status !== 'pending') throw new Error('Missing pending contact');
	yield* ctx.progress({text:'Read contact'});
	const outcome = yield* ctx.act({ 'contacts.update': [{target:row,set:{note:row.name}}] });
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
const setupFor = Effect.fnUntraced(function* (
	fixture: EngineManifest,
	guestSource: string,
	adapt: (db: TenantDbShape) => RawDb = (db) => db
) {
	const db = Context.get(yield* Layer.build(TestDb.layer(fixture)), TenantDb);
	const adapter = adapt(db);
	const intercepted = TenantDb.typed({
		...adapter,
		write: (statement, lock) =>
			adapter
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
			manifest: fixture,
			guest: yield* program(guestSource),
			db: Layer.succeed(TenantDb, intercepted),
			now: '2026-10-24T08:00:00.000Z',
			seed: { sys_integration: [{ id: 'crm', integration: 'crm', name: 'CRM', active: true }] }
		})
	);
	const t = Context.get(context, TestWorkspace),
		registry = Context.get(context, RunHandlers),
		writes = Context.get(context, Callables),
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
	const handler = (name: string, input: Json = {}, cause?: string) =>
		Effect.gen(function* () {
			const h = yield* registry.handler(name);
			if (Option.isNone(h)) throw new Error(`Missing handler ${name}`);
			return yield* h.value(input, {
				id: randomUUID(),
				starter: null,
				...(cause === undefined ? {} : { cause, attempts: 1 })
			});
		}).pipe(Effect.provide(context));
	const act = (verb: 'create' | 'update' | 'delete', input: Json) => {
		const key = randomUUID(),
			now = t.clock.now();
		return writes.acts(one_act({
			model: 'contacts',
			verb,
			input,
			authority,
			key,
			issuedAt: now,
			invocationId: key,
			bindings: { now, today: now.slice(0, 10), tz: 'UTC' }
		}));
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
});
const setup = setupFor(manifest, source).pipe(
	Scope.provide(fileScope),
	Effect.cached,
	Effect.runSync
);

describe('durable model sync', () => {
	it.live('fans local and imported rows out to every active peer account, without echoing an inbound row', () =>
		Effect.scoped(Effect.gen(function* () {
			const f = yield* setupFor(manifest, source);
			yield* f.t.db.write({
				text: `INSERT INTO sys_integration(id,integration,name,active)
				VALUES ('crm_peer','crm','Peer',true),('crm_paused','crm','Paused',false)`,
				params: []
			});
			yield* f.act('create', [{ name: 'Local fanout' }]);
			f.page({ rows: [{ $id: 'remote-import', $version: '1', name: 'Imported fanout' }], cursor: 'fanout-1', more: false });
			yield* f.t.syncs.read('contacts.sync.crm', { instance: 'crm' });
			expect(yield* f.t.db.rows(Schema.Struct({ name: Schema.String, instance: Schema.String }), {
				text: `SELECT c.name,o.instance FROM sys_outbox o JOIN contacts c ON c.id::text=o.record
				WHERE c.name IN ('Local fanout','Imported fanout') ORDER BY c.name,o.instance`,
				params: []
			})).toEqual([
				{ name: 'Imported fanout', instance: 'crm_peer' },
				{ name: 'Local fanout', instance: 'crm' },
				{ name: 'Local fanout', instance: 'crm_peer' }
			]);
		}))
	);
	it.live('a write reads its row through the model codecs, and changed names only declared fields', () =>
		Effect.scoped(Effect.gen(function* () {
			const typed: EngineManifest = {
				...manifest,
				models: { contacts: { description: 'Contacts', record_label: 'record.name', fields: {
					name: { kind: 'text' }, note: { kind: 'text', optional: true }, visits: { kind: 'int' }
				} } },
				exposures: { contacts: {
					outputs: { default: { contacts: { fields: 'all' } } },
					create: { columns: { contacts: ['name', 'note', 'visits'] } },
					syncs: { crm: { with: 'crm', read: true, write: true } }
				} }
			};
			const f = yield* setupFor(typed, `export default { model: { contacts: { bodies: { syncs: { crm: {
	read: function* () { return { rows: [], cursor: null, more: false }; },
	write: function* ({ op, row, changed }, ctx) {
		return yield* ctx.request({ method: 'POST', path: '/contacts',
			body: { name: [op, typeof row.visits, row.visits, 'bolt_search' in row, changed.join('+')].join(' ') } });
	}
} } } } } };`);
			yield* f.act('create', [{ name: 'Typed', visits: 0 }]);
			yield* f.handler('sync.deliver');
			expect(f.calls.map((call) => call.body?.name)).toEqual(['create number 0 false name+note+visits']);
		}))
	);
	it.live('refuses inbound updates and deletes of a locked row atomically with the sync page', () =>
		Effect.scoped(Effect.gen(function* () {
			const contacts = manifest.models.contacts;
			if (contacts === undefined) throw new Error('Missing contact fixture');
			const f = yield* setupFor({ ...manifest, models: { contacts: {
				...contacts,
				locks: { frozen: { where: { name: { eq: 'Locked contact' } }, except: ['note'] } }
			} } }, source);
			f.page({ rows: [{ $id: 'locked', $version: '1', name: 'Locked contact' }], cursor: 'locked-1', more: false });
			yield* f.t.syncs.read('contacts.sync.crm');
			const [contact] = yield* f.rows();
			if (contact === undefined) throw new Error('Missing imported locked contact');
			expect((yield* f.act('update', [{ target: contact.id, set: { note: 'Local note awaiting delivery' } }])).outcome)
				.toMatchObject({ kind: 'committed' });
			const checkpoint = f.t.db.value(Schema.Struct({
				contacts: Schema.Array(Schema.Json),
				state: Schema.Json,
				replicas: Schema.Array(Schema.Json),
				history: Schema.Array(Schema.Json),
				outbox: Schema.Array(Schema.Json)
			}), {
				text: `SELECT jsonb_build_object(
					'contacts', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb) FROM contacts c),
					'state', (SELECT to_jsonb(s) - 'health' FROM sys_sync s WHERE s.instance='crm' AND s.sync='contacts.sync.crm'),
					'replicas', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb) FROM sys_sync_row r WHERE r.instance='crm' AND r.sync='contacts.sync.crm'),
					'history', (SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.revision), '[]'::jsonb) FROM bolt_history h WHERE h.collection='contacts' AND h.record=$1::uuid),
					'outbox', (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.seq), '[]'::jsonb) FROM sys_outbox o WHERE o.model='contacts')
				)`,
				params: [contact.id]
			});
			const before = yield* checkpoint;
			expect(before.state).toMatchObject({ cursor: 'locked-1', version: 1 });
			expect(before.replicas).toMatchObject([{ record: contact.id, remote_id: 'locked', remote_version: '1' }]);
			expect(before.history).toMatchObject([{ op: 'create' }, { op: 'update' }]);
			expect(before.outbox).toMatchObject([{ status: 'queued', image: { note: 'Local note awaiting delivery' } }]);
			const attempts: readonly { row: Json; cursor: string }[] = [
				{ row: { $id: 'locked', $version: '2', name: 'Overwritten' }, cursor: 'blocked-update' },
				{ row: { $id: 'locked', $version: '3', $deleted: true }, cursor: 'blocked-delete' }
			];
			for (const attempt of attempts) {
				f.page({ rows: [
					{ $id: `sibling-${attempt.cursor}`, $version: '1', name: 'Must not be imported' },
					attempt.row
				], cursor: attempt.cursor, more: false });
				expect(yield* f.t.syncs.read('contacts.sync.crm').pipe(Effect.flip)).toMatchObject({ code: 'locked' });
				expect(yield* checkpoint).toEqual(before);
				expect(yield* f.t.db.value(Schema.Json, {
					text: "SELECT health FROM sys_sync WHERE instance='crm' AND sync='contacts.sync.crm'",
					params: []
				})).toMatchObject({ state: 'attention', code: 'locked' });
			}
			expect(f.calls).toEqual([]);
			expect(f.accepted.size).toBe(0);
		}))
	);
	it.live('a sync page is admitted, planned and its effects queued as one holder: the sync, an admin outside any run', () =>
		Effect.scoped(Effect.gen(function* () {
			const contacts = manifest.exposures.contacts;
			if (contacts === undefined) throw new Error('Missing contact exposure');
			const f = yield* setupFor({ ...manifest, exposures: { contacts: {
				...contacts, create: { columns: { contacts: ['name', 'note'] }, effect: true }
			} } }, source);
			f.page({ rows: [{ $id: 'effected', $version: '1', name: 'Effected contact' }], cursor: 'effected-1', more: false });
			yield* f.t.syncs.read('contacts.sync.crm', { instance: 'crm' });
			const runs = yield* f.t.db.rows(Schema.Struct({ actor: Schema.String, depth: Schema.Number, starter: Schema.Json }), {
				text: "SELECT actor, depth, starter FROM sys_run WHERE automation = 'contacts.effect.create'",
				params: []
			});
			expect(runs).toMatchObject([{
				depth: 0,
				starter: {
					admin: true,
					platform: true,
					policies: [],
					actor: { kind: 'system', by: { sync: 'contacts.sync.crm', instance: 'crm' } }
				}
			}]);
			// any other holder would admit as one authority and queue effects as another
			const now = f.t.clock.now(), key = randomUUID();
			const member = yield* Context.get(f.context, Identity).authority(f.t.admin);
			const page = (authority: typeof member) => Context.get(f.context, Callables).acts({
				name: 'contacts.upsert', from: 'Server', key, issuedAt: now, invocationId: key, authority,
				bindings: { now, today: now.slice(0, 10), tz: 'UTC' },
				acts: [{ model: 'contacts', verb: 'upsert', on_conflict: 'update', input: [{ name: 'Not a sync' }] }],
				sync: { sync: 'contacts.sync.crm', instance: 'crm', fields: ['name'], deletes: [], pieces: () => {} }
			}).pipe(Effect.flip);
			expect(yield* page({ ...member, admin: false })).toMatchObject({ code: 'invalid' });
			expect(yield* page({ ...member, run: { depth: 0, holder: { actor: member.actor, policies: [], admin: true } } }))
				.toMatchObject({ code: 'invalid' });
		}))
	);
	it('compares versions exactly and caps retry delays', () => {
		expect(remoteVersionNewer('9007199254740993', '9007199254740992')).toBe(true);
		expect(remoteVersionNewer('9007199254740992', '9007199254740993')).toBe(false);
		expect(remoteVersionNewer('2026-10-24T08:01:00Z', '2026-10-24T08:02:00Z')).toBe(false);
		expect(retryDelay(8, [60_000, 300_000, 900_000, 1_800_000, 3_600_000], 3_600_000)).toBe(3_600_000);
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
		'a page with no rows and an unchanged cursor commits nothing, and health still shows the read',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* setup,
						t = f.t;
					yield* f.fresh();
					const state = () =>
						t.db.rows(
							Schema.Struct({ version: Schema.Number, read: Schema.NullOr(Schema.String) }),
							{
								text: `SELECT version, last_read_at::text AS read FROM sys_sync WHERE sync = 'contacts.sync.crm'`,
								params: []
							}
						);
					f.page({ rows: [], cursor: 'quiet-1', more: false });
					yield* t.syncs.read('contacts.sync.crm');
					const before = yield* state();
					t.clock.advance('1h');
					t.count.reset();
					yield* t.syncs.read('contacts.sync.crm');
					expect(t.count.writes).toBe(0);
					expect(yield* state()).toEqual(before);
					expect(yield* f.syncs.health('crm').pipe(Effect.provide(f.context))).toMatchObject({
						last_read_at: t.clock.now(),
						lag_seconds: 0
					});
					f.page({ rows: [], cursor: 'quiet-2', more: false });
					yield* t.syncs.read('contacts.sync.crm');
					expect((yield* state())[0]?.version).toBe((before[0]?.version ?? 0) + 1);
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
	it.live('delivers a newer change past a dead row and retires stale replays', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* setupFor(manifest, source);
				yield* f.act('create', [{ name: 'Original' }]);
				yield* f.handler('sync.deliver');
				const row = (yield* f.rows())[0];
				if (row === undefined) throw new Error('Missing contact');
				yield* f.act('update', [{ target: row.id, set: { name: 'Undeliverable' } }]);
				f.mode('down');
				for (let attempt = 0; attempt < 8; attempt++) {
					yield* f.handler('sync.deliver');
					f.t.clock.advance('2h');
				}
				expect(yield* f.syncs.health('crm')).toMatchObject({ dead: 1 });
				f.mode('ok');
				yield* f.act('update', [{ target: row.id, set: { name: 'Current' } }]);
				yield* f.handler('sync.deliver');
				expect(f.calls.at(-1)?.body?.name).toBe('Current');
				expect(yield* f.syncs.health('crm')).toMatchObject({ dead: 0, pending: 0 });
				expect(yield* f.syncs.replay('crm').pipe(Effect.provide(f.context))).toEqual({
					replayed: 0
				});
				const delivered = f.calls.length;
				// A database created before the cut may still carry an older dead row after a newer acknowledgement.
				yield* f.t.db.write({
					text: "UPDATE sys_outbox SET status = 'dead' WHERE record = $1 AND image ->> 'name' = 'Undeliverable'",
					params: [row.id]
				});
				expect(yield* f.syncs.replay('crm').pipe(Effect.provide(f.context))).toEqual({
					replayed: 1
				});
				yield* f.handler('sync.deliver');
				expect(f.calls).toHaveLength(delivered);
				expect(yield* f.syncs.health('crm')).toMatchObject({ dead: 0, pending: 0 });
			})
		)
	);
	it.live('a stale delivery claim makes no external request after a replacement acknowledges', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const blocked = yield* Deferred.make<void>(),
					resume = yield* Deferred.make<void>();
				let armed = false,
					delayed = false;
				const f = yield* setupFor(manifest, source, (db) => ({
					...db,
					read: (statements) =>
						Effect.gen(function* () {
							const result = yield* db.read(statements);
							if (
								armed &&
								!delayed &&
								statements.some((statement) =>
									statement.text.includes('FROM sys_integration WHERE id IN')
								)
							) {
								delayed = true;
								yield* Deferred.succeed(blocked, undefined);
								yield* Deferred.await(resume);
							}
							return result;
						})
				}));
				yield* f.act('create', [{ name: 'Once' }]);
				armed = true;
				const first = yield* f.handler('sync.deliver').pipe(Effect.forkChild);
				yield* Effect.gen(function* () {
					yield* Deferred.await(blocked);
					// a live claimer heartbeats its lease as the clock moves; a stuck one's lease lapses unrenewed
					yield* f.t.db.write({
						text: "UPDATE sys_outbox SET claimed_at = claimed_at - interval '6 minutes' WHERE status = 'sending'",
						params: []
					});
					yield* f.handler('sync.deliver');
					yield* Deferred.succeed(resume, undefined);
					yield* Fiber.join(first);
					expect(f.calls).toHaveLength(1);
					expect(
						yield* f.t.db.rows(Schema.Struct({ status: Schema.String, attempts: Schema.Number }), {
							text: 'SELECT status, attempts FROM sys_outbox',
							params: []
						})
					).toEqual([{ status: 'acked', attempts: 2 }]);
				}).pipe(Effect.ensuring(Deferred.succeed(resume, undefined)));
			})
		)
	);
	it.live('a replay waits for a later live claim on the same record', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* setupFor(manifest, source);
				yield* f.act('create', [{ name: 'Before' }]);
				yield* f.t.db.write({ text: "UPDATE sys_outbox SET status = 'dead'", params: [] });
				const row = (yield* f.rows())[0];
				if (row === undefined) throw new Error('Missing contact');
				yield* f.act('update', [{ target: row.id, set: { name: 'After' } }]);
				yield* f.t.db.write({
					text: "UPDATE sys_outbox SET status = 'sending', attempts = 1, claimed_at = $1::timestamptz WHERE status = 'queued'",
					params: [f.t.clock.now()]
				});
				expect(yield* f.syncs.replay('crm').pipe(Effect.provide(f.context))).toEqual({
					replayed: 1
				});
				expect(yield* f.handler('sync.deliver')).toEqual({ delivered: 0 });
				expect(f.calls).toEqual([]);
			})
		)
	);
	it.live('a failure before choosing a partition is recorded on connection health', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const fixture: EngineManifest = {
					...manifest,
					exposures: {
						contacts: {
							...manifest.exposures.contacts,
							outputs: { default: { contacts: { fields: 'all' } } },
							syncs: { crm: { with: 'crm', partitions: 'areas', read: true } }
						}
					},
					integrations: {
						crm: {
							description: 'CRM',
							driver: 'http',
							http: { base_url: 'https://crm.example' },
							configuration: { areas: { kind: 'text', many: true, default: [] } }
						}
					}
				};
				const f = yield* setupFor(fixture, source, (db) => ({
					...db,
					write: (statement, lock) =>
						statement.text.includes('WITH released AS')
							? Effect.fail(DbError.make('XX000', 'Partition cleanup unavailable'))
							: db.write(statement, lock)
				}));
				yield* f.t.db.write({
					text: `INSERT INTO sys_sync (id,sync,instance,partition,health,digest,cycle,version)
				VALUES (gen_random_uuid(),'contacts.sync.crm','crm','retired','{"state":"ready"}'::jsonb,'previous',0,1)`,
					params: []
				});
				expect(Exit.isFailure(yield* Effect.exit(f.handler('contacts.sync.crm')))).toBe(true);
				expect(
					yield* f.t.db.value(Schema.Json, {
						text: "SELECT status -> 'health' FROM sys_integration WHERE id = 'crm'",
						params: []
					})
				).toMatchObject({ state: 'attention', message: 'Partition cleanup unavailable' });
				expect(
					yield* f.t.db.value(Schema.Number, {
						text: 'SELECT count(*)::int FROM sys_sync WHERE partition IS NULL',
						params: []
					})
				).toBe(0);
			})
		)
	);

	it.live(
		'resumes SQL writes and reads after ten missed slots, keeps the write key, and holds a permanent SQL rejection',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* setupFor(
						{
							...manifest,
							integrations: { crm: { description: 'CRM', driver: 'sqlserver' } }
						},
						`export default { model: { contacts: { bodies: { syncs: { crm: {
				read: function* ({cursor}, ctx) {
					const result = yield* ctx.request({op:'values',values:{cursor}});
					return {rows:result.rows,cursor:'last-good'};
				},
				write: function* ({row}, ctx) {
					const result = yield* ctx.request({op:'values',values:{name:row.name}});
					return {$id:result.rows[0].id};
				}
			} } } } } };`
					);
					let problem: 'timeout' | 'invalid' | undefined;
					const reads: Json[] = [];
					f.t.fakes.links.answer = (_instance, input) =>
						Effect.gen(function* () {
							const { values } = yield* Schema.decodeUnknownEffect(
								Schema.Struct({
									values: Schema.Record(Schema.String, Schema.Json)
								})
							)(input).pipe(
								Effect.mapError(
									() => new FacilityFailure({ kind: 'invalid', message: 'Bad test request' })
								)
							);
							if ('cursor' in values) reads.push(values['cursor'] ?? null);
							if (problem)
								return yield* new FacilityFailure({
									kind: problem,
									message: 'SQL unavailable or refused'
								});
							return { rows: 'cursor' in values ? [] : [{ id: 'source-contact' }] };
						});
					const read = () => f.handler('contacts.sync.crm', {}, 'cron');
					yield* read();
					yield* f.act('create', [{ name: 'Local commitment' }]);
					const outbox = () =>
						f.t.db.rows(
							Schema.Struct({ key: Schema.String, status: Schema.String, attempts: Schema.Number }),
							{
								text: 'SELECT key, status, attempts FROM sys_outbox ORDER BY seq',
								params: []
							}
						);
					const key = (yield* outbox())[0]?.key;
					problem = 'timeout';
					for (let slot = 0; slot < 10; slot++) {
						yield* f.handler('sync.deliver');
						expect(Exit.isFailure(yield* Effect.exit(read()))).toBe(true);
						f.t.clock.advance('2min');
					}
					expect(yield* outbox()).toEqual([{ key, status: 'queued', attempts: 10 }]);
					expect(reads).toEqual([null, ...Array(10).fill('last-good')]);
					problem = undefined;
					yield* read();
					yield* f.handler('sync.deliver');
					expect(reads.at(-1)).toBe('last-good');
					expect(yield* outbox()).toEqual([{ key, status: 'acked', attempts: 11 }]);

					problem = 'invalid';
					yield* f.act('create', [{ name: 'Needs review' }]);
					yield* f.handler('sync.deliver');
					expect((yield* outbox())[1]).toMatchObject({ status: 'dead', attempts: 1 });
					expect((yield* f.rows()).map((row) => row.name)).toContain('Needs review');
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
						at: new Date(f.t.clock.now()).toISOString(),
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
