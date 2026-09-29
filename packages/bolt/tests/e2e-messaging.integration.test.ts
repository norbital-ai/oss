// End to end through the engine entry and the test kit (P22, rules 57–61, §3.8): the kit's fake transports feed the
// engine's channels, its envoys run the agent's real turn loop over a scripted model, record-driven outbound ships
// through the engine's own `channels.deliver` run, and an approval hold lands in the approvers' inbox.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { AiPort, EngineManifest, Outcome } from '../src/engine/contracts.ts';
import { testWorkspace, type TestWorkspace, respondSystem1 } from '../src/test/index.ts'; // hook:decisions

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, // hook:decisions — not a triage test (rule 60a opt-out)
	models: {
		jobs: { description: 'A job', label: 'title', fields: { title: { kind: 'text' }, status: { kind: 'text' } } },
		sent_emails: { description: 'A customer notice', label: 'subject', fields: { to: { kind: 'text' }, subject: { kind: 'text' }, body: { kind: 'text' },
			sent_at: { kind: 'instant', optional: true }, delivered_at: { kind: 'instant', optional: true }, failed_reason: { kind: 'text', optional: true } } },
		orders: { description: 'An order', label: 'title', fields: { title: { kind: 'text' } } },
		tickets: { description: 'A ticket', label: 'title', fields: { title: { kind: 'text' } } },
	},
	relationships: {},
	collections: {
		jobs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'status'] } }, update: { input: { columns: ['status'] } } },
		sent_emails: { read: { fields: 'all' }, create: { input: { columns: ['to', 'subject', 'body'] } },
			update: { input: { columns: ['sent_at', 'delivered_at', 'failed_reason'] } } },
		orders: { read: { fields: 'all' }, create: { input: { columns: ['title'] } },
			notifications: { approvalStepRequested: [{ channel: 'inbox', to: ['step_approvers'], title: 'Awaiting your decision' }] } },
		tickets: { read: { fields: 'all' }, create: { input: { columns: ['title'] } }, notifications: { committed: [
			{ channel: 'customer_mail', to: [{ team: 'Contractors' }, 'requestor'], title: 'New ticket', body: 'A ticket was opened.' },
			{ channel: 'field_wa', to: [{ team: 'Contractors' }], title: 'New ticket' }] } },
	},
	integrations: {}, pipelines: {},
	policies: {
		desk: { description: 'What the envoys may do', grants: { jobs: { read: true } } },
		contractor: { description: 'Contractors', grants: { jobs: { read: true } } },
		staff: { description: 'Staff', grants: { sent_emails: { read: true, create: true }, tickets: { read: true, create: true } } },
		mailer: { description: 'The mail channel', grants: { sent_emails: { read: true, update: true } } },
		sales: { description: 'Sales', grants: { orders: { read: true, create: { approval: [{ steps: [['Finance']] }] } } } },
		finance: { description: 'Finance', grants: { orders: { read: true } } },
	},
	teams: { Contractors: ['contractor'] },
	automations: {},
	channels: {
		field_wa: { transport: 'whatsapp' }, sales_tg: { transport: 'telegram' },
		customer_mail: { transport: 'email', address: 'support', policies: ['mailer'], outbound: { notice: { from: 'sent_emails', on: 'create' } } },
	},
	connections: {},
	envoys: {
		field_ops: { channel: 'field_wa', audience: 'authenticated', name: 'Norbius', policies: ['desk'], triage: false, groupMessages: 'mention_or_reply', delegation: 'disabled', task: 'Keep jobs up to date.' },
		sales_desk: { channel: 'sales_tg', audience: 'public', name: 'Norbius', policies: ['desk'], triage: false, groupMessages: 'disabled', delegation: 'disabled', task: 'Answer about jobs.' },
	},
	mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

const guestSource = `export default { channel: { customer_mail: {
	outbound: { notice: { message: ({ record }) => ({ to: [record.to], subject: record.subject, text: record.body, thread: record.id }) } },
	events: { sent: (e) => ({ sent_at: e.at }), delivered: (e) => ({ delivered_at: e.at }), bounced: (e) => ({ failed_reason: e.reason }) },
} } };`;

/** "close <id>" asks for `act jobs.update`; a tool result is answered with the result; anything else is echoed. */
const text = (c: Json) => typeof c === 'string' ? c : String((c as { text?: Json } | null)?.text ?? '');
const ai: AiPort & { requests: number } = { requests: 0, sys_1: respondSystem1, sys_2: { models: ['default'],
	async infer(request) {
		ai.requests++;
		const usage = { input: 10, output: 5 }, last = request.messages.findLast((m) => !(typeof m.content === 'string' && m.content.startsWith('[conversation state]')))!; // not the step's closing note
		if (last.role === 'tool') return { content: `result: ${JSON.stringify(last.content)}`, toolCalls: [], finish: 'stop', usage };
		const close = /^close (\S+)/m.exec(text(last.content)); // hook:agent — the message line of the inbound envelope
		if (close !== null) return { content: '', toolCalls: [{ id: `c${ai.requests}`, name: 'act', input: { callable: 'jobs.update', input: { target: close[1]!, set: { status: 'done' } } } }], finish: 'tool', usage };
		return { content: `echo: ${text(last.content)}`, toolCalls: [], finish: 'stop', usage };
	} } };

let t: TestWorkspace;
const ADA = 'u-ada', CAL = 'u-cal';
beforeEach(async () => {
	ai.requests = 0;
	t = await testWorkspace({ manifest, guest: { source: guestSource }, ai, envoys: { workspace: 'Acme Field' } });
	await t.db.write({ text: `WITH team AS (INSERT INTO sys_team (id, name) VALUES ('t-con', 'Contractors') RETURNING id)
		INSERT INTO sys_user (id, email, name, admin, team, phone) VALUES
			('${ADA}', 'ada@ws.example', 'Ada', true, NULL, '+65 9123 4567'),
			('${CAL}', 'cal@ws.example', 'Cal', false, (SELECT id FROM team), '6598765432')`, params: [] });
});
const ok = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o.records[0]!.id; };
const job = async () => ok(await t.as(t.admin).act('jobs.create', { title: 'Kismis', status: 'open' }));
const status = async (id: string) => (await t.as(t.admin).get('jobs', id))!['status'];
let seq = 0;
const say = async (channel: 'field_wa' | 'sales_tg', from: string, body: string, over: { [k: string]: Json } = {}) => {
	const port = channel === 'field_wa' ? t.fakes.transports.whatsapp : t.fakes.transports.telegram;
	await port.emit({ kind: 'inbound', channel, message: { id: `m${++seq}`, thread: from, sentAt: t.clock.now(), from: { handle: from, name: null }, text: body, attachments: [], ...over } });
	await t.settled();
};
const inbound = async (body: string) => (await t.db.read([{ text: `SELECT "as", addressed, refused, role FROM sys_message WHERE direction = 'inbound' AND text = $1`, params: [body] }]))[0]!.rows[0];
const sentTexts = () => t.fakes.transports.whatsapp.sent.map((s) => (s.message as { text: string }).text);

describe('envoys through the engine entry (P22, rules 57–60)', () => {
	it('an authenticated WhatsApp DM from an administrator updates a record the envoy\'s policies cannot', async () => {
		const id = await job();
		await say('field_wa', '6591234567:14@s.whatsapp.net', `close ${id}`);
		expect(await status(id)).toBe('done');
		expect(await inbound(`close ${id}`)).toMatchObject({ as: { envoy: { member: ADA, dm: true } }, role: 'user' });
		expect(t.fakes.transports.whatsapp.sent.at(-1)!.message).toMatchObject({ to: '6591234567:14@s.whatsapp.net' });
	});

	it('a linked contractor\'s DM holds only what the envoy\'s policies or the contractor team grant (P32)', async () => {
		const id = await job();
		await say('field_wa', '6598765432@s.whatsapp.net', `close ${id}`);
		expect(await status(id)).toBe('open');
		expect(await inbound(`close ${id}`)).toMatchObject({ as: { envoy: { member: CAL, dm: true } } });
		expect(sentTexts().at(-1)).toMatch(/No tool 'act'|forbidden|refused/i);
	});

	it('an unlinked sender gets one registration notice and no turn', async () => {
		await say('field_wa', '6590000001@s.whatsapp.net', 'hello?');
		await say('field_wa', '6590000001@s.whatsapp.net', 'anyone?');
		expect(ai.requests).toBe(0);
		expect(sentTexts()).toHaveLength(1);
		expect(sentTexts()[0]).toContain('Register this whatsapp account with Acme Field to continue.');
		expect(await inbound('anyone?')).toMatchObject({ refused: 'unregistered', role: null });
	});

	it('a group under mention_or_reply keeps chatter ambient; every addressed message runs under the envoy\'s policies, an administrator\'s too (P32)', async () => {
		const group = { thread: '1203@g.us', group: true };
		const id = await job();
		await say('field_wa', '6591234567@s.whatsapp.net', 'running late', { ...group, invocation: 'ambient' });
		expect(ai.requests).toBe(0);
		expect(await inbound('running late')).toMatchObject({ addressed: false, role: null });
		await say('field_wa', '6598765432@s.whatsapp.net', `close ${id}`, { ...group, invocation: 'mention' });
		expect(await status(id)).toBe('open');
		await say('field_wa', '6591234567@s.whatsapp.net', `close ${id}`, { ...group, invocation: 'reply', id: 'ada-close' });
		expect(await status(id)).toBe('open');
		const rows = (await t.db.read([{ text: `SELECT "as" FROM sys_message WHERE direction = 'inbound' AND addressed ORDER BY seq`, params: [] }]))[0]!.rows;
		expect(rows.map((r) => (r['as'] as { envoy: { member: string; dm: boolean } }).envoy)).toMatchObject([{ member: CAL, dm: false }, { member: ADA, dm: false }]);
		expect(t.fakes.transports.whatsapp.sent.every((s) => (s.message as { to: string }).to === '1203@g.us')).toBe(true);
	});

	it('a public Telegram envoy runs an unlinked sender\'s turn under its own policies, never admin', async () => {
		const id = await job();
		await say('sales_tg', '777', `close ${id}`);
		expect(ai.requests).toBeGreaterThan(0);
		expect(await status(id)).toBe('open');
		expect(await inbound(`close ${id}`)).toMatchObject({ as: { envoy: { name: 'sales_desk', channel: 'sales_tg', sender: '777', member: null, dm: true } } });
		expect(t.fakes.transports.telegram.sent).toHaveLength(1);
	});
});

describe('channels through the engine entry (rule 61)', () => {
	it('a record-driven email is queued in the writing statement, sent once by the delivery run, and delivery events patch the row', async () => {
		t.count.reset();
		const id = ok(await t.as(t.member(['staff'])).act('sent_emails.create', { to: 'carol@acme.com', subject: 'PCN 1234', body: 'Your parts change.' }));
		expect(t.count.writes).toBe(1);
		await t.runDue();
		await t.runDue();
		const mail = t.fakes.transports.email;
		expect(mail.sent).toHaveLength(1);
		expect(mail.sent[0]!.message).toMatchObject({ to: ['carol@acme.com'], subject: 'PCN 1234', thread: id, from: 'support' });
		await mail.emit({ kind: 'delivery', channel: 'customer_mail', providerId: mail.sent[0]!.providerId, event: 'delivered', at: '2026-09-25T10:01:00.000Z' });
		expect(await t.as(t.admin).get('sent_emails', id)).toMatchObject({ sent_at: { $t: t.clock.now() }, delivered_at: { $t: '2026-09-25T10:01:00.000Z' } });
	});

	it('a notice on a declared channel is queued by the writing statement and reaches each named member\'s handle there (rule 47)', async () => {
		t.count.reset();
		ok(await t.as(t.member(['staff'], { id: ADA })).act('tickets.create', { title: 'Leak' }));
		expect(t.count.writes).toBe(1);
		const [queued] = await t.db.read([{ text: `SELECT n.recipient->>'channel' AS channel, (SELECT count(*)::int FROM sys_run r WHERE r.automation = 'notifications.deliver') AS runs
			FROM sys_notification n ORDER BY 1`, params: [] }]);
		expect(queued!.rows).toEqual([{ channel: 'customer_mail', runs: 1 }, { channel: 'field_wa', runs: 1 }]);
		await t.runDue();
		await t.runDue();
		expect(t.fakes.transports.email.sent.map((s) => s.message).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
			.toMatchObject([{ to: ['ada@ws.example'], subject: 'New ticket', text: 'A ticket was opened.' }, { to: ['cal@ws.example'], subject: 'New ticket' }]);
		expect(t.fakes.transports.whatsapp.sent.map((s) => s.message)).toMatchObject([{ to: '6598765432@s.whatsapp.net', text: 'New ticket' }]);
		await t.runDue(); // a re-run of the same notices sends nothing twice
		expect(t.fakes.transports.email.sent).toHaveLength(2);
	});

	it('an approval hold notifies the step approvers in their inbox, one row per member (L-BOLT-354)', async () => {
		await t.db.write({ text: `WITH team AS (INSERT INTO sys_team (id, name) VALUES ('t-fin', 'Finance') RETURNING id)
			INSERT INTO sys_user (id, email, name, team) SELECT v.id, v.email, v.name, (SELECT id FROM team) FROM (VALUES ('u-fay', 'fay@ws.example', 'Fay'),
				('u-fin', 'fin@ws.example', 'Fin')) v(id, email, name)`, params: [] });
		const held = await t.as(t.member(['sales'], { teamPath: ['Sales'] })).act('orders.create', { title: 'desk' });
		expect(held.kind).toBe('pendingApproval');
		const [rows] = await t.db.read([{ text: `SELECT member, title, link->>'collection' AS c, read_at FROM sys_notification ORDER BY member`, params: [] }]);
		expect(rows!.rows).toEqual([{ member: 'u-fay', title: 'Awaiting your decision', c: 'orders', read_at: null },
			{ member: 'u-fin', title: 'Awaiting your decision', c: 'orders', read_at: null }]);
	});
});
