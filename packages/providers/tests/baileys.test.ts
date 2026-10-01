// WhatsApp Web (Baileys): the message codec, and the link over a fake socket — QR and code pairing, the sealed auth
// files, resume, reconnect after a drop, logout, and the send shape.
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { baileys, baileysReceipt, whatsappMessage, type WaSocket } from '../src/baileys/index.ts';
import { fakeFetch, file, host, signal } from './kit.ts';

describe('WhatsApp (Baileys) messages', () => {
	it('a receipt on our own message is its delivery report; anything else is not', () => {
		const key = { id: 'M1', remoteJid: '659@s.whatsapp.net', fromMe: true };
		expect(baileysReceipt({ key, update: { status: 2 } })).toMatchObject({
			providerId: 'M1',
			report: { kind: 'sent', provider: 'baileys' }
		});
		expect(baileysReceipt({ key, update: { status: 3 } })?.report.kind).toBe('delivered');
		expect(baileysReceipt({ key, update: { status: 4 } })?.report.kind).toBe('read');
		expect(baileysReceipt({ key, update: { status: 0 } })?.report).toMatchObject({
			kind: 'failed',
			reason: 'WhatsApp reported an error'
		});
		expect(baileysReceipt({ key, update: { status: 1 } })).toBeNull();
		expect(baileysReceipt({ key: { ...key, fromMe: false }, update: { status: 4 } })).toBeNull();
		expect(baileysReceipt({ key, update: { starred: true } })).toBeNull();
	});
	const self = '6580000000:3@s.whatsapp.net';
	/** Our LID, the identity WhatsApp actually names in a group mention; `self` is the phone JID it prints as. */
	const MY_LID = '113377445566:4@lid';
	const wa = (key: object, message: object, extra: object = {}) => ({
		key: { id: 'M1', ...key },
		messageTimestamp: 1_790_000_000,
		pushName: 'Ben',
		message,
		...extra
	});
	it('personal sync includes sent history without changing messaging channels', () => {
		expect(
			whatsappMessage(
				wa({ remoteJid: '659@s.whatsapp.net', fromMe: true }, { conversation: 'sent quote' }),
				self,
				{ includeSent: true, history: true }
			)
		).toMatchObject({ direction: 'outbound', history: true, text: 'sent quote' });
	});
	it('our own echo and empty messages are not messages', () => {
		expect(
			whatsappMessage(
				wa({ remoteJid: '659@s.whatsapp.net', fromMe: true }, { conversation: 'x' }),
				self
			)
		).toBeNull();
		expect(whatsappMessage({ key: { id: 'M1', remoteJid: 'x' } }, self)).toBeNull();
	});
	it('a group message names its participant; a mention of our number or a quote of our message addresses us', () => {
		const g = { remoteJid: '1203@g.us', participant: '6591234567:14@s.whatsapp.net' };
		expect(whatsappMessage(wa(g, { conversation: 'running late' }), self)).toMatchObject({
			thread: '1203@g.us',
			group: true,
			invocation: 'ambient',
			from: { handle: '6591234567:14@s.whatsapp.net', name: 'Ben' }
		});
		expect(
			whatsappMessage(
				wa(g, {
					extendedTextMessage: {
						text: '@bot done',
						contextInfo: { mentionedJid: ['6580000000@s.whatsapp.net'] }
					}
				}),
				self
			)!['invocation']
		).toBe('mention');
		expect(
			whatsappMessage(
				wa(g, {
					extendedTextMessage: {
						text: 'ok',
						contextInfo: { participant: '6580000000@s.whatsapp.net', stanzaId: 'X' }
					}
				}),
				self
			)
		).toMatchObject({ invocation: 'reply', replyTo: 'X' });
		expect(
			whatsappMessage(
				wa(g, {
					extendedTextMessage: {
						text: 'ok',
						contextInfo: { participant: '6599999999@s.whatsapp.net' }
					}
				}),
				self
			)!['invocation']
		).toBe('ambient');
	});
	it('a mention by our LID addresses us too, which is what WhatsApp actually sends', () => {
		// WhatsApp addresses a linked device by LID, so `mentionedJid` carries the LID and not the phone JID the number
		// prints as. Matching only the phone JID reads every real mention as ambient — the linked device never wakes.
		const g = { remoteJid: '1203@g.us', participant: '6591234567:14@s.whatsapp.net' };
		const mentioned = (jid: string) =>
			whatsappMessage(
				wa(g, { extendedTextMessage: { text: '@bot done', contextInfo: { mentionedJid: [jid] } } }),
				self,
				{ lid: MY_LID }
			)!['invocation'];
		expect(mentioned('6580000000@s.whatsapp.net')).toBe('mention');
		expect(mentioned(MY_LID)).toBe('mention');
		expect(mentioned('999999999999@lid')).toBe('ambient');
	});
	it('a revoke tombstones its target; an edit converges its target text; a backfill is history', () => {
		const dm = { remoteJid: '6591234567@s.whatsapp.net' };
		expect(
			whatsappMessage(wa(dm, { protocolMessage: { type: 0, key: { id: 'OLD' } } }), self)
		).toMatchObject({ id: 'OLD', deleted: true });
		expect(
			whatsappMessage(
				wa(dm, {
					protocolMessage: {
						type: 14,
						key: { id: 'OLD' },
						editedMessage: { conversation: 'fixed' }
					}
				}),
				self
			)
		).toMatchObject({
			id: 'OLD',
			text: 'fixed',
			version: new Date(1_790_000_000_000).toISOString()
		});
		expect(
			whatsappMessage(wa(dm, { imageMessage: { caption: 'photo' } }), self, { history: true })
		).toMatchObject({ text: 'photo', history: true, invocation: 'direct' });
	});
});

describe('the WhatsApp Web link', () => {
	const workDir = mkdtempSync(join(tmpdir(), 'providers-baileys-'));
	const fake = () => {
		const opened: { ev: EventEmitter; socket: WaSocket; dir: string; sent: unknown[] }[] = [];
		const open = async (dir: string) => {
			const ev = new EventEmitter(),
				sent: unknown[] = [];
			const socket: WaSocket = {
				ev: {
					on: (e, l) => {
						ev.on(e, l as (x: unknown) => void);
					}
				},
				user: { id: '6580000000:3@s.whatsapp.net' },
				sendMessage: async (jid, content) => {
					sent.push({ jid, content });
					return { key: { id: 'OUT1' } };
				},
				requestPairingCode: async () => 'ABCD-1234',
				logout: async () => {},
				end: () => {}
			};
			opened.push({ ev, socket, dir, sent });
			return { socket, download: async () => null };
		};
		return { opened, provider: baileys({ open, workDir, backoffMs: () => 5, sealMs: 5 }) };
	};
	const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
	it('pairs by QR, or by code for a phone; refuses a malformed phone', async () => {
		const { opened, provider } = fake(),
			h = await host(provider, fakeFetch([]));
		await expect(h.link.pair({ phone: '12' })).rejects.toThrow(/digits, country code first/);
		await h.link.pair({});
		opened[0]!.ev.emit('connection.update', { qr: 'QR-DATA' });
		expect(h.link.connection()).toMatchObject({
			state: 'pairing',
			pairing: { kind: 'qr', value: 'QR-DATA' }
		});
		await h.link.pair({ phone: '+65 8000 0000' });
		opened[1]!.ev.emit('connection.update', { qr: 'QR2' });
		await wait(1);
		expect(h.link.connection()).toMatchObject({
			state: 'pairing',
			pairing: { kind: 'code', value: 'ABCD-1234' }
		});
	});
	it('seals the auth files on creds.update and resumes from them; a drop reconnects, a logout clears the credential', async () => {
		const { opened, provider } = fake(),
			h = await host(provider, fakeFetch([]));
		await h.link.pair({});
		const first = opened[0]!;
		await writeFile(join(first.dir, 'creds.json'), '{"me":1}');
		first.ev.emit('creds.update', {});
		first.ev.emit('connection.update', { connection: 'open' });
		await wait(30);
		expect(h.saved).toEqual([{ files: { 'creds.json': '{"me":1}' } }]);
		expect(h.link.connection()).toMatchObject({
			state: 'connected',
			pairedAs: '6580000000:3@s.whatsapp.net',
			about: { account: '6580000000' }
		});
		first.ev.emit('connection.update', {
			connection: 'close',
			lastDisconnect: { error: { output: { statusCode: 428 }, message: 'lost' } }
		});
		expect(h.link.connection()).toMatchObject({ state: 'reconnecting', detail: '428: lost' });
		await wait(30);
		expect(opened).toHaveLength(2);
		opened[1]!.ev.emit('connection.update', {
			connection: 'close',
			lastDisconnect: { error: { output: { statusCode: 401 }, message: 'logged out' } }
		});
		expect(h.link.connection()).toMatchObject({ state: 'error' });
		expect(h.saved.at(-1)).toBeNull();
		const resumed = fake(),
			again = await host(resumed.provider, fakeFetch([]), { files: { 'creds.json': '{"me":1}' } });
		expect(resumed.opened).toHaveLength(1);
		expect(again.link.connection().state).toBe('connecting');
		await again.link.close();
	});
	it('emits inbound messages for this channel and sends only while connected', async () => {
		const { opened, provider } = fake(),
			h = await host(provider, fakeFetch([]));
		await h.link.pair({});
		await expect(
			h.link.send('desk', { to: '659@s.whatsapp.net', text: 'x' }, signal())
		).rejects.toThrow(/not open/);
		opened[0]!.ev.emit('connection.update', { connection: 'open' });
		opened[0]!.ev.emit('messages.upsert', {
			type: 'notify',
			messages: [
				{
					key: { id: 'M1', remoteJid: '659@s.whatsapp.net' },
					messageTimestamp: 1_790_000_000,
					message: { conversation: 'hi' }
				}
			]
		});
		await wait(5);
		expect(h.events).toMatchObject([
			{ kind: 'inbound', channel: 'desk', message: { id: 'M1', text: 'hi', invocation: 'direct' } }
		]);
		expect(
			await h.link.send('desk', { to: '659@s.whatsapp.net', text: 'hello' }, signal())
		).toEqual({ providerId: 'OUT1' });
		expect(opened[0]!.sent).toEqual([{ jid: '659@s.whatsapp.net', content: { text: 'hello' } }]);
		await h.link.send('desk', { to: '659@s.whatsapp.net', text: 'files' }, signal(), [
			file('report.pdf', 'application/pdf', '%PDF r'),
			file('chart.png', 'image/png', 'png')
		]);
		expect(opened[0]!.sent.slice(-3)).toEqual([
			{ jid: '659@s.whatsapp.net', content: { text: 'files' } },
			{
				jid: '659@s.whatsapp.net',
				content: {
					document: Buffer.from('%PDF r'),
					mimetype: 'application/pdf',
					fileName: 'report.pdf'
				}
			},
			{ jid: '659@s.whatsapp.net', content: { image: Buffer.from('png'), mimetype: 'image/png' } }
		]);
		await h.link.unpair();
		expect(h.saved.at(-1)).toBeNull();
		expect(h.link.connection().state).toBe('unpaired');
	});
});
