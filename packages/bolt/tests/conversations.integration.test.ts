// engine/conversations on PGlite (§4.3, rule 61, rule 41's exception, G12 (3)): serial-pcn's
// `customer_notices` shape — a `sent_emails` row's create sends its mail through the `customer_mail` connection, delivery
// reports and the customer's reply land on the row after it is closed — plus one-statement inbound keyed by instance
// (dedupe, edits, revokes, files, the import cutoff, the `messages` feed it queues), serial at-least-once delivery and
// the epoch.
import { describe, expect, it, vi } from '@effect/vitest';
import { afterAll } from 'vitest';
import { Context, Effect, Exit, Layer, Result, Schema, Scope } from 'effect';
import { createHash } from 'node:crypto';
import { Drivers, Files } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Conversations, Outbound } from '../src/engine/services.ts';
import { decodeProjectedManifest } from '../src/engine/manifest.ts';
import { program } from '../src/test/guest.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import { SendRefused } from '../src/engine/conversations/status.ts';
import { TestWorkspace } from '../src/test/index.ts';
import { filesOf } from '../src/engine/conversations/store.ts';

const manifest = Result.getOrThrow(
	decodeProjectedManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			sent_emails: {
				description: 'A customer notice',
				label: 'subject',
				fields: {
					to: { kind: 'text' },
					subject: { kind: 'text' },
					body: { kind: 'text' },
					status: {
						kind: 'state',
						initial: 'open',
						states: { open: { to: ['closed'] }, closed: { edit: 'none' } }
					},
					sent_at: { kind: 'instant', optional: true },
					delivered_at: { kind: 'instant', optional: true },
					opened_at: { kind: 'instant', optional: true },
					replied_at: { kind: 'instant', optional: true },
					failed_reason: { kind: 'text', optional: true }
				}
			},
			supplier_mail: {
				description: 'A supplier mail',
				label: 'subject',
				key: ['inbox', 'message_id'],
				fields: { message_id: { kind: 'text' }, subject: { kind: 'text' }, files: { kind: 'json' } }
			}
		},
		relationships: {
			'supplier_mail.inbox': {
				to: 'sys_integration',
				where: { integration: { eq: 'mail_import' } }
			}
		},
		exposures: {
			sent_emails: {
				read: { sent_emails: { fields: 'all' } },
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
				read: { supplier_mail: { fields: 'all' } },
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
		connections: {
			customer_mail: { integration: 'customer_notices' },
			desk_wa: { integration: 'whatsapp' },
			slack_a: { integration: 'slack' },
			slack_b: { integration: 'slack' },
			supplier_inbox: { integration: 'mail_import' }
		},
		policies: {
			staff: {
				description: 'Staff',
				grants: { sent_emails: { read: true, create: true, update: true, moves: 'all' } }
			}
		},
		teams: {
			direct: ['staff']
		},
		automations: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
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
	sentAt: '2026-09-25T10:03:00.000Z',
	from: { address: 'Carol@acme.com', name: 'Carol' },
	replyTo: null,
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
	providerId: string;
	message: Json;
	attachments?: Parameters<Drivers['Service']['send']>[2];
};
const recorded: Recorded[] = [];
let sends = 0;
const record: Drivers['Service']['send'] = (instance, message, attachments) =>
	Effect.sync(() => {
		const providerId = `${instance}:${++sends}`;
		recorded.push({
			instance,
			providerId,
			message,
			...(attachments === undefined ? {} : { attachments })
		});
		return { providerId };
	});
let send = record;
const blobs = new Map<string, Uint8Array>();
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
	get: (key) =>
		Effect.suspend(() => {
			const bytes = blobs.get(key);
			return bytes === undefined
				? Port.unavailable('files', `no blob ${key}`)
				: Effect.succeed(bytes);
		}),
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
				TestWorkspace.layer({ manifest, guest: yield* guest, ports })
			);
			return { context, route: yield* routeFixture(context) };
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
			handlers: Object.fromEntries(
				Object.entries(nativeConversations.handlers).map(([name, handler]) => [
					name,
					(...args: Parameters<typeof handler>) => handler(...args).pipe(Effect.provide(context))
				])
			)
		};
		const act = (authority: Authority, callable: string, input: Json) =>
			actReply(route, authority, { callable, input, issuedAt: t.clock.now() }).pipe(
				Effect.map((r) => r.outcome)
			);
		const staffMember = t.member(['staff']);
		const staff = () => t.as(staffMember).authority;
		const notice = () =>
			act(staff(), 'sent_emails.create', [
				{
					to: 'carol@acme.com',
					subject: 'PCN 1234',
					body: 'Your parts change.'
				}
			]).pipe(Effect.map((o) => ok(o).records[0]!.id));
		const row = (id: string) =>
			qReply(route, t.as(t.admin).authority, {
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
				`SELECT m.id, m.integration, m.status, m.attempts, m.error, m.conversation, m.provider_id, o.record
				FROM sys_message m LEFT JOIN sys_outbox o ON o.key = m.meta ->> 'sync_write'
				WHERE m.direction = 'outbound' AND m.status IS NOT NULL AND ${fresh('sys_message', 'm')} ORDER BY m.seq`
			);
		const sent = (instance: string) => recorded.filter((s) => s.instance === instance);
		/** The provider id the native fake answered for this test's n-th send on `instance`. */
		const provider = (instance: string, n = 1) => sent(instance)[n - 1]?.providerId ?? '';
		const deliver = () =>
			t.syncs.deliver().pipe(
				Effect.andThen(outbound.deliver),
				Effect.tap(() => t.syncs.read('sent_emails.sync.mail')),
				Effect.provide(context)
			);
		const report = (
			instance: string,
			providerId: string,
			r: { kind: 'delivered' | 'opened' | 'bounced' | 'deferred'; at: string } & {
				[k: string]: Json;
			}
		) =>
			conversations
				.receive(instance, {
					kind: 'delivery',
					providerId,
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

describe('delivery status (§5.9)', () => {
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
						{ status: 'failed', attempts: 2, error: 'no such user' }
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
							return new Error('socket closed');
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

describe('inbound (§4.3)', () => {
	const chat = (over: { [k: string]: Json } = {}): Json => ({
		id: 'W1',
		thread: '6591234567@s.whatsapp.net',
		sentAt: '2026-09-25T10:00:00.000Z',
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
					expect(rows[0]!['files']).toEqual([
						{
							id: expect.any(String),
							name: 'form.pdf',
							mime: 'application/pdf',
							bytes: bytes.byteLength
						}
					]);
					expect(f.blobs.size).toBe(1);
					expect(new Set(rows.map((r) => r['conversation'])).size).toBe(1);
					yield* t.receive('desk_wa', { id: 'bad' });
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
					yield* t.runDue();
					const rows = () =>
						t.db
							.read([
								{
									text: `SELECT inbox, message_id, subject FROM supplier_mail WHERE message_id = '<pcn-1@onsemi.com>'`,
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
					yield* t.runDue();
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
					).toMatchObject({ code: 'notFound' });
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
						yield* f.act(f.t.as(f.t.admin).authority, 'sys_integration.update', [
							{
								target: 'desk_wa',
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
							chat({ thread, id: 'missing-source', sentAt: '2030-01-01T00:00:00.000Z' }),
							chat({
								thread,
								id: 'invalid-source',
								sentAt: '2030-01-01T00:00:00.000Z',
								sourceAt: 'not an instant'
							}),
							chat({
								thread,
								id: 'old-source',
								sentAt: '2030-01-01T00:00:00.000Z',
								sourceAt: '2026-09-25T09:59:59.999Z'
							}),
							chat({
								thread,
								id: 'new-source',
								sentAt: '1999-01-01T00:00:00.000Z',
								sourceAt: '2026-09-25T10:00:00.001Z'
							}),
							chat({ thread, id: 'equal-source', sourceAt: '2026-09-25T10:00:00.000Z' }),
							chat({
								thread,
								id: 'old-attachment',
								sentAt: '2030-01-01T00:00:00.000Z',
								sourceAt: '2026-09-25T09:59:59.999Z',
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

// last: a fork's activation leaves the store to another epoch
describe('epochs', () => {
	it.live('rows of another epoch (a fork, a restore) are never sent', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					t = f.t;
				f.failing(() => new Error('down'));
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
