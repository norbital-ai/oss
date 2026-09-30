// bolt-server's self-host adapters (G12 (9), rules 38a, 61, 71, §5.11.4, §5.11.6): the WhatsApp socket owner over a fake
// Baileys socket (pair, reconnect with progress, terminal logout), the Telegram webhook, SMTP against a fake server, the
// configuration decode, sealed secrets, the timekeeper, and the FIFO envelope.
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { TransportEvent } from '../../bolt/src/engine/contracts.ts';
import { openPglite } from '../../bolt/src/engine/db/pglite.ts';
import { sealedSecrets } from '../../bolt/src/engine/secrets.ts';
import { ConfigError, decodeConfig } from '../src/config.ts';
import { mailSender } from '../src/mail.ts';
import { openAi, timekeeper } from '../src/ports.ts';
import { envelope } from '../src/server.ts';
import { telegram } from '../src/telegram.ts';
import { whatsapp, type WaOpen, type WaSocket, type WaState } from '../src/whatsapp.ts';

const scratch = join(tmpdir(), 'norbital-scratch', `bolt-server-transports-${process.pid}`);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A Baileys socket double: tests drive `connection.update` and `messages.upsert` as the library would. */
function fakeBaileys() {
	const sockets: (WaSocket & { emit(e: string, x: unknown): void; ended: boolean; loggedOut: boolean; sent: { jid: string; text: string }[]; groupReads: string[]; presence: string[] })[] = [];
	const open: WaOpen = async (dir) => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'creds.json'), '{}');
		const ev = new EventEmitter();
		const s = {
			ev: { on: (e: string, l: (x: never) => void) => { ev.on(e, l as (x: unknown) => void); } }, user: { id: '6590000000:7@s.whatsapp.net' },
			ended: false, loggedOut: false, sent: [] as { jid: string; text: string }[],
			emit: (e: string, x: unknown) => { ev.emit(e, x); },
			async sendMessage(jid: string, c: { text: string }) { s.sent.push({ jid, text: c.text }); return { key: { id: `wa-${s.sent.length}` } }; },
			async requestPairingCode() { return 'ABCD-EFGH'; },
			presence: [] as string[],
			async sendPresenceUpdate(type: 'composing' | 'paused', jid: string) { s.presence.push(`${type} ${jid}`); },
			async groupMetadata(jid: string) { s.groupReads.push(jid); return { subject: 'Site crew' }; },
			groupReads: [] as string[],
			async logout() { s.loggedOut = true; },
			end() { s.ended = true; },
		};
		sockets.push(s);
		return { socket: s, download: async () => null };
	};
	return { open, sockets };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('WhatsApp over a persistent socket (G12 (9))', () => {
	it('pairs by QR, delivers messages, reconnects with progress, and a logout is terminal', async () => {
		const dir = join(scratch, 'wa');
		const { open, sockets } = fakeBaileys();
		const wa = whatsapp(dir, 'field_ops', open, () => 10);
		const states: WaState['state'][] = [];
		wa.observe((s) => states.push(s.state));
		await wa.start();
		expect(wa.state()).toEqual({ state: 'unpaired' }); // no stored pairing: nothing opens

		await wa.pair();
		sockets[0]!.emit('connection.update', { qr: 'QR-1' });
		expect(wa.state()).toEqual({ state: 'pairing', qr: 'QR-1', code: null });
		sockets[0]!.emit('connection.update', { connection: 'open' });
		expect(wa.state()).toEqual({ state: 'connected', as: '6590000000:7@s.whatsapp.net' });
		// an agent at work shows "typing…" in the chat
		await wa.typing!('field_ops', '6591111111@s.whatsapp.net', AbortSignal.timeout(1_000));
		expect(sockets[0]!.presence).toEqual(['composing 6591111111@s.whatsapp.net']);

		const got: TransportEvent[] = [];
		wa.subscribe(async (e) => { got.push(e); });
		sockets[0]!.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '6591111111@s.whatsapp.net', id: 'M1', fromMe: false },
			messageTimestamp: 1_790_000_000, pushName: 'Ann', message: { conversation: 'job done' } }] });
		await tick();
		expect(got).toMatchObject([{ kind: 'inbound', channel: 'field_ops', message: { id: 'M1', text: 'job done', invocation: 'direct', from: { handle: '6591111111@s.whatsapp.net' } } }]);
		expect(got[0]!.kind === 'inbound' && 'title' in (got[0]!.message as object)).toBe(false); // a DM names no group
		// a group message carries the group's subject, read once per group
		for (const id of ['G1', 'G2']) sockets[0]!.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '120363000000000001@g.us', id, fromMe: false,
			participant: '6591111111@s.whatsapp.net' }, messageTimestamp: 1_790_000_000, pushName: 'Ann', message: { conversation: 'crew update' } }] });
		await tick();
		expect(got.slice(1)).toMatchObject([{ message: { id: 'G1', group: true, title: 'Site crew' } }, { message: { id: 'G2', title: 'Site crew' } }]);
		expect(sockets[0]!.groupReads).toEqual(['120363000000000001@g.us']);
		got.length = 1;
		expect(await wa.send('field_ops', { to: '6591111111@s.whatsapp.net', text: 'thanks' }, AbortSignal.timeout(1000))).toEqual({ providerId: 'wa-1' });

		// a drop that is not a logout reconnects, and says so
		sockets[0]!.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 }, message: 'Connection Closed' } } });
		expect(wa.state()).toMatchObject({ state: 'reconnecting', attempt: 1, detail: '428: Connection Closed' });
		await expect(wa.send('field_ops', { to: 'x', text: 'y' }, AbortSignal.timeout(1000))).rejects.toThrow(/not open/);
		await new Promise((r) => setTimeout(r, 30));
		expect(sockets).toHaveLength(2);
		sockets[1]!.emit('connection.update', { connection: 'open' });
		expect(wa.state().state).toBe('connected');
		sockets[0]!.emit('connection.update', { connection: 'open' }); // a late event from the replaced socket changes nothing
		expect(states).toEqual(['connecting', 'pairing', 'connected', 'reconnecting', 'connecting', 'connected']);

		// logged out from the phone: terminal, credentials gone, no reconnect
		sockets[1]!.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 }, message: 'logged out' } } });
		await new Promise((r) => setTimeout(r, 30));
		expect(wa.state()).toMatchObject({ state: 'loggedOut' });
		expect(sockets).toHaveLength(2);
		await wa.start();
		expect(sockets).toHaveLength(2); // no stored credentials to resume

		// an administrator's pairing by phone code, then an administrator's logout
		await wa.pair('6590000000');
		sockets[2]!.emit('connection.update', { qr: 'QR-2' });
		await tick();
		expect(wa.state()).toEqual({ state: 'pairing', qr: null, code: 'ABCD-EFGH' });
		sockets[2]!.emit('connection.update', { connection: 'open' });
		await wa.logout();
		expect(sockets[2]!.loggedOut).toBe(true);
		expect(wa.state()).toMatchObject({ state: 'loggedOut', detail: 'logged out by an administrator' });
		await expect(wa.pair('+65 9000')).rejects.toThrow(/digits/);
		wa.stop();
	});
});

describe('Telegram webhook', () => {
	it('registers its webhook, refuses a wrong secret and delivers a verified update', async () => {
		const calls: { url: string; body: { [k: string]: unknown } }[] = [];
		const f = (async (url: string | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? '{}')) as { [k: string]: unknown };
			calls.push({ url: String(url), body });
			const result = String(url).endsWith('/getMe') ? { id: 42, username: 'desk_bot' } : String(url).endsWith('/sendMessage') ? { message_id: 9 } : true;
			return Response.json({ ok: true, result });
		}) as typeof fetch;
		const tg = telegram('123:abc', 'sales_desk', f, 'https://tg.test');
		await tg.activate('https://acme.example');
		const hook = calls.find((c) => c.url.endsWith('/setWebhook'))!.body;
		expect(hook['url']).toBe('https://acme.example/hooks/bolt.telegram');
		const got: TransportEvent[] = [];
		tg.subscribe(async (e) => { got.push(e); });
		const update = { update_id: 1, message: { message_id: 5, date: 1_790_000_000, chat: { id: 77, type: 'private' }, from: { id: 77, first_name: 'Bo' }, text: 'hi' } };
		const post = (secret: string) => tg.webhook(new Request('https://acme.example/hooks/bolt.telegram', { method: 'POST', body: JSON.stringify(update),
			headers: { 'x-telegram-bot-api-secret-token': secret } }));
		expect((await post('wrong')).status).toBe(401);
		expect(got).toEqual([]);
		expect((await post(String(hook['secret_token']))).status).toBe(200);
		expect(got).toMatchObject([{ kind: 'inbound', channel: 'sales_desk', message: { id: '77:5', text: 'hi', from: { handle: '77', name: 'Bo' } } }]);
		expect(await tg.send('sales_desk', { to: '77', text: 'hello' }, AbortSignal.timeout(1000))).toEqual({ providerId: '77:9' });
	});
});

describe('SMTP mail', () => {
	it('sends one message with AUTH PLAIN to a loopback server', async () => {
		const lines: string[] = [];
		const server = createServer((s: Socket) => {
			let data = false, buffer = '';
			s.write('220 fake\r\n');
			s.on('data', (d) => {
				buffer += d.toString();
				for (let i = buffer.indexOf('\r\n'); i >= 0; i = buffer.indexOf('\r\n')) {
					const line = buffer.slice(0, i); buffer = buffer.slice(i + 2);
					lines.push(line);
					if (data) { if (line === '.') { data = false; s.write('250 queued\r\n'); } continue; }
					if (line.startsWith('EHLO')) s.write('250-fake\r\n250 AUTH PLAIN\r\n');
					else if (line.startsWith('AUTH')) s.write('235 ok\r\n');
					else if (line === 'DATA') { data = true; s.write('354 go\r\n'); }
					else if (line === 'QUIT') s.end('221 bye\r\n');
					else s.write('250 ok\r\n');
				}
			});
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		const port = (server.address() as { port: number }).port;
		const send = mailSender(`smtp://u%40x:p@127.0.0.1:${port}?from=noreply@acme.example`, 'https://acme.example');
		const id = await send({ to: ['a@b.example'], subject: 'Your sign-in code', text: 'Your sign-in code is 123456.' }, AbortSignal.timeout(5000));
		server.close();
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(lines).toContain(`AUTH PLAIN ${Buffer.from('\u0000u@x\u0000p').toString('base64')}`);
		expect(lines).toContain('MAIL FROM:<noreply@acme.example>');
		expect(lines).toContain('RCPT TO:<a@b.example>');
		expect(lines).toContain('Subject: Your sign-in code');
	});
});

describe('bolt start configuration (§5.11.6)', () => {
	const base = { BOLT_ARTIFACT: '/a', BOLT_PUBLIC_URL: 'https://acme.example', BOLT_PGLITE_DIR: '/db' };
	it('decodes the defaults and the flags', () => {
		const c = decodeConfig(base, ['--accept', '--trust-proxy=10.0.0.0/8,::1', '--founder=a@b.example', '--seed=./pack']);
		expect(c).toMatchObject({ host: '127.0.0.1', port: 3100, database: { pglite: '/db' }, publicUrl: 'https://acme.example', files: null, mail: null,
			accept: true, trustProxy: ['10.0.0.0/8', '::1'], founder: 'a@b.example', seed: './pack', telemetryRetainHours: 72, environment: null });
		expect(decodeConfig({ ...base, BOLT_ENVIRONMENT: 'staging' }).environment).toBe('staging');
	});
	it.each([
		[{ ...base, BOLT_SERVER_PORT: '1' }, /unknown configuration: BOLT_SERVER_PORT/],
		[{ ...base, BOLT_DATABASE_URL: 'postgres://x' }, /exactly one/],
		[{ BOLT_ARTIFACT: '/a', BOLT_PUBLIC_URL: 'https://acme.example' }, /exactly one/],
		[{ ...base, BOLT_PUBLIC_URL: 'http://acme.example' }, /https/],
		[{ ...base, BOLT_PUBLIC_URL: 'https://acme.example/app' }, /no path/],
		[{ ...base, BOLT_MASTER_KEY: 'short' }, /32-byte/],
		[{ ...base, BOLT_AI_SYS_2_PROVIDER: 'anthropic' }, /not registered/],
		[{ ...base, BOLT_FILES_PROVIDER: 'local' }, /BOLT_FILES_ENDPOINT/],
		[{ BOLT_PUBLIC_URL: 'https://acme.example', BOLT_PGLITE_DIR: '/db' }, /BOLT_ARTIFACT/],
	])('refuses to start: %o', (env, message) => {
		expect(() => decodeConfig(env)).toThrow(ConfigError);
		expect(() => decodeConfig(env)).toThrow(message);
	});
	it('accepts a loopback http origin and refuses a bad flag', () => {
		expect(decodeConfig({ ...base, BOLT_PUBLIC_URL: 'http://app.localhost:5173' }).publicUrl).toBe('http://app.localhost:5173');
		expect(() => decodeConfig(base, ['--trust-proxy=nope'])).toThrow(/CIDR/);
		expect(() => decodeConfig(base, ['--port=1'])).toThrow(/flag/);
	});
});

describe('sealed secrets (§5.11.4)', () => {
	it('stores envelopes a copied row cannot open, answers status without a key, refuses undeclared names', async () => {
		const { db, pg } = await openPglite();
		await db.write({ text: 'CREATE TABLE sys_config (key text PRIMARY KEY, value text NOT NULL)', params: [] });
		const key = Buffer.alloc(32, 7);
		const s = sealedSecrets(db, key, { ERP_TOKEN: {}, BASE: { secret: false, default: 'https://erp.example' } });
		await s.set('workspace', 'ERP_TOKEN', 'tok');
		await s.set('user-1', 'google', 'refresh');
		expect(await s.use('workspace', 'ERP_TOKEN')).toBe('tok');
		expect(s.env('ERP_TOKEN')).toBe('tok');
		expect(s.env('BASE')).toBe('https://erp.example');
		await expect(s.set('workspace', 'OTHER', 'x')).rejects.toThrow(/declared/);
		// the user's envelope under another owner fails to open
		await db.write({ text: `INSERT INTO sys_config SELECT 'secret:user-2:google', value FROM sys_config WHERE key = 'secret:user-1:google'`, params: [] });
		expect(await s.use('user-2', 'google')).toBeNull();
		const [raw] = await db.read([{ text: `SELECT value FROM sys_config WHERE key = 'secret:workspace:ERP_TOKEN'`, params: [] }]);
		expect(String(raw!.rows[0]!['value'])).not.toContain('tok');
		const keyless = sealedSecrets(db, null, { ERP_TOKEN: {}, BASE: { secret: false } });
		expect(await keyless.status('workspace')).toEqual({ ERP_TOKEN: true, BASE: false });
		await expect(keyless.set('workspace', 'ERP_TOKEN', 'x')).rejects.toThrow(/BOLT_MASTER_KEY/);
		await pg.close();
	});
});

describe('the in-process timekeeper and the envelope (rules 52a, 71)', () => {
	it('wakes a scope once at its earliest announcement and takes the settled answer', async () => {
		const woke: string[] = [];
		let dk: ReturnType<typeof timekeeper> | undefined;
		dk = timekeeper(async (scope) => { woke.push(scope); if (woke.length === 1) dk!.settle(scope, new Date(Date.now() + 20).toISOString()); });
		dk.announce('ws', new Date(Date.now() + 40).toISOString());
		dk.announce('ws', new Date(Date.now() + 10).toISOString());
		dk.announce('ws', new Date(Date.now() + 60).toISOString()); // later: ignored
		await new Promise((r) => setTimeout(r, 120));
		expect(woke).toEqual(['ws', 'ws']);
		dk.stop();
	});
	it('stays silent about a wake that a stop interrupted, and never wakes again (rule 71a)', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		let calls = 0;
		const dk = timekeeper(async () => { calls++; dk.stop(); throw new Error('PGlite is closing'); });
		dk.announce('ws', new Date().toISOString());
		await new Promise((r) => setTimeout(r, 30));
		expect(calls).toBe(1);
		expect(errors).not.toHaveBeenCalled();
		errors.mockRestore();
	});
	it('admits FIFO under the limit, request-path work ahead of automations', async () => {
		const admit = envelope(1);
		const order: string[] = [];
		let release!: () => void;
		const first = admit(0, () => new Promise<void>((r) => { order.push('a'); release = r; }));
		const automation = admit(1, async () => { order.push('automation'); });
		const request = admit(0, async () => { order.push('request'); });
		await tick();
		expect(order).toEqual(['a']);
		release();
		await Promise.all([first, automation, request]);
		expect(order).toEqual(['a', 'request', 'automation']);
	});
	it('drains within its grace: admission closes, waiters are shed, a never-settling call cannot hold it (rule 71a)', async () => {
		const admit = envelope(1);
		void admit(1, () => new Promise<void>(() => {}));
		const shed = expect(admit(0, async () => 'late')).rejects.toMatchObject({ code: 'busy' });
		const started = Date.now();
		expect(await admit.drain(50)).toBe(false);
		expect(Date.now() - started).toBeLessThan(500);
		await shed;
		await expect(admit(0, async () => 'new')).rejects.toMatchObject({ code: 'busy' });
		expect(await envelope(1).drain(10_000)).toBe(true);
	});
});

describe('the OpenAI-compatible model port (P19)', () => {
	it('maps the declared classes to the operator\'s models on the sys_2 endpoint (the client itself: bolt tests/openai-chat.test.ts)', async () => {
		let url = '', sent: { model: string } | undefined;
		const f = (async (u: string | URL, init?: RequestInit) => {
			url = String(u);
			sent = JSON.parse(String(init?.body)) as typeof sent;
			return Response.json({ choices: [{ message: { content: 'ok' } }] });
		}) as typeof fetch;
		const ai = openAi({ sys1: { endpoint: 'https://s1.test/v1' }, sys2: { endpoint: 'https://llm.test/v1', credential: 'k' } },
			{ sys1: 'tiny', sys2: { default: 'gpt-x', fast: 'gpt-y' }, embed: {}, modalities: { sys2: null, embed: null } }, ['default', 'fast', 'strong'], f);
		expect(ai.sys_2.models).toEqual(['default', 'fast']);
		expect((await ai.sys_2.infer({ model: 'fast', messages: [{ role: 'user', content: 'hi' }] }, AbortSignal.timeout(1000))).content).toBe('ok');
		expect([url, sent!.model]).toEqual(['https://llm.test/v1/chat/completions', 'gpt-y']);
	});
	it('sys_1 asks the operator\'s model on its own endpoint in P37 shapes: a text-only state, a distribution decoded, a context refusal TooLarge', async () => {
		let url = '', sent: { model: string; response_format?: unknown; messages: { content: unknown }[] } | undefined, status = 200;
		const f = (async (u: string | URL, init?: RequestInit) => {
			url = String(u);
			sent = JSON.parse(String(init?.body)) as typeof sent;
			if (status !== 200) return new Response('{"error":{"message":"This model\'s maximum context length is 32768 tokens"}}', { status });
			return Response.json({ choices: [{ message: { content: '{"action":{"probabilities":{"respond":0.2,"wait":0.8}},"wait":{"probabilities":{"0":0.1,"1":0.2,"2":0.7}},"sure":{"noul":0.9}}' } }],
				usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.0001 } });
		}) as typeof fetch;
		const ai = openAi({ sys1: { endpoint: 'https://s1.test/v1', credential: 's' }, sys2: { endpoint: 'https://llm.test/v1' } },
			{ sys1: 'tiny', sys2: { default: 'gpt-x' }, embed: {}, modalities: { sys2: null, embed: null } }, ['default'], f);
		const request = { state: { text: 'see photo', photo: { name: 'p.png', mime: 'image/png', size: 2 } },
			questions: { action: { type: 'choice', instructions: 'p', criteria: { respond: 'now', wait: 'later' } },
				wait: { type: 'score', instructions: 's', criteria: ['0 s', '1 s', '2 s'] }, sure: { type: 'noul', instructions: 'n', criteria: { true: 'y', false: 'n' } } } } as const;
		const d = await ai.sys_1.ask(request, AbortSignal.timeout(1000));
		expect([url, sent!.model]).toEqual(['https://s1.test/v1/chat/completions', 'tiny']);
		expect(sent!.response_format).toMatchObject({ type: 'json_schema' });
		expect(sent!.messages.at(-1)!.content).toEqual(expect.stringContaining('"photo":{"name":"p.png","mime":"image/png","size":2}'));
		expect(d).toMatchObject({ costUsd: 0.0001, answers: { action: { type: 'choice', choice: 'wait', confidence: 0.8 }, sure: { type: 'noul', noul: 0.9 },
			wait: { type: 'score', level: 2, legend: { 2: '2 s' } } } });
		expect((d.answers['wait'] as { score: number }).score).toBeCloseTo(1.6);
		status = 400;
		await expect(ai.sys_1.ask(request, AbortSignal.timeout(1000))).rejects.toMatchObject({ kind: 'tooLarge' });
	});
	it('sys_1 on provider decisions posts { model, state, questions } to the Decisions API URL as given', async () => {
		let url = '', sent: unknown;
		const f = (async (u: string | URL, init?: RequestInit) => {
			url = String(u);
			sent = JSON.parse(String(init?.body));
			return Response.json({ answers: { sure: { type: 'noul', noul: 0.9 } }, usage: { cost: 0.00002 } });
		}) as typeof fetch;
		const ai = openAi({ sys1: { provider: 'decisions', endpoint: 'https://d.test/api/alpha/decisions', credential: 's' }, sys2: { endpoint: 'https://llm.test/v1' } },
			{ sys1: 'vendor/jev', sys2: { default: 'gpt-x' }, embed: {}, modalities: { sys2: null, embed: null } }, ['default'], f);
		const request = { state: { text: 'hi' }, questions: { sure: { type: 'noul', instructions: 'n', criteria: { true: 'y', false: 'n' } } } } as const;
		expect(await ai.sys_1.ask(request, AbortSignal.timeout(1000))).toMatchObject({ costUsd: 0.00002, answers: { sure: { type: 'noul', noul: 0.9 } } });
		expect([url, sent]).toEqual(['https://d.test/api/alpha/decisions', { model: 'vendor/jev', state: request.state, questions: request.questions }]);
	});
});
