// engine/channels over the open transport set (rule 61): Slack, Discord and WeChat ingest and send through the one
// generic path, several channels share one transport (each keyed by its own name), and a `custom` channel sends through
// its declared connection (its inbound: channels-custom.integration.test.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import type { Json } from '../src/decl/values.ts';
import type { EngineManifest, Outcome } from '../src/engine/contracts.ts';
import type { HttpPort, HttpRequest } from '../src/engine/integrations/runner.ts';
import { testWorkspace, type TestWorkspace } from '../src/test/index.ts';

const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {}, relationships: {}, collections: {}, integrations: {}, pipelines: {},
	policies: { staff: { description: 'Staff', grants: {} } },
	teams: {},
	automations: {
		partner_out: { description: 'Replies on the partner channel', runAs: ['staff'] },
	},
	channels: {
		sales_slack: { transport: 'slack' }, ops_slack: { transport: 'slack' }, crew_discord: { transport: 'discord' }, oa: { transport: 'wechat' },
		partner: { transport: 'custom', send: 'partner_api' },
	},
	connections: { partner_api: { baseUrl: 'PARTNER_URL' } }, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

const guest = `export default { automation: {
	partner_out: { body: async (input, ctx) => ctx.send('partner', { to: 'chat-9', text: 'on our way' }) },
} };`;

const posted: { connection: string; request: HttpRequest }[] = [];
const http: HttpPort = { async request(connection, request) { posted.push({ connection, request }); return { status: 200, body: { id: 'partner-1' } }; } };

let t: TestWorkspace;
beforeEach(async () => {
	posted.length = 0;
	t = await testWorkspace({ manifest, guest: { source: guest }, http });
});
const ok = (o: Outcome) => { if (o.kind !== 'committed') throw new Error(JSON.stringify(o)); return o; };
const chat = (id: string, thread: string, over: { [k: string]: Json } = {}): Json =>
	({ id, thread, sentAt: '2026-10-01T10:00:00.000Z', from: { handle: 'U1', name: 'Ana' }, text: `hi ${id}`, ...over });
const inbound = async () => (await t.db.read([{ text: `SELECT channel, provider_id, sender, text FROM sys_message WHERE direction = 'inbound' ORDER BY seq`, params: [] }]))[0]!.rows;
const outbound = async () => (await t.db.read([{ text: `SELECT channel, status, provider_id, error FROM sys_message WHERE direction = 'outbound' ORDER BY seq`, params: [] }]))[0]!.rows;

describe('the chat transports', () => {
	it('Slack, Discord and WeChat ingest through the one decode; two Slack channels keep their own rows', async () => {
		await t.fakes.transports.slack.emit({ kind: 'inbound', channel: 'sales_slack', message: chat('C1:1', 'C1') });
		await t.fakes.transports.slack.emit({ kind: 'inbound', channel: 'ops_slack', message: chat('C1:1', 'C1') });
		await t.fakes.transports.discord.emit({ kind: 'inbound', channel: 'crew_discord', message: chat('m1', '99') });
		await t.fakes.transports.wechat.emit({ kind: 'inbound', channel: 'oa', message: chat('w1', 'openid-1', { from: { handle: 'openid-1', name: null } }) });
		expect(await inbound()).toEqual([
			{ channel: 'sales_slack', provider_id: 'C1:1', sender: 'U1', text: 'hi C1:1' },
			{ channel: 'ops_slack', provider_id: 'C1:1', sender: 'U1', text: 'hi C1:1' },
			{ channel: 'crew_discord', provider_id: 'm1', sender: 'U1', text: 'hi m1' },
			{ channel: 'oa', provider_id: 'w1', sender: 'openid-1', text: 'hi w1' },
		]);
	});

	it('a send names its channel: the transport port serves both Slack channels and says which', async () => {
		await t.engine.channels.send('sales_slack', { to: 'C1', text: 'to sales' });
		await t.engine.channels.send('ops_slack', { to: 'C2', text: 'to ops' });
		await t.engine.channels.send('oa', { to: 'openid-1', text: 'to wechat' });
		expect(t.fakes.transports.slack.sent.map((s) => [s.channel, (s.message as { text: string }).text])).toEqual([['sales_slack', 'to sales'], ['ops_slack', 'to ops']]);
		expect(t.fakes.transports.wechat.sent).toHaveLength(1);
		expect((await outbound()).map((r) => r['status'])).toEqual(['sent', 'sent', 'sent']);
	});
});

describe('a custom channel', () => {
	it('sends through the connection its `send` names; the answer\'s id is the provider id', async () => {
		ok(await t.as(t.admin).start('partner_out', {}));
		await t.runDue();
		await t.runDue();
		expect(posted).toMatchObject([{ connection: 'partner_api', request: { method: 'POST', path: '', body: { to: 'chat-9', text: 'on our way' } } }]);
		expect(await outbound()).toMatchObject([{ channel: 'partner', status: 'sent', provider_id: 'partner-1' }]);
	});
});
