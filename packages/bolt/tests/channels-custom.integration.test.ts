// A custom channel's inbound, end to end (rule 61): the workspace's connect page pairs a shared secret, the host seals it;
// the channel's own webhook (`/hooks/bolt.custom/<channel>`, shown at setup) checks the declared HMAC with that secret
// before anything is read, the channel's `inbound.messages` maps the body, and the rows enter like any provider's —
// deduplicated, answered by the envoy on the channel through the channel's connection. `poll` reads the same way.
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import { channelLinks } from '../src/engine/channels/links.ts';
import type { AiPort, EngineManifest } from '../src/engine/contracts.ts';
import type { HttpPort, HttpRequest } from '../src/engine/integrations/runner.ts';
import { respondSystem1, testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
	models: {}, relationships: {}, collections: {}, integrations: {}, pipelines: {}, automations: {}, teams: {},
	policies: { desk: { description: 'The desk', grants: {} } },
	channels: { partner: { transport: 'custom', send: 'partner_api',
		inbound: { verify: { scheme: 'hmac-sha256', secret: 'signingSecret' }, messages: true },
		poll: { connection: 'partner_api', cron: '*/5 * * * *', path: '/messages', messages: true } } },
	connections: { partner_api: { baseUrl: 'PARTNER_URL' } },
	envoys: { desk: { channel: 'partner', audience: 'public', name: 'Norbius', policies: ['desk'], triage: false, groupMessages: 'disabled', delegation: 'disabled', task: 'Help.' } },
	mcp: {}, apps: {}, customFields: {}, agent: { internal: 'Staff.', external: 'Customers.', skills: {} },
} as unknown as EngineManifest;

// the partner's own wire shape, mapped by the channel's declared bodies
const guest = `const msg = (e) => ({ id: e.id, thread: e.chat, sentAt: e.at, from: { handle: e.user, name: e.name ?? null }, text: e.text });
export default { channel: { partner: {
	inbound: { messages: ({ body }) => body.events.map(msg) },
	poll: { messages: ({ body }) => body.items.map(msg) },
} } };`;

const SECRET = 'whsec-partner';
const event = (id: string, text: string) => ({ id, chat: 'chat-1', user: 'partner-user', name: 'Pat', at: '2026-10-01T10:00:00.000Z', text });
const ai: AiPort = { sys_1: respondSystem1, sys_2: { models: ['default'], infer: async () => ({ content: 'on it', toolCalls: [], finish: 'stop', usage: { input: 1, output: 1 } }) } };
const posted: { connection: string; request: HttpRequest }[] = [];
let polled: Json = { items: [] };
const http: HttpPort = { async request(connection, request) {
	posted.push({ connection, request });
	return request.method === 'GET' ? { status: 200, body: polled } : { status: 200, body: { id: `out-${posted.length}` } };
} };

let t: TestWorkspace, links: ReturnType<typeof channelLinks>;
const sealed = new Map<string, Json>();
beforeEach(async () => {
	posted.length = 0; sealed.clear(); polled = { items: [] };
	t = await testWorkspace({ manifest, guest: { source: guest }, http, ai });
	// what a host wires: sealed store, the channel's hook URL, and inbound into the environment's engine
	links = channelLinks({ manifest, providers: [], load: async (c) => sealed.get(c) ?? null,
		store: async (c, v) => { if (v === null) sealed.delete(c); else sealed.set(c, v); },
		webhookUrl: (c, tr) => `https://acme.example/hooks/bolt.${tr}/${c}`, emit: (_t, e) => t.engine.channels.receive(e), log: () => {} });
	await links.resume();
});
const hook = (body: Json, signature: string) => links.webhook('partner', new Request('https://acme.example/hooks/bolt.custom/partner',
	{ method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': signature }, body: JSON.stringify(body) }));
const sign = (body: Json, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex')}`;
const inbound = async () => (await t.db.read([{ text: `SELECT m.provider_id, m.sender, m.text, c.envoy FROM sys_message m JOIN sys_conversation c ON c.id = m.conversation
	WHERE m.direction = 'inbound' ORDER BY m.seq`, params: [] }]))[0]!.rows;

describe('a custom channel\'s inbound', () => {
	it('shows its webhook at setup, seals what the connect page pairs, and ingests a signed body the envoy answers through the connection', async () => {
		expect(links.state('partner')).toMatchObject({ state: 'unpaired', about: { webhookUrl: 'https://acme.example/hooks/bolt.custom/partner' } });
		expect((await hook({ events: [] }, sign({ events: [] }))).status).toBe(404); // nothing paired: no secret, no webhook
		await links.pair('partner', { signingSecret: SECRET });
		expect(sealed.get('partner')).toEqual({ provider: 'workspace', credential: { signingSecret: SECRET } });
		expect(links.state('partner').state).toBe('connected');

		const body = { events: [event('p1', 'where is my order?')] };
		expect((await hook(body, sign(body))).status).toBe(200);
		expect((await hook(body, sign(body))).status).toBe(200); // a redelivery is the same row
		expect(await inbound()).toEqual([{ provider_id: 'p1', sender: 'partner-user', text: 'where is my order?', envoy: 'desk' }]);
		await t.settled();
		expect(posted).toMatchObject([{ connection: 'partner_api', request: { method: 'POST', body: { to: 'chat-1', text: 'on it' } } }]);
	});

	it('refuses a bad signature before reading anything', async () => {
		await links.pair('partner', { signingSecret: SECRET });
		const body = { events: [event('p2', 'forged')] };
		expect((await hook(body, sign(body, 'guessed'))).status).toBe(401);
		expect((await hook(body, '')).status).toBe(401);
		expect(await inbound()).toEqual([]);
	});

	it('polls through the named connection on its cron, ingesting what the answer maps to (deduplicated by id)', async () => {
		polled = { items: [event('q1', 'polled one'), event('q2', 'polled two')] };
		t.clock.advance('5min');
		await t.runDue();
		t.clock.advance('5min');
		await t.runDue(); // the next slot: the same items are one row each
		expect(posted.filter((p) => p.request.method === 'GET')).toMatchObject([{ connection: 'partner_api', request: { path: '/messages' } }, { request: { path: '/messages' } }]);
		expect((await inbound()).map((r) => r['provider_id'])).toEqual(['q1', 'q2']);
	});
});
