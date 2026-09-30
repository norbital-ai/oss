// engine/channels on PGlite (rule 61, rule 41's exception, G12 (3)): serial-pcn's `customer_notices` shape — a
// `sent_emails` row's create sends its mail from the writing statement, delivery events and the customer's reply land on
// the row after it is closed — plus inbound dedupe and edits, serial at-least-once delivery, the epoch, and `ctx.send`.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import { channels, type Channels } from '../src/engine/channels/index.ts';
import { SendRefused } from '../src/engine/channels/status.ts';
import { fakeTransport, type FakeTransport } from '../src/engine/channels/transports.ts';
import type { Authority, EngineManifest, Outcome } from '../src/engine/contracts.ts';
import type { IdentityHost } from '../src/engine/identity/session.ts';
import { settings } from '../src/shell/data.ts';
import { guestRunner } from '../src/engine/guest/runner.ts';
import { lowerRead } from '../src/engine/index.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		sent_emails: { description: 'A customer notice', label: 'subject', fields: {
			to: { kind: 'text' }, subject: { kind: 'text' }, body: { kind: 'text' },
			status: { kind: 'state', initial: 'open', states: { open: { to: ['closed'] }, closed: { edit: 'none' } } },
			sent_at: { kind: 'instant', optional: true }, delivered_at: { kind: 'instant', optional: true }, opened_at: { kind: 'instant', optional: true },
			replied_at: { kind: 'instant', optional: true }, failed_reason: { kind: 'text', optional: true } } },
	},
	relationships: {},
	collections: {
		sent_emails: { read: { fields: 'all' }, create: { input: { columns: ['to', 'subject', 'body'] } },
			update: { input: { columns: ['status', 'sent_at', 'delivered_at', 'opened_at', 'replied_at', 'failed_reason'] } } },
	},
	integrations: {}, pipelines: {},
	policies: {
		staff: { description: 'Staff', grants: { sent_emails: { read: true, create: true, update: true, moves: 'all' } } },
		mailer: { description: 'The mail channel', grants: { sent_emails: { read: true, update: true } } },
		clerk: { description: 'A clerk: a notice is held for a lead', grants: { sent_emails: { read: true,
			create: { approval: [{ match: { requestor: 'in_team' }, steps: [['Leads']] }] } } } },
	},
	teams: { Clerks: ['clerk'], Leads: ['staff'] },
	automations: { ping: { description: 'Sends a WhatsApp line', runAs: ['staff'] } },
	channels: {
		customer_mail: { transport: 'email', policies: ['mailer'], outbound: { notice: { from: 'sent_emails', on: 'create' } } },
		desk_wa: { transport: 'whatsapp' },
	},
	connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

const guestSource = `export default {
	channel: { customer_mail: {
		outbound: { notice: { message: ({ record }) => record.to === 'nobody' ? null : ({ to: [record.to], subject: record.subject, text: record.body, thread: record.id }) } },
		events: {
			sent: (e) => ({ sent_at: e.at }), delivered: (e) => ({ delivered_at: e.at }), opened: (e) => ({ opened_at: e.at }),
			bounced: (e) => ({ failed_reason: e.reason }), failed: (e) => ({ failed_reason: e.reason }), replied: (e) => ({ replied_at: e.at }),
			deferred: (e) => ({ failed_reason: 'deferred ' + (e.code ?? '') }), auto_replied: (e) => ({ failed_reason: 'auto: ' + e.reply.subject }),
		},
	} },
	automation: { ping: { body: async (input, ctx) => ctx.send('desk_wa', { to: '6591234567@s.whatsapp.net', text: 'hello from a run' }) } },
};`;
const guest = guestRunner({ source: guestSource }, { lowerRead: (member, args) => lowerRead(manifest, member, args), console: () => {} });

let t: TestWorkspace, ch: Channels, mail: FakeTransport, wa: FakeTransport;
const open = (epoch?: string) => channels({ engine: t.engine, transports: { email: mail, whatsapp: wa }, guest, clock: () => t.clock.now(),
	deadlines: t.fakes.deadlines, scope: 'test', files: t.fakes.files, ...(epoch === undefined ? {} : { epoch }) });
beforeEach(async () => {
	t = await testWorkspace({ manifest, guest: { source: guestSource }, runs: { platform: { 'channels.deliver': async () => (await ch.deliver()) as unknown as Json } } });
	mail = fakeTransport('mail');
	wa = fakeTransport('wa');
	ch = open();
	await ch.activate();
});
const ok = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o; };
const staff = () => t.as(t.member(['staff']));
const notice = async () => ok(await staff().act('sent_emails.create', { to: 'carol@acme.com', subject: 'PCN 1234', body: 'Your parts change.' })).records[0]!.id;
const row = async (id: string) => (await t.as(t.admin).get('sent_emails', id))!;
const outbox = async () => (await t.db.read([{ text: `SELECT id, status, attempts, error, conversation, provider_id, record FROM sys_message WHERE direction = 'outbound' ORDER BY seq`, params: [] }]))[0]!.rows;

describe('record-driven outbound (G12 (3))', () => {
	it('a message that answers null sends nothing for that row: skipped, not failed, and the row is not patched', async () => {
		const id = ok(await staff().act('sent_emails.create', { to: 'nobody', subject: 'x', body: 'y' })).records[0]!.id;
		await ch.deliver();
		expect(mail.sent).toHaveLength(0);
		expect(await outbox()).toMatchObject([{ status: 'skipped', error: expect.stringContaining('sends nothing') }]);
		expect(await row(id)).toMatchObject({ failed_reason: null, sent_at: null });
		// the channel's day in Settings counts it on its own, neutral: never a failure, never the last error
		const s = await settings({ db: t.db, now: () => new Date(t.clock.now()) } as unknown as IdentityHost, manifest,
			{ admin: true, actor: t.admin.actor } as unknown as Authority);
		expect(s.ok && s.value.channels.find((c) => c.name === 'customer_mail')?.delivery).toMatchObject({ failed: 0, skipped: 1, lastError: null });
	});
	it('a notice row\'s create queues its mail and the delivery run in the same statement', async () => {
		t.count.reset();
		const id = await notice();
		expect(t.count.writes).toBe(1);
		expect(await outbox()).toMatchObject([{ status: 'queued', record: { collection: 'sent_emails', id } }]);
		const [runs] = await t.db.read([{ text: `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'channels.deliver' AND state = 'queued'`, params: [] }]);
		expect(runs!.rows[0]!['n']).toBe(1);
		expect(t.fakes.deadlines.announced.length).toBeGreaterThan(0);
	});

	it('the delivery run builds the message from the committed row and sends it once; `sent` lands on the row', async () => {
		const id = await notice();
		await t.runDue();
		expect(mail.sent).toHaveLength(1);
		expect(mail.sent[0]!.message).toMatchObject({ to: ['carol@acme.com'], subject: 'PCN 1234', text: 'Your parts change.', thread: id });
		expect((await row(id))['sent_at']).not.toBeNull();
		await t.runDue();
		await ch.deliver();
		expect(mail.sent).toHaveLength(1);
	});

	it('delivered, opened and the customer\'s reply land on the row after it is closed: per-state edit never refuses them (rule 41)', async () => {
		const id = await notice();
		await t.runDue();
		ok(await staff().act('sent_emails.update', { target: id, set: { status: 'closed' } }));
		expect(await staff().act('sent_emails.update', { target: id, set: { failed_reason: 'x' } })).toMatchObject({ kind: 'refused', code: 'locked' });
		const providerId = mail.sent[0]!.providerId;
		await ch.receive({ kind: 'delivery', channel: 'customer_mail', providerId, report: { kind: 'delivered', at: '2026-09-25T10:01:00.000Z', provider: 'fake' } });
		await ch.receive({ kind: 'delivery', channel: 'customer_mail', providerId, report: { kind: 'opened', at: '2026-09-25T10:02:00.000Z', provider: 'fake', approximate: true } });
		await ch.receive({ kind: 'inbound', channel: 'customer_mail', message: { id: '<reply-1@acme.com>', thread: null, sentAt: '2026-09-25T10:03:00.000Z',
			from: { address: 'Carol@acme.com', name: 'Carol' }, replyTo: null, to: [], cc: [], subject: 'Re: PCN 1234', text: 'Thanks', html: null,
			headers: { 'in-reply-to': providerId }, attachments: [] } });
		expect(await row(id)).toMatchObject({ status: 'closed', delivered_at: { $t: '2026-09-25T10:01:00.000Z' },
			opened_at: { $t: '2026-09-25T10:02:00.000Z' }, replied_at: { $t: '2026-09-25T10:03:00.000Z' } });
	});

	it('a send the transport refuses is retried with backoff and, after 8 attempts, fails on the row', async () => {
		mail.fail = () => new Error('provider down');
		const id = await notice();
		for (let i = 0; i < 8; i++) { await ch.deliver(); t.clock.advance('10min'); }
		expect(await outbox()).toMatchObject([{ status: 'failed', attempts: 8, error: 'provider down' }]);
		expect((await row(id))['failed_reason']).toBe('provider down');
		expect(mail.sent).toHaveLength(0);
	});

	it('a bounce reported later marks the row failed with the provider\'s reason', async () => {
		const id = await notice();
		await t.runDue();
		await ch.receive({ kind: 'delivery', channel: 'customer_mail', providerId: mail.sent[0]!.providerId, report: { kind: 'bounced', at: '2026-09-25T10:05:00.000Z', provider: 'fake', code: '552 5.2.2', reason: 'mailbox full', permanent: true } });
		expect((await row(id))['failed_reason']).toBe('mailbox full');
		expect(await outbox()).toMatchObject([{ status: 'bounced', error: 'mailbox full' }]);
	});
});

describe('delivery status (§5.9)', () => {
	const timeline = async () => (await t.db.read([{ text: `SELECT status, delivery FROM sys_message WHERE direction = 'outbound' ORDER BY seq`, params: [] }]))[0]!.rows[0]!;
	const report = (kind: 'delivered' | 'bounced' | 'deferred', at: string, extra: { [k: string]: Json } = {}) =>
		ch.receive({ kind: 'delivery', channel: 'customer_mail', providerId: mail.sent[0]!.providerId, report: { kind, at, provider: 'fake', ...extra } });
	const inbound = (id: string, headers: { [k: string]: string }, subject: string) => ch.receive({ kind: 'inbound', channel: 'customer_mail', message: {
		id, thread: null, sentAt: '2026-09-25T11:00:00.000Z', from: { address: 'carol@acme.com', name: 'Carol' }, replyTo: null, to: [], cc: [], subject,
		text: 'x', html: null, headers: { 'in-reply-to': mail.sent[0]!.providerId, ...headers }, attachments: [] } });

	it('every report lands on the timeline; a bounce is terminal: a later delivered neither moves the status nor maps; a redelivery is recorded once', async () => {
		const id = await notice();
		await t.runDue();
		await report('bounced', '2026-09-25T10:05:00.000Z', { code: '550 5.1.1', reason: 'no such user', permanent: true });
		await report('bounced', '2026-09-25T10:05:00.000Z', { code: '550 5.1.1', reason: 'no such user', permanent: true });
		await report('delivered', '2026-09-25T10:06:00.000Z');
		const got = await timeline();
		expect(got['status']).toBe('bounced');
		expect((got['delivery'] as { kind: string }[]).map((e) => e.kind)).toEqual(['queued', 'sent', 'bounced', 'delivered']);
		expect(got['delivery']).toMatchObject([{ provider: 'bolt' }, { provider: 'bolt' }, { code: '550 5.1.1', reason: 'no such user', permanent: true, provider: 'fake' }, {}]);
		expect(await row(id)).toMatchObject({ failed_reason: 'no such user', delivered_at: null });
	});

	it('status only advances: deferred after delivered is recorded, not applied', async () => {
		await notice();
		await t.runDue();
		await report('delivered', '2026-09-25T10:05:00.000Z');
		await report('deferred', '2026-09-25T10:06:00.000Z', { code: '451 4.7.1' });
		expect((await timeline())['status']).toBe('delivered');
	});

	it('an auto-reply is recorded and mapped as auto_replied, never as the customer\'s reply; a person\'s reply then is', async () => {
		const id = await notice();
		await t.runDue();
		await inbound('<ooo@acme.com>', { 'auto-submitted': 'auto-replied' }, 'Automatic reply: PCN 1234');
		expect(await timeline()).toMatchObject({ status: 'sent' });
		expect(await row(id)).toMatchObject({ replied_at: null, failed_reason: 'auto: Automatic reply: PCN 1234' });
		await inbound('<human@acme.com>', {}, 'Re: PCN 1234');
		const got = await timeline();
		expect(got['status']).toBe('replied');
		expect((got['delivery'] as { kind: string }[]).map((e) => e.kind)).toEqual(['queued', 'sent', 'auto_replied', 'replied']);
		expect((await row(id))['replied_at']).toEqual({ $t: '2026-09-25T11:00:00.000Z' });
	});

	it('a quiet window without a report presumes the mail delivered, once', async () => {
		mail.presumeAfterMs = 86_400_000;
		const id = await notice();
		await t.runDue();
		t.clock.advance('23h');
		await ch.deliver();
		expect((await timeline())['status']).toBe('sent');
		t.clock.advance('2h');
		await ch.deliver();
		const got = await timeline();
		expect(got['status']).toBe('delivered');
		expect((got['delivery'] as Json[]).at(-1)).toMatchObject({ kind: 'delivered', presumed: true, provider: 'bolt' });
		expect((await row(id))['delivered_at']).not.toBeNull();
		const [due] = await t.db.read([{ text: `SELECT count(*)::int AS n FROM sys_message WHERE presume_at IS NOT NULL`, params: [] }]);
		expect(due!.rows[0]!['n']).toBe(0);
	});

	it('a provider refusal: permanent fails at once with its code, a temporary one is deferred and retried', async () => {
		mail.fail = () => new SendRefused('mailbox busy', '451 4.3.2', false);
		const id = await notice();
		await ch.deliver();
		expect(await timeline()).toMatchObject({ status: 'queued', delivery: [{ kind: 'queued' }, { kind: 'deferred', code: '451 4.3.2', reason: 'mailbox busy', permanent: false }] });
		expect((await row(id))['failed_reason']).toBe('deferred 451 4.3.2');
		mail.fail = () => new SendRefused('no such user', '550 5.1.1');
		t.clock.advance('10min');
		await ch.deliver();
		expect(await outbox()).toMatchObject([{ status: 'failed', attempts: 2, error: 'no such user' }]);
		expect((await timeline())['delivery']).toMatchObject([{}, {}, { kind: 'failed', code: '550 5.1.1', permanent: true }]);
		expect((await row(id))['failed_reason']).toBe('no such user');
	});
});

describe('a notice held for approval (rules 47, 61)', () => {
	const clerk = () => t.member(['clerk'], { teamPath: ['Clerks'] });
	const lead = () => t.member(['staff'], { teamPath: ['Leads'] });
	const held = async () => {
		const o = await t.as(clerk()).act('sent_emails.create', { to: 'carol@acme.com', subject: 'PCN 1234', body: 'Your parts change.' });
		if (o.kind !== 'pendingApproval') throw new Error(JSON.stringify(o));
		return o.requestId;
	};
	const decide = (requestId: string, status: 'APPROVED' | 'REJECTED') =>
		t.engine.approvals.process({ requestId, status, reason: 'no', authority: t.as(lead()).authority, now: t.clock.now() });

	it('is sent only once the request is approved, by the run the seal queues', async () => {
		const requestId = await held();
		await t.runDue();
		expect(mail.sent).toHaveLength(0);
		expect(await outbox()).toMatchObject([{ status: 'queued' }]);
		expect((await decide(requestId, 'APPROVED')).kind).toBe('decided');
		await t.runDue();
		expect(mail.sent).toHaveLength(1);
		expect(mail.sent[0]!.message).toMatchObject({ subject: 'PCN 1234' });
	});

	it('is never sent when the request is rejected', async () => {
		const requestId = await held();
		await decide(requestId, 'REJECTED');
		await t.runDue();
		await ch.deliver();
		expect(mail.sent).toHaveLength(0);
		expect(await outbox()).toMatchObject([{ status: 'skipped', error: 'the record no longer exists' }]);
	});
});

describe('delivery order and epochs', () => {
	it('a conversation is delivered serially in seq order: a later message waits while an earlier one retries', async () => {
		let first = true;
		wa.fail = () => { if (first) { first = false; return new Error('socket closed'); } return null; };
		await ch.send('desk_wa', { to: '6591234567@s.whatsapp.net', text: 'one' });
		await ch.send('desk_wa', { to: '6591234567@s.whatsapp.net', text: 'two' });
		await ch.send('desk_wa', { to: '6599999999@s.whatsapp.net', text: 'elsewhere' });
		expect(wa.sent.map((s) => (s.message as { text: string }).text)).toEqual(['elsewhere']);
		t.clock.advance('2s');
		await ch.deliver();
		expect(wa.sent.map((s) => (s.message as { text: string }).text)).toEqual(['elsewhere', 'one', 'two']);
	});

	it('rows of another epoch (a fork, a restore) are never sent', async () => {
		mail.fail = () => new Error('down');
		await notice();
		await ch.deliver();
		mail.fail = null;
		const forked = open('fork-1');
		await forked.activate();
		t.clock.advance('1h');
		await forked.deliver();
		expect(mail.sent).toHaveLength(0);
		expect(await outbox()).toMatchObject([{ status: 'skipped' }]);
		await notice();
		await forked.deliver();
		expect(mail.sent).toHaveLength(1);
	});

	it('ctx.send from an automation queues one journalled row that the delivery run sends', async () => {
		ok(await t.as(t.admin).start('ping', {}));
		await t.runDue();
		await t.runDue();
		expect(wa.sent.map((s) => s.message)).toMatchObject([{ to: '6591234567@s.whatsapp.net', text: 'hello from a run' }]);
		expect(await outbox()).toHaveLength(1);
	});
});

describe('inbound history', () => {
	const inbound = (over: { [k: string]: Json } = {}): Json => ({ id: 'W1', thread: '6591234567@s.whatsapp.net', sentAt: '2026-09-25T10:00:00.000Z',
		from: { handle: '6591234567@s.whatsapp.net', name: 'Ben' }, text: 'first', attachments: [], ...over });
	const history = async () => (await t.db.read([{ text: `SELECT provider_id, text, deleted_at IS NOT NULL AS deleted, files, conversation FROM sys_message WHERE direction = 'inbound' ORDER BY seq`, params: [] }]))[0]!.rows;

	it('a redelivery is the same row; a newer version converges it, an older one changes nothing; a revoke tombstones it for good', async () => {
		await ch.receive({ kind: 'inbound', channel: 'desk_wa', message: inbound() });
		await ch.receive({ kind: 'inbound', channel: 'desk_wa', message: inbound() });
		await ch.receive({ kind: 'inbound', channel: 'desk_wa', message: inbound({ text: 'edited', version: '2026-09-25T10:01:00.000Z' }) });
		await ch.receive({ kind: 'inbound', channel: 'desk_wa', message: inbound({ text: 'stale', version: '2026-09-25T10:00:30.000Z' }) });
		expect(await history()).toMatchObject([{ provider_id: 'W1', text: 'edited', deleted: false }]);
		await ch.receive({ kind: 'inbound', channel: 'desk_wa', message: inbound({ deleted: true }) });
		await ch.receive({ kind: 'inbound', channel: 'desk_wa', message: inbound({ text: 'late', version: '2026-09-25T11:00:00.000Z' }) });
		expect(await history()).toMatchObject([{ provider_id: 'W1', text: '', deleted: true }]);
	});

	it('attachment bytes are stored before the row commits, as a FileRef on the message; one conversation per chat', async () => {
		const bytes = new TextEncoder().encode('%PDF-1.7');
		await ch.receive({ kind: 'inbound', channel: 'desk_wa', message: inbound({ attachments: [{ fileName: 'form.pdf', mimeType: 'application/pdf', byteLength: bytes.byteLength, bin: 0 }] }), bins: [bytes] });
		await ch.receive({ kind: 'inbound', channel: 'desk_wa', message: inbound({ id: 'W2', text: 'second' }) });
		const rows = await history();
		expect(rows[0]!['files']).toMatchObject([{ fileName: 'form.pdf', file: { name: 'form.pdf', mime: 'application/pdf' } }]);
		expect(t.fakes.files.blobs.size).toBe(1);
		expect(new Set(rows.map((r) => r['conversation'])).size).toBe(1);
		await expect(ch.receive({ kind: 'inbound', channel: 'desk_wa', message: { id: 'bad' } })).rejects.toThrow(/malformed/);
	});
});

describe('outbound attachments', () => {
	const stored = async (id: string, name: string, bytes: Uint8Array, size = bytes.byteLength) => {
		const blob = await t.fakes.files.put(bytes, { name, mime: 'application/pdf' }, AbortSignal.timeout(1_000));
		await t.db.write({ text: `INSERT INTO sys_file (id, name, mime, size, key, sha256, field, created_at) VALUES ($1, $2, 'application/pdf', $3, $4, '', 'x.file', now())`,
			params: [id, name, size, blob.key] });
		return { id, name, mime: 'application/pdf' };
	};
	const failed = async () => (await t.db.read([{ text: `SELECT status, error FROM sys_message WHERE direction = 'outbound'`, params: [] }]))[0]!.rows;

	it('a message\'s stored files reach the provider as bytes, in order, with their names and types; the row keeps the refs', async () => {
		const report = await stored('f-report', 'report.pdf', new TextEncoder().encode('%PDF report'));
		const sheet = await stored('f-sheet', 'datasheet.pdf', new TextEncoder().encode('%PDF sheet'));
		await ch.send('desk_wa', { to: '6591234567@s.whatsapp.net', text: 'your notice', attachments: [report, sheet] });
		expect(wa.sent).toHaveLength(1);
		expect(wa.sent[0]!.message).toMatchObject({ attachments: [{ id: 'f-report' }, { id: 'f-sheet' }] });
		expect(wa.sent[0]!.attachments!.map((a) => [a.name, a.mime, new TextDecoder().decode(a.bytes)]))
			.toEqual([['report.pdf', 'application/pdf', '%PDF report'], ['datasheet.pdf', 'application/pdf', '%PDF sheet']]);
	});

	it('over the per-message cap, or a file no longer stored, the message fails for good and never reaches the provider', async () => {
		const big = await stored('f-big', 'big.pdf', new Uint8Array(8), 21 * 2 ** 20);
		await ch.send('desk_wa', { to: '6591234567@s.whatsapp.net', text: 'too big', attachments: [big] });
		await ch.send('desk_wa', { to: '6597654321@s.whatsapp.net', text: 'gone', attachments: [{ id: 'f-none' }] });
		expect(wa.sent).toHaveLength(0);
		expect(await failed()).toEqual(expect.arrayContaining([
			{ status: 'failed', error: 'the attachments are 21.0 MiB, over the 20 MiB a message carries' },
			{ status: 'failed', error: 'attachment f-none is not a stored file' }]));
	});
});
