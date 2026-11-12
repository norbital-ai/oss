import { with_accounts } from './support/accounts.ts';
import { with_envoys } from './support/envoys.ts';
// engine/conversations on PGlite: a
// `customer_notices` shape — a `sent_emails` row's create sends its mail through the `customer_mail` connection, delivery
// reports and the customer's reply land on the row after it is closed — plus one-statement inbound keyed by instance
// (dedupe, edits, revokes, files, the import cutoff, the `messages` feed it queues), serial at-least-once delivery and
// the epoch.
import { describe, expect, it, vi } from '@effect/vitest';
import { afterAll } from 'vitest';
import { Context, Crypto, Effect, Exit, Layer, Result, Schema, Scope } from 'effect';
import { createHash } from 'node:crypto';
import { Drivers, Files, Logs } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Conversations, Live, Outbound } from '../src/engine/services.ts';
import { conversations as native_conversations } from '../src/engine/conversations/index.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { DbError } from '../src/engine/errors.ts';
import { decode_projected_manifest } from '../src/engine/manifest.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { act_reply, q_reply, route_fixture } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import { FacilityFailure, Unavailable } from '../src/decl/errors.ts';
import { SendRefused } from '../src/engine/conversations/status.ts';
import { LINK_DOWN } from '../src/engine/integrations/abi.ts';
import { TestWorkspace } from '../../bolt-cli/src/test/index.ts';
import { filesOf } from '../src/engine/conversations/store.ts';

const runtime_accounts = [
	{ id: 'customer_mail', integration: 'customer_notices', status: { state: 'connected' } },
	// paused outside its own test: an active second customer_notices instance would mirror every notice
	{ id: 'atomic_mail', integration: 'customer_notices', active: false, status: { state: 'connected' } },
	{ id: 'desk_wa', integration: 'whatsapp', status: { state: 'connected' } },
	{ id: 'slack_a', integration: 'slack', status: { state: 'connected' } },
	{ id: 'slack_b', integration: 'slack', status: { state: 'connected' } },
	{ id: 'supplier_inbox', integration: 'mail_import' },
	{ id: 'repair_wa', integration: 'whatsapp', status: { state: 'connected' } },
	{ id: 'envoy_wa', integration: 'whatsapp' },
	{ id: 'recent_wa', integration: 'whatsapp' },
	{ id: 'dedupes_wa', integration: 'whatsapp', status: { state: 'connected' } },
] as const;
const runtime_envoys = [{ id: '0199a000-0000-7000-8000-0000000000e9', name: 'Repair desk', policies: ['staff'], audience: 'public', triage: false, group_messages: 'disabled', accounts: ['envoy_wa', 'atomic_mail'] }] as const;

const manifest = Result.getOrThrow(
	decode_projected_manifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			sent_emails: {
				description: 'A customer notice',
				record_label: 'record.subject',
				fields: {
					to: { kind: 'text' },
					subject: { kind: 'text' },
					body: { kind: 'text' },
					status: {
						kind: 'state',
						initial: 'open',
						states: { open: { to: ['closed'] }, closed: {} }
					},
					sent_at: { kind: 'instant', optional: true },
					delivered_at: { kind: 'instant', optional: true },
					opened_at: { kind: 'instant', optional: true },
					replied_at: { kind: 'instant', optional: true },
					failed_reason: { kind: 'text', optional: true }
				},
				locks: { closed: { where: { status: { eq: 'closed' } }, except: ['sent_at', 'delivered_at', 'opened_at', 'replied_at', 'failed_reason'] } }
			},
			supplier_mail: {
				description: 'A supplier mail',
				record_label: 'record.subject',
				// the engine's id map carries the connection; the row needs no routing field
				key: ['message_id'],
				unique: [{ fields: ['message_id'], import_key: true }],
				fields: { message_id: { kind: 'text' }, subject: { kind: 'text' }, files: { kind: 'json' } }
			}
		},
		relationships: {},
		exposures: {
			sent_emails: {
				outputs: { default: { sent_emails: { fields: 'all' } } },
				create: { columns: { sent_emails: ['to', 'subject', 'body'] } },
				syncs: { mail: { with: 'customer_notices', read: true, write: true } },
				update: {
					columns: {
						sent_emails: [
							'status',
							'sent_at',
							'delivered_at',
							'opened_at',
							'replied_at',
							'failed_reason'
						]
					}
				}
			},
			supplier_mail: {
				outputs: { default: { supplier_mail: { fields: 'all' } } },
				syncs: { inbox: { with: 'mail_import', read: true } }
			}
		},
		integrations: {
			customer_notices: {
				description: 'Customer notices',
				driver: 'email'
			},
			mail_import: {
				description: 'The supplier inbox',
				driver: 'email'
			}
		},
		
		policies: {
			staff: {
				description: 'Staff',
				grants: {
					sent_emails: { outputs: { default: {} }, create: {}, update: { moves: 'all' } }
				}
			}
		},
		teams: {
			direct: { policies: ['staff'] }
		},
		automations: {},
		mcp: {},
		apps: {},
		custom_fields: {},
		agent: { skills: {} }
	})
);

const guest = program(`export default {
	model: {
		sent_emails: { bodies: { syncs: { mail: {
			write: function* ({op,row},ctx) { if(op!=='create'||row.to==='nobody')return null;return {$id:yield* ctx.send({to:[row.to],subject:row.subject,text:row.body,thread:row.id})}; },
			read: function* ({deliveries}) { return {rows:deliveries.filter((e)=>e.kind!=='message').map((e)=>({$id:e.message,...(e.kind==='sent'?{sent_at:e.at}:e.kind==='delivered'?{delivered_at:e.at}:e.kind==='opened'?{opened_at:e.at}:e.kind==='replied'?{replied_at:e.at}:e.kind==='auto_replied'?{failed_reason:'auto: '+e.reply.subject}:{failed_reason:e.kind==='deferred'?'deferred '+(e.code??''):e.reason})}))}; }
		} } } },
		supplier_mail: { bodies: { syncs: { inbox: { read: function* ({deliveries}) {return {rows:deliveries.filter((d)=>d.kind==='message').map(({message:m})=>({$id:m.id,$version:m.version,...(m.deleted?{$deleted:true}:{message_id:m.id,subject:m.subject,files:m.attachments})}))};} } } } }
	}
};`);

const ok = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
const mail = (over: { [k: string]: Json }) => ({
	id: '<r@acme.com>',
	thread: null,
	sent_at: '2026-09-25T10:03:00.000Z',
	from: { address: 'Carol@acme.com', name: 'Carol' },
	reply_to: null,
	to: [],
	cc: [],
	subject: 'Re: PCN 1234',
	text: 'Thanks',
	html: null,
	headers: {},
	attachments: [],
	...over
});
// One workspace for the file. Each test reads only the rows it made (`fresh`), its own sends and blobs; ids, threads
// and provider ids never repeat across tests.
type Recorded = {
	instance: string;
	provider_id: string;
	message: Json;
	attachments?: Parameters<Drivers['Service']['send']>[2];
};
const recorded: Recorded[] = [];
let sends = 0;
const record: Drivers['Service']['send'] = (instance, message, attachments) =>
	Effect.sync(() => {
		const provider_id = `${instance}:${++sends}`;
		recorded.push({
			instance,
			provider_id,
			message,
			...(attachments === undefined ? {} : { attachments })
		});
		return { provider_id };
	});
let send = record;
const blobs = new Map<string, Uint8Array>();
const stored: Files['Service']['get'] = (key) =>
	Effect.suspend(() => {
		const bytes = blobs.get(key);
		return bytes === undefined
			? Port.unavailable('files', `no blob ${key}`)
			: Effect.succeed(bytes);
	});
let readFile = stored;
const files: Files['Service'] = {
	put: (bytes, meta) =>
		Effect.sync(() => {
			const key = crypto.randomUUID();
			blobs.set(key, bytes);
			return {
				key,
				bytes: bytes.byteLength,
				sha256: createHash('sha256').update(bytes).digest('hex'),
				mime: meta.mime
			};
		}),
	get: (key, max) => readFile(key, max),
	url: (key) => Effect.succeed(`memory://${key}`),
	remove: (key) =>
		Effect.sync(() => {
			blobs.delete(key);
		}),
	download: () => Port.unavailable('files.download')
};
const ports = Layer.mergeAll(
	Layer.succeed(Files, files),
	Layer.succeed(Drivers, {
		available: true,
		send: (...args) => send(...args),
		typing: () => Effect.void,
		request: () => Port.unavailable('link'),
		read: () => Port.unavailable('link'),
		changed: () => Effect.void
	})
);
const fileScope = Effect.runSync(Scope.make());
afterAll(() => Effect.runPromise(Scope.close(fileScope, Exit.void)));
const workspace = Effect.runSync(
	Effect.cached(
		Effect.gen(function* () {
			const context = yield* Layer.build(
				with_envoys(with_accounts(TestWorkspace.layer({ manifest, guest: yield* guest, ports }), runtime_accounts), runtime_envoys)
			);
			return { context, route: yield* route_fixture(context) };
		}).pipe(Scope.provide(fileScope))
	)
);
const fixture = () =>
	Effect.gen(function* () {
		const { context, route } = yield* workspace;
		recorded.length = 0;
		send = record;
		blobs.clear();
		const t = Context.get(context, TestWorkspace),
			nativeConversations = Context.get(context, Conversations),
			outbound = Context.get(context, Outbound);
		// the rows earlier tests left: every read below skips them
		const before = (table: string) =>
			t.db
				.rows(Schema.Struct({ id: Schema.String }), {
					text: `SELECT id::text AS id FROM ${table}`,
					params: []
				})
				.pipe(Effect.map((rows) => `'{${rows.map((r) => r.id).join(',')}}'::text[]`));
		const old = {
			sys_message: yield* before('sys_message'),
			sys_file: yield* before('sys_file'),
			sys_run: yield* before('sys_run')
		};
		const fresh = (table: keyof typeof old, alias: string = table) =>
			`${alias}.id::text <> ALL(${old[table]})`;
		const conversations: Conversations['Service'] = {
			...nativeConversations,
			send: (...args) => nativeConversations.send(...args).pipe(Effect.provide(context)),
			receive: (...args) => nativeConversations.receive(...args).pipe(Effect.provide(context)),
			recent: (...args) => nativeConversations.recent(...args).pipe(Effect.provide(context)),
			repair: (...args) => nativeConversations.repair(...args).pipe(Effect.provide(context)),
			handlers: Object.fromEntries(
				Object.entries(nativeConversations.handlers).map(([name, handler]) => [
					name,
					(...args: Parameters<typeof handler>) => handler(...args).pipe(Effect.provide(context))
				])
			)
		};
		const act = (authority: Authority, callable: string, input: Json) =>
			act_reply(route, authority, { acts: { [callable]: input }, issued_at: t.clock.now() }).pipe(
				Effect.map((r) => r.outcome)
			);
		const staffMember = t.member(['staff']);
		const staffAuthority = (yield* t.as(staffMember)).authority;
		const adminAuthority = (yield* t.as(t.admin)).authority;
		const staff = () => staffAuthority;
		const notice = () =>
			act(staff(), 'sent_emails.create', [
				{
					to: 'carol@acme.com',
					subject: 'PCN 1234',
					body: 'Your parts change.'
				}
			]).pipe(Effect.map((o) => ok(o).records[0]?.id ?? ''));
		const row = (id: string) =>
			q_reply(route, adminAuthority, {
				reads: [{ m: 'query', a: [{ sent_emails: { where: { id: { eq: id } } } }] }]
			}).pipe(
				Effect.flatMap((r) =>
					Schema.decodeUnknownEffect(
						Schema.Struct({
							sent_emails: Schema.Struct({
								rows: Schema.Tuple([Schema.Record(Schema.String, Schema.Json)])
							})
						})
					)(r.answers[0])
				),
				Effect.map((answer) => answer.sent_emails.rows[0])
			);
		const rows = (text: string) =>
			t.db.read([{ text, params: [] }]).pipe(Effect.map((r) => r[0]?.rows ?? []));
		const runs = () =>
			t.db.rows(
				Schema.Struct({
					automation: Schema.String,
					state: Schema.String,
					due: Schema.String,
					error: Schema.NullOr(Schema.String)
				}),
				{
					text: `SELECT automation, state, due_at::text AS due, left(error->>'message',400) AS error
			FROM sys_run WHERE state IN ('queued','running','failed') AND ${fresh('sys_run')} ORDER BY due_at,id LIMIT 10`,
					params: []
				}
			);
		const outbox = () =>
			rows(
				`SELECT m.id, m.integration, m.status, m.attempts, m.error, m.conversation, m.provider_id, m.sent_at, o.record
				FROM sys_message m LEFT JOIN sys_outbox o ON o.key = m.meta ->> 'sync_write'
				WHERE m.direction = 'outbound' AND m.status IS NOT NULL AND ${fresh('sys_message', 'm')} ORDER BY m.seq`
			);
		const sent = (instance: string) => recorded.filter((s) => s.instance === instance);
		/** The provider id the native fake answered for this test's n-th send on `instance`. */
		const provider = (instance: string, n = 1) => sent(instance)[n - 1]?.provider_id ?? '';
		const deliver = () =>
			t.syncs.deliver().pipe(
				Effect.andThen(outbound.deliver),
				Effect.tap(() => t.syncs.read('sent_emails.sync.mail')),
				Effect.provide(context)
			);
		const report = (
			instance: string,
			provider_id: string,
			r: { kind: 'delivered' | 'opened' | 'bounced' | 'deferred'; at: string } & {
				[k: string]: Json;
			}
		) =>
			conversations.receive(instance, {
				kind: 'delivery',
				provider_id,
				report: { provider: 'fake', ...r }
			});
		const timeline = () =>
			rows(
				`SELECT status, delivery FROM sys_message m WHERE direction = 'outbound' AND ${fresh('sys_message', 'm')} ORDER BY seq`
			).pipe(
				Effect.map((r) => {
					const first = r[0];
					if (first === undefined) throw new Error('no timeline');
					return first;
				})
			);
		const history = () =>
			rows(
				`SELECT integration, provider_id, text, deleted_at IS NOT NULL AS deleted, ${filesOf('m')} AS files, conversation, origin FROM sys_message m WHERE direction = 'inbound' AND ${fresh('sys_message', 'm')} ORDER BY seq`
			);
		return {
			t,
			context,
			conversations,
			outbound,
			recorded,
			record,
			files,
			blobs,
			act,
			staff,
			notice,
			row,
			rows,
			runs,
			outbox,
			sent,
			provider,
			fresh,
			deliver,
			report,
			timeline,
			history,
			setSend: (value: Drivers['Service']['send']) => {
				send = value;
			},
			failing: (f: (message: Json) => Error | null) => {
				send = (...args) =>
					Effect.suspend(() => {
						const error = f(args[1]);
						return error === null
							? record(...args)
							: Effect.fail(error instanceof SendRefused ? error : Port.failure('link')(error));
					});
			}
		};
	});

describe('delivery status', () => {
	it.live('commits an inbound reply, delivery correlation, sync hint and envoy admission together', () =>
		Effect.scoped(Effect.gen(function* () {
			const f = yield* fixture();
			const thread = 'atomic-reply-thread';
			const pause = (active: boolean) =>
				f.t.db.write({ text: 'UPDATE sys_integration SET active = $1 WHERE id = $2', params: [active, 'atomic_mail'] });
			yield* pause(true);
			yield* Effect.addFinalizer(() => Effect.orDie(pause(false)));
			const outbound = yield* f.conversations.send('atomic_mail', { to: ['carol@acme.com'], subject: 'Daily report', text: 'Report', thread }, {});
			yield* f.deliver();
			let refuse = true, intercepted = 0;
			const db = TenantDb.typed({ ...f.t.db, write: (statement, lock) => {
				if (refuse && statement.text.includes('envoys.admit')) {
					intercepted++;
					return Effect.fail(new DbError({ sqlstate: '40001', message: 'injected inbound admission failure' }));
				}
				return f.t.db.write(statement, lock);
			} });
			const receiver = native_conversations({
				crypto: Context.get(f.context, Crypto.Crypto),
				engine: { manifest, db, live: Context.get(f.context, Live) },
				files, filesReady: () => Effect.void, logs: Context.get(f.context, Logs),
				clock: Effect.sync(() => f.t.clock.now()), outbound: f.outbound
			});
			const event = { kind: 'messages' as const, messages: [mail({ id: '<atomic-reply@acme.com>', thread, headers: { 'in-reply-to': f.provider('atomic_mail') } })] };
			expect(yield* Effect.flip(receiver.receive('atomic_mail', event))).toMatchObject({ _tag: 'DbError', sqlstate: '40001' });
			expect(intercepted).toBe(1);
			expect(yield* f.rows(`SELECT status FROM sys_message WHERE id='${outbound}'`)).toEqual([{ status: 'sent' }]);
			expect(yield* f.rows("SELECT id FROM sys_message WHERE provider_id='<atomic-reply@acme.com>'")).toEqual([]);
			expect(yield* f.rows("SELECT id FROM sys_inbox WHERE instance='atomic_mail'")).toEqual([]);
			expect(yield* f.rows(`SELECT id FROM sys_run r WHERE automation='envoys.admit' AND ${f.fresh('sys_run', 'r')}`)).toEqual([]);
			refuse = false;
			yield* receiver.receive('atomic_mail', event);
			yield* receiver.receive('atomic_mail', event);
			expect(yield* f.rows(`SELECT status FROM sys_message WHERE id='${outbound}'`)).toEqual([{ status: 'replied' }]);
			expect(yield* f.rows("SELECT id FROM sys_message WHERE provider_id='<atomic-reply@acme.com>'")).toHaveLength(1);
			expect(yield* f.rows("SELECT id FROM sys_inbox WHERE instance='atomic_mail'")).toHaveLength(1);
			expect(yield* f.rows(`SELECT id FROM sys_run r WHERE automation='envoys.admit' AND ${f.fresh('sys_run', 'r')}`)).toHaveLength(1);
		}))
	);
	it.live('persists a provider reference before I/O and preserves an early reply across a later send acknowledgement', () =>
		Effect.scoped(Effect.gen(function* () {
			const f = yield* fixture();
			const provider_id = '<early-reference@acme.com>', thread = 'early-reference-thread';
			let outgoing = '';
			f.setSend((instance, message) => Effect.gen(function* () {
				outgoing = (yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(message)).id;
				yield* f.conversations.receive(instance, { kind: 'outbound_ref', message: outgoing, provider_id });
				expect(yield* f.rows(`SELECT provider_id,status,sent_at FROM sys_message WHERE id='${outgoing}'`)).toEqual([{ provider_id, status: 'sending', sent_at: null }]);
				yield* f.conversations.receive(instance, { kind: 'messages', messages: [mail({ id: '<early-reply@acme.com>', thread, headers: { 'in-reply-to': provider_id }, text: 'Explain this report' })] });
				expect(yield* f.rows(`SELECT status, sent_at = '2026-09-25T10:03:00.000Z'::timestamptz AS accepted_at_reply FROM sys_message WHERE id='${outgoing}'`)).toEqual([{ status: 'replied', accepted_at_reply: true }]);
				return { provider_id };
			}).pipe(Effect.mapError(Port.failure('link'))));
			const id = yield* f.conversations.send('customer_mail', { to: ['carol@acme.com'], subject: 'Daily report', text: 'Daily report', thread }, {});
			yield* f.deliver();
			expect(id).toBe(outgoing);
			expect(yield* f.outbox()).toMatchObject([{ id, provider_id, status: 'replied', attempts: 1 }]);
			expect((yield* f.history()).filter((row) => row['provider_id'] === '<early-reply@acme.com>')).toHaveLength(1);
			expect((yield* f.timeline())['delivery']).toMatchObject([{ kind: 'queued' }, { kind: 'replied' }, { kind: 'sent' }]);
			expect(yield* Effect.flip(f.outbound.reference('customer_mail', { message: id, provider_id: '<conflicting@acme.com>' }))).toMatchObject({ code: 'conflict' });
		}))
	);
	it.live('keeps an early delivery acknowledgement when the non-idempotent send ends without an answer', () =>
		Effect.scoped(Effect.gen(function* () {
			const f = yield* fixture();
			let calls = 0;
			const provider_id = 'ack-before-timeout';
			f.setSend((instance, message) => Effect.gen(function* () {
				calls++;
				const { id } = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(message);
				yield* f.conversations.receive(instance, { kind: 'outbound_ref', message: id, provider_id });
				expect(yield* f.rows(`SELECT sent_at FROM sys_message WHERE id='${id}'`)).toEqual([{ sent_at: null }]);
				yield* f.conversations.receive(instance, { kind: 'delivery', provider_id, report: { kind: 'delivered', at: f.t.clock.now(), provider: 'fake' } });
				expect(yield* f.rows(`SELECT status, sent_at = '${f.t.clock.now()}'::timestamptz AS accepted_at_report FROM sys_message WHERE id='${id}'`)).toEqual([{ status: 'delivered', accepted_at_report: true }]);
				return yield* Effect.fail(new FacilityFailure({ kind: 'timeout', message: 'send acknowledgement lost' }));
			}).pipe(Effect.mapError(Port.failure('link'))));
			yield* f.conversations.send('desk_wa', { to: 'early-ack@s.whatsapp.net', text: 'Daily update' }, {});
			f.t.clock.advance('1h');
			yield* f.deliver();
			expect(calls).toBe(1);
			expect(yield* f.outbox()).toMatchObject([{ provider_id, status: 'delivered', attempts: 1 }]);
		}))
	);
	it.live(
		'every report lands on the timeline; a bounce is terminal: a later delivered neither moves the status nor maps; a redelivery is recorded once',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture();
					const id = yield* f.notice();
					// the committed row is queued through its sync, sent once, and the send is the row's
					expect(f.sent('customer_mail')).toHaveLength(0);
					yield* f.deliver();
					expect(f.sent('customer_mail')).toHaveLength(1);
					expect(yield* f.outbox()).toMatchObject([{ record: id, status: 'sent' }]);
					const bounce = {
						kind: 'bounced' as const,
						at: '2026-09-25T10:05:00.000Z',
						code: '550 5.1.1',
						reason: 'no such user',
						permanent: true
					};
					yield* f.report('customer_mail', f.provider('customer_mail'), bounce);
					yield* f.report('customer_mail', f.provider('customer_mail'), bounce);
					yield* f.report('customer_mail', f.provider('customer_mail'), {
						kind: 'delivered',
						at: '2026-09-25T10:06:00.000Z'
					});
					// one read maps every stored report: only a report that moved the status is stored
					yield* f.t.syncs.read('sent_emails.sync.mail');
					const got = yield* f.timeline();
					expect(got['status'], JSON.stringify({ timeline: got, runs: yield* f.runs() })).toBe(
						'bounced'
					);
					expect(
						Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ kind: Schema.String })))(
							got['delivery']
						).map((e) => e.kind)
					).toEqual(['queued', 'sent', 'bounced', 'delivered']);
					expect(got['delivery']).toMatchObject([
						{ provider: 'bolt' },
						{ provider: 'bolt' },
						{ code: '550 5.1.1', reason: 'no such user', permanent: true, provider: 'fake' },
						{}
					]);
					expect(yield* f.row(id)).toMatchObject({
						failed_reason: 'no such user',
						delivered_at: null
					});
				})
			)
	);

	it.live(
		'a provider refusal: permanent fails at once with its code, a temporary one is deferred and retried',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					f.failing(() => new SendRefused('mailbox busy', '451 4.3.2', false));
					const id = yield* f.notice();
					yield* f.deliver();
					expect(yield* f.timeline()).toMatchObject({
						status: 'queued',
						delivery: [
							{ kind: 'queued' },
							{ kind: 'deferred', code: '451 4.3.2', reason: 'mailbox busy', permanent: false }
						]
					});
					expect((yield* f.row(id))['failed_reason']).toBe('deferred 451 4.3.2');
					f.failing(() => new SendRefused('no such user', '550 5.1.1'));
					t.clock.advance('10min');
					yield* f.deliver();
					expect(yield* f.outbox()).toMatchObject([
						{ status: 'failed', attempts: 2, error: 'no such user', sent_at: null }
					]);
					expect((yield* f.timeline())['delivery']).toMatchObject([
						{},
						{},
						{ kind: 'failed', code: '550 5.1.1', permanent: true }
					]);
					expect((yield* f.row(id))['failed_reason']).toBe('no such user');
				})
			)
	);
});

describe('delivery order', () => {
	it.live(
		'a conversation is delivered serially in seq order: a later message waits while an earlier one retries',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					let first = true;
					f.failing(() => {
						if (first) {
							first = false;
							// an explicit temporary refusal retries; an unexplained failure after handoff is uncertain
							return new SendRefused('socket closed', undefined, false);
						}
						return null;
					});
					yield* f.conversations.send(
						'desk_wa',
						{ to: '6591234567@s.whatsapp.net', text: 'one' },
						{}
					);
					yield* f.conversations.send(
						'desk_wa',
						{ to: '6591234567@s.whatsapp.net', text: 'two' },
						{}
					);
					yield* f.conversations.send(
						'desk_wa',
						{ to: '6599999999@s.whatsapp.net', text: 'elsewhere' },
						{}
					);
					const texts = () =>
						f
							.sent('desk_wa')
							.map(
								(s) =>
									Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(s.message).text
							);
					expect(texts()).toEqual(['elsewhere']);
					t.clock.advance('2s');
					yield* f.deliver();
					expect(texts()).toEqual(['elsewhere', 'one', 'two']);
				})
			)
	);

	it.live(
		'a send names its instance: two Slack connections deliver through their own links and keep their own conversations',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture();
					yield* f.conversations.send('slack_a', { to: 'C1', text: 'to a' }, {});
					yield* f.conversations.send('slack_b', { to: 'C1', text: 'to b' }, {});
					expect(
						f.recorded.map((s) => [
							s.instance,
							Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(s.message).text
						])
					).toEqual([
						['slack_a', 'to a'],
						['slack_b', 'to b']
					]);
					expect(
						(yield* Effect.flip(f.conversations.send('supplier_nope', { to: 'C1', text: 'x' }, {})))
							.message
					).toMatch(/no integration instance/);
				})
			)
	);
});

describe('inbound', () => {
	const chat = (over: { [k: string]: Json } = {}): Json => ({
		id: 'W1',
		thread: '6591234567@s.whatsapp.net',
		sent_at: '2026-09-25T10:00:00.000Z',
		from: { handle: '6591234567@s.whatsapp.net', name: 'Ben' },
		text: 'first',
		attachments: [],
		...over
	});
	it.live(
		'a redelivery is the same row; a newer version converges it, an older one changes nothing; a revoke tombstones it for good',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					yield* t.receive('desk_wa', [chat(), chat()]);
					yield* t.receive(
						'desk_wa',
						chat({ text: 'edited', version: '2026-09-25T10:01:00.000Z' })
					);
					yield* t.receive('desk_wa', chat({ text: 'stale', version: '2026-09-25T10:00:30.000Z' }));
					expect(yield* f.history()).toMatchObject([
						{
							integration: 'desk_wa',
							provider_id: 'W1',
							text: 'edited',
							deleted: false,
							origin: 'live'
						}
					]);
					yield* t.receive('desk_wa', chat({ deleted: true }));
					yield* t.receive('desk_wa', chat({ text: 'late', version: '2026-09-25T11:00:00.000Z' }));
					expect(yield* f.history()).toMatchObject([
						{ provider_id: 'W1', text: '', deleted: true }
					]);
					// a bare revoke (the id alone) holds the id, so the message never lands later
					yield* t.receive('desk_wa', { id: 'W9', deleted: true });
					yield* t.receive('desk_wa', chat({ id: 'W9', text: 'too late' }));
					expect((yield* f.history()).find((r) => r['provider_id'] === 'W9')).toMatchObject({
						text: '',
						deleted: true
					});
				})
			)
	);

	it.live(
		"attachment bytes are stored in the message's statement as a FileRef; one conversation per chat; a malformed message is logged, not redelivered",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const bytes = new TextEncoder().encode('%PDF-1.7'),
						thread = '6592222222@s.whatsapp.net';
					yield* t.receive(
						'desk_wa',
						chat({
							id: 'F1',
							thread,
							attachments: [
								{ name: 'form.pdf', mime: 'application/pdf', bytes: bytes.byteLength, bin: 0 }
							]
						}),
						{ bins: [bytes] }
					);
					yield* t.receive('desk_wa', chat({ id: 'F2', thread, text: 'second' }));
					const rows = yield* f.history();
					expect(rows[0]?.['files']).toEqual([
						{
							id: expect.any(String),
							name: 'form.pdf',
							mime: 'application/pdf',
							bytes: bytes.byteLength
						}
					]);
					expect(f.blobs.size).toBe(1);
					expect(new Set(rows.map((r) => r['conversation'])).size).toBe(1);
					// the engine logs a link's malformed message and moves on (the kit's `receive` refuses one outright)
					yield* f.conversations.receive('desk_wa', { kind: 'messages', messages: [{ id: 'bad' }] });
					expect(
						t.fakes.logs
							.filter((r) => r.event === 'conversation.malformed')
							.map((r) => r.invocation)
					).toEqual(['desk_wa']);
					expect(yield* f.history()).toHaveLength(2);
				})
			)
	);

	it.live(
		'a message sync is queued in the ingest statement: one run per message version, none for a redelivery, and the run maps it',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const pcn = (over: { [k: string]: Json } = {}) =>
						mail({
							id: '<pcn-1@onsemi.com>',
							from: { address: 'pcn@onsemi.com', name: null },
							subject: 'PCN 1234',
							...over
						});
					yield* f.conversations.receive('supplier_inbox', { kind: 'messages', messages: [pcn()] });
					yield* f.conversations.receive('supplier_inbox', { kind: 'messages', messages: [pcn()] });
					const runs = () =>
						t.db
							.read([
								{
									text: `SELECT automation, state, input FROM sys_run WHERE automation = 'supplier_mail.sync.inbox' AND cause = 'provider' AND ${f.fresh('sys_run')} ORDER BY due_at, id`,
									params: []
								}
							])
							.pipe(Effect.map((r) => r[0]?.rows ?? []));
					expect(yield* runs()).toMatchObject([
						{ state: 'queued', input: { instance: 'supplier_inbox' } }
					]);
					// The source's readSoon coalesces inbound hints for exactly two seconds.
					t.clock.advance('2s');
					yield* t.run_due();
					const rows = () =>
						t.db
							.read([
								{
									text: `SELECT r.instance AS inbox, m.message_id, m.subject FROM supplier_mail m
										JOIN sys_sync_row r ON r.record = m.id::text WHERE m.message_id = '<pcn-1@onsemi.com>'`,
									params: []
								}
							])
							.pipe(Effect.map((r) => r[0]?.rows ?? []));
					expect(yield* rows(), JSON.stringify(yield* runs())).toEqual([
						{ inbox: 'supplier_inbox', message_id: '<pcn-1@onsemi.com>', subject: 'PCN 1234' }
					]);
					yield* t.receive(
						'supplier_inbox',
						pcn({ subject: 'PCN 1234 rev B', version: '2026-09-25T10:04:00.000Z' })
					);
					t.clock.advance('2s');
					yield* t.run_due();
					expect(yield* runs()).toHaveLength(2);
					expect(yield* rows(), JSON.stringify(yield* runs())).toEqual([
						{ inbox: 'supplier_inbox', message_id: '<pcn-1@onsemi.com>', subject: 'PCN 1234 rev B' }
					]);
				})
			)
	);

	it.live(
		'a message on an unknown or non-conversation instance is refused, so the link does not acknowledge it',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture();
					expect(
						yield* Effect.flip(
							f.conversations.receive('nowhere', { kind: 'messages', messages: [chat()] })
						)
					).toMatchObject({ code: 'not_found' });
				})
			)
	);
	it.live(
		'an import cutoff admits by provider source time, the boundary included; an older attachment never reaches storage',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						thread = '6594444444@s.whatsapp.net',
						bytes = new TextEncoder().encode('%PDF-1.7'),
						put = vi.spyOn(f.files, 'put');
					ok(
						yield* f.act((yield* f.t.as(f.t.admin)).authority, 'sys_integration.update', [
							{
								target: { id: 'desk_wa' },
								set: {
									import_start: {
										kind: 'since',
										at: '2026-09-25T10:00:00.000Z',
										zone: 'UTC',
										origin: 'date'
									}
								}
							}
						])
					);
					yield* f.conversations.receive('desk_wa', {
						kind: 'messages',
						messages: [
							chat({ thread, id: 'missing-source', sent_at: '2030-01-01T00:00:00.000Z' }),
							chat({
								thread,
								id: 'invalid-source',
								sent_at: '2030-01-01T00:00:00.000Z',
								source_at: 'not an instant'
							}),
							chat({
								thread,
								id: 'old-source',
								sent_at: '2030-01-01T00:00:00.000Z',
								source_at: '2026-09-25T09:59:59.999Z'
							}),
							chat({
								thread,
								id: 'new-source',
								sent_at: '1999-01-01T00:00:00.000Z',
								source_at: '2026-09-25T10:00:00.001Z'
							}),
							chat({ thread, id: 'equal-source', source_at: '2026-09-25T10:00:00.000Z' }),
							chat({
								thread,
								id: 'old-attachment',
								sent_at: '2030-01-01T00:00:00.000Z',
								source_at: '2026-09-25T09:59:59.999Z',
								attachments: [
									{ name: 'old.pdf', mime: 'application/pdf', bytes: bytes.byteLength, bin: 0 }
								]
							})
						],
						bins: [bytes]
					});
					expect((yield* f.history()).map((row) => row['provider_id'])).toEqual([
						'new-source',
						'equal-source'
					]);
					expect(
						yield* f.rows(
							`SELECT provider_id, (extract(epoch FROM source_at) * 1000)::double precision AS source_ms
						FROM sys_message m WHERE integration = 'desk_wa' AND ${f.fresh('sys_message', 'm')} ORDER BY seq`
						)
					).toEqual([
						{ provider_id: 'new-source', source_ms: Date.parse('2026-09-25T10:00:00.001Z') },
						{ provider_id: 'equal-source', source_ms: Date.parse('2026-09-25T10:00:00.000Z') }
					]);
					expect(put).not.toHaveBeenCalled();
					expect(f.blobs.size).toBe(0);
					expect(yield* f.rows(`SELECT id FROM sys_file WHERE ${f.fresh('sys_file')}`)).toEqual([]);
				})
			)
	);
});

describe('what a send does not know', () => {
	const timedOut = () =>
		Effect.fail(new FacilityFailure({ kind: 'timeout', message: 'no answer in time' }));
	const statuses = (f: Effect.Success<ReturnType<typeof fixture>>) =>
		f.outbox().pipe(Effect.map((rows) => rows.map((r) => [r['status'], r['attempts']])));
	const dedupes = (f: Effect.Success<ReturnType<typeof fixture>>) =>
		f.t.db.write({
			text: `UPDATE sys_integration SET status = coalesce(status, '{}'::jsonb) || '{"idempotent_sends":true}'::jsonb WHERE id = 'dedupes_wa'`,
			params: []
		});

	it.live('a send that timed out is not sent again: it stays uncertain', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				let tries = 0;
				f.setSend(() =>
					Effect.suspend(() => {
						tries++;
						return timedOut();
					})
				);
				yield* f.conversations.send('desk_wa', { to: 'U1@s.whatsapp.net', text: 'once' }, {});
				f.t.clock.advance('1h');
				yield* f.deliver();
				expect(tries).toBe(1);
				expect(yield* statuses(f)).toEqual([['uncertain', 1]]);
			})
		)
	);

	it.live('a provider that dedupes on the id is asked again after a timeout', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* dedupes(f);
				f.setSend(timedOut);
				yield* f.conversations.send('dedupes_wa', { to: 'U2@s.whatsapp.net', text: 'once' }, {});
				expect(yield* statuses(f)).toEqual([['queued', 1]]);
				f.setSend(f.record);
				f.t.clock.advance('1h');
				yield* f.deliver();
				expect(yield* statuses(f)).toEqual([['sent', 2]]);
			})
		)
	);

	it.live('a timeout before the send reached the provider is retried: nothing can have gone', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				const blob = yield* files.put(new Uint8Array([1]), { name: 'a.txt', mime: 'text/plain' });
				yield* f.t.db.write({
					text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at) VALUES ('slow-file', 'a.txt', 'text/plain', 1, $1, $2, 'sys_conversation.inputs', $3::timestamptz)`,
					params: [blob.key, blob.sha256, f.t.clock.now()]
				});
				readFile = timedOut;
				yield* f.conversations.send(
					'desk_wa',
					{ to: 'U3@s.whatsapp.net', text: 'see file', attachments: [{ id: 'slow-file' }] },
					{}
				);
				expect(yield* statuses(f)).toEqual([['queued', 1]]);
				readFile = stored;
				f.t.clock.advance('1h');
				yield* f.deliver();
				expect(yield* statuses(f)).toEqual([['sent', 2]]);
			})
		).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					readFile = stored;
				})
			)
		)
	);

	const strand = (f: Effect.Success<ReturnType<typeof fixture>>, instance: string, to: string) =>
		Effect.gen(function* () {
			f.setSend(timedOut);
			yield* f.conversations.send(instance, { to, text: 'cut off' }, {});
			yield* f.t.db.write({
				text: `UPDATE sys_message m SET status = 'sending', claimed_at = $1::timestamptz WHERE direction = 'outbound' AND ${f.fresh('sys_message', 'm')}`,
				params: [f.t.clock.now()]
			});
			f.setSend(f.record);
		});

	it.live(
		'a send left without an answer wakes at its lease, behind which a later message waits, and stays uncertain',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					yield* strand(f, 'desk_wa', 'U4@s.whatsapp.net');
					yield* f.conversations.send('desk_wa', { to: 'U4@s.whatsapp.net', text: 'next' }, {});
					const lease = new Date(Date.parse(t.clock.now()) + 600_000).toISOString();
					// the send's drain runs now; the stranded row holds the next one back, so the drain moves to its lease
					yield* t.run_due();
					expect(f.sent('desk_wa')).toHaveLength(0);
					expect(
						yield* f.rows(
							`SELECT 1 AS woken FROM sys_run r WHERE r.automation = 'integrations.deliver' AND r.state = 'queued' AND r.key = 'bolt.drain:integrations.deliver' AND r.due_at = '${lease}'::timestamptz`
						)
					).toEqual([{ woken: 1 }]);
					t.clock.advance('11min');
					yield* f.deliver();
					expect(f.sent('desk_wa')).toHaveLength(1);
					expect((yield* statuses(f)).map(([status]) => status)).toEqual(['uncertain', 'sent']);
				})
			)
	);

	it.live('a provider that dedupes on the id sends a stranded row again at its lease', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* dedupes(f);
				yield* strand(f, 'dedupes_wa', 'U5@s.whatsapp.net');
				f.t.clock.advance('11min');
				yield* f.deliver();
				expect((yield* statuses(f)).map(([status]) => status)).toEqual(['sent']);
			})
		)
	);

	it.live(
		'a link that is down spends no attempt, however long it stays down, and its connect delivers',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					f.setSend(() =>
						Effect.fail(new Unavailable({ facility: LINK_DOWN, reason: 'not connected' }))
					);
					yield* f.conversations.send('desk_wa', { to: 'U6@s.whatsapp.net', text: 'wait' }, {});
					expect(yield* statuses(f)).toEqual([['queued', 0]]);
					t.clock.advance('1h');
					yield* t.run_due();
					t.clock.advance('2d');
					yield* t.run_due();
					expect(yield* statuses(f)).toEqual([['queued', 0]]);
					f.setSend(f.record);
					yield* f.outbound.resume('desk_wa').pipe(Effect.provide(f.context));
					yield* t.run_due();
					expect(f.sent('desk_wa')).toHaveLength(1);
					expect(yield* statuses(f)).toEqual([['sent', 1]]);
				})
			)
	);

	it.live('a resume with nothing waiting queues no delivery', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.outbound.resume('slack_b').pipe(Effect.provide(f.context));
				expect(yield* f.runs()).toEqual([]);
			})
		)
	);
});

describe('repair (a webhook is a hint)', () => {
	const HOUR = 3_600_000,
		DAY = 24 * HOUR;
	type F = Effect.Success<ReturnType<typeof fixture>>;
	const ago = (f: F, ms: number) => new Date(Date.parse(f.t.clock.now()) - ms).toISOString();
	const seen = (thread: string, id: string, sent_at: string, over: { [k: string]: Json } = {}) => ({
		id,
		thread,
		sent_at,
		from: { handle: thread, name: 'Ben' },
		text: 'as stored',
		attachments: [],
		...over
	});
	const stored = (f: F, thread: string) =>
		f.rows(
			`SELECT m.provider_id, m.text, m.origin, m.deleted_at IS NOT NULL AS deleted FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation
			WHERE c.thread = '${thread}' AND m.direction = 'inbound' AND ${f.fresh('sys_message', 'm')} ORDER BY m.provider_id`
		);
	const admissions = (f: F) =>
		f.rows(
			`SELECT r.input->>'message' AS message FROM sys_run r WHERE r.automation = 'envoys.admit' AND ${f.fresh('sys_run', 'r')}`
		);

	it.live(
		'brings what a delivery lost and an edit; the same view again writes nothing and starts nothing',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t,
						thread = 'R1@s.whatsapp.net',
						since = ago(f, 7 * DAY);
					const sent_at = ago(f, 3 * HOUR);
					yield* t.receive('repair_wa', seen(thread, 'R1-a', sent_at));
					const page = {
						complete: false,
						messages: [
							seen(thread, 'R1-a', sent_at, { text: 'edited', version: ago(f, 2 * HOUR) }),
							seen(thread, 'R1-b', ago(f, 2 * HOUR), { text: 'lost' })
						]
					};
					yield* f.conversations.repair('repair_wa', thread, since, page);
					expect(yield* stored(f, thread)).toEqual([
						{ provider_id: 'R1-a', text: 'edited', origin: 'live', deleted: false },
						{ provider_id: 'R1-b', text: 'lost', origin: 'sync', deleted: false }
					]);
					const runs = (yield* f.runs()).length;
					t.count.reset();
					yield* f.conversations.repair('repair_wa', thread, since, page);
					expect(t.count.writes).toBe(0);
					expect((yield* f.runs()).length).toBe(runs);
				})
			)
	);

	it.live(
		'a complete view tombstones what it lacks; a partial one, a settling message and rows outside the window stay',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t,
						thread = 'R2@s.whatsapp.net';
					yield* f.conversations.send('repair_wa', { to: thread, text: 'ours' }, {});
					t.clock.advance('10min');
					const since = ago(f, 2 * DAY);
					yield* t.receive('repair_wa', [
						seen(thread, 'R2-kept', ago(f, HOUR)),
						seen(thread, 'R2-gone', ago(f, HOUR)),
						seen(thread, 'R2-narrowed', ago(f, DAY + HOUR)),
						seen(thread, 'R2-older', ago(f, 3 * DAY)),
						seen(thread, 'R2-settling', ago(f, 60_000))
					]);
					const messages = [seen(thread, 'R2-kept', ago(f, HOUR))];
					yield* f.conversations.repair('repair_wa', thread, since, { complete: false, messages });
					const deleted = () =>
						stored(f, thread).pipe(
							Effect.map((rows) => rows.filter((r) => r['deleted']).map((r) => r['provider_id']))
						);
					expect(yield* deleted()).toEqual([]);
					yield* f.conversations.repair('repair_wa', thread, since, {
						complete: true,
						messages,
						since: ago(f, DAY)
					});
					expect(yield* deleted()).toEqual(['R2-gone']);
					expect(
						yield* f.rows(
							`SELECT m.status, m.deleted_at FROM sys_message m WHERE m.direction = 'outbound' AND ${f.fresh('sys_message', 'm')}`
						)
					).toEqual([{ status: 'sent', deleted_at: null }]);
					// a page that echoes what bolt sent adds no inbound row
					const [ours] = f.sent('repair_wa');
					yield* f.conversations.repair('repair_wa', thread, since, {
						complete: false,
						messages: [seen(thread, ours?.provider_id ?? '', ago(f, 11 * 60_000))]
					});
					expect(yield* stored(f, thread)).toHaveLength(5);
					t.count.reset();
					yield* f.conversations.repair('repair_wa', thread, since, {
						complete: true,
						messages,
						since: ago(f, DAY)
					});
					expect(t.count.writes).toBe(0);
				})
			)
	);

	it.live(
		'an envoy answers a repaired message only while its sender may still wait: an old one, an edit and a delete start nothing',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t,
						thread = 'R3@s.whatsapp.net',
						since = ago(f, 7 * DAY);
					yield* t.db.write({
						text: `UPDATE sys_integration SET envoy = 'desk' WHERE id = 'envoy_wa'`,
						params: []
					});
					yield* t.receive('envoy_wa', seen(thread, 'R3-known', ago(f, 3 * HOUR)));
					yield* t.receive('envoy_wa', seen(thread, 'R3-dropped', ago(f, 3 * HOUR)));
					const before = (yield* admissions(f)).map((r) => r['message']);
					yield* f.conversations.repair('envoy_wa', thread, since, {
						complete: true,
						messages: [
							seen(thread, 'R3-known', ago(f, 3 * HOUR), {
								text: 'edited',
								version: ago(f, HOUR)
							}),
							seen(thread, 'R3-old', ago(f, 2 * HOUR), { text: 'long past' }),
							seen(thread, 'R3-fresh', ago(f, HOUR / 2), { text: 'still waiting' })
						]
					});
					expect((yield* stored(f, thread)).map((r) => [r['provider_id'], r['origin']])).toEqual([
						['R3-dropped', 'live'],
						['R3-fresh', 'live'],
						['R3-known', 'live'],
						['R3-old', 'sync']
					]);
					// sys_run rows carry no order: the admission the repair added is the one not there before
					const added = (yield* admissions(f)).map((r) => r['message']).filter((m) => !before.includes(m));
					expect(added).toEqual(
						yield* f.rows(
							`SELECT m.id FROM sys_message m WHERE m.provider_id = 'R3-fresh' AND m.integration = 'envoy_wa'`
						).pipe(Effect.map((rows) => rows.map((r) => r['id'])))
					);
				})
			)
	);

	it.live(
		"recent names one instance's active threads, newest first, within the window and the cap",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const quiet = 'T-quiet@s.whatsapp.net',
						first = 'T-first@s.whatsapp.net',
						second = 'T-second@s.whatsapp.net';
					yield* t.receive('recent_wa', seen(quiet, 'T-a', t.clock.now()));
					t.clock.advance('8d');
					yield* t.receive('recent_wa', seen(first, 'T-b', t.clock.now()));
					t.clock.advance('1min');
					yield* t.receive('recent_wa', seen(second, 'T-c', t.clock.now()));
					yield* t.receive('slack_b', seen('C9', 'T-d', t.clock.now()));
					expect(yield* f.conversations.recent('recent_wa')).toEqual({
						since: ago(f, 7 * DAY),
						threads: [second, first]
					});
					yield* t.db.write({
						text: `WITH c AS (INSERT INTO sys_conversation (id, integration, thread, kind)
						SELECT 'cap-' || g, 'recent_wa', 'cap-' || g, 'dm' FROM generate_series(1, 205) g RETURNING id)
					INSERT INTO sys_message (id, conversation, integration, direction, created_at)
						SELECT 'm-' || id, id, 'recent_wa', 'inbound', $1::timestamptz FROM c`,
						params: [t.clock.now()]
					});
					expect((yield* f.conversations.recent('recent_wa')).threads).toHaveLength(200);
				})
			)
	);
});

// last: a fork's activation leaves the store to another epoch
describe('epochs', () => {
	it.live('rows of another epoch (a fork, a restore) are never sent', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					t = f.t;
				f.failing(() => new SendRefused('down', undefined, false));
				yield* f.notice();
				yield* f.deliver();
				f.setSend(f.record);
				// the queued retry was written by another environment (this host's epoch is '')
				yield* t.db.write({
					text: `UPDATE sys_message m SET epoch = 'fork-1' WHERE direction = 'outbound' AND status = 'queued' AND ${f.fresh('sys_message', 'm')}`,
					params: []
				});
				t.clock.advance('1h');
				yield* f.deliver();
				expect(f.sent('customer_mail')).toHaveLength(0);
				expect(yield* f.outbox(), JSON.stringify(yield* f.runs())).toMatchObject([
					{ status: 'skipped' }
				]);
			})
		)
	);
});
