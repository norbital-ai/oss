// Outbound on PGlite (§4.2): a record-bound row is queued in the commit that makes its record effective (never while an
// approval holds it), once per rule, record, instance and version; its payload is built from the committed record at
// delivery with its hash recorded before any I/O, so a changed payload under the same key is refused and a sent row is
// never sent again. A command runs until acknowledged, however long its remote is away, its remote idempotency key making
// a lost answer harmless; a message goes through the instance's link, its outcome patching the record through the rule's
// `events`. Reads of `from` carry `$outbound`. One guarantee per test.
import { describe, expect, it } from '@effect/vitest';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { Context, Effect, Layer, Result, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import type { Authority, Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import type { Holder } from '../src/engine/access/authority.ts';
import { Drivers } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import {
	Activation,
	Approvals,
	Guest,
	Outbound,
	type OutboundFile
} from '../src/engine/services.ts';
import { OutboundLive } from '../src/engine/integrations/outbound.ts';
import { TenantDb } from '../src/engine/db/tenant-db.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, qReply, routeFixture } from './support/route-fixture.ts';
import { DbError } from '../src/engine/errors.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { PgliteDb } from '../src/engine/db/pglite.ts';
import { SendRefused } from '../src/engine/conversations/status.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { TestWorkspace, type TestOptions } from '../src/test/index.ts';

const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			orders: {
				description: 'An order',
				label: 'number',
				fields: {
					number: { kind: 'text' },
					status: { kind: 'enum', values: ['draft', 'confirmed'], default: 'draft' },
					seal: { kind: 'text', optional: true },
					total: { kind: 'int', default: 0 },
					note: { kind: 'text', optional: true }
				}
			},
			sent_emails: {
				description: 'A customer mail',
				label: 'subject',
				fields: {
					to_address: { kind: 'text' },
					subject: { kind: 'text' },
					body: { kind: 'text' },
					status: { kind: 'text', default: 'queued' },
					failure: { kind: 'text', optional: true }
				}
			}
		},
		relationships: {
			'orders.book': {
				to: 'sys_integration',
				optional: true,
				where: { integration: { eq: 'ledger' } }
			}
		},
		collections: {
			orders: {
				read: { fields: 'all' },
				create: { input: { columns: ['number', 'status', 'seal', 'total', 'book'] } },
				update: { input: { columns: ['status', 'seal', 'total', 'note'] } }
			},
			sent_emails: {
				read: { fields: 'all' },
				create: { input: { columns: ['to_address', 'subject', 'body'] } },
				update: { input: { columns: ['status', 'failure'] } }
			}
		},
		integrations: {
			ledger: {
				description: 'An accounting database',
				driver: 'sqlserver',
				credential: { connection: { kind: 'text' } },
				outbound: {
					orders: {
						from: 'orders',
						on: ['create', 'update'],
						when: { status: { eq: 'confirmed' } },
						via: 'book',
						version: 'seal'
					}
				}
			},
			notices: {
				description: 'The notices mailbox',
				driver: 'email',
				outbound: { mails: { from: 'sent_emails', via: 'customer_mail' } }
			}
		},
		connections: { books: { integration: 'ledger' }, customer_mail: { integration: 'notices' } },
		pipelines: {},
		policies: {
			clerk: {
				description: 'Writes customer mail for review',
				grants: { sent_emails: { read: true, approval: { create: [{ steps: [['finance']] }] } } }
			},
			reviewer: { description: 'Reviews customer mail', grants: { sent_emails: { read: true } } }
		},
		teams: {
			sales: { name: 'Sales', policies: ['clerk'] },
			finance: { name: 'Finance', policies: ['reviewer'] }
		},
		automations: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);

/** `guest.mjs`: the ledger's order command submits by its key; the mailbox's notices are built from the record, its events patch it. */
const guestSource = `export default { integration_definition: {
	ledger: { bodies: { feeds: {}, outbound: { orders: {
		build: (o) => o.seal === null ? null : { number: o.number, total: Number(o.total), seal: o.seal },
		run: function* (p, ctx) { return { id: String((yield* ctx.request({ statement: 'submit', parameters: { key: ctx.key, number: p.number, total: p.total } })).rows[0].id) }; },
	} } } },
	notices: { bodies: { feeds: {}, outbound: { mails: {
		build: (r) => ({ to: [r.to_address], subject: r.subject, text: r.body, thread: r.id }),
		events: { sent: () => ({ status: 'sent' }), failed: (e) => ({ status: 'failed', failure: e.reason }) },
	} } } },
} };`;

const NOW = '2026-10-14T08:00:00.000Z';
const required = <T>(value: T | null | undefined): T => {
	if (value === null || value === undefined) throw new Error('fixture value missing');
	return value;
};
const ok = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
const Parameters = Schema.Struct({
	key: Schema.String,
	number: Schema.String,
	total: Schema.Number,
	text: Schema.optionalKey(Schema.String)
});
type Ledger = {
	orders: Map<string, { id: number; number: string; total: number }>;
	submits: (typeof Parameters.Type)[];
	down: boolean;
	lose: boolean;
};
type Links = {
	sent: { instance: string; message: Json; attachments?: readonly OutboundFile[] }[];
	answer: Drivers['Service']['request'];
	send: Drivers['Service']['send'];
};
const setup = (
	options: {
		manifest?: EngineManifest;
		source?: string;
		db?: TestOptions['db'];
		ledger?: Ledger;
		links?: Links;
	} = {}
) =>
	Effect.gen(function* () {
		const ledger: Ledger = options.ledger ?? {
			orders: new Map(),
			submits: [],
			down: false,
			lose: false
		};
		const links: Links = options.links ?? {
			sent: [],
			answer: (_instance, op) =>
				Effect.gen(function* () {
					const { parameters: p } = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ parameters: Parameters })
					)(op).pipe(Effect.mapError(Port.failure('request')));
					if (ledger.down)
						return yield* Effect.fail(Port.failure('request')(new Error('the ledger is down')));
					ledger.submits.push(p);
					const known = ledger.orders.get(p.key) ?? {
						id: ledger.orders.size + 1,
						number: p.number,
						total: p.total
					};
					ledger.orders.set(p.key, known);
					if (ledger.lose) {
						ledger.lose = false;
						return yield* Effect.fail(
							Port.failure('request')(new Error('the connection reset after the commit'))
						);
					}
					return { rows: [{ id: known.id }] };
				}),
			send: (instance, message, attachments) =>
				Effect.sync(() => {
					links.sent.push({
						instance,
						message,
						...(attachments === undefined ? {} : { attachments })
					});
					return { providerId: `${instance}:${links.sent.length}` };
				})
		};
		const ports = Layer.succeed(Drivers, {
			available: true,
			send: (instance, message, attachments) => links.send(instance, message, attachments),
			request: (instance, op) => links.answer(instance, op),
			typing: () => Effect.void,
			read: () => Port.unavailable('link'),
			changed: () => Effect.void
		});
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest: options.manifest ?? manifest,
				guest: yield* program(options.source ?? guestSource),
				now: NOW,
				ports,
				...(options.db === undefined ? {} : { db: options.db })
			})
		);
		const t = Context.get(context, TestWorkspace),
			route = yield* routeFixture(context);
		const act = (callable: string, input: Json, authority: Authority = t.as(t.admin).authority) =>
			actReply(route, authority, { callable, input, issuedAt: NOW }).pipe(
				Effect.map((reply) => reply.outcome)
			);
		const get = (collection: string, id: string) =>
			qReply(route, t.as(t.admin).authority, { reads: [{ m: 'get', a: [collection, id] }] }).pipe(
				Effect.flatMap((reply) =>
					Schema.decodeUnknownEffect(Schema.NullOr(Schema.Record(Schema.String, Schema.Json)))(
						reply.answers[0]
					)
				)
			);
		const sql = (text: string, params: Json[] = []) =>
			t.db.rows(Schema.Record(Schema.String, Schema.Json), { text, params });
		const outbound = () =>
			sql(
				`SELECT rule, status, class, error IS NOT NULL AS failed, message FROM sys_message WHERE direction = 'outbound' ORDER BY seq`
			);
		const order = (over: { [key: string]: Json } = {}) =>
			act('orders.create', {
				number: 'SO-1',
				status: 'confirmed',
				seal: 'S1',
				total: 100,
				book: 'books',
				...over
			}).pipe(Effect.map((outcome) => required(ok(outcome).records[0]).id));
		const team = (holder: Holder & { id: string }) =>
			new Authorities(t.manifest, 'test').member(t.db, holder.id).pipe(Effect.map(required));
		return {
			context,
			t,
			ledger,
			links,
			act,
			get,
			sql,
			outbound,
			order,
			team,
			deliver: Context.get(context, Outbound).deliver.pipe(Effect.provide(context)),
			approvals: Context.get(context, Approvals)
		};
	});

describe('environment epoch', () => {
	it.live('keeps missing default epochs implicit and persists only epoch changes', () =>
		Effect.gen(function* () {
			const f = yield* setup();
			const stored = () =>
				f.t.db.rows(Schema.Struct({ value: Schema.String, version: Schema.String }), {
					text: `SELECT value, xmin::text AS version FROM sys_config WHERE key = 'integrations.epoch'`,
					params: []
				});
			const activate = (epoch: string) =>
				Effect.gen(function* () {
					const context = yield* Layer.build(
						OutboundLive.pipe(
							Layer.provide(
								Layer.mergeAll(
									NodeCrypto.layer,
									Layer.succeedContext(
										Context.add(f.context, Activation, {
											...Context.get(f.context, Activation),
											epoch
										})
									)
								)
							)
						)
					);
					yield* Context.get(context, Outbound).activate.pipe(
						Effect.provide(Context.merge(f.context, context))
					);
				});
			expect(yield* stored()).toEqual([]);
			yield* activate('');
			expect(yield* stored()).toEqual([]);
			yield* activate('fork-1');
			const first = required((yield* stored())[0]);
			expect(first.value).toBe('fork-1');
			yield* activate('fork-1');
			// A no-op activation must not create another database row version.
			expect(yield* stored()).toEqual([first]);
			yield* activate('fork-2');
			const changed = required((yield* stored())[0]);
			expect(changed.value).toBe('fork-2');
			expect(changed.version).not.toBe(first.version);
			yield* activate('');
			const reset = required((yield* stored())[0]);
			expect(reset.value).toBe('');
			expect(reset.version).not.toBe(changed.version);
			yield* activate('');
			expect(yield* stored()).toEqual([reset]);
		})
	);
});

describe('a command', () => {
	it.live('builds commands with generated sequence labels from the declared row', () =>
		Effect.gen(function* () {
			let f = yield* setup();
			const answer = f.links.answer;
			const orderModel = required(manifest.models['orders']);
			f = yield* setup({
				ledger: f.ledger,
				links: f.links,
				manifest: {
					...manifest,
					models: {
						...manifest.models,
						orders: {
							...orderModel,
							fields: { ...orderModel.fields, reference: { kind: 'seq', pattern: 'REF-{0000}' } }
						}
					}
				},
				source: guestSource.replace('number: o.number', 'number: o.reference')
			});
			f.links.answer = answer;
			yield* f.order();
			expect(yield* f.deliver).toEqual({ sent: 1, failed: 0 });
			expect(f.ledger.submits).toMatchObject([{ number: 'REF-0001' }]);
		})
	);

	it.live(
		'is queued with the commit that confirms its record, built at delivery, and acknowledged once',
		() =>
			Effect.gen(function* () {
				const f = yield* setup();
				ok(yield* f.act('orders.create', { number: 'SO-0', book: 'books' })); // a draft matches no rule
				const id = yield* f.order();
				expect(yield* f.outbound()).toEqual([
					{
						rule: 'ledger.orders',
						status: 'queued',
						class: 'command',
						failed: false,
						message: null
					}
				]);
				yield* f.t.runDue();
				expect(yield* f.outbound()).toEqual([
					{
						rule: 'ledger.orders',
						status: 'sent',
						class: 'command',
						failed: false,
						message: { number: 'SO-1', total: 100, seal: 'S1' }
					}
				]);
				expect(f.ledger.submits).toHaveLength(1);
				expect((yield* f.get('orders', id))?.['$outbound']).toEqual({
					'ledger.orders': { status: 'sent', error: null }
				});
				// an edit under the same version queues nothing; a sent row is never sent again
				ok(yield* f.act('orders.update', { target: id, set: { note: 'thanks' } }));
				yield* f.t.runDue();
				expect(f.ledger.submits).toHaveLength(1);
			})
	);

	it.live('is retried until acknowledged across a ten-minute outage, never failing for good', () =>
		Effect.gen(function* () {
			const f = yield* setup();
			f.ledger.down = true;
			yield* f.order();
			for (let minute = 0; minute < 10; minute++) {
				yield* f.t.runDue();
				expect(yield* f.outbound()).toMatchObject([{ status: 'queued', failed: true }]);
				f.t.clock.advance('1min');
			}
			f.ledger.down = false;
			for (
				let minute = 0;
				minute < 6 && (yield* f.outbound())[0]?.['status'] !== 'sent';
				minute++
			) {
				f.t.clock.advance('1min');
				yield* f.t.runDue();
			}
			expect(yield* f.outbound()).toMatchObject([{ status: 'sent', failed: false }]);
			expect([...f.ledger.orders.values()]).toEqual([{ id: 1, number: 'SO-1', total: 100 }]);
		})
	);

	it.live(
		'an answer lost after the remote committed is retried under the same key: the remote holds it once',
		() =>
			Effect.gen(function* () {
				const f = yield* setup();
				f.ledger.lose = true;
				yield* f.order();
				yield* f.t.runDue();
				expect(yield* f.outbound()).toMatchObject([{ status: 'queued' }]);
				f.t.clock.advance('1min');
				yield* f.t.runDue();
				expect(yield* f.outbound()).toMatchObject([{ status: 'sent' }]);
				expect(f.ledger.submits).toHaveLength(2);
				expect(new Set(f.ledger.submits.map((s) => s.key)).size).toBe(1);
				expect(f.ledger.orders.size).toBe(1);
			})
	);

	it.live(
		'a retry hands run the payload exactly as built, never its stored jsonb with reordered keys',
		() =>
			Effect.gen(function* () {
				let f = yield* setup();
				const answer = f.links.answer;
				f = yield* setup({
					ledger: f.ledger,
					links: f.links,
					source: guestSource.replace(
						'parameters: { key: ctx.key, number: p.number, total: p.total }',
						'parameters: { key: ctx.key, number: p.number, total: p.total, text: JSON.stringify(p) }'
					)
				});
				f.links.answer = answer;
				f.ledger.lose = true;
				yield* f.order();
				yield* f.t.runDue();
				f.t.clock.advance('1min');
				yield* f.t.runDue();
				expect(yield* f.outbound()).toMatchObject([{ status: 'sent' }]);
				// built `{ number, total, seal }`; jsonb would hand back `{ seal, total, number }` — a remote fingerprint must not move
				expect(f.ledger.submits.map((s) => s.text)).toEqual([
					'{"number":"SO-1","total":100,"seal":"S1"}',
					'{"number":"SO-1","total":100,"seal":"S1"}'
				]);
			})
	);

	it.live(
		"a failed request records what the facility said, as a message's failed send does, never the facility error's JSON",
		() =>
			Effect.gen(function* () {
				const f = yield* setup();
				f.links.answer = (instance) =>
					Effect.fail(Port.failure('request')(new Error(`'${instance}' is not connected`)));
				const id = yield* f.order();
				yield* f.t.runDue();
				// a database driver's diagnostics may name its connection: its failure says its kind alone
				expect((yield* f.get('orders', id))?.['$outbound']).toEqual({
					'ledger.orders': { status: 'queued', error: 'Database request failed.' }
				});
			})
	);

	it.live(
		'a payload changed under the same key is refused, never sent; a new version sends again',
		() =>
			Effect.gen(function* () {
				const f = yield* setup();
				f.ledger.down = true;
				const id = yield* f.order();
				yield* f.t.runDue();
				ok(yield* f.act('orders.update', { target: id, set: { total: 120 } }));
				f.ledger.down = false;
				f.t.clock.advance('1min');
				yield* f.t.runDue();
				expect(yield* f.outbound()).toMatchObject([{ status: 'failed' }]);
				expect(
					(yield* f.sql(`SELECT error FROM sys_message WHERE direction = 'outbound'`))[0]?.['error']
				).toMatch(/^submissionChanged/);
				expect(f.ledger.submits).toEqual([]);
				ok(yield* f.act('orders.update', { target: id, set: { seal: 'S2' } }));
				yield* f.t.runDue();
				expect((yield* f.outbound()).map((r) => r['status'])).toEqual(['failed', 'sent']);
				expect(f.ledger.submits).toMatchObject([{ number: 'SO-1', total: 120 }]);
				expect((yield* f.get('orders', id))?.['$outbound']).toEqual({
					'ledger.orders': { status: 'sent', error: null }
				});
			})
	);

	it.live(
		'a record its build cannot read for a while is retried, never taken for gone; the command lands once it reads',
		() =>
			Effect.gen(function* () {
				let f = yield* setup();
				let down = false;
				const db = Layer.effect(
					TenantDb,
					Effect.gen(function* () {
						const inner = yield* TenantDb;
						return TenantDb.typed({
							...inner,
							read: (statements) =>
								down && statements.some((statement) => statement.text.includes('"orders"'))
									? Effect.fail(
											new DbError({ message: 'the database went away', sqlstate: '08006' })
										)
									: inner.read(statements)
						});
					})
				).pipe(Layer.provide(PgliteDb.layer()));
				f = yield* setup({ db, ledger: f.ledger, links: f.links });
				yield* f.order();
				down = true;
				for (let minute = 0; minute < 3; minute++) {
					yield* f.deliver;
					expect(yield* f.outbound()).toMatchObject([{ status: 'queued', failed: true }]);
					f.t.clock.advance('1min');
				}
				down = false;
				yield* f.deliver;
				expect(yield* f.outbound()).toMatchObject([{ status: 'sent', failed: false }]);
				expect(f.ledger.submits).toMatchObject([{ number: 'SO-1', total: 100 }]);
			})
	);

	it.live(
		'is built at its claim: a record that changed while its instance was paused is sent as it is then',
		() =>
			Effect.gen(function* () {
				const f = yield* setup();
				ok(yield* f.act('sys_integration.update', { target: 'books', set: { active: false } }));
				const id = yield* f.order();
				yield* f.t.runDue();
				ok(yield* f.act('orders.update', { target: id, set: { total: 120 } }));
				ok(yield* f.act('sys_integration.update', { target: 'books', set: { active: true } }));
				yield* f.t.runDue();
				expect(yield* f.outbound()).toMatchObject([{ status: 'sent', message: { total: 120 } }]);
				expect(f.ledger.submits).toMatchObject([{ number: 'SO-1', total: 120 }]);
			})
	);
});

describe('a message', () => {
	it.live(
		'an approval-held create sends nothing; the approval queues and sends it, its `sent` event patching the record',
		() =>
			Effect.gen(function* () {
				const f = yield* setup();
				const clerk = f.t.member(['clerk'], { teams: ['sales'] }),
					finance = f.t.member(['reviewer'], { teams: ['finance'] });
				const held = yield* f.act(
					'sent_emails.create',
					{ to_address: 'buyer@example.com', subject: 'Your quote', body: 'Attached.' },
					yield* f.team(clerk)
				);
				expect(held).toMatchObject({ kind: 'pendingApproval' });
				yield* f.t.runDue();
				expect(yield* f.outbound()).toEqual([]);
				expect(f.links.sent).toEqual([]);
				if (held.kind !== 'pendingApproval') throw new Error(JSON.stringify(held));
				const requestId = held.requestId;
				expect(
					yield* f.approvals.process({
						requestId,
						authority: yield* f.team(finance),
						status: 'APPROVED',
						now: NOW
					})
				).toMatchObject({ kind: 'decided' });
				yield* f.t.runDue();
				const [mail] = yield* f.sql(`SELECT id::text AS id, status FROM sent_emails`);
				const message: Json = {
					to: ['buyer@example.com'],
					subject: 'Your quote',
					text: 'Attached.',
					thread: required(required(mail)['id'])
				};
				expect(f.links.sent).toMatchObject([{ instance: 'customer_mail', message }]);
				expect(mail).toMatchObject({ status: 'sent' });
				expect(yield* f.outbound()).toMatchObject([
					{ rule: 'notices.mails', status: 'sent', class: 'message' }
				]);
			})
	);

	it.live(
		'a permanent refusal fails the row at once and its `failed` event carries the reason to the record',
		() =>
			Effect.gen(function* () {
				const f = yield* setup();
				f.links.send = () => Effect.fail(new SendRefused('550 5.1.1 no such mailbox', '550'));
				const mail = required(
					ok(
						yield* f.act('sent_emails.create', {
							to_address: 'nobody@example.com',
							subject: 'Hello',
							body: 'Hi.'
						})
					).records[0]
				).id;
				yield* f.t.runDue();
				expect(yield* f.outbound()).toMatchObject([{ status: 'failed' }]);
				expect(yield* f.get('sent_emails', mail)).toMatchObject({
					status: 'failed',
					failure: '550 5.1.1 no such mailbox',
					$outbound: { 'notices.mails': { status: 'failed', error: '550 5.1.1 no such mailbox' } }
				});
			})
	);

	it.live('an interrupted build is retried after its backoff, not failed for good', () =>
		Effect.gen(function* () {
			const f = yield* setup();
			const native = Context.get(f.context, Guest);
			let interrupted = 2;
			const guest = Guest.of({
				...native,
				invoke: (invocation, bridge) =>
					invocation.target.endsWith('.build') && interrupted-- > 0
						? Effect.succeed({
								kind: 'failed',
								error: BoltError.make('interrupted', 'guest', 'interrupted build'),
								cpuMs: 0
							})
						: native.invoke(invocation, bridge)
			});
			const context = yield* Layer.build(
				OutboundLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							NodeCrypto.layer,
							Layer.succeedContext(Context.add(f.context, Guest, guest))
						)
					)
				)
			);
			const deliver = Context.get(context, Outbound).deliver.pipe(
				Effect.provide(Context.merge(f.context, context))
			);
			ok(
				yield* f.act('sent_emails.create', {
					to_address: 'buyer@example.com',
					subject: 'Hello',
					body: 'Hi.'
				})
			);
			yield* deliver;
			expect(yield* f.outbound()).toMatchObject([
				{ status: 'queued', failed: true, message: null }
			]);
			f.t.clock.advance('1min');
			yield* deliver;
			f.t.clock.advance('1min');
			yield* deliver;
			expect(yield* f.outbound()).toMatchObject([{ status: 'sent', failed: false }]);
			expect(f.links.sent).toHaveLength(1);
		})
	);

	it.live(
		'built for its queue, then changed under the same key while an earlier message held the queue: refused, never sent stale',
		() =>
			Effect.gen(function* () {
				let f = yield* setup();
				let down = true;
				f = yield* setup({
					ledger: f.ledger,
					links: f.links,
					source: guestSource.replace(
						'build: (r) => ({ to: [r.to_address], subject: r.subject, text: r.body, thread: r.id })',
						"build: (r) => ({ to: [r.to_address], subject: r.subject, text: r.body + ' (' + r.status + ')', thread: 'one thread' })"
					)
				});
				const send = f.links.send;
				f.links.send = (instance, message, attachments) =>
					down
						? Effect.fail(Port.failure('link')(new Error('the mailbox is away')))
						: send(instance, message, attachments);
				ok(
					yield* f.act('sent_emails.create', {
						to_address: 'buyer@example.com',
						subject: 'First',
						body: 'One.'
					})
				);
				const second = required(
					ok(
						yield* f.act('sent_emails.create', {
							to_address: 'buyer@example.com',
							subject: 'Second',
							body: 'Two.'
						})
					).records[0]
				).id;
				yield* f.deliver;
				expect((yield* f.outbound()).map((r) => r['status'])).toEqual(['queued', 'queued']);
				ok(yield* f.act('sent_emails.update', { target: second, set: { status: 'held' } }));
				down = false;
				f.t.clock.advance('1min');
				yield* f.deliver;
				expect((yield* f.outbound()).map((r) => r['status'])).toEqual(['sent', 'failed']);
				expect(
					(yield* f.sql(
						`SELECT error FROM sys_message WHERE direction = 'outbound' ORDER BY seq`
					))[1]?.['error']
				).toMatch(/^submissionChanged/);
				expect(
					f.links.sent.map(
						(x) =>
							Schema.decodeUnknownSync(Schema.Struct({ subject: Schema.String }))(x.message).subject
					)
				).toEqual(['First']);
			})
	);

	it.live('waits while its instance is paused and is sent once it is resumed', () =>
		Effect.gen(function* () {
			const f = yield* setup();
			ok(
				yield* f.act('sys_integration.update', { target: 'customer_mail', set: { active: false } })
			);
			ok(
				yield* f.act('sent_emails.create', {
					to_address: 'buyer@example.com',
					subject: 'Later',
					body: 'Soon.'
				})
			);
			yield* f.t.runDue();
			expect(f.links.sent).toEqual([]);
			ok(
				yield* f.act('sys_integration.update', { target: 'customer_mail', set: { active: true } })
			);
			yield* f.t.runDue();
			expect(f.links.sent).toHaveLength(1);
		})
	);
});

const diary = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en' },
		models: {
			visits: {
				description: 'A visit on a member calendar',
				label: 'title',
				fields: {
					title: { kind: 'text' },
					rev: { kind: 'int', default: 0 },
					etag: { kind: 'text', optional: true }
				}
			}
		},
		relationships: {
			'visits.calendar': { to: 'sys_integration', where: { integration: { eq: 'diary' } } }
		},
		collections: {
			visits: {
				read: { fields: 'all' },
				create: { input: { columns: ['title', 'rev', 'calendar'] } },
				update: { input: { columns: ['title', 'rev', 'etag'] } }
			}
		},
		integrations: {
			diary: {
				description: 'A member calendar',
				driver: 'calendar',
				outbound: {
					visits: {
						from: 'visits',
						on: ['create', 'update'],
						when: { rev: { gt: 0 } },
						via: 'calendar',
						version: 'rev'
					}
				}
			}
		},
		connections: {},
		pipelines: {},
		policies: {},
		teams: {},
		automations: {},
		envoys: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);
/** The diary's write is the calendar driver's `call`; its receipt patches the record with the remote's etag. */
const diarySource = `export default { integration_definition: {
	diary: { bodies: { feeds: {}, outbound: { visits: {
		build: (v) => ({ title: v.title, rev: Number(v.rev) }),
		run: function* (p, ctx) {
			const event = yield* ctx.request({ method: 'POST', path: '/calendars/primary/events', body: { summary: p.title }, output: { kind: 'json' } });
			return { id: event.id, set: { etag: event.etag } };
		},
	} } } },
} };`;

describe('a personal command', () => {
	it.live(
		"writes back to a member's own account through its call, patches the receipt onto the record and never echoes it",
		() =>
			Effect.gen(function* () {
				const calls: Json[] = [];
				const f = yield* setup({
					manifest: diary,
					source: diarySource,
					links: {
						sent: [],
						send: () => Effect.die('a calendar never sends'),
						answer: (_instance, op) =>
							Effect.sync(() => {
								calls.push(op);
								return {
									status: 200,
									body: { id: `event-${calls.length}`, etag: `"e${calls.length}"` }
								};
							})
					}
				});
				const alice = f.t.member([]);
				const account = required(
					ok(
						yield* f.act('sys_integration.create', {
							integration: 'diary',
							name: "Alice's calendar",
							owner: alice.id
						})
					).records[0]
				).id;
				const id = required(
					ok(yield* f.act('visits.create', { title: 'Site visit', rev: 1, calendar: account }))
						.records[0]
				).id;
				yield* f.t.runDue();
				expect(yield* f.outbound()).toMatchObject([{ status: 'sent', class: 'command' }]);
				expect(calls).toMatchObject([
					{ method: 'POST', path: '/calendars/primary/events', body: { summary: 'Site visit' } }
				]);
				expect(yield* f.get('visits', id)).toMatchObject({ etag: '"e1"', rev: 1 });
				// the receipt's own patch, and any edit under the same rev, write nothing again
				ok(yield* f.act('visits.update', { target: id, set: { title: 'Site visit (moved)' } }));
				yield* f.t.runDue();
				expect(calls).toHaveLength(1);
				ok(yield* f.act('visits.update', { target: id, set: { rev: 2 } }));
				yield* f.t.runDue();
				expect(calls).toHaveLength(2);
				expect((yield* f.outbound()).map((row) => row['status'])).toEqual(['sent', 'sent']);
				expect(yield* f.get('visits', id)).toMatchObject({ etag: '"e2"' });
			})
	);
});
