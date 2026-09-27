// engine/channels on PGlite (rule 61, rule 41's exception, G12 (3)): serial-pcn's `customer_notices` shape — a
// `sent_emails` row's create sends its mail from the writing statement, delivery events and the customer's reply land on
// the row after it is closed — plus inbound dedupe and edits, serial at-least-once delivery, the epoch, and `ctx.send`.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import { channels, type Channels } from '../src/engine/channels/index.ts';
import { fakeTransport, type FakeTransport } from '../src/engine/channels/transports.ts';
import type { EngineManifest, Outcome } from '../src/engine/contracts.ts';
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
	},
	teams: {},
	automations: { ping: { description: 'Sends a WhatsApp line', runAs: ['staff'] } },
	channels: {
		customer_mail: { transport: 'email', address: 'support', policies: ['mailer'], outbound: { notice: { from: 'sent_emails', on: 'create' } } },
		desk_wa: { transport: 'whatsapp' },
	},
	connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

const guestSource = `export default {
	channel: { customer_mail: {
		outbound: { notice: { message: ({ record }) => ({ to: [record.to], subject: record.subject, text: record.body, thread: record.id }) } },
		events: {
			sent: (e) => ({ sent_at: e.at }), delivered: (e) => ({ delivered_at: e.at }), opened: (e) => ({ opened_at: e.at }),
			bounced: (e) => ({ failed_reason: e.reason }), failed: (e) => ({ failed_reason: e.reason }), replied: (e) => ({ replied_at: e.at }),
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
		expect(mail.sent[0]!.message).toMatchObject({ to: ['carol@acme.com'], subject: 'PCN 1234', text: 'Your parts change.', thread: id, from: 'support' });
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
		await ch.receive({ kind: 'delivery', channel: 'customer_mail', providerId, event: 'delivered', at: '2026-09-25T10:01:00.000Z' });
		await ch.receive({ kind: 'delivery', channel: 'customer_mail', providerId, event: 'opened', at: '2026-09-25T10:02:00.000Z' });
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
		await ch.receive({ kind: 'delivery', channel: 'customer_mail', providerId: mail.sent[0]!.providerId, event: 'bounced', at: '2026-09-25T10:05:00.000Z', data: { reason: 'mailbox full' } });
		expect((await row(id))['failed_reason']).toBe('mailbox full');
		expect(await outbox()).toMatchObject([{ status: 'failed' }]);
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
