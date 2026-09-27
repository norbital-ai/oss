// engine/envoys on PGlite with the agent area's real turn loop and a scripted model (P22, P32, rules 57–61; G12 (4), (5)):
// a DM holds the envoy's policies joined by the linked sender's own authority (an administrator's DM update commits
// where the envoy's policies would refuse it; a contractor's DM does what the contractor's team grants), a group turn
// holds the envoy's policies alone whoever sends, an unlinked sender gets one private registration notice per 15
// minutes and no turn, a public desk resolves its senders, chat replies leave while the turn works, and `envoys.receive`
// bounds admission.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import { agents } from '../src/engine/agent/index.ts';
import { fakeTransport, type FakeTransport } from '../src/engine/channels/transports.ts';
import type { AiPort, AiRequest, EngineManifest } from '../src/engine/contracts.ts';
import { messaging, NOTICES } from '../src/engine/envoys/index.ts';
import { testWorkspace, type TestWorkspace, respondSystem1 } from '../src/test/index.ts'; // hook:decisions

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, // hook:decisions — not a triage test (rule 60a opt-out)
	models: { jobs: { description: 'A job', label: 'title', fields: { title: { kind: 'text' }, status: { kind: 'text' } } } },
	relationships: {},
	collections: { jobs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'status'] } }, update: { input: { columns: ['status'] } } } },
	integrations: {}, pipelines: {},
	policies: {
		desk: { description: 'What the envoys may do', grants: { jobs: { read: true, create: true } }, limits: { 'envoys.receive': [{ rate: '3/min', per: 'sender' }] } },
		contractor: { description: 'Contractors', grants: { jobs: { read: true, update: true } } },
	},
	teams: { Contractors: ['contractor'] },
	automations: {},
	channels: { field_wa: { transport: 'whatsapp' }, sales_tg: { transport: 'telegram' }, ops_mail: { transport: 'email', address: 'ops' } },
	connections: {},
	envoys: {
		field_ops: { channel: 'field_wa', audience: 'authenticated', policies: ['desk'], triage: false, groupMessages: 'mention_or_reply', delegation: 'disabled', task: 'Keep jobs up to date.' },
		sales_desk: { channel: 'sales_tg', audience: 'public', policies: ['desk'], triage: false, groupMessages: 'disabled', delegation: 'enabled', task: 'Answer about jobs.' },
		ops_desk: { channel: 'ops_mail', audience: 'authenticated', policies: ['desk'], triage: false, delegation: 'disabled', task: 'Answer mail.' },
	},
	mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

/**
 * A scripted model: a message whose own line is "close <id>" says "On it." and asks for `act jobs.update`; after a tool
 * result it answers "Done." (noting what the chat had already been sent); else it echoes.
 */
function scriptedAi() {
	const requests: AiRequest[] = [], sentBeforeEnd: string[][] = [];
	let n = 0;
	const text = (c: Json) => typeof c === 'string' ? c : String((c as { text?: Json } | null)?.text ?? '');
	const ai: AiPort & { requests: AiRequest[]; sentBeforeEnd: string[][] } = { requests, sentBeforeEnd, sys_1: respondSystem1, sys_2: { models: ['default'],
		async infer(request) {
			requests.push(request);
			const usage = { input: 10, output: 5 };
			const last = request.messages.findLast((m) => !(typeof m.content === 'string' && m.content.startsWith('[conversation state]')))!; // the step's closing note is the engine's, not a message
			if (last.role === 'tool') { sentBeforeEnd.push(texts(wa)); return { content: 'Done.', toolCalls: [], finish: 'stop', usage }; }
			// the command is its own line of the message, after the envelope's header (never a word inside the header)
			const close = /^(?:\[[^\]\n]*\] )?close (\S+)$/m.exec(text(last.content));
			if (close !== null) return { content: 'On it.', toolCalls: [{ id: `c${++n}`, name: 'act', input: { callable: 'jobs.update', input: { target: close[1]!, set: { status: 'done' } } } }], finish: 'tool', usage };
			return { content: `echo: ${text(last.content)}`, toolCalls: [], finish: 'stop', usage };
		} } };
	return ai;
}

let t: TestWorkspace, wa: FakeTransport, tg: FakeTransport, mail: FakeTransport, ai: ReturnType<typeof scriptedAi>, desk: ReturnType<typeof messaging>;
const ADA = 'u-ada', CAL = 'u-cal', DANA = 'u-dana';
beforeEach(async () => {
	t = await testWorkspace({ manifest });
	await t.db.write({ text: `WITH team AS (INSERT INTO sys_team (id, name) VALUES ('t-con', 'Contractors') RETURNING id)
		INSERT INTO sys_user (id, email, name, admin, team, phone) VALUES
			('${ADA}', 'ada@ws.example', 'Ada', true, NULL, '+65 9123 4567'),
			('${CAL}', 'cal@ws.example', 'Cal', false, (SELECT id FROM team), '6598765432'),
			('${DANA}', 'dana@ws.example', 'Dana', false, (SELECT id FROM team), NULL)`, params: [] });
	wa = fakeTransport('wa'); tg = fakeTransport('tg'); mail = fakeTransport('mail');
	ai = scriptedAi();
	const turns = agents({ engine: t.engine, ai, bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
	desk = messaging({ engine: t.engine, agents: turns, transports: { whatsapp: wa, telegram: tg, email: mail }, clock: () => t.clock.now(), workspace: 'Acme Field' });
	desk.channels.subscribe();
});
const job = async () => {
	const o = await t.as(t.admin).act('jobs.create', { title: 'Kismis', status: 'open' });
	if (o.kind !== 'committed') throw new Error(o.kind);
	return o.records[0]!.id;
};
const status = async (id: string) => (await t.as(t.admin).get('jobs', id))!['status'];
let seq = 0;
const say = async (channel: 'field_wa' | 'sales_tg', from: string, text: string, over: { [k: string]: Json } = {}) => {
	const port = channel === 'field_wa' ? wa : tg;
	await port.emit({ kind: 'inbound', channel, message: { id: `m${++seq}`, thread: from, sentAt: t.clock.now(), from: { handle: from, name: null }, text, attachments: [], ...over } });
	await desk.envoys.settled();
};
const rows = async (text: string) => (await t.db.read([{ text: `SELECT "as", addressed, refused, role, state FROM sys_message WHERE direction = 'inbound' AND text = $1`, params: [text] }]))[0]!.rows;
const texts = (port: FakeTransport) => port.sent.map((s) => (s.message as { text: string }).text);

describe('direct messages (rule 57)', () => {
	it('a linked administrator\'s DM holds the envoy\'s policies and her bypass: her update commits where the envoy\'s would refuse it; the interim line left first', async () => {
		const id = await job();
		await say('field_wa', '6591234567:14@s.whatsapp.net', `close ${id}`);
		expect(await status(id)).toBe('done');
		expect((await rows(`close ${id}`))[0]).toMatchObject({ as: { envoy: { name: 'field_ops', member: ADA, dm: true } }, role: 'user', state: 'consumed' });
		expect(texts(wa).at(-1)).toMatch(/^Done\.\nSaved: jobs /);
		expect(wa.sent.at(-1)!.message).toMatchObject({ to: '6591234567:14@s.whatsapp.net' });
		expect(ai.sentBeforeEnd[0]).toEqual(['On it.']); // streamed while the turn worked, not at its end (parity 2.12)
	});

	it('a linked contractor\'s DM does what the contractor\'s team grants on top of the envoy\'s policies', async () => {
		const id = await job();
		await say('field_wa', '6598765432@s.whatsapp.net', `close ${id}`);
		expect(await status(id)).toBe('done');
		expect((await rows(`close ${id}`))[0]!['as']).toEqual({ envoy: { name: 'field_ops', channel: 'field_wa', sender: '6598765432@s.whatsapp.net', member: CAL, dm: true } });
	});

	it('an unlinked sender gets one host-authored registration notice per 15 minutes and no turn; redeeming links the number and replays only when ticked', async () => {
		await say('field_wa', '6590000003@s.whatsapp.net', 'someone else');
		await say('field_wa', '6590000001@s.whatsapp.net', 'hello?');
		await say('field_wa', '6590000001@s.whatsapp.net', 'anyone?');
		expect(ai.requests).toHaveLength(0);
		expect(texts(wa)).toHaveLength(2);
		expect(texts(wa)[1]).toContain('Register this whatsapp account with Acme Field to continue.');
		expect((await rows('anyone?'))[0]).toMatchObject({ refused: 'unregistered', role: null });
		const claim = /claim=([\w-]+)/.exec(texts(wa)[1]!)![1]!;
		expect(await desk.envoys.inspect(claim)).toEqual({ state: 'ready', envoy: 'field_ops', transport: 'whatsapp', handle: '6590000001' });
		const dana = await t.signIn('dana@ws.example');
		expect(await desk.envoys.redeem(claim, dana, { replay: true })).toMatchObject({ state: 'registered', envoy: 'field_ops' });
		await desk.envoys.settled();
		const [u] = await t.db.read([{ text: `SELECT phone FROM sys_user WHERE id = $1`, params: [DANA] }]);
		expect(u!.rows[0]!['phone']).toBe('6590000001');
		expect((await rows('anyone?'))[0]).toMatchObject({ as: { envoy: { member: DANA, dm: true } }, refused: null });
		expect((await rows('someone else'))[0]).toMatchObject({ refused: 'unregistered', role: null });
		expect(await desk.envoys.inspect(claim)).toEqual({ state: 'registered' });
		expect(await desk.envoys.redeem(claim, await t.signIn('cal@ws.example'))).toEqual({ state: 'used' });
		t.clock.advance('16min');
		await say('field_wa', '6590000002@s.whatsapp.net', 'hi');
		expect(texts(wa).filter((x) => x.startsWith('Register'))).toHaveLength(3);
	});

	it('a public desk resolves its senders: an unlinked one\'s turn holds exactly its policies, never admin; group messages are ignored', async () => {
		const id = await job();
		await say('sales_tg', '777', `close ${id}`);
		expect(await status(id)).toBe('open');
		expect((await rows(`close ${id}`))[0]!['as']).toEqual({ envoy: { name: 'sales_desk', channel: 'sales_tg', sender: '777', member: null, dm: true } });
		const before = ai.requests.length;
		await say('sales_tg', '888', 'group chatter', { thread: '-100', group: true, invocation: 'mention' });
		expect(ai.requests).toHaveLength(before);
		expect((await rows('group chatter'))[0]).toMatchObject({ role: null, addressed: null });
	});

	it('any member may verify an additional email address through registration; the envoy then knows them by it (P32, as today)', async () => {
		const mailFrom = (id: string, text: string) => mail.emit({ kind: 'inbound', channel: 'ops_mail', message: { id, thread: null, sentAt: t.clock.now(),
			from: { address: 'Dana.Home@else.example', name: 'Dana' }, replyTo: null, to: [], cc: [], subject: 'Hi', text, html: null, headers: {}, attachments: [] } });
		await mailFrom('<d1@x>', 'from home');
		await desk.envoys.settled();
		const claim = /claim=([\w-]+)/.exec((mail.sent.at(-1)!.message as { text: string }).text)![1]!;
		expect(mail.sent.at(-1)!.message).toMatchObject({ to: ['dana.home@else.example'] });
		expect(await desk.envoys.redeem(claim, await t.signIn('dana@ws.example'))).toMatchObject({ state: 'registered' });
		await mailFrom('<d2@x>', 'again from home');
		await desk.envoys.settled();
		expect((await rows('again from home'))[0]).toMatchObject({ as: { envoy: { member: DANA, dm: true } }, refused: null });
	});

	it('an email envoy treats every message as addressed and answers in the thread', async () => {
		await mail.emit({ kind: 'inbound', channel: 'ops_mail', message: { id: '<q1@x>', thread: null, sentAt: t.clock.now(), from: { address: 'Ada@ws.example', name: 'Ada' },
			replyTo: null, to: [], cc: [], subject: 'Status', text: 'how are we?', html: null, headers: {}, attachments: [] } });
		await desk.envoys.settled();
		expect(mail.sent.at(-1)!.message).toMatchObject({ to: ['ada@ws.example'], subject: 'Re: Status', thread: '<q1@x>' });
		expect((mail.sent.at(-1)!.message as { text: string }).text).toContain('how are we?');
	});
});

describe('groups (rule 60)', () => {
	const group = { thread: '1203@g.us', group: true };
	it('an unaddressed message is ambient: stored, never a turn; a mention or a reply is admitted', async () => {
		await say('field_wa', '6591234567@s.whatsapp.net', 'running late', { ...group, invocation: 'ambient' });
		expect(ai.requests).toHaveLength(0);
		expect((await rows('running late'))[0]).toMatchObject({ addressed: false, role: null });
		await say('field_wa', '6591234567@s.whatsapp.net', '@bot status', { ...group, invocation: 'mention' });
		await say('field_wa', '6598765432@s.whatsapp.net', 'and mine?', { ...group, invocation: 'reply' });
		expect(ai.requests).toHaveLength(2);
		expect(wa.sent.every((s) => (s.message as { to: string }).to === '1203@g.us')).toBe(true);
	});

	it('every group turn holds the envoy\'s policies alone: an administrator\'s update is refused; each message keeps its sender header, and a turn sees the whole transcript (P32)', async () => {
		const id = await job();
		await say('field_wa', '6591234567@s.whatsapp.net', `close ${id}`, { ...group, invocation: 'mention' });
		expect(await status(id)).toBe('open');
		await say('field_wa', '6598765432@s.whatsapp.net', 'what did Ada do?', { ...group, invocation: 'mention' });
		expect((await rows(`close ${id}`))[0]!['as']).toMatchObject({ envoy: { member: ADA, dm: false } });
		expect((await rows('what did Ada do?'))[0]!['as']).toMatchObject({ envoy: { member: CAL, dm: false } });
		const seen = JSON.stringify(ai.requests.at(-1)!.messages);
		expect(seen).toContain(`close ${id}`);
		expect(seen).toContain('Done.');
		expect(seen).toContain('linked member u-ada');
	});

	it('an unlinked member who mentions the bot gets the registration link privately, never in the group, and no turn', async () => {
		await say('field_wa', '6590000009@s.whatsapp.net', '@bot hi', { ...group, invocation: 'mention' });
		expect(ai.requests).toHaveLength(0);
		expect(wa.sent).toHaveLength(1);
		expect(wa.sent[0]!.message).toMatchObject({ to: '6590000009@s.whatsapp.net', text: expect.stringContaining('Register') });
		expect(wa.sent.some((s) => (s.message as { to: string }).to === '1203@g.us')).toBe(false);
	});
});

describe('admission limits and the human in the loop', () => {
	it('envoys.receive (the envoy\'s own policy, per sender) limits a flood; a limited message is recorded and answered once with a fixed line', async () => {
		for (const n of [1, 2, 3, 4, 5]) await say('field_wa', '6598765432@s.whatsapp.net', `m${n}`);
		expect(ai.requests).toHaveLength(3);
		expect((await rows('m4'))[0]).toMatchObject({ refused: 'rateLimited', role: null });
		expect(texts(wa).filter((x) => x === NOTICES.rateLimited)).toHaveLength(1);
		t.clock.advance('1min');
		await say('field_wa', '6598765432@s.whatsapp.net', 'later');
		expect(ai.requests).toHaveLength(4);
	});

	it('a public desk\'s turns share the desk-wide agent limit: the 101st distinct sender in an hour is limited (G12 (4))', async () => {
		for (let n = 1; n <= 101; n++) await say('sales_tg', `9${n}`, `hello ${n}`);
		expect(ai.requests).toHaveLength(100);
		expect((await rows('hello 101'))[0]).toMatchObject({ refused: 'rateLimited', role: null });
		t.clock.advance('1h');
		await say('sales_tg', '9102', 'next hour');
		expect(ai.requests).toHaveLength(101);
	});
});
