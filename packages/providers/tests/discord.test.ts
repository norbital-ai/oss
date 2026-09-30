// Discord: setup validation with /users/@me, the Gateway handshake over a fake socket (HELLO → IDENTIFY with the
// message-content intent, READY, heartbeats), MESSAGE_CREATE decode, terminal close codes, and the REST send shape.
import { describe, expect, it } from 'vitest';
import { discord, type GatewaySocket } from '../src/discord/index.ts';
import { fakeFetch, file, host, json, signal } from './kit.ts';

type Fake = GatewaySocket & { sent: unknown[]; fire(type: 'message' | 'close', e: { data?: unknown; code?: number }): void };
const gateway = () => {
	const sockets: Fake[] = [];
	const socket = () => {
		const listeners: { [t: string]: ((e: { data?: unknown; code?: number }) => void)[] } = {};
		const s: Fake = { sent: [], send(d) { s.sent.push(JSON.parse(d)); }, close() {}, addEventListener(t, l) { (listeners[t] ??= []).push(l); },
			fire(t, e) { for (const l of listeners[t] ?? []) l(e); } };
		sockets.push(s);
		return s;
	};
	return { sockets, socket };
};
const api = () => fakeFetch([
	(c) => c.url.endsWith('/users/@me') ? (c.headers['authorization'] === 'Bot good' ? json({ id: '100', username: 'crewbot' }) : json({ message: '401: Unauthorized' }, 401)) : undefined,
	(c) => c.url.endsWith('/messages') ? json({ id: 'm-out' }) : undefined,
	(c) => c.url.endsWith('/typing') ? new Response(null, { status: 204 }) : undefined,
]);
const msg = (d: object) => ({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { id: 'm1', channel_id: '55', guild_id: 'g1', timestamp: '2026-10-01T10:00:00.000Z', content: 'hi',
	author: { id: '7', username: 'ana', global_name: 'Ana' }, mentions: [], ...d } });

describe('Discord', () => {
	it('validates the token with /users/@me before opening a gateway', async () => {
		const g = gateway(), f = api(), h = await host(discord({ socket: g.socket }), f);
		await expect(h.link.pair({})).rejects.toThrow(/bot token is required/);
		await expect(h.link.pair({ botToken: 'bad' })).rejects.toThrow(/401/);
		expect(g.sockets).toHaveLength(0);
		await h.link.pair({ botToken: 'good' });
		expect(h.saved).toEqual([{ botToken: 'good', botId: '100', botName: 'crewbot' }]);
		expect(h.link.connection()).toMatchObject({ state: 'connecting', about: { inviteUrl: expect.stringContaining('client_id=100') } });
	});
	it('identifies with the message-content intent, is connected on READY and decodes messages', async () => {
		const g = gateway(), h = await host(discord({ socket: g.socket }), api(), { botToken: 'good', botId: '100', botName: 'crewbot' });
		const s = g.sockets[0]!;
		s.fire('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) });
		expect(s.sent[0]).toMatchObject({ op: 2, d: { token: 'good' } });
		expect(((s.sent[0] as { d: { intents: number } }).d.intents & (1 << 15)) !== 0).toBe(true);
		s.fire('message', { data: JSON.stringify({ op: 0, t: 'READY', s: 1, d: { guilds: [{ id: 'g1' }, { id: 'g2' }] } }) });
		expect(h.link.connection()).toMatchObject({ state: 'connected', pairedAs: 'crewbot', about: { guilds: 2 } });
		s.fire('message', { data: JSON.stringify(msg({ mentions: [{ id: '100' }], content: '<@100> status' })) });
		s.fire('message', { data: JSON.stringify(msg({ id: 'm2', guild_id: undefined, channel_id: '66' })) });
		s.fire('message', { data: JSON.stringify(msg({ id: 'm3', author: { id: '100', bot: true } })) });
		await new Promise((r) => setTimeout(r, 1));
		expect(h.events.map((e) => e.kind === 'inbound' ? e.message : null)).toMatchObject([
			{ id: 'm1', thread: '55', group: true, invocation: 'mention', from: { handle: '7', name: 'Ana' } },
			{ id: 'm2', thread: '66', group: false, invocation: 'direct' },
		]);
		s.fire('message', { data: JSON.stringify({ op: 1 }) });
		expect(s.sent.at(-1)).toEqual({ op: 1, d: 3 });
		await h.link.close();
	});
	it('a refused token or a missing intent is terminal; any other close reconnects', async () => {
		const g = gateway(), h = await host(discord({ socket: g.socket, backoffMs: () => 1 }), api(), { botToken: 'good', botId: '100', botName: 'crewbot' });
		g.sockets[0]!.fire('close', { code: 1006 });
		expect(h.link.connection().state).toBe('reconnecting');
		await new Promise((r) => setTimeout(r, 10));
		expect(g.sockets).toHaveLength(2);
		g.sockets[1]!.fire('close', { code: 4014 });
		expect(h.link.connection()).toMatchObject({ state: 'error', error: expect.stringContaining('Message Content Intent') });
		await h.link.close();
	});
	it('sends and types through REST with the bot token', async () => {
		const g = gateway(), f = api(), h = await host(discord({ socket: g.socket }), f, { botToken: 'good', botId: '100', botName: 'crewbot' });
		expect(await h.link.send('desk', { to: '55', text: 'on it' }, signal())).toEqual({ providerId: 'm-out' });
		await h.link.typing!('desk', '55', signal());
		expect(f.calls.map((c) => [c.method, c.url, c.headers['authorization'], c.body])).toEqual([
			['POST', 'https://discord.com/api/v10/channels/55/messages', 'Bot good', '{"content":"on it"}'],
			['POST', 'https://discord.com/api/v10/channels/55/typing', 'Bot good', ''],
		]);
		await h.link.close();
	});
	it('attachments go in the same message as multipart files, named', async () => {
		const g = gateway(), f = api(), h = await host(discord({ socket: g.socket }), f, { botToken: 'good', botId: '100', botName: 'crewbot' });
		await h.link.send('desk', { to: '55', text: 'the report' }, signal(), [file('report.pdf', 'application/pdf', '%PDF r')]);
		const form = f.calls[0]!.form!;
		expect(JSON.parse(String(form.get('payload_json')))).toEqual({ content: 'the report', attachments: [{ id: 0, filename: 'report.pdf' }] });
		const part = form.get('files[0]') as File;
		expect([part.name, part.type, await part.text()]).toEqual(['report.pdf', 'application/pdf', '%PDF r']);
		expect(f.calls[0]!.headers['content-type']).toBeUndefined();
		await h.link.close();
	});
});
