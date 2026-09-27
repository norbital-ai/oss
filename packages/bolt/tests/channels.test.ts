// engine/channels and engine/envoys, the pure half: the transport codecs every host adapter shares (Telegram webhook
// updates, Baileys WhatsApp messages, Resend events behind Svix), the inbound decode at the trust boundary, the
// runtime `OutboundFor` check, and the sender handle rule (rule 57, P24).
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkOutbound } from '../src/engine/channels/outbound.ts';
import { decodeInbound, fakeTransport, resendEvent, telegramUpdate, telegramVerified, whatsappMessage } from '../src/engine/channels/transports.ts';
import { canonicalHandle } from '../src/engine/envoys/registration.ts';

const bot = { id: 42, username: 'DeskBot' };
const tg = (message: object, edited = false) => ({ update_id: 1, [edited ? 'edited_message' : 'message']: { message_id: 7, date: 1_790_000_000, from: { id: 5, first_name: 'Ana' }, ...message } });

describe('Telegram updates', () => {
	it('a DM is direct; the chat is part of the provider id', () => {
		const got = telegramUpdate(tg({ chat: { id: 5, type: 'private' }, text: 'hello' }), bot)!;
		expect(got.message).toMatchObject({ id: '5:7', thread: '5', group: false, invocation: 'direct', text: 'hello', from: { handle: '5', name: 'Ana' } });
	});
	it('in a group: an @mention, a bot command for us, a reply to our message address the bot; anything else is ambient', () => {
		const group = { chat: { id: -9, type: 'supergroup' } };
		expect(telegramUpdate(tg({ ...group, text: 'hey @deskbot status?', entities: [{ type: 'mention', offset: 4, length: 8 }] }), bot)!.message['invocation']).toBe('mention');
		expect(telegramUpdate(tg({ ...group, text: '/status@DeskBot', entities: [{ type: 'bot_command', offset: 0, length: 15 }] }), bot)!.message['invocation']).toBe('mention');
		expect(telegramUpdate(tg({ ...group, text: 'yes', reply_to_message: { message_id: 3, from: { id: 42 } } }), bot)!.message['invocation']).toBe('reply');
		expect(telegramUpdate(tg({ ...group, text: 'yes', reply_to_message: { message_id: 3, from: { id: 8 } } }), bot)!.message['invocation']).toBe('ambient');
		expect(telegramUpdate(tg({ ...group, text: 'hey @other', entities: [{ type: 'mention', offset: 4, length: 6 }] }), bot)!.message['invocation']).toBe('ambient');
	});
	it('an edit carries its edit time as the version; a topic is its own conversation; media is named for the adapter to fetch', () => {
		const got = telegramUpdate(tg({ chat: { id: -9, type: 'supergroup' }, is_topic_message: true, message_thread_id: 3, caption: 'site photo', edit_date: 1_790_000_060,
			photo: [{ file_id: 'small' }, { file_id: 'big' }] }, true), bot)!;
		expect(got.message).toMatchObject({ thread: '-9:thread:3', text: 'site photo', version: new Date(1_790_000_060_000).toISOString() });
		expect(got.media).toEqual({ fileId: 'big', fileName: 'photo-big.jpg', mimeType: 'image/jpeg' });
		expect(telegramUpdate({ update_id: 1, callback_query: {} }, bot)).toBeNull();
	});
	it('the webhook secret header is compared exactly', () => {
		expect(telegramVerified({ 'x-telegram-bot-api-secret-token': 's3cret' }, 's3cret')).toBe(true);
		expect(telegramVerified({ 'x-telegram-bot-api-secret-token': 's3cre' }, 's3cret')).toBe(false);
		expect(telegramVerified({}, '')).toBe(false);
	});
});

describe('WhatsApp (Baileys) messages', () => {
	const self = '6580000000:3@s.whatsapp.net';
	const wa = (key: object, message: object, extra: object = {}) => ({ key: { id: 'M1', ...key }, messageTimestamp: 1_790_000_000, pushName: 'Ben', message, ...extra });
	it('our own echo and empty messages are not messages', () => {
		expect(whatsappMessage(wa({ remoteJid: '659@s.whatsapp.net', fromMe: true }, { conversation: 'x' }), self)).toBeNull();
		expect(whatsappMessage({ key: { id: 'M1', remoteJid: 'x' } }, self)).toBeNull();
	});
	it('a group message names its participant; a mention of our number or a quote of our message addresses us', () => {
		const g = { remoteJid: '1203@g.us', participant: '6591234567:14@s.whatsapp.net' };
		expect(whatsappMessage(wa(g, { conversation: 'running late' }), self)).toMatchObject({ thread: '1203@g.us', group: true, invocation: 'ambient',
			from: { handle: '6591234567:14@s.whatsapp.net', name: 'Ben' } });
		expect(whatsappMessage(wa(g, { extendedTextMessage: { text: '@bot done', contextInfo: { mentionedJid: ['6580000000@s.whatsapp.net'] } } }), self)!['invocation']).toBe('mention');
		expect(whatsappMessage(wa(g, { extendedTextMessage: { text: 'ok', contextInfo: { participant: '6580000000@s.whatsapp.net', stanzaId: 'X' } } }), self))
			.toMatchObject({ invocation: 'reply', replyTo: 'X' });
		expect(whatsappMessage(wa(g, { extendedTextMessage: { text: 'ok', contextInfo: { participant: '6599999999@s.whatsapp.net' } } }), self)!['invocation']).toBe('ambient');
	});
	it('a revoke tombstones its target; an edit converges its target text; a backfill is history', () => {
		const dm = { remoteJid: '6591234567@s.whatsapp.net' };
		expect(whatsappMessage(wa(dm, { protocolMessage: { type: 0, key: { id: 'OLD' } } }), self)).toMatchObject({ id: 'OLD', deleted: true });
		expect(whatsappMessage(wa(dm, { protocolMessage: { type: 14, key: { id: 'OLD' }, editedMessage: { conversation: 'fixed' } } }), self))
			.toMatchObject({ id: 'OLD', text: 'fixed', version: new Date(1_790_000_000_000).toISOString() });
		expect(whatsappMessage(wa(dm, { imageMessage: { caption: 'photo' } }), self, { history: true })).toMatchObject({ text: 'photo', history: true, invocation: 'direct' });
	});
});

describe('Resend events behind Svix', () => {
	const secret = `whsec_${Buffer.from('k'.repeat(24)).toString('base64')}`;
	const signed = (event: object, now = 1_790_000_000_000) => {
		const body = new TextEncoder().encode(JSON.stringify(event)), ts = String(Math.floor(now / 1000));
		const sig = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`msg_1.${ts}.`).update(body).digest('base64');
		return { headers: { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }, body };
	};
	it('an unsigned or stale delivery is unverified; delivery types map onto DeliveryKind', () => {
		const { headers, body } = signed({ type: 'email.bounced', created_at: '2026-09-25T10:00:00Z', data: { email_id: 'e1', bounce: { message: 'mailbox full' } } });
		expect(resendEvent('mail', { ...headers, 'svix-signature': 'v1,AAAA' }, body, secret, 1_790_000_000_000)).toBe('unverified');
		expect(resendEvent('mail', headers, body, secret, 1_790_000_000_000 + 3_600_000)).toBe('unverified');
		expect(resendEvent('mail', headers, body, secret, 1_790_000_000_000)).toEqual({ kind: 'delivery', channel: 'mail', providerId: 'e1', event: 'bounced',
			at: '2026-09-25T10:00:00.000Z', data: { reason: 'mailbox full' } });
	});
	it('an inbound mail keeps its full text and headers (GAP-C1) and decodes to one thread', () => {
		const { headers, body } = signed({ type: 'email.received', created_at: '2026-09-25T10:00:00Z', data: { email_id: 'e2', message_id: '<r1@x>',
			from: 'Carol <carol@acme.com>', to: ['support@ws.example'], subject: 'Re: your quote', text: 'yes please',
			headers: { 'In-Reply-To': '<q1@ws>', References: '<root@ws> <q1@ws>' } } });
		const e = resendEvent('mail', headers, body, secret, 1_790_000_000_000);
		if (e === null || e === 'unverified' || e.kind !== 'inbound') throw new Error('expected an inbound mail');
		const got = decodeInbound('email', e.message)!;
		expect(got).toMatchObject({ id: '<r1@x>', sender: 'carol@acme.com', senderName: 'Carol', thread: '<root@ws>', references: ['<q1@ws>', '<root@ws>'],
			invocation: 'direct', group: false, text: 'yes please' });
		expect(got.email).toMatchObject({ subject: 'Re: your quote', headers: { 'in-reply-to': '<q1@ws>' } });
	});
});

describe('the inbound decode and the outbound check', () => {
	it('malformed adapter output is refused; a DM is direct whatever the adapter said', () => {
		expect(decodeInbound('whatsapp', { id: 'x' })).toBeNull();
		expect(decodeInbound('email', { id: 'x', sentAt: '2026-09-25T10:00:00Z', from: {} })).toBeNull();
		expect(decodeInbound('telegram', { id: '1', sentAt: '2026-09-25T10:00:00Z', thread: '5', from: { handle: '5' }, invocation: 'ambient', text: 'x' }))
			.toMatchObject({ group: false, invocation: 'direct', version: '2026-09-25T10:00:00.000Z' });
	});
	it('OutboundFor at runtime: email needs to/subject/body; chat needs to/text; inbox sends no messages', () => {
		expect(checkOutbound('email', { to: ['a@b.c'], subject: 's', text: 't' })).toHaveProperty('message');
		expect(checkOutbound('email', { to: [], subject: 's', text: 't' })).toHaveProperty('error');
		expect(checkOutbound('whatsapp', { to: '659', text: 'hi' })).toHaveProperty('message');
		expect(checkOutbound('telegram', { to: '5' })).toHaveProperty('error');
		expect(checkOutbound('inbox', { to: 'x', text: 'y' })).toHaveProperty('error');
	});
	it('the fake transport records sends, fails on demand and hands events to every subscriber', async () => {
		const t = fakeTransport('wa');
		const seen: string[] = [];
		const off = t.subscribe(async (e) => { seen.push(e.kind); });
		expect(await t.send('c', { to: 'x', text: 'y' }, AbortSignal.timeout(1000))).toEqual({ providerId: 'wa-1' });
		t.fail = () => new Error('socket closed');
		await expect(t.send('c', {}, AbortSignal.timeout(1000))).rejects.toThrow('socket closed');
		await t.emit({ kind: 'delivery', channel: 'c', providerId: 'wa-1', event: 'delivered', at: '2026-09-25T10:00:00Z' });
		off();
		await t.emit({ kind: 'delivery', channel: 'c', providerId: 'wa-1', event: 'opened', at: '2026-09-25T10:00:00Z' });
		expect(seen).toEqual(['delivery']);
	});
});

describe('sender handles (rule 57; transport-identity.ts)', () => {
	it('a WhatsApp JID drops its device suffix before the digits are taken', () => {
		expect(canonicalHandle('whatsapp', '6589548277:14@s.whatsapp.net')).toBe('6589548277');
		expect(canonicalHandle('whatsapp', '+65 8954 8277')).toBe('6589548277');
	});
	it('a leading @ is a sigil; handles fold case; email is the whole address; nothing identifying is empty', () => {
		expect(canonicalHandle('telegram', '@Alice')).toBe('alice');
		expect(canonicalHandle('email', ' Carol@Acme.com ')).toBe('carol@acme.com');
		expect(canonicalHandle('telegram', '@')).toBe('');
		expect(canonicalHandle('whatsapp', 'no digits')).toBe('');
	});
});
