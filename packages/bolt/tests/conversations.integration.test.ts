// engine/conversations on PGlite (§4.2 class `message`, §4.3, rule 61, rule 41's exception, G12 (3)): serial-pcn's
// `customer_notices` shape — a `sent_emails` row's create sends its mail through the `customer_mail` connection, delivery
// reports and the customer's reply land on the row after it is closed — plus one-statement inbound keyed by instance
// (dedupe, edits, revokes, files, oversize descriptors, the `messages` feed it queues), personal instances (sync only),
// serial at-least-once delivery, the epoch, `ctx.send`, outbound attachments and connection notices.
import { describe, expect, it, vi } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, Layer, Option, Result, Schema } from 'effect';
import { createHash } from 'node:crypto';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Drivers, Files } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { Activation, Approvals, Conversations, Outbound } from '../src/engine/services.ts';
import { EngineLive } from '../src/engine/host.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { DbError } from '../src/engine/errors.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { uuidv7 } from '../src/protocol/wire.ts';
import { HostIdentity } from '../src/shell/host.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority, Outcome } from '../src/engine/contracts.ts';
import { PgliteDb } from '../src/engine/db/pglite.ts';
import { LIMITS } from '../src/engine/contracts.ts';
import { SendRefused } from '../src/engine/conversations/status.ts';
import { Chain, noticeInsert } from '../src/engine/write/sql.ts';
import { settings } from '../src/shell/settings/data.ts';
import { TestWorkspace, type TestOptions } from '../src/test/index.ts';
import { filesOf } from '../src/engine/conversations/store.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
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
		collections: {
			sent_emails: {
				read: { fields: 'all' },
				create: { input: { columns: ['to', 'subject', 'body'] } },
				update: {
					input: {
						columns: [
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
			supplier_mail: { read: { fields: 'all' } }
		},
		integrations: {
			customer_notices: {
				description: 'Customer notices',
				driver: 'email',
				outbound: { notice: { from: 'sent_emails', via: 'customer_mail' } }
			},
			mail_import: {
				description: 'The supplier inbox',
				driver: 'email',
				feeds: { supplier_mail: { into: 'supplier_mail', key: ['message_id'], from: 'messages' } }
			}
		},
		connections: {
			customer_mail: { integration: 'customer_notices' },
			desk_wa: { integration: 'whatsapp' },
			slack_a: { integration: 'slack' },
			slack_b: { integration: 'slack' },
			supplier_inbox: { integration: 'mail_import' }
		},
		pipelines: {},
		policies: {
			staff: {
				description: 'Staff',
				grants: { sent_emails: { read: true, create: true, update: true, moves: 'all' } }
			},
			clerk: {
				description: 'A clerk proposes notices for a lead to approve',
				grants: {
					sent_emails: {
						read: true,
						approval: { create: [{ match: { requestor: 'in_team' }, steps: [['Leads']] }] }
					}
				}
			}
		},
		teams: {
			Clerks: ['clerk'],
			Leads: ['staff'],
			direct: ['staff'],
			assigned: { name: 'Recipients', policies: ['staff'] },
			child: { name: 'Child', parent: 'assigned', policies: [] },
			'name-only': { name: 'Leads', policies: [] }
		},
		automations: { ping: { description: 'Sends a WhatsApp line', runAs: ['staff'] } },
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);

const guest = program(`export default {
	integration_definition: {
		customer_notices: { bodies: { feeds: {}, outbound: { notice: {
			build: (record) => record.to === 'nobody' ? null : ({ to: [record.to], subject: record.subject, text: record.body, thread: record.id }),
			events: {
				sent: (e) => ({ sent_at: e.at }), delivered: (e) => ({ delivered_at: e.at }), opened: (e) => ({ opened_at: e.at }),
				bounced: (e) => ({ failed_reason: e.reason }), failed: (e) => ({ failed_reason: e.reason }), replied: (e) => ({ replied_at: e.at }),
				deferred: (e) => ({ failed_reason: 'deferred ' + (e.code ?? '') }), auto_replied: (e) => ({ failed_reason: 'auto: ' + e.reply.subject }),
			},
		} } } },
		mail_import: { bodies: { feeds: { supplier_mail: { map: function* (mails) { return mails.map((m) => m.deleted ? { delete: { message_id: m.id } }
			: { upsert: { message_id: m.id, subject: m.subject, files: m.attachments } }); } } }, outbound: {} } },
	},
	automation: { ping: { body: function* (input, ctx) { return yield* ctx.send('desk_wa', { to: '6591234567@s.whatsapp.net', text: 'hello from a run' }); } } },
};`);

const ok = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
/** The provider id the native fake answered for its n-th send. */
const provider = (instance: string, n = 1) => `${instance}:${n}`;
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
const fixture = (options: Extract<TestOptions<Drivers | Files>, { artifact?: never }> = {}) =>
	Effect.gen(function* () {
		const recorded: {
			instance: string;
			message: Json;
			attachments?: Parameters<Drivers['Service']['send']>[2];
		}[] = [];
		const record: Drivers['Service']['send'] = (instance, message, attachments) =>
			Effect.sync(() => {
				recorded.push({ instance, message, ...(attachments === undefined ? {} : { attachments }) });
				return { providerId: `${instance}:${recorded.length}` };
			});
		let send = record,
			fileDelay = 0;
		const blobs = new Map<string, Uint8Array>();
		const files: Files['Service'] = {
			put: (bytes, meta) =>
				Effect.sleep(fileDelay).pipe(
					Effect.andThen(
						Effect.sync(() => {
							const key = crypto.randomUUID();
							blobs.set(key, bytes);
							return {
								key,
								bytes: bytes.byteLength,
								sha256: createHash('sha256').update(bytes).digest('hex'),
								mime: meta.mime
							};
						})
					)
				),
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
				})
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
		const context = yield* Layer.build(
			TestWorkspace.layer({ manifest, guest: yield* guest, ...options, ports })
		);
		const t = Context.get(context, TestWorkspace),
			nativeConversations = Context.get(context, Conversations),
			outbound = Context.get(context, Outbound),
			approvals = Context.get(context, Approvals);
		const conversations: Conversations['Service'] = {
			...nativeConversations,
			send: (...args) => nativeConversations.send(...args).pipe(Effect.provide(context)),
			receive: (...args) => nativeConversations.receive(...args).pipe(Effect.provide(context)),
			webhook: (...args) => nativeConversations.webhook(...args).pipe(Effect.provide(context)),
			handlers: Object.fromEntries(
				Object.entries(nativeConversations.handlers).map(([name, handler]) => [
					name,
					(...args: Parameters<typeof handler>) => handler(...args).pipe(Effect.provide(context))
				])
			)
		};
		const route = yield* routeFixture(context);
		const act = (authority: Authority, callable: string, input: Json) =>
			actReply(route, authority, { callable, input, issuedAt: t.clock.now() }).pipe(
				Effect.map((r) => r.outcome)
			);
		const staffMember = t.member(['staff']);
		const staff = () => t.as(staffMember).authority;
		t.as(t.admin);
		yield* t.db.read([]);
		const notice = () =>
			act(staff(), 'sent_emails.create', {
				to: 'carol@acme.com',
				subject: 'PCN 1234',
				body: 'Your parts change.'
			}).pipe(Effect.map((o) => ok(o).records[0]!.id));
		const row = (id: string) =>
			qReply(route, t.as(t.admin).authority, {
				reads: [{ m: 'get', a: ['sent_emails', id, {}] }]
			}).pipe(
				Effect.flatMap((r) =>
					Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(r.answers[0])
				)
			);
		const rows = (text: string) =>
			t.db.read([{ text, params: [] }]).pipe(Effect.map((r) => r[0]?.rows ?? []));
		const outbox = () =>
			rows(
				`SELECT id, integration, status, attempts, error, conversation, provider_id, record FROM sys_message WHERE direction = 'outbound' AND status IS NOT NULL ORDER BY seq`
			);
		const sent = (instance: string) => recorded.filter((s) => s.instance === instance);
		const deliver = () => outbound.deliver.pipe(Effect.provide(context));
		const report = (
			instance: string,
			providerId: string,
			r: { kind: 'delivered' | 'opened' | 'bounced' | 'deferred'; at: string } & {
				[k: string]: Json;
			}
		) =>
			conversations.receive(instance, {
				kind: 'delivery',
				providerId,
				report: { provider: 'fake', ...r }
			});
		const timeline = () =>
			rows(
				`SELECT status, delivery FROM sys_message WHERE direction = 'outbound' ORDER BY seq`
			).pipe(
				Effect.map((r) => {
					const first = r[0];
					if (first === undefined) throw new Error('no timeline');
					return first;
				})
			);
		const reply = (id: string, headers: { [k: string]: string }, subject: string) =>
			t.receive(
				'customer_mail',
				mail({
					id,
					sentAt: '2026-09-25T11:00:00.000Z',
					subject,
					text: 'x',
					headers: { 'in-reply-to': provider('customer_mail'), ...headers }
				})
			);
		const history = () =>
			rows(
				`SELECT integration, provider_id, text, deleted_at IS NOT NULL AS deleted, ${filesOf('m')} AS files, conversation, origin FROM sys_message m WHERE direction = 'inbound' ORDER BY seq`
			);
		const personal = () =>
			Effect.gen(function* () {
				const alice = t.member([], { email: 'alice@ws.example' });
				return ok(
					yield* act(t.as(t.admin).authority, 'sys_integration.create', {
						integration: 'whatsapp',
						name: "Alice's phone",
						owner: alice.id
					})
				).records[0]!.id;
			});
		const stored = (id: string, name: string, bytes: Uint8Array, size = bytes.byteLength) =>
			Effect.gen(function* () {
				const blob = yield* files.put(bytes, { name, mime: 'application/pdf' });
				yield* t.db.write({
					text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at) VALUES ($1, $2, 'application/pdf', $3, $4, '', 'x.file', now())`,
					params: [id, name, size, blob.key]
				});
				return { id, name, mime: 'application/pdf' };
			});
		return {
			t,
			context,
			route,
			conversations,
			outbound,
			approvals,
			recorded,
			record,
			files,
			blobs,
			act,
			staff,
			notice,
			row,
			rows,
			outbox,
			sent,
			deliver,
			report,
			timeline,
			reply,
			history,
			personal,
			stored,
			setSend: (value: Drivers['Service']['send']) => {
				send = value;
			},
			delayFiles: (ms: number) => {
				fileDelay = ms;
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

describe('record-driven outbound to a conversation (G12 (3))', () => {
	it.live(
		'a build that answers null sends nothing for that row: skipped, not failed, and the row is not patched',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const id = ok(
						yield* f.act(f.staff(), 'sent_emails.create', { to: 'nobody', subject: 'x', body: 'y' })
					).records[0]!.id;
					yield* f.deliver();
					expect(f.sent('customer_mail')).toHaveLength(0);
					expect(yield* f.outbox()).toMatchObject([
						{ status: 'skipped', error: expect.stringContaining('sends nothing') }
					]);
					expect(yield* f.row(id)).toMatchObject({ failed_reason: null, sent_at: null });
					// the instance's day in Settings counts it on its own, neutral: never a failure, never the last error
					const s = yield* settings(
						Context.get(f.context, HostIdentity),
						t.manifest,
						t.as(t.admin).authority
					);
					expect(s.instances.find((i) => i.id === 'customer_mail')?.delivery).toMatchObject({
						failed: 0,
						skipped: 1,
						lastError: null
					});
				})
			)
	);

	it.live("a notice row's create queues its mail and the delivery run in the same statement", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					t = f.t;
				t.count.reset();
				const id = yield* f.notice();
				expect(t.count.writes).toBe(1);
				expect(yield* f.outbox()).toMatchObject([
					{
						integration: 'customer_mail',
						status: 'queued',
						record: { collection: 'sent_emails', id }
					}
				]);
				const [runs] = yield* t.db.read([
					{
						text: `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'integrations.deliver' AND state = 'queued'`,
						params: []
					}
				]);
				expect(runs!.rows[0]!['n']).toBe(1);
				expect(t.fakes.deadlines.announced.length).toBeGreaterThan(0);
			})
		)
	);

	it.live(
		'the delivery run builds the message from the committed row and sends it once; `sent` lands on the row',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const id = yield* f.notice();
					yield* t.runDue();
					expect(f.sent('customer_mail')).toMatchObject([
						{
							message: {
								to: ['carol@acme.com'],
								subject: 'PCN 1234',
								text: 'Your parts change.',
								thread: id
							}
						}
					]);
					expect((yield* f.row(id))['sent_at']).not.toBeNull();
					yield* t.runDue();
					yield* f.deliver();
					expect(f.sent('customer_mail')).toHaveLength(1);
				})
			)
	);

	it.live(
		"delivered, opened and the customer's reply land on the row after it is closed: per-state edit never refuses them (rule 41)",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const id = yield* f.notice();
					yield* t.runDue();
					ok(
						yield* f.act(f.staff(), 'sent_emails.update', { target: id, set: { status: 'closed' } })
					);
					expect(
						yield* f.act(f.staff(), 'sent_emails.update', {
							target: id,
							set: { failed_reason: 'x' }
						})
					).toMatchObject({ kind: 'refused', code: 'locked' });
					const pid = provider('customer_mail');
					yield* f.report('customer_mail', pid, {
						kind: 'delivered',
						at: '2026-09-25T10:01:00.000Z'
					});
					yield* f.report('customer_mail', pid, {
						kind: 'opened',
						at: '2026-09-25T10:02:00.000Z',
						approximate: true
					});
					yield* t.receive(
						'customer_mail',
						mail({ id: '<reply-1@acme.com>', headers: { 'in-reply-to': pid } })
					);
					expect(yield* f.row(id)).toMatchObject({
						status: 'closed',
						delivered_at: '2026-09-25T10:01:00.000Z',
						opened_at: '2026-09-25T10:02:00.000Z',
						replied_at: '2026-09-25T10:03:00.000Z'
					});
				})
			)
	);

	it.live(
		'a reply whose match failed after it was stored is matched on its redelivery, and only once',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const storage = yield* Layer.build(PgliteDb.layer()),
						inner = Context.get(storage, TenantDb);
					let down = false;
					const db = TenantDb.typed({
						read: inner.read,
						transaction: inner.transaction,
						write: (statement, lock) =>
							Effect.suspend(() => {
								if (
									down &&
									statement.text.includes('WITH cur AS (SELECT id, status FROM sys_message')
								) {
									down = false;
									return Effect.fail(DbError.make('08006', 'the database went away'));
								}
								return inner.write(statement, lock);
							})
					});
					const f = yield* fixture({ db: Layer.succeed(TenantDb, db) }),
						t = f.t;
					const id = yield* f.notice();
					yield* t.runDue();
					const answer = mail({
						id: '<reply-1@acme.com>',
						headers: { 'in-reply-to': provider('customer_mail') }
					});
					down = true;
					expect((yield* Effect.flip(t.receive('customer_mail', answer))).message).toMatch(
						/went away/
					);
					expect((yield* f.row(id))['replied_at']).toBeNull();
					// unacknowledged, so the provider delivers it again
					yield* t.receive('customer_mail', answer);
					expect((yield* f.row(id))['replied_at']).toEqual('2026-09-25T10:03:00.000Z');
					yield* t.receive('customer_mail', answer);
					const [out] = (yield* t.db.read([
						{
							text: `SELECT status, delivery FROM sys_message WHERE direction = 'outbound'`,
							params: []
						}
					]))[0]!.rows;
					expect(out!['status']).toBe('replied');
					expect(
						Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ kind: Schema.String })))(
							out!['delivery']
						).filter((e) => e.kind === 'replied')
					).toHaveLength(1);
				})
			)
	);

	it.live(
		'a send the link refuses is retried with backoff and, after 8 attempts, fails on the row',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					f.failing(() => new Error('provider down'));
					const id = yield* f.notice();
					for (let i = 0; i < 8; i++) {
						yield* f.deliver();
						t.clock.advance('10min');
					}
					expect(yield* f.outbox()).toMatchObject([
						{ status: 'failed', attempts: 8, error: 'provider down' }
					]);
					expect((yield* f.row(id))['failed_reason']).toBe('provider down');
					expect(f.sent('customer_mail')).toHaveLength(0);
				})
			)
	);

	it.live("a bounce reported later marks the row failed with the provider's reason", () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					t = f.t;
				const id = yield* f.notice();
				yield* t.runDue();
				yield* f.report('customer_mail', provider('customer_mail'), {
					kind: 'bounced',
					at: '2026-09-25T10:05:00.000Z',
					code: '552 5.2.2',
					reason: 'mailbox full',
					permanent: true
				});
				expect((yield* f.row(id))['failed_reason']).toBe('mailbox full');
				expect(yield* f.outbox()).toMatchObject([{ status: 'bounced', error: 'mailbox full' }]);
			})
		)
	);
});

describe('delivery status (§5.9)', () => {
	it.live(
		'every report lands on the timeline; a bounce is terminal: a later delivered neither moves the status nor maps; a redelivery is recorded once',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const id = yield* f.notice();
					yield* t.runDue();
					const bounce = {
						kind: 'bounced' as const,
						at: '2026-09-25T10:05:00.000Z',
						code: '550 5.1.1',
						reason: 'no such user',
						permanent: true
					};
					yield* f.report('customer_mail', provider('customer_mail'), bounce);
					yield* f.report('customer_mail', provider('customer_mail'), bounce);
					yield* f.report('customer_mail', provider('customer_mail'), {
						kind: 'delivered',
						at: '2026-09-25T10:06:00.000Z'
					});
					const got = yield* f.timeline();
					expect(got['status']).toBe('bounced');
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

	it.live('status only advances: deferred after delivered is recorded, not applied', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					t = f.t;
				yield* f.notice();
				yield* t.runDue();
				yield* f.report('customer_mail', provider('customer_mail'), {
					kind: 'delivered',
					at: '2026-09-25T10:05:00.000Z'
				});
				yield* f.report('customer_mail', provider('customer_mail'), {
					kind: 'deferred',
					at: '2026-09-25T10:06:00.000Z',
					code: '451 4.7.1'
				});
				expect((yield* f.timeline())['status']).toBe('delivered');
			})
		)
	);

	it.live(
		"an auto-reply is recorded and mapped as auto_replied, never as the customer's reply; a person's reply then is",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const id = yield* f.notice();
					yield* t.runDue();
					yield* f.reply(
						'<ooo@acme.com>',
						{ 'auto-submitted': 'auto-replied' },
						'Automatic reply: PCN 1234'
					);
					expect(yield* f.timeline()).toMatchObject({ status: 'sent' });
					expect(yield* f.row(id)).toMatchObject({
						replied_at: null,
						failed_reason: 'auto: Automatic reply: PCN 1234'
					});
					yield* f.reply('<human@acme.com>', {}, 'Re: PCN 1234');
					const got = yield* f.timeline();
					expect(got['status']).toBe('replied');
					expect(
						Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ kind: Schema.String })))(
							got['delivery']
						).map((e) => e.kind)
					).toEqual(['queued', 'sent', 'auto_replied', 'replied']);
					expect((yield* f.row(id))['replied_at']).toEqual('2026-09-25T11:00:00.000Z');
				})
			)
	);

	it.live('a quiet window without a report presumes the mail delivered, once', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					t = f.t;
				f.setSend((instance, message, attachments) =>
					f
						.record(instance, message, attachments)
						.pipe(Effect.map((answer) => ({ ...answer, presumeAfterMs: 86_400_000 })))
				);
				const id = yield* f.notice();
				yield* t.runDue();
				t.clock.advance('23h');
				yield* f.deliver();
				expect((yield* f.timeline())['status']).toBe('sent');
				t.clock.advance('2h');
				yield* f.deliver();
				const got = yield* f.timeline();
				expect(got['status']).toBe('delivered');
				expect(
					Schema.decodeUnknownSync(Schema.Array(Schema.Json))(got['delivery']).at(-1)
				).toMatchObject({ kind: 'delivered', presumed: true, provider: 'bolt' });
				expect((yield* f.row(id))['delivered_at']).not.toBeNull();
				const [due] = yield* t.db.read([
					{
						text: `SELECT count(*)::int AS n FROM sys_message WHERE presume_at IS NOT NULL`,
						params: []
					}
				]);
				expect(due!.rows[0]!['n']).toBe(0);
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

describe('a proposed notice awaiting approval (rules 47, 61)', () => {
	it.live('is never sent when the request is rejected', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					t = f.t;
				const member = (team: 'Clerks' | 'Leads') =>
					Effect.gen(function* () {
						const email = `${team}-${crypto.randomUUID()}@approval.test`,
							user = t.member([], { email });
						yield* t.db.write({
							text: 'UPDATE sys_user SET team = $1 WHERE id = $2',
							params: [team, user.id]
						});
						return yield* t.signIn(email);
					});
				const o = yield* f.act(t.as(yield* member('Clerks')).authority, 'sent_emails.create', {
					to: 'carol@acme.com',
					subject: 'PCN 1234',
					body: 'Your parts change.'
				});
				if (o.kind !== 'pendingApproval') throw new Error(JSON.stringify(o));
				expect(
					yield* f.approvals
						.process({
							requestId: o.requestId,
							status: 'REJECTED',
							reason: 'no',
							authority: yield* member('Leads'),
							now: t.clock.now()
						})
						.pipe(Effect.provide(f.context))
				).toMatchObject({ kind: 'decided', status: 'REJECTED' });
				yield* t.runDue();
				yield* f.deliver();
				expect(f.sent('customer_mail')).toHaveLength(0);
				expect(yield* f.outbox()).toEqual([]);
			})
		)
	);
});

describe('delivery order and epochs', () => {
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

	it.live('rows of another epoch (a fork, a restore) are never sent', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					t = f.t;
				f.failing(() => new Error('down'));
				yield* f.notice();
				yield* f.deliver();
				f.setSend(f.record);
				const forkContext = yield* Layer.build(
					EngineLive(manifest).pipe(
						Layer.provide(
							Layer.mergeAll(
								NodeCrypto.layer,
								Layer.succeedContext(f.context),
								Layer.succeed(Activation, {
									scope: 'test',
									epoch: 'fork-1',
									release: 'test',
									publicUrl: 'http://localhost',
									guest: Option.some(yield* guest),
									transforms: new Set<string>(),
									projections: new Set<string>(),
									start: [],
									secretsKey: Option.none()
								})
							)
						)
					)
				);
				const forked = Context.get(forkContext, Outbound);
				yield* forked.activate.pipe(Effect.provide(Context.merge(f.context, forkContext)));
				t.clock.advance('1h');
				yield* forked.deliver.pipe(Effect.provide(Context.merge(f.context, forkContext)));
				expect(f.sent('customer_mail')).toHaveLength(0);
				expect(yield* f.outbox()).toMatchObject([{ status: 'skipped' }]);
				const forkRoute = yield* routeFixture(Context.merge(f.context, forkContext));
				ok(
					(yield* actReply(forkRoute, f.staff(), {
						callable: 'sent_emails.create',
						input: { to: 'carol@acme.com', subject: 'PCN 1234', body: 'Your parts change.' },
						issuedAt: t.clock.now()
					})).outcome
				);
				yield* forked.deliver.pipe(Effect.provide(Context.merge(f.context, forkContext)));
				expect(f.sent('customer_mail')).toHaveLength(1);
			})
		)
	);

	it.live(
		'ctx.send from an automation queues one journalled message row on the connection that the delivery run sends',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					ok(
						yield* f.act(t.as(t.admin).authority, 'start', {
							automation: 'ping',
							input: {},
							id: uuidv7(Date.parse(t.clock.now()))
						})
					);
					yield* t.runDue();
					yield* t.runDue();
					expect(f.sent('desk_wa').map((s) => s.message)).toMatchObject([
						{ to: '6591234567@s.whatsapp.net', text: 'hello from a run' }
					]);
					expect((yield* f.outbox()).map((r) => r['integration'])).toEqual(['desk_wa']);
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
	it.live('an import cutoff uses only provider source time, including the boundary itself', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				ok(
					yield* f.act(f.t.as(f.t.admin).authority, 'sys_integration.update', {
						target: 'desk_wa',
						set: {
							import_start: {
								kind: 'since',
								at: '2026-09-25T10:00:00.000Z',
								zone: 'UTC',
								origin: 'date'
							}
						}
					})
				);
				yield* f.conversations.receive('desk_wa', {
					kind: 'messages',
					messages: [
						chat({ id: 'missing-source', sentAt: '2030-01-01T00:00:00.000Z' }),
						chat({
							id: 'invalid-source',
							sentAt: '2030-01-01T00:00:00.000Z',
							sourceAt: 'not an instant'
						}),
						chat({
							id: 'old-source',
							sentAt: '2030-01-01T00:00:00.000Z',
							sourceAt: '2026-09-25T09:59:59.999Z'
						}),
						chat({
							id: 'new-source',
							sentAt: '1999-01-01T00:00:00.000Z',
							sourceAt: '2026-09-25T10:00:00.001Z'
						}),
						chat({ id: 'equal-source', sourceAt: '2026-09-25T10:00:00.000Z' })
					]
				});
				expect((yield* f.history()).map((row) => row['provider_id'])).toEqual([
					'new-source',
					'equal-source'
				]);
				expect(
					yield* f.rows(
						`SELECT provider_id, (extract(epoch FROM source_at) * 1000)::double precision AS source_ms
						FROM sys_message WHERE integration = 'desk_wa' ORDER BY seq`
					)
				).toEqual([
					{ provider_id: 'new-source', source_ms: Date.parse('2026-09-25T10:00:00.001Z') },
					{ provider_id: 'equal-source', source_ms: Date.parse('2026-09-25T10:00:00.000Z') }
				]);
			})
		)
	);

	it.live('an old source attachment is rejected before its bytes reach file storage', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				ok(
					yield* f.act(f.t.as(f.t.admin).authority, 'sys_integration.update', {
						target: 'desk_wa',
						set: {
							import_start: {
								kind: 'since',
								at: '2026-09-25T10:00:00.000Z',
								zone: 'UTC',
								origin: 'date'
							}
						}
					})
				);
				const put = vi.spyOn(f.files, 'put'),
					bytes = new TextEncoder().encode('%PDF-1.7');
				yield* f.conversations.receive('desk_wa', {
					kind: 'messages',
					messages: [
						chat({
							sentAt: '2030-01-01T00:00:00.000Z',
							sourceAt: '2026-09-25T09:59:59.999Z',
							attachments: [
								{ name: 'old.pdf', mime: 'application/pdf', bytes: bytes.byteLength, bin: 0 }
							]
						})
					],
					bins: [bytes]
				});
				expect(put).not.toHaveBeenCalled();
				expect(f.blobs.size).toBe(0);
				expect(yield* f.history()).toEqual([]);
				expect(yield* f.rows('SELECT id FROM sys_file')).toEqual([]);
			})
		)
	);

	it.live('a sparse revoke needs an eligible source time on the same instance', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture();
				yield* f.conversations.receive('desk_wa', {
					kind: 'messages',
					messages: [
						chat({ id: 'eligible-revoke', sourceAt: '2026-09-25T10:00:00.000Z' }),
						chat({ id: 'old-revoke', sourceAt: '2026-09-25T09:59:59.999Z' }),
						chat({ id: 'uncertified-revoke' })
					]
				});
				yield* f.conversations.receive('slack_a', {
					kind: 'messages',
					messages: [chat({ id: 'other-instance-proof', sourceAt: '2026-09-25T11:00:00.000Z' })]
				});
				for (const target of ['desk_wa', 'slack_b'])
					ok(
						yield* f.act(f.t.as(f.t.admin).authority, 'sys_integration.update', {
							target,
							set: {
								import_start: {
									kind: 'since',
									at: '2026-09-25T10:00:00.000Z',
									zone: 'UTC',
									origin: 'date'
								}
							}
						})
					);
				yield* f.conversations.receive('desk_wa', {
					kind: 'messages',
					messages: [
						{ id: 'eligible-revoke', deleted: true },
						{ id: 'old-revoke', deleted: true },
						{ id: 'uncertified-revoke', deleted: true },
						{ id: 'unknown-revoke', deleted: true }
					]
				});
				yield* f.conversations.receive('slack_b', {
					kind: 'messages',
					messages: [{ id: 'other-instance-proof', deleted: true }]
				});
				expect(yield* f.history()).toMatchObject([
					{ integration: 'desk_wa', provider_id: 'eligible-revoke', text: '', deleted: true },
					{ integration: 'desk_wa', provider_id: 'old-revoke', text: 'first', deleted: false },
					{
						integration: 'desk_wa',
						provider_id: 'uncertified-revoke',
						text: 'first',
						deleted: false
					},
					{
						integration: 'slack_a',
						provider_id: 'other-instance-proof',
						text: 'first',
						deleted: false
					}
				]);
				expect(yield* f.history()).toHaveLength(4);
				expect(
					yield* f.rows(`SELECT source_at = '2026-09-25T10:00:00.000Z'::timestamptz AS preserved
						FROM sys_message WHERE integration = 'desk_wa' AND provider_id = 'eligible-revoke'`)
				).toEqual([{ preserved: true }]);
			})
		)
	);

	it.live(
		'saving a cutoff waits for an attachment ingest already admitted under the old boundary',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						entered = yield* Deferred.make<void>(),
						release = yield* Deferred.make<void>(),
						saveStarted = yield* Deferred.make<void>(),
						bytes = new TextEncoder().encode('%PDF-1.7'),
						originalPut = f.files.put,
						boundary = {
							kind: 'since',
							at: '2026-09-25T11:00:00.000Z',
							zone: 'UTC',
							origin: 'date'
						} as const;
					ok(
						yield* f.act(f.t.as(f.t.admin).authority, 'sys_integration.update', {
							target: 'desk_wa',
							set: { import_start: { kind: 'all' } }
						})
					);
					const put = vi.spyOn(f.files, 'put').mockImplementation((data, metadata) =>
						Effect.gen(function* () {
							yield* Deferred.succeed(entered, undefined);
							yield* Deferred.await(release);
							return yield* originalPut(data, metadata);
						})
					);
					const ingest = yield* f.conversations
						.receive('desk_wa', {
							kind: 'messages',
							messages: [
								chat({
									id: 'before-cutoff',
									sourceAt: '2026-09-25T10:00:00.000Z',
									attachments: [
										{ name: 'first.pdf', mime: 'application/pdf', bytes: bytes.byteLength, bin: 0 }
									]
								})
							],
							bins: [bytes]
						})
						.pipe(Effect.forkChild);
					yield* Deferred.await(entered);
					let saved = false;
					const save = yield* Effect.gen(function* () {
						yield* Deferred.succeed(saveStarted, undefined);
						const result = yield* f.act(f.t.as(f.t.admin).authority, 'sys_integration.update', {
							target: 'desk_wa',
							set: { import_start: boundary }
						});
						saved = true;
						return result;
					}).pipe(Effect.forkChild);
					yield* Deferred.await(saveStarted);
					yield* Effect.sleep('20 millis');
					expect(saved).toBe(false);
					yield* Deferred.succeed(release, undefined);
					yield* Fiber.join(ingest);
					ok(yield* Fiber.join(save));
					expect(saved).toBe(true);
					expect(
						yield* f.rows("SELECT import_start FROM sys_integration WHERE id = 'desk_wa'")
					).toEqual([{ import_start: boundary }]);
					const before = yield* f.history();
					expect(before).toMatchObject([
						{ provider_id: 'before-cutoff', text: 'first', files: [{ name: 'first.pdf' }] }
					]);
					expect(before).toHaveLength(1);
					yield* f.conversations.receive('desk_wa', {
						kind: 'messages',
						messages: [
							chat({
								id: 'after-cutoff',
								sentAt: '2030-01-01T00:00:00.000Z',
								sourceAt: '2026-09-25T10:00:00.000Z',
								attachments: [
									{ name: 'old.pdf', mime: 'application/pdf', bytes: bytes.byteLength, bin: 0 }
								]
							})
						],
						bins: [bytes]
					});
					expect(yield* f.history()).toEqual(before);
					expect(put).toHaveBeenCalledTimes(1);
					expect(f.blobs.size).toBe(1);
				})
			)
	);

	it.live(
		'a same-version replay fills missing source time without rewriting or requeuing the message',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						bytes = new TextEncoder().encode('%PDF-1.7'),
						version = '2026-09-25T10:03:00.000Z',
						id = '<source-repair@acme.com>';
					yield* f.conversations.receive('supplier_inbox', {
						kind: 'messages',
						messages: [
							mail({
								id,
								version,
								attachments: [
									{ name: 'original.pdf', mime: 'application/pdf', bytes: bytes.byteLength, bin: 0 }
								]
							})
						],
						bins: [bytes]
					});
					ok(
						yield* f.act(f.t.as(f.t.admin).authority, 'sys_integration.update', {
							target: 'supplier_inbox',
							set: {
								import_start: {
									kind: 'since',
									at: '2026-09-25T10:00:00.000Z',
									zone: 'UTC',
									origin: 'date'
								}
							}
						})
					);
					const messageSql = `SELECT id, seq, conversation, text, version, sender, sender_name, sent_at,
					email, ${filesOf('m')} AS files, edited_at, created_at FROM sys_message m WHERE integration = 'supplier_inbox'`,
						runsSql = `SELECT id, automation, state, input, key FROM sys_run
						WHERE automation = 'mail_import.supplier_mail' ORDER BY id`,
						before = yield* f.rows(messageSql),
						runs = yield* f.rows(runsSql),
						put = vi.spyOn(f.files, 'put');
					expect(before).toHaveLength(1);
					expect(runs).toHaveLength(1);
					expect(
						yield* f.rows("SELECT source_at FROM sys_message WHERE integration = 'supplier_inbox'")
					).toEqual([{ source_at: null }]);
					const replay = mail({
						id,
						version,
						sentAt: '2030-01-01T00:00:00.000Z',
						sourceAt: '2026-09-25T10:03:00.000Z',
						subject: 'This must not replace the original',
						text: 'This must not replace the original',
						attachments: [
							{ name: 'changed.pdf', mime: 'application/pdf', bytes: bytes.byteLength, bin: 0 }
						]
					});
					yield* f.conversations.receive('supplier_inbox', {
						kind: 'messages',
						messages: [replay, replay],
						bins: [bytes]
					});
					expect(yield* f.rows(messageSql)).toEqual(before);
					expect(yield* f.rows(runsSql)).toEqual(runs);
					expect(
						yield* f.rows(`SELECT source_at = '2026-09-25T10:03:00.000Z'::timestamptz AS repaired
						FROM sys_message WHERE integration = 'supplier_inbox'`)
					).toEqual([{ repaired: true }]);
					expect(put).not.toHaveBeenCalled();
					expect(f.blobs.size).toBe(1);
				})
			)
	);

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
		'a cleared chat tombstones its rows up to the clear in one statement; an admitted row keeps its transcript',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					yield* t.receive('desk_wa', [
						chat({ id: 'C1' }),
						chat({ id: 'C2', sentAt: '2026-09-25T10:05:00.000Z' }),
						chat({ id: 'C3', sentAt: '2026-09-25T10:10:00.000Z' }),
						chat({ id: 'O1', thread: '6590000000@s.whatsapp.net' })
					]);
					yield* t.db.write({
						text: `UPDATE sys_message SET role = 'user' WHERE provider_id = 'C2'`,
						params: []
					});
					yield* f.conversations.receive('desk_wa', {
						kind: 'clear',
						thread: '6591234567@s.whatsapp.net',
						before: '2026-09-25T10:05:00.000Z'
					});
					expect(yield* f.history()).toMatchObject([
						{ provider_id: 'C1', text: '', deleted: true },
						{ provider_id: 'C2', text: 'first', deleted: true },
						{ provider_id: 'C3', text: 'first', deleted: false },
						{ provider_id: 'O1', text: 'first', deleted: false }
					]);
				})
			)
	);

	it.live('the same provider id on two instances is two rows in two conversations', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const f = yield* fixture(),
					t = f.t;
				const slack = (id: string) => ({
					id,
					thread: 'C1',
					sentAt: '2026-09-25T10:00:00.000Z',
					from: { handle: 'U1', name: 'Ana' },
					text: 'hello'
				});
				yield* t.receive('slack_a', slack('1700.1'));
				yield* t.receive('slack_b', slack('1700.1'));
				const rows = yield* f.history();
				expect(rows.map((r) => r['integration'])).toEqual(['slack_a', 'slack_b']);
				expect(new Set(rows.map((r) => r['conversation'])).size).toBe(2);
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
					const bytes = new TextEncoder().encode('%PDF-1.7');
					yield* t.receive(
						'desk_wa',
						chat({
							attachments: [
								{ name: 'form.pdf', mime: 'application/pdf', bytes: bytes.byteLength, bin: 0 }
							]
						}),
						{ bins: [bytes] }
					);
					yield* t.receive('desk_wa', chat({ id: 'W2', text: 'second' }));
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
		'a file over what a row stores, or not the length it claims, stays a named descriptor: the message lands, nothing is stored, nothing fails',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const big = new Uint8Array(LIMITS.storedFileBytes + 1),
						short = new Uint8Array(3);
					yield* t.receive(
						'desk_wa',
						chat({
							text: 'the video',
							attachments: [
								{ name: 'site.mp4', mime: 'video/mp4', bytes: big.byteLength, bin: 0 },
								{ name: 'note.txt', mime: 'text/plain', bytes: 9, bin: 1 }
							]
						}),
						{ bins: [big, short] }
					);
					expect((yield* f.history()).map((r) => [r['text'], r['files']])).toEqual([
						[
							'the video',
							[
								{ name: 'site.mp4', mime: 'video/mp4', bytes: big.byteLength },
								{ name: 'note.txt', mime: 'text/plain', bytes: 9 }
							]
						]
					]);
					expect(f.blobs.size).toBe(0);
				})
			)
	);

	it.live(
		'a large file whose asynchronous store finishes inside its idle deadline is stored, and its message and the next one land',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const video = new Uint8Array(LIMITS.storedFileBytes);
					f.delayFiles(LIMITS.callMs.attachment / 4);
					yield* t.receive(
						'desk_wa',
						chat({
							text: 'the site',
							attachments: [
								{ name: 'site.mp4', mime: 'video/mp4', bytes: video.byteLength, bin: 0 }
							]
						}),
						{ bins: [video] }
					);
					f.delayFiles(0);
					yield* t.receive('desk_wa', chat({ id: 'W2', text: 'and then' }));
					expect(yield* f.history()).toMatchObject([
						{
							text: 'the site',
							files: [
								{
									id: expect.any(String),
									name: 'site.mp4',
									mime: 'video/mp4',
									bytes: video.byteLength
								}
							]
						},
						{ text: 'and then' }
					]);
					expect([...f.blobs.values()].map((b) => b.byteLength)).toEqual([video.byteLength]);
				})
			),
		30_000
	);

	it.live(
		'a messages feed is queued in the ingest statement: one run per message version, none for a redelivery, and the run maps it',
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
					t.count.reset();
					yield* f.conversations.receive('supplier_inbox', { kind: 'messages', messages: [pcn()] });
					expect(t.count.writes).toBe(1);
					yield* f.conversations.receive('supplier_inbox', { kind: 'messages', messages: [pcn()] });
					const runs = () =>
						t.db
							.read([
								{
									text: `SELECT automation, state, input FROM sys_run WHERE automation = 'mail_import.supplier_mail' ORDER BY due_at, id`,
									params: []
								}
							])
							.pipe(Effect.map((r) => r[0]?.rows ?? []));
					expect(yield* runs()).toMatchObject([
						{ state: 'queued', input: { instance: 'supplier_inbox' } }
					]);
					yield* t.runDue();
					const rows = () =>
						t.db
							.read([{ text: `SELECT inbox, message_id, subject FROM supplier_mail`, params: [] }])
							.pipe(Effect.map((r) => r[0]?.rows ?? []));
					expect(yield* rows()).toEqual([
						{ inbox: 'supplier_inbox', message_id: '<pcn-1@onsemi.com>', subject: 'PCN 1234' }
					]);
					yield* t.receive(
						'supplier_inbox',
						pcn({ subject: 'PCN 1234 rev B', version: '2026-09-25T10:04:00.000Z' })
					);
					expect(yield* runs()).toHaveLength(2);
					expect(yield* rows()).toEqual([
						{ inbox: 'supplier_inbox', message_id: '<pcn-1@onsemi.com>', subject: 'PCN 1234 rev B' }
					]);
					// an envoy-less instance queues no admission
					expect(
						(yield* t.db.read([
							{
								text: `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'envoys.admit'`,
								params: []
							}
						]))[0]!.rows[0]!['n']
					).toBe(0);
				})
			)
	);

	it.live(
		'a messages feed maps each attachment as its message stores it: { id, name, mime, bytes }, no id when its bytes never arrived',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const pdf = new TextEncoder().encode('%PDF-1.7');
					yield* t.receive(
						'supplier_inbox',
						mail({
							id: '<pcn-3@onsemi.com>',
							from: { address: 'pcn@onsemi.com', name: null },
							subject: 'PCN 3',
							attachments: [
								{ name: 'pcn.pdf', mime: 'application/pdf', bytes: pdf.byteLength, bin: 0 },
								{ name: 'site.mp4', mime: 'video/mp4', bytes: 9 }
							]
						}),
						{ bins: [pdf] }
					);
					yield* t.runDue();
					const [row] = (yield* t.db.read([
						{ text: `SELECT files FROM supplier_mail`, params: [] }
					]))[0]!.rows;
					expect(row!['files']).toEqual([
						{
							id: expect.any(String),
							name: 'pcn.pdf',
							mime: 'application/pdf',
							bytes: pdf.byteLength
						},
						{ name: 'site.mp4', mime: 'video/mp4', bytes: 9 }
					]);
				})
			)
	);

	it.live(
		'a failed ingest statement commits neither the message nor its runs; the redelivery lands once',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					yield* t.db.write({
						text: `ALTER TABLE sys_run ADD CONSTRAINT reject_feed CHECK (automation <> 'mail_import.supplier_mail')`,
						params: []
					});
					const pcn = mail({
						id: '<pcn-2@onsemi.com>',
						from: { address: 'pcn@onsemi.com', name: null },
						subject: 'PCN 2'
					});
					expect(
						(yield* Effect.flip(
							f.conversations.receive('supplier_inbox', { kind: 'messages', messages: [pcn] })
						)).message
					).toBeTruthy();
					expect(yield* f.history()).toEqual([]);
					yield* t.db.write({
						text: 'ALTER TABLE sys_run DROP CONSTRAINT reject_feed',
						params: []
					});
					yield* f.conversations.receive('supplier_inbox', { kind: 'messages', messages: [pcn] });
					expect(yield* f.history()).toHaveLength(1);
					expect(
						(yield* t.db.read([
							{
								text: `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'mail_import.supplier_mail'`,
								params: []
							}
						]))[0]!.rows[0]!['n']
					).toBe(1);
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
});

describe('a personal instance (sync only)', () => {
	it.live(
		'imports history and its own sent messages as sync rows, never admits and never sends; the owner is the attribution',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const phone = yield* f.personal();
					yield* t.receive(
						phone,
						{
							id: 'alice:sent',
							thread: '6591234567@s.whatsapp.net',
							sentAt: '2026-09-25T10:00:00.000Z',
							direction: 'outbound',
							from: { handle: 'me', name: 'Alice' },
							text: 'see you',
							attachments: []
						},
						{ history: true }
					);
					yield* t.receive(phone, {
						id: 'alice:live',
						thread: '6591234567@s.whatsapp.net',
						sentAt: '2026-09-25T10:01:00.000Z',
						from: { handle: '6591234567@s.whatsapp.net', name: 'Ben' },
						text: 'ok',
						attachments: []
					});
					const [rows] = yield* t.db.read([
						{
							text: `SELECT m.direction, m.origin, m.message, u.email AS owner FROM sys_message m JOIN sys_integration i ON i.id = m.integration
			JOIN sys_user u ON u.id = i.owner ORDER BY m.seq`,
							params: []
						}
					]);
					expect(rows!.rows).toEqual([
						{ direction: 'outbound', origin: 'sync', message: null, owner: 'alice@ws.example' },
						{ direction: 'inbound', origin: 'sync', message: null, owner: 'alice@ws.example' }
					]);
					expect(
						(yield* t.db.read([
							{
								text: `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'envoys.admit'`,
								params: []
							}
						]))[0]!.rows[0]!['n']
					).toBe(0);
					expect(
						(yield* Effect.flip(
							f.conversations.send(phone, { to: '6591234567@s.whatsapp.net', text: 'hello' }, {})
						)).message
					).toMatch(/cannot send/);
				})
			)
	);

	it.live(
		'stores group membership once per conversation and keeps sync conversations outside envoys',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const phone = yield* f.personal();
					const group = (participants: Json) =>
						t.receive(
							phone,
							{
								id: 'group-history',
								thread: 'alice:group',
								group: true,
								sentAt: '2026-09-25T10:00:00.000Z',
								from: { handle: '6591009037@s.whatsapp.net', name: 'POC' },
								title: 'Customer group',
								text: 'hi',
								participants
							},
							{ history: true }
						);
					yield* group([{ handle: '6591009037@s.whatsapp.net', name: 'POC' }, { handle: 123 }]);
					const conv = () =>
						t.db
							.read([
								{ text: 'SELECT title, envoy, participants FROM sys_conversation', params: [] }
							])
							.pipe(Effect.map((r) => r[0]?.rows ?? []));
					expect(yield* conv()).toEqual([
						{
							title: 'Customer group',
							envoy: null,
							participants: [{ handle: '6591009037@s.whatsapp.net', name: 'POC' }]
						}
					]);
					yield* group([]);
					expect(yield* conv()).toEqual([
						{ title: 'Customer group', envoy: null, participants: [] }
					]);
				})
			)
	);
});

describe('outbound attachments', () => {
	it.live(
		"a message's stored files reach the link as bytes, in order, with their names and types; the row keeps the refs",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture();
					const report = yield* f.stored(
						'f-report',
						'report.pdf',
						new TextEncoder().encode('%PDF report')
					);
					const sheet = yield* f.stored(
						'f-sheet',
						'datasheet.pdf',
						new TextEncoder().encode('%PDF sheet')
					);
					yield* f.conversations.send(
						'desk_wa',
						{ to: '6591234567@s.whatsapp.net', text: 'your notice', attachments: [report, sheet] },
						{}
					);
					expect(f.sent('desk_wa')).toHaveLength(1);
					expect(f.sent('desk_wa')[0]!.message).toMatchObject({
						attachments: [{ id: 'f-report' }, { id: 'f-sheet' }]
					});
					expect(
						f
							.sent('desk_wa')[0]!
							.attachments!.map((a) => [a.name, a.mime, new TextDecoder().decode(a.bytes)])
					).toEqual([
						['report.pdf', 'application/pdf', '%PDF report'],
						['datasheet.pdf', 'application/pdf', '%PDF sheet']
					]);
				})
			)
	);

	it.live(
		'over the per-message cap, or a file no longer stored, the message fails for good and never reaches the link',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture();
					const big = yield* f.stored('f-big', 'big.pdf', new Uint8Array(8), 21 * 2 ** 20);
					yield* f.conversations.send(
						'desk_wa',
						{ to: '6591234567@s.whatsapp.net', text: 'too big', attachments: [big] },
						{}
					);
					yield* f.conversations.send(
						'desk_wa',
						{ to: '6597654321@s.whatsapp.net', text: 'gone', attachments: [{ id: 'f-none' }] },
						{}
					);
					expect(f.sent('desk_wa')).toHaveLength(0);
					expect(
						(yield* f.outbox()).map((r) => ({ status: r['status'], error: r['error'] }))
					).toEqual(
						expect.arrayContaining([
							{
								status: 'failed',
								error: 'the attachments are 21.0 MiB, over the 20 MiB a message carries'
							},
							{ status: 'failed', error: 'attachment f-none is not a stored file' }
						])
					);
				})
			)
	);
});

describe('connection notices (rule 47)', () => {
	it.live(
		"use direct source-team policies for inbox and the connection's handles, with no label grant or child inheritance",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const f = yield* fixture(),
						t = f.t;
					const direct = t.member([], { email: 'direct@example.test' });
					const team = t.member([], { email: 'team@example.test' });
					const child = t.member([], { email: 'child@example.test' });
					const named = t.member([], { email: 'named@example.test' });
					const inactive = t.member([], { email: 'inactive@example.test' });
					const external = t.member([], { email: 'external@example.test', external: true });
					yield* t.db.write({
						text: "UPDATE sys_user SET team = CASE id WHEN $1 THEN 'direct' WHEN $2 THEN 'assigned' WHEN $3 THEN 'child' WHEN $4 THEN 'name-only' ELSE 'assigned' END WHERE id IN ($1, $2, $3, $4, $5, $6)",
						params: [direct.id, team.id, child.id, named.id, inactive.id, external.id]
					});
					yield* t.db.write({
						text: 'UPDATE sys_user SET active = false WHERE id = $1',
						params: [inactive.id]
					});
					const add = (id: string, to: string) =>
						Effect.gen(function* () {
							const c = new Chain();
							const recipients = [{ policy: 'staff' }, { user: direct.id }, { team: 'assigned' }];
							noticeInsert(
								c,
								'n',
								[
									{
										id: `${id}-inbox`,
										to: { channel: 'inbox', recipients },
										title: 'Source recipients',
										once: `${id}-inbox`
									},
									{
										id: `${id}-out`,
										to: { channel: to, recipients },
										title: 'Source recipients',
										once: `${id}-out`
									}
								],
								t.clock.now(),
								'true',
								manifest.teams
							);
							yield* t.db.write(c.sql('1 AS done'));
							return `${id}-out`;
						});
					const notify = (id: string) => {
						const handler = f.conversations.handlers['notifications.deliver'];
						if (handler === undefined) throw new Error('no notice handler');
						return handler({ ids: [id] }, { id: crypto.randomUUID(), starter: null });
					};
					const first = yield* add('first', 'customer_mail');
					const [inbox] = yield* t.db.read([
						{
							text: 'SELECT DISTINCT member FROM sys_notification WHERE member IS NOT NULL ORDER BY member',
							params: []
						}
					]);
					expect(inbox?.rows.map((r) => r['member'])).toEqual([direct.id, team.id].sort());
					expect(yield* notify(first)).toEqual({ sent: 2, skipped: 0 });
					expect(f.sent('customer_mail').map((s) => s.message)).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ to: ['direct@example.test'] }),
							expect.objectContaining({ to: ['team@example.test'] })
						])
					);
					// once per notice and member
					expect(yield* notify(first)).toEqual({ sent: 2, skipped: 0 });
					yield* f.deliver();
					expect(f.sent('customer_mail')).toHaveLength(2);
					// a WhatsApp connection reaches the members by their phone; one without a phone is not reached
					yield* t.db.write({
						text: `UPDATE sys_user SET phone = '+65 9100 0001' WHERE id = $1`,
						params: [direct.id]
					});
					expect(yield* notify(yield* add('wa', 'desk_wa'))).toEqual({ sent: 1, skipped: 1 });
					expect(f.sent('desk_wa').map((s) => s.message)).toMatchObject([
						{ to: '6591000001@s.whatsapp.net', text: 'Source recipients' }
					]);
					// a slot that is no conversation connection reaches nobody
					expect(yield* notify(yield* add('none', 'supplier_nope'))).toEqual({
						sent: 0,
						skipped: 1
					});
				})
			)
	);
});
