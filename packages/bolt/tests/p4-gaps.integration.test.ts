// P4 gaps over the host half on PGlite: the in-app agent's `/__bolt` callables (`sys_conversation.start`,
// `sys_message.post`, `sys_message.confirm`) with the transcript; envoy registration inspect
// and redeem through the shell host; web push of inbox notices through `bolt.push`; and the journal crash test
// (`t.crash`, rule 55).
import { describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { AiPort, AiResponse, EngineManifest, Outcome, TransportPort } from '../src/engine/contracts.ts';
import { RateWindows } from '../src/engine/access/rate.ts';
import { Authorities } from '../src/engine/identity/actor.ts';
import { issueClaim } from '../src/engine/envoys/registration.ts';
import { loadKeys, mint, type IdentityHost } from '../src/engine/identity/session.ts';
import { boltHandler } from '../src/protocol/http.ts';
import type { AgentRow } from '../src/protocol/wire.ts';
import { shellHost } from '../src/shell/host.ts';
import { testWorkspace, type TestWorkspace, respondSystem1 } from '../src/test/index.ts'; // hook:decisions

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } }, // hook:decisions — not a triage test (rule 60a opt-out)
	models: {
		quotes: { description: 'A quote', label: 'title', fields: { title: { kind: 'text' } } },
		logs: { description: 'A log line', label: 'line', fields: { line: { kind: 'text' } } },
	},
	relationships: {},
	collections: {
		quotes: { read: { fields: 'all' }, create: { input: { columns: ['title'] } },
			actions: { mark: { description: 'Mark a quote', input: { title: { kind: 'text' } }, output: { kind: 'text' }, agent: 'confirm' } } },
		logs: { read: { fields: 'all' }, create: { input: { columns: ['line'] } } },
	},
	policies: { rep: { description: 'Rep', grants: { quotes: { read: true, create: true, actions: ['mark'] }, logs: { read: true, create: true } } } },
	automations: { log: { description: 'Log each new quote', on: { created: 'quotes' }, runAs: ['rep'] } },
	envoys: { field: { channel: 'field', audience: 'authenticated', name: 'Norbius', policies: ['rep'], triage: false, groupMessages: 'disabled', delegation: 'disabled', task: 'Help.' } },
	channels: { field: { transport: 'whatsapp' } },
	agent: { internal: 'Staff brief.', skills: {} },
	integrations: {}, pipelines: {}, teams: {}, connections: {}, mcp: {}, apps: {}, customFields: {},
} as unknown as EngineManifest;
const guest = { source: `export default {
	collection: { quotes: { bodies: { actions: { mark: async (input, ctx) => (await ctx.act('quotes.create', { title: input.title })).records[0].id } } } },
	automation: { log: { body: async (input, ctx) => {
		for (const id of input.ids) await ctx.act('logs.create', { line: 'quote ' + id });
		await ctx.notify({ to: { policy: 'rep' }, title: 'Logged' });
	} } },
};` };

type Step = () => AiResponse;
const say = (text: string): Step => () => ({ content: text, toolCalls: [], finish: 'stop', usage: { input: 10, output: 5 } });
const use = (name: string, input: Json, id: string): Step => () => ({ content: '', toolCalls: [{ id, name, input }], finish: 'tool', usage: { input: 10, output: 5 } });
const cassette = (steps: Step[]): AiPort => { let i = 0; return { sys_1: respondSystem1, sys_2: { models: ['default'], async infer() { const s = steps[i++]; if (s === undefined) throw new Error('cassette exhausted'); return s(); } } }; };

async function setup(steps: Step[] = []) {
	const t = await testWorkspace({ manifest, guest, ai: cassette(steps) });
	const authorities = new Authorities(manifest, 'test');
	const user = async (id: string, o: { external?: boolean } = {}) => {
		await t.db.write({ text: `INSERT INTO sys_user (id, email, name, kind) VALUES ($1, $2, $3, $4)`, params: [id, `${id}@x.test`, id, o.external ? 'external' : 'staff'] });
		await t.db.write({ text: `INSERT INTO sys_assignment (id, principal_type, principal, policy) VALUES ($1, 'sys_user', $2, 'rep')`, params: [crypto.randomUUID(), id] });
		return id;
	};
	const bolt = boltHandler({ engine: t.engine, uuid: () => crypto.randomUUID(),
		session: async (r) => { const u = r.headers.get('x-user'); return u === null ? null : authorities.member(t.db, u); },
		bindings: () => ({ now: t.clock.now(), today: t.clock.now().slice(0, 10), tz: 'UTC', params: {} }) });
	const call = async (as: string, method: string, path: string, body?: unknown) => {
		const res = await bolt(new Request(`http://cell${path}`, { method, headers: { 'x-user': as, 'content-type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
			...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
		return res!;
	};
	const act = async (as: string, callable: string, input: Json) =>
		(await (await call(as, 'POST', '/__bolt/act', { callable, input, issuedAt: t.clock.now() })).json() as { outcome: Outcome }).outcome;
	const transcript = async (as: string, c: string) => {
		const res = await call(as, 'GET', `/__bolt/agent?conversation=${c}`);
		return { status: res.status, rows: res.ok ? ((await res.json()) as { value: { rows: AgentRow[] } }).value.rows : [] };
	};
	return { t, bolt, user, call, act, transcript, authorities };
}
const output = (o: Outcome) => (o as Extract<Outcome, { kind: 'committed' }>).output as { id: string };
const quotes = async (t: TestWorkspace) => (await t.db.read([{ text: 'SELECT title FROM quotes ORDER BY title', params: [] }]))[0]!.rows;

describe('the in-app agent over /__bolt (§5.9)', () => {
	it('starts a conversation, posts, holds a confirm call on a card, and runs it when its person confirms', async () => {
		const { t, bolt, user, act, transcript } = await setup([use('act', { callable: 'quotes.mark', input: { title: 'Chair' } }, 'k1'), say('Marked.')]);
		const ann = await user('ann'), bob = await user('bob');
		const c = output(await act(ann, 'sys_conversation.start', { title: 'Help' })).id;
		const posted = await act(ann, 'sys_message.post', { conversation: c, text: 'mark a chair' });
		expect(posted.kind).toBe('committed');
		await bolt.settled();
		const held = (await transcript(ann, c)).rows.find((r) => r.state === 'confirm')!;
		expect(held).toMatchObject({ tag: 'confirm', call: { name: 'act', input: { callable: 'quotes.mark' } } });
		expect(await quotes(t)).toEqual([]);
		// another member sees neither the transcript nor the card
		expect((await transcript(bob, c)).status).toBe(404);
		expect(await act(bob, 'sys_message.confirm', { message: held.id, approve: true })).toMatchObject({ kind: 'refused', code: 'notFound' });
		expect(await act(bob, 'sys_message.post', { conversation: c, text: 'hi' })).toMatchObject({ kind: 'refused', code: 'notFound' });
		expect((await act(ann, 'sys_message.confirm', { message: held.id, approve: true })).kind).toBe('committed');
		await bolt.settled();
		expect(await quotes(t)).toEqual([{ title: 'Chair' }]);
		const reply = (await transcript(ann, c)).rows.at(-1)!;
		expect(reply).toMatchObject({ role: 'assistant', text: 'Marked.', receipts: [{ outcome: 'committed', callable: 'quotes.mark' }] });
	});

	it('has no second stream: the turn reaches the panel only through the live transcript (agent-live-stream)', async () => {
		const { user, act, call } = await setup();
		const ann = await user('ann');
		const c = output(await act(ann, 'sys_conversation.start', {})).id;
		expect(await call(ann, 'GET', `/__bolt/agent/stream?conversation=${c}`)).toBeNull();
		expect(await call(ann, 'GET', '/__bolt/agent/conversations')).toBeNull();
	});

	it('refuses members the workspace gives no assistant, and a body that is not the callable\'s', async () => {
		const { user, act, call } = await setup();
		const ext = await user('ext', { external: true });
		expect(await act(ext, 'sys_conversation.start', {})).toMatchObject({ kind: 'refused', code: 'forbidden' });
		const ann = await user('ann');
		const res = await call(ann, 'POST', '/__bolt/act', { callable: 'sys_message.post', input: { conversation: 1 }, issuedAt: new Date().toISOString() });
		expect(res.status).toBe(400);
	});
});

describe('web push of inbox notices (§5.7)', () => {
	it('stores a subscription and pushes each notice to the devices of the members it addresses, from a run', async () => {
		const { t, user, call, act } = await setup();
		const ann = await user('ann');
		expect((await call(ann, 'POST', '/__bolt/push', { endpoint: 'http://insecure' })).status).toBe(400);
		// with no device subscribed, a notice queues no push run
		await t.db.write({ text: `INSERT INTO sys_notification (id, recipient, title, at) VALUES ('n0', '{"user":"ann"}', 'Early', now())`, params: [] });
		expect((await t.db.read([{ text: `SELECT count(*)::int AS n FROM sys_run WHERE automation = 'bolt.push'`, params: [] }]))[0]!.rows[0]).toEqual({ n: 0 });
		expect((await call(ann, 'POST', '/__bolt/push', { endpoint: 'https://push.example/ann', keys: { p256dh: 'k', auth: 'a' } })).status).toBe(204);
		// an automation's notice (a guest `ctx.notify` inside its run's statement) is pushed by the next wake
		await act(ann, 'quotes.create', { title: 'Desk' });
		await t.runDue();
		await t.runDue();
		const pushed = t.fakes.transports.push.sent.map((s) => s.message as { subscription: { endpoint: string }; title: string });
		expect(pushed).toEqual([expect.objectContaining({ subscription: { endpoint: 'https://push.example/ann', keys: { p256dh: 'k', auth: 'a' } }, title: 'Logged', url: '/inbox' })]);
		// a notice for someone else reaches no device of ann's
		await t.db.write({ text: `INSERT INTO sys_notification (id, recipient, title, at) VALUES ('n2', '{"user":"zed"}', 'Not yours', $1::timestamptz)`, params: [t.clock.now()] });
		await t.runDue();
		expect(t.fakes.transports.push.sent).toHaveLength(1);
		expect((await call(ann, 'POST', '/__bolt/push', { endpoint: 'https://push.example/ann', remove: true })).status).toBe(204);
		expect((await t.db.read([{ text: `SELECT count(*)::int AS n FROM bolt_push_subscriptions`, params: [] }]))[0]!.rows[0]).toEqual({ n: 0 });
	});
});

describe('envoy registration through the shell host (§3.9)', () => {
	it('redirects the engine link to the page, inspects without consuming, and redeems for the signed-in member', async () => {
		const { t, user } = await setup();
		const ann = await user('ann');
		const mail: TransportPort = { send: async () => ({ providerId: 'x' }), subscribe: () => () => {} };
		const identity: IdentityHost = { db: t.db, now: () => new Date(t.clock.now()), windows: new RateWindows(), keys: await loadKeys(t.db), mail, devSink: true, publicUrl: 'https://acme.example' };
		const shell = shellHost({ manifest, identity, authorities: new Authorities(manifest, 'test'), workspace: { name: 'Acme', handle: 'acme' }, ip: () => '203.0.113.9', envoys: t.engine.envoys });
		const session = await mint(identity, ann);
		const cookie = `nb_s=${encodeURIComponent((session as { value: { token: string } }).value.token)}`;
		const get = (path: string, auth = true) => shell.handle(new Request(`https://acme.example${path}`, auth ? { headers: { cookie } } : {}));
		const claim = (await issueClaim(t.db, 'field', 'whatsapp', '6591234567:3@s.whatsapp.net', t.clock.now()))!;
		const link = await get(`/__bolt/envoys/register?claim=${claim}`, false);
		expect(link!.status).toBe(303);
		expect(link!.headers.get('location')).toBe(`https://acme.example/register/${claim}`);
		const seen = await (await get(`/__bolt/shell/register?claim=${claim}`))!.json() as { value: Json };
		expect(seen.value).toEqual({ state: 'ready', envoy: 'field', transport: 'whatsapp', handle: '6591234567' });
		expect((await get(`/__bolt/shell/register?claim=${claim}`, false))!.status).toBe(401);
		const redeem = await shell.handle(new Request('https://acme.example/__bolt/shell/register', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({ claim, replay: false }) }));
		expect(((await redeem!.json()) as { value: Json }).value).toMatchObject({ state: 'registered', envoy: 'field', replay: [] });
		expect((await t.db.read([{ text: `SELECT phone FROM sys_user WHERE id = $1`, params: [ann] }]))[0]!.rows[0]).toEqual({ phone: '6591234567' });
		expect(((await (await get(`/__bolt/shell/register?claim=${claim}`))!.json()) as { value: Json }).value).toEqual({ state: 'registered' });
	});
});

describe('two session cookies of one name (a Partitioned one beside one set before 0.0.142)', () => {
	it('the live session is found behind a dead one the browser sends first, and sign-out revokes both', async () => {
		const { t, user } = await setup();
		const ann = await user('ann');
		const identity: IdentityHost = { db: t.db, now: () => new Date(t.clock.now()), windows: new RateWindows(), keys: await loadKeys(t.db), devSink: true, publicUrl: 'https://acme.example' };
		const shell = shellHost({ manifest, identity, authorities: new Authorities(manifest, 'test'), workspace: { name: 'Acme', handle: 'acme' }, ip: () => '203.0.113.9' });
		const token = ((await mint(identity, ann)) as { value: { token: string } }).value.token;
		const cookie = `nb_s=dead-token-from-before-a-reset; nb_s=${encodeURIComponent(token)}`;
		const boot = await shell.handle(new Request('https://acme.example/__bolt/shell', { headers: { cookie } }));
		expect(boot!.status).toBe(200);
		expect(((await boot!.json()) as { value: { actor: Json } }).value.actor).toMatchObject({ kind: 'member', id: ann });
		await shell.handle(new Request('https://acme.example/__bolt/session/signout', { method: 'POST', headers: { cookie } }));
		expect((await t.db.read([{ text: 'SELECT count(*)::int AS n FROM sys_session', params: [] }]))[0]!.rows[0]).toEqual({ n: 0 });
	});
});

describe('the journal crash test (rule 55, t.crash)', () => {
	it('a run whose host died after its effects replays from its journal: each effect once', async () => {
		const { t, act, user } = await setup();
		const ann = await user('ann');
		await act(ann, 'quotes.create', { title: 'Desk' });
		const [run] = (await t.db.read([{ text: `SELECT id FROM sys_run WHERE automation = 'log'`, params: [] }]))[0]!.rows;
		await t.crash(String(run!['id']));
		expect((await t.db.read([{ text: `SELECT state, leases FROM sys_run WHERE id = $1`, params: [run!['id']!] }]))[0]!.rows[0]).toEqual({ state: 'queued', leases: 1 });
		await t.runDue();
		const logs = (await t.db.read([{ text: 'SELECT line FROM logs', params: [] }]))[0]!.rows;
		expect(logs).toHaveLength(1);
		const notes = (await t.db.read([{ text: `SELECT count(*)::int AS n FROM sys_notification WHERE title = 'Logged'`, params: [] }]))[0]!.rows[0];
		expect(notes).toEqual({ n: 1 });
		expect((await t.db.read([{ text: `SELECT state FROM sys_run WHERE id = $1`, params: [run!['id']!] }]))[0]!.rows[0]).toEqual({ state: 'succeeded' });
		await expect(t.crash(String(run!['id']))).rejects.toThrow(/did not run/);
	});
});
