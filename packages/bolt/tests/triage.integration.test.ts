// System 1 triage (P31, P33, rule 60a; §11.2 G12 (10)) through the engine entry and the test kit: a scripted
// `ai.system1` (no vendor) decides when admitted envoy and in-app messages start a turn; the kit's clock drives each exact-time
// re-check. Mentions and send-now are deterministic, a row is new input at most once, and every decision is costed.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { AiPort, EngineManifest, MeteringPort } from '../src/engine/contracts.ts';
import { TRIAGE_DEBOUNCE, TRIAGE_MAX_WAITS } from '../src/engine/agent/triage.ts';
import type { System1Port, System1Request } from '../src/engine/decisions/index.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: { jobs: { description: 'A job', label: 'title', fields: { title: { kind: 'text' }, status: { kind: 'text' } } } },
	relationships: {},
	collections: { jobs: { read: { fields: 'all' }, create: { input: { columns: ['title', 'status'] } }, update: { input: { columns: ['status'] } } } },
	integrations: {}, pipelines: {},
	policies: { desk: { description: 'Desk', grants: { jobs: { read: true } } }, contractor: { description: 'Contractors', grants: { jobs: { read: true } } } },
	teams: { Contractors: ['contractor'] },
	automations: {},
	channels: { field_wa: { transport: 'whatsapp' } },
	connections: {},
	envoys: { field_ops: { channel: 'field_wa', audience: 'private', name: 'Norbius', policies: ['desk'], groupMessages: 'mention_or_reply',
		delegation: 'disabled', triage: {}, task: 'Keep jobs up to date.' } },
	mcp: {}, apps: {}, customFields: {}, agent: { internal: 'Staff brief.', skills: {} },
} as unknown as EngineManifest;

/** Closes every "close <id>" no earlier tool call targeted; otherwise answers. Stateless over the transcript it is sent. */
/** A user message's text without its envelope's sender header (`[who] `). */
const text = (c: Json) => (typeof c === 'string' ? c : String((c as { text?: Json } | null)?.text ?? '')).replace(/^\[[^\]]*\]\s*/, '');
const ai: AiPort['sys_2'] & { requests: string[][]; raw: string[][] } = { models: ['default'], requests: [], raw: [],
	async infer(request) {
		const usage = { input: 10, output: 5 };
		ai.requests.push(request.messages.filter((m) => m.role === 'user' && !String(typeof m.content === 'string' ? m.content : '').startsWith('[conversation state]')).map((m) => text(m.content)));
		ai.raw.push(request.messages.filter((m) => m.role === 'user' && !String(typeof m.content === 'string' ? m.content : '').startsWith('[conversation state]')).map((m) => JSON.stringify(m.content)));
		const asked = new Set([...JSON.stringify(request.messages).matchAll(/\\?"target\\?":\\?"([\w-]+)/g)].map((x) => x[1]));
		const open = request.messages.filter((m) => m.role === 'user' && !String(typeof m.content === 'string' ? m.content : '').startsWith('[conversation state]')).flatMap((m) => [.../close ([\w-]+)/g.exec(text(m.content)) ?? []].slice(1)).find((id) => !asked.has(id));
		// "check the chatter" reads it once, as the unread note asks
		const read = request.messages.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('read_messages'));
		if (!read && request.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('check the chatter')))
			return { content: '', toolCalls: [{ id: `c${ai.requests.length}`, name: 'read_messages', input: {} }], finish: 'tool', usage };
		if (open !== undefined) return { content: '', toolCalls: [{ id: `c${ai.requests.length}`, name: 'act', input: { callable: 'jobs.update', input: { target: open, set: { status: 'done' } } } }], finish: 'tool', usage };
		return { content: 'Done.', toolCalls: [], finish: 'stop', usage };
	} };

type Action = 'respond' | 'wait' | 'ignore';
/** The verdict a scripted conversation-level action means for every message it covers. */
const VERDICT: { readonly [a in Action]: string } = { respond: 'yes', wait: 'delay', ignore: 'no' };
/** What the decider was shown, read back from System 1's state and the questions it was asked. */
type Seen = { kind: string; directive: string; assistant: string; pending: readonly string[]; asked: readonly string[] };
const seen = (r: System1Request): Seen => {
	const st = r.state as { directive: string; conversation: string; assistant: string; pending: readonly { text: string }[] };
	return { kind: st.conversation, directive: st.directive, assistant: st.assistant, pending: st.pending.map((p) => p.text),
		asked: Object.keys(r.questions).filter((id) => id !== 'wait') };
};
/**
 * A scripted System 1: answers from `script` in order (the last answer repeats); `throws` makes it fail. One question is
 * asked per pending message, all in the one call, and the script's conversation-level action is what each gets — so a
 * scenario reads as it always did while the request shape is the per-message one.
 */
function decider() {
	const port: System1Port & { inputs: Seen[]; answers: string[]; script: (Action | { action: Action; wait: number; p?: number })[]; throws: boolean } = {
		inputs: [], answers: [], script: ['respond'], throws: false,
		async ask(r) {
			port.inputs.push(seen(r));
			if (port.throws) throw new Error('provider down');
			const s = port.script[Math.min(port.inputs.length - 1, port.script.length - 1)]!;
			const d = typeof s === 'string' ? { action: s, wait: 2 } : s;
			port.answers.push(d.action);
			const p = 'p' in d && d.p !== undefined ? d.p : 0.9;
			const answers: Record<string, unknown> = {};
			for (const id of Object.keys(r.questions)) {
				if (id === 'wait') continue;
				answers[id] = { type: 'choice', choice: VERDICT[d.action], confidence: 0.9, probabilities: { [VERDICT[d.action]]: p } };
			}
			answers['wait'] = { type: 'score', score: d.wait, level: Math.round(d.wait), confidence: p, probabilities: {}, legend: {} };
			return { answers: answers as never, costUsd: 0.0002, provider: 'scripted' };
		} };
	return port;
}

let t: TestWorkspace, port: ReturnType<typeof decider>;
const metered: { meter: string; quantity: number; key: string }[] = [];
const metering: MeteringPort = { async record(meter, quantity, key) { metered.push({ meter, quantity, key }); } };
const ADA = 'u-ada', CAL = 'u-cal';
const open = async (o: { triage?: boolean; manifest?: EngineManifest } = {}) => {
	port = decider();
	ai.requests = []; ai.raw = [];
	metered.length = 0;
	t = await testWorkspace({ manifest: o.manifest ?? manifest, metering, ...(o.triage === false ? {} : { ai: { sys_1: port, sys_2: ai } }) });
	await t.db.write({ text: `WITH team AS (INSERT INTO sys_team (id, name) VALUES ('t-con', 'Contractors') RETURNING id)
		INSERT INTO sys_user (id, email, name, admin, team, phone) VALUES
			('${ADA}', 'ada@ws.example', 'Ada', true, NULL, '+65 9123 4567'),
			('${CAL}', 'cal@ws.example', 'Cal', false, (SELECT id FROM team), '6598765432')`, params: [] });
};
beforeEach(() => open());

let seq = 0;
const DM = '6591234567@s.whatsapp.net', GROUP = { thread: '1203@g.us', group: true };
const say = async (from: string, body: string, over: { [k: string]: Json } = {}) => {
	await t.fakes.transports.whatsapp.emit({ kind: 'inbound', channel: 'field_wa', message: { id: `m${++seq}`, thread: from, sentAt: t.clock.now(),
		from: { handle: from, name: null }, text: body, attachments: [], ...over } });
	await t.settled();
};
const q = async (sql: string, ...params: Json[]) => (await t.db.read([{ text: sql, params }]))[0]!.rows;
const row = async (body: string) => (await q(`SELECT state, ambient, delivered_turn, "as" FROM sys_message WHERE text = $1`, body))[0]!;
const queued = async () => q(`SELECT input, due_at::text AS due FROM sys_run WHERE automation = 'agent.triage' AND state = 'queued'`);
const job = async () => { const o = await t.as(t.admin).act('jobs.create', { title: 'Kismis', status: 'open' }); if (o.kind !== 'committed') throw new Error(o.kind); return o.records[0]!.id; };
/** The trailing debounce elapses (P40): the queued decision is due. */
const debounce = async () => { t.clock.advance(`${TRIAGE_DEBOUNCE / 1000}s`); await t.runDue(); };
const statusOf = async (id: string) => (await t.as(t.admin).get('jobs', id))!['status'];

/** Across every case: no decider `pending` holds a row an earlier decision admitted or ignored, and no pending row is delivered or ambient. */
async function neverTwice(): Promise<void> {
	const done = new Set<string>();
	port.inputs.forEach((input, i) => {
		for (const p of input.pending) expect(done.has(p)).toBe(false);
		if (port.answers[i] !== 'wait') for (const p of input.pending) done.add(p);
	});
	expect(await q(`SELECT id FROM sys_message WHERE state = 'pending' AND (delivered_turn IS NOT NULL OR ambient)`)).toEqual([]);
}

describe('envoy triage (G12 (10))', () => {
	it('a pending photo goes into the state as metadata only (P37 (3)); a sys_1 refusing the call Unsupported admits as respond', async () => {
		const states: System1Request['state'][] = [];
		const scripted = port.ask.bind(port);
		port.ask = async (r, signal) => { states.push(r.state); if (states.length === 2) throw { kind: 'unsupported', message: 'no images here' }; return scripted(r, signal); };
		const photo = async (text: string) => {
			await t.fakes.transports.whatsapp.emit({ kind: 'inbound', channel: 'field_wa', bins: [new Uint8Array([9, 9])], message: { id: `m${++seq}`, thread: DM,
				sentAt: t.clock.now(), from: { handle: DM, name: null }, text, attachments: [{ fileName: 'p.jpg', mimeType: 'image/jpeg', byteLength: 2, bin: 0 }] } });
			await t.settled();
			await debounce();
		};
		await photo('the pump, see photo');
		const pending = (states[0] as unknown as { pending: { attachments?: Json[] }[] }).pending;
		expect(pending[0]!.attachments![0]).toEqual({ name: 'p.jpg', mime: 'image/jpeg', size: 2 });
		await photo('and another one');
		expect(states).toHaveLength(2);
		expect((await row('and another one'))['delivered_turn']).not.toBeNull(); // the failure outcome: respond
		const events = await q(`SELECT severity, attributes FROM sys_event WHERE event = 'decision.made' ORDER BY severity`);
		expect(events.map((e) => [e['severity'], (e['attributes'] as { error?: string }).error ?? null, (e['attributes'] as { action: string }).action]))
			.toEqual([['info', null, 'respond'], ['warn', 'unsupported', 'respond']]);
	});

	it('a DM in three parts within 20 s is one turn after the decider waits; each elapsed wait re-asks with the pending set as it is', async () => {
		port.script = ['wait', 'wait', 'wait', 'respond'];
		await say(DM, 'the Kismis job');
		await debounce();
		expect(port.inputs.map((i) => i.pending.length)).toEqual([1]);
		t.clock.advance('10s');
		await t.runDue(); // the wait elapsed: asked again, nothing new
		expect(port.inputs.map((i) => i.pending.length)).toEqual([1, 1]);
		t.clock.advance('4s');
		await say(DM, 'is finished');
		await debounce(); // a new part re-triages once the sender pauses
		t.clock.advance('4s');
		await say(DM, 'mark it done please');
		await debounce();
		expect(port.inputs.map((i) => i.pending.length)).toEqual([1, 1, 2, 3]);
		expect(port.inputs[0]).toMatchObject({ kind: 'envoy DM', assistant: 'Norbius', asked: ['m0'], directive: 'Keep jobs up to date.' });
		expect(ai.requests).toHaveLength(1);
		const turns = new Set(await Promise.all(['the Kismis job', 'is finished', 'mark it done please'].map(async (b) => (await row(b))['delivered_turn'])));
		expect(turns.size).toBe(1);
		expect([...turns][0]).not.toBeNull();
		expect(await queued()).toHaveLength(0); // an idle conversation queues no decision
		await neverTwice();
		const events = await q(`SELECT attributes FROM sys_event WHERE event = 'decision.made'`);
		expect(events).toHaveLength(4);
		expect(events.every((e) => (e['attributes'] as { costUsd: number }).costUsd === 0.0002)).toBe(true);
		expect(metered).toHaveLength(4);
		expect(metered[0]).toMatchObject({ meter: 'ai', quantity: 0.0002 });
	});

	it('a guessed wait (under 0.7) answers at once: silence costs the person, a coin flip is no reason for it', async () => {
		port.script = [{ action: 'wait', wait: 1, p: 0.58 }];
		await say(DM, 'run the review for the Kismis job');
		await debounce();
		expect(port.inputs).toHaveLength(1);
		expect((await row('run the review for the Kismis job'))['delivered_turn']).not.toBeNull();
	});

	it('a wait is at most 2 s, with the channel showing typing; after 12 consecutive waits the rows are admitted with no 13th call; a new row resets the count', async () => {
		port.script = [{ action: 'wait', wait: 2 }];
		await say(DM, 'part one');
		await debounce();
		expect(Date.parse(String((await queued())[0]!['due'])) - Date.parse(t.clock.now())).toBe(2_000);
		// the person sees the assistant is on it rather than silence
		expect(t.fakes.transports.whatsapp.typed).toEqual([{ channel: 'field_wa', to: DM }]);
		for (let i = 1; i < 5; i++) { t.clock.advance('10s'); await t.runDue(); }
		expect((await queued())[0]!['input']).toMatchObject({ waits: 5 });
		await say(DM, 'part two');
		expect((await queued())[0]!['input']).toMatchObject({ waits: 0 });
		t.clock.advance(`${TRIAGE_DEBOUNCE / 1000}s`);
		for (let i = 0; i <= TRIAGE_MAX_WAITS; i++) { await t.runDue(); t.clock.advance('10s'); }
		expect(port.inputs).toHaveLength(5 + TRIAGE_MAX_WAITS);
		expect(ai.requests).toHaveLength(1);
		expect((await row('part two'))['delivered_turn']).not.toBeNull();
		await neverTwice();
	});

	it('group chatter the decider ignores makes no turn and stays readable; a mention admits the pending rows at once with no decision call', async () => {
		port.script = ['ignore'];
		await say(DM.replace('6591234567', '6598765432'), 'lunch?', GROUP);
		await debounce();
		expect(port.inputs[0]).toMatchObject({ kind: 'envoy group' });
		expect(await row('lunch?')).toMatchObject({ state: null, ambient: true, delivered_turn: null });
		expect(ai.requests).toHaveLength(0);

		const calls = port.inputs.length;
		await say(DM, 'the van is late', GROUP);
		await say(DM, '@bot note that', { ...GROUP, invocation: 'mention' });
		expect(port.inputs).toHaveLength(calls);
		expect(ai.requests).toHaveLength(1);
		expect(ai.requests[0]).not.toContain('lunch?'); // ignored: never new input
		expect((await row('the van is late'))['delivered_turn']).toBe((await row('@bot note that'))['delivered_turn']);
		await debounce(); // the decision the chatter queued was flushed
		expect(port.inputs).toHaveLength(calls);
		await neverTwice();
	});

	it('an ignored photo is what read_messages reads, and a mention quoting it carries its text and file into the turn', async () => {
		port.script = ['ignore'];
		await t.fakes.transports.whatsapp.emit({ kind: 'inbound', channel: 'field_wa', bins: [new Uint8Array([9, 9])], message: { id: 'photo1', ...GROUP, sentAt: t.clock.now(),
			from: { handle: DM, name: 'Dion' }, text: 'Put this in to kismi', attachments: [{ fileName: 'p.jpg', mimeType: 'image/jpeg', byteLength: 2, bin: 0 }] } });
		await t.settled();
		await debounce();
		expect(await row('Put this in to kismi')).toMatchObject({ state: null, ambient: true });

		await say(DM, '@bot check the chatter', { ...GROUP, invocation: 'mention', replyTo: 'photo1' });
		const turn = ai.raw[0]!.join('\n');
		expect(turn).toContain('[replying to Dion');
		expect(turn).toContain('Put this in to kismi');
		expect(turn).toMatch(/attachment seq \d+ file 0: p\.jpg/);
		const [read] = await q(`SELECT content FROM sys_message WHERE role = 'tool' AND content->>'name' = 'read_messages'`);
		expect(JSON.stringify(read!['content'])).toContain('Put this in to kismi');
	});

	it('triaged group chatter is charged like an addressed message: over envoys.receive it stays unaddressed, unanswered and never decided', async () => {
		await open({ manifest: { ...manifest, policies: { ...manifest.policies, desk: { ...manifest.policies['desk'], limits: { 'envoys.receive': [{ rate: '2/min', per: 'sender' }] } } } } as unknown as EngineManifest });
		port.script = ['ignore'];
		const cal = DM.replace('6591234567', '6598765432');
		for (const n of [1, 2, 3]) await say(cal, `chat ${n}`, GROUP);
		await debounce();
		expect((await q(`SELECT state, addressed, refused FROM sys_message WHERE text = 'chat 3'`))[0]).toEqual({ state: null, addressed: false, refused: null });
		expect(port.inputs.flatMap((i) => i.pending)).not.toContain('chat 3');
		expect(t.fakes.transports.whatsapp.sent).toHaveLength(0); // no "slow down" line into the group
	});

	it('a collated group turn acts under the envoy\'s policy (P32), each sender header in its input', async () => {
		const [mine, theirs] = [await job(), await job()];
		await say('6598765432@s.whatsapp.net', `close ${theirs}`, GROUP); // Cal, a contractor
		await say(DM, `close ${mine}`, GROUP); // Ada, an administrator
		await debounce();
		expect(port.inputs[0]!.pending).toHaveLength(2);
		expect(ai.raw.at(-1)!.join()).toMatch(/linked member u-cal[\s\S]*linked member u-ada/); // both sender headers
		expect(await statusOf(mine)).toBe('open'); // `desk` reads only, whoever the administrator is
		expect(await statusOf(theirs)).toBe('open');
	});

	it('a failed System 1 call answers a DM but keeps a group quiet (ambient); the failure is recorded, nothing is metered', async () => {
		port.throws = true;
		await say(DM, 'hello');
		await say('6598765432@s.whatsapp.net', 'chatter', GROUP);
		await debounce();
		expect((await row('hello'))['delivered_turn']).not.toBeNull();
		expect(await row('chatter')).toMatchObject({ delivered_turn: null, ambient: true });
		const events = await q(`SELECT severity, attributes FROM sys_event WHERE event = 'decision.made'`);
		expect(events.length).toBeGreaterThan(0);
		expect(events.every((e) => e['severity'] === 'warn' && (e['attributes'] as { error?: string; use: string }).error === 'upstream')).toBe(true);
		expect(metered).toHaveLength(0);
	});

	it('an envoy built before names were required is asked about generically, never as an empty name', async () => {
		// a tenant's active release is a built artifact that outlives its template: an artifact from before `name` was
		// required declares none, and `names you ()` is worse than not naming it. The wording is the generic one.
		const nameless = { ...manifest, envoys: { field_ops: { channel: 'field_wa', audience: 'private', policies: ['desk'],
			groupMessages: 'mention_or_reply', delegation: 'disabled', triage: {}, task: 'Keep jobs up to date.' } } } as unknown as EngineManifest;
		await open({ manifest: nameless });
		await say(DM, 'hello');
		await debounce();
		expect(port.inputs[0]!.assistant).toBe('the assistant');
		expect(port.inputs[0]!.assistant).not.toBe('');
		expect((await row('hello'))['delivered_turn']).not.toBeNull();
	});

	it('with no AI facility every message behaves as without triage', async () => {
		await open({ triage: false });
		await say(DM, 'hello');
		expect((await row('hello'))['delivered_turn']).not.toBeNull();
		await say(DM, 'chatter', GROUP);
		expect(await row('chatter')).toMatchObject({ state: null, delivered_turn: null });
		expect(await queued()).toHaveLength(0);
	});
});

describe('in-app triage', () => {
	const start = () => t.engine.agents.start({ owner: ADA });
	it('two plain-Enter parts are one turn; a one-to-one chat is never offered ignore and reads it as respond', async () => {
		const c = await start();
		port.script = ['wait', 'ignore'];
		await t.engine.triage.post({ conversation: c, as: { member: ADA }, text: 'draft a note', author: ADA, mode: 'agent' });
		await debounce();
		await t.engine.triage.post({ conversation: c, as: { member: ADA }, text: 'for the Kismis job', author: ADA, mode: 'agent' });
		await debounce();
		// one question per pending message, both parts of the second decision in the same call; in-app the agent is Norbius
		expect(port.inputs.map((i) => [i.kind, i.assistant, i.asked.length, i.pending.length])).toEqual([['in-app, one-to-one', 'Norbius', 1, 1], ['in-app, one-to-one', 'Norbius', 2, 2]]);
		expect(ai.requests).toHaveLength(1);
		expect(ai.requests[0]).toEqual(['draft a note', 'for the Kismis job']);
		await neverTwice();
	});

	it('a plain-Enter post keeps the person\'s timezone on its row, as a send-now does (rule 57)', async () => {
		const c = await start();
		await t.engine.triage.post({ conversation: c, as: { member: ADA }, text: 'what time is it', author: ADA, mode: 'agent', tz: 'Asia/Singapore' });
		expect((await q(`SELECT content FROM sys_message WHERE text = 'what time is it'`))[0]!['content']).toEqual({ text: 'what time is it', tz: 'Asia/Singapore' });
	});

	it('send-now admits every pending row at once and asks no decider', async () => {
		const c = await start();
		await t.engine.triage.post({ conversation: c, as: { member: ADA }, text: 'part', author: ADA, mode: 'agent' });
		await t.engine.triage.release(c);
		await t.engine.agents.post({ conversation: c, as: { member: ADA }, text: 'now', author: ADA });
		await t.engine.agents.drain(c);
		expect(ai.requests).toEqual([['part', 'now']]);
		await t.runDue();
		expect(port.inputs).toHaveLength(0);
	});

	it('a shared conversation may be ignored: the rows become ambient and start nothing', async () => {
		const c = await start();
		port.script = ['ignore'];
		await t.engine.triage.post({ conversation: c, as: { member: ADA }, text: 'one', author: ADA, mode: 'agent' });
		await t.engine.triage.post({ conversation: c, as: { member: CAL }, text: 'two', author: CAL, mode: 'agent' });
		await debounce();
		expect(port.inputs[0]).toMatchObject({ kind: 'in-app, shared', assistant: 'Norbius', asked: ['m0', 'm1'] });
		expect(await row('two')).toMatchObject({ ambient: true, delivered_turn: null });
		expect(ai.requests).toHaveLength(0);
	});

	it('a message that names the assistant is answered like a mention, in a shared conversation too: no decision call', async () => {
		// seen on staging: "Hello norbius" in a shared panel conversation was judged "Not for the assistant"
		const c = await start();
		port.script = ['ignore'];
		await t.engine.triage.post({ conversation: c, as: { member: ADA }, text: 'one', author: ADA, mode: 'agent' });
		await t.engine.triage.post({ conversation: c, as: { member: CAL }, text: 'two', author: CAL, mode: 'agent' });
		await debounce(); // shared, and the decider ignores the chatter
		expect(await row('two')).toMatchObject({ ambient: true, delivered_turn: null });
		const calls = port.inputs.length;
		await t.engine.triage.post({ conversation: c, as: { member: ADA }, text: 'Hello norbius', author: ADA, mode: 'agent' });
		await debounce();
		expect(port.inputs).toHaveLength(calls);
		expect((await row('Hello norbius'))['delivered_turn']).not.toBeNull();
		expect(ai.requests.at(-1)).toContain('Hello norbius');
	});

	it('`agent: { triage: false }` opts the in-app agent out', async () => {
		expect(t.engine.triage.inApp()).toBe(true);
		const off = await testWorkspace({ manifest: { ...manifest, workspace: { ...manifest.workspace, agent: { triage: false } } }, ai: { sys_1: port, sys_2: ai } });
		expect(off.engine.triage.inApp()).toBe(false);
	});
});
