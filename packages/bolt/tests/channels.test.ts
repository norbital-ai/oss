// engine/channels and engine/envoys, the pure half: the inbound decode at the trust boundary, the runtime `OutboundFor`
// check, and the sender handle rule (rule 57, P24). The provider codecs are `@norbital-ai/providers`' tests.
import { describe, expect, it } from 'vitest';
import { checkOutbound } from '../src/engine/channels/outbound.ts';
import { isAutoReply, statusAfter } from '../src/engine/channels/status.ts';
import { decodeInbound, fakeTransport } from '../src/engine/channels/transports.ts';
import { canonicalHandle } from '../src/engine/envoys/senders.ts';

describe('an inbound mail', () => {
	it('keeps its full text and headers (GAP-C1) and decodes to one thread', () => {
		const got = decodeInbound('email', { id: '<r1@x>', thread: null, sentAt: '2026-09-25T10:00:00Z', from: { address: 'Carol@Acme.com', name: 'Carol' }, replyTo: null,
			to: [{ address: 'support@ws.example', name: null }], cc: [], subject: 'Re: your quote', text: 'yes please', html: null,
			headers: { 'in-reply-to': '<q1@ws>', references: '<root@ws> <q1@ws>' }, attachments: [] })!;
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
		// the chat decode is the transport's, not a provider's: Slack, Discord, WeChat and custom decode alike
		for (const t of ['slack', 'discord', 'wechat', 'custom'])
			expect(decodeInbound(t, { id: '1', sentAt: '2026-09-25T10:00:00Z', thread: 'C1', from: { handle: 'U1', name: 'Ana' }, group: true, invocation: 'mention', text: 'x' }))
				.toMatchObject({ sender: 'U1', thread: 'C1', group: true, invocation: 'mention' });
	});
	it('OutboundFor at runtime: email needs to/subject/body; chat needs to/text; inbox sends no messages', () => {
		expect(checkOutbound('email', { to: ['a@b.c'], subject: 's', text: 't' })).toHaveProperty('message');
		expect(checkOutbound('email', { to: [], subject: 's', text: 't' })).toHaveProperty('error');
		// a message row is stored as it is: a stored file's reference passes, inline bytes never do
		const ref = { id: 'f1', name: 'r.pdf', mime: 'application/pdf', bytes: 3, sha256: 'x' };
		expect(checkOutbound('email', { to: ['a@b.c'], subject: 's', text: 't', attachments: [ref] })).toHaveProperty('message');
		expect(checkOutbound('email', { to: ['a@b.c'], subject: 's', text: 't', attachments: [{ name: 'r.pdf', mime: 'application/pdf', base64: 'AAA=' }] }))
			.toEqual({ error: expect.stringContaining('never inline bytes') });
		expect(checkOutbound('whatsapp', { to: '659', text: 'hi' })).toHaveProperty('message');
		expect(checkOutbound('telegram', { to: '5' })).toHaveProperty('error');
		expect(checkOutbound('inbox', { to: 'x', text: 'y' })).toHaveProperty('error');
		// every chat transport and a custom channel take the one chat shape
		for (const t of ['slack', 'discord', 'wechat', 'custom']) {
			expect(checkOutbound(t, { to: 'C1', text: 'hi' })).toHaveProperty('message');
			expect(checkOutbound(t, { text: 'hi' })).toHaveProperty('error');
		}
	});
	it('the fake transport records sends, fails on demand and hands events to every subscriber', async () => {
		const t = fakeTransport('wa');
		const seen: string[] = [];
		const off = t.subscribe(async (e) => { seen.push(e.kind); });
		expect(await t.send('c', { to: 'x', text: 'y' }, AbortSignal.timeout(1000))).toEqual({ providerId: 'wa-1' });
		t.fail = () => new Error('socket closed');
		await expect(t.send('c', {}, AbortSignal.timeout(1000))).rejects.toThrow('socket closed');
		await t.emit({ kind: 'delivery', channel: 'c', providerId: 'wa-1', report: { kind: 'delivered', at: '2026-09-25T10:00:00Z', provider: 'fake' } });
		off();
		await t.emit({ kind: 'delivery', channel: 'c', providerId: 'wa-1', report: { kind: 'read', at: '2026-09-25T10:00:00Z', provider: 'fake' } });
		expect(seen).toEqual(['delivery']);
	});
});

describe('delivery status order (§5.9; status.ts)', () => {
	it('advances by rank, terminal failures win, auto_replied and a lower rank change nothing', () => {
		expect(statusAfter('queued', 'sent')).toBe('sent');
		expect(statusAfter('sent', 'deferred')).toBe('deferred');
		expect(statusAfter('deferred', 'delivered')).toBe('delivered');
		expect(statusAfter('delivered', 'deferred')).toBe('delivered');
		expect(statusAfter('delivered', 'read')).toBe('read');
		expect(statusAfter('read', 'opened')).toBe('read');
		expect(statusAfter('opened', 'replied')).toBe('replied');
		expect(statusAfter('replied', 'auto_replied')).toBe('replied');
		expect(statusAfter('delivered', 'bounced')).toBe('bounced');
		expect(statusAfter('bounced', 'delivered')).toBe('bounced');
		expect(statusAfter('failed', 'replied')).toBe('failed');
		expect(statusAfter('uncertain', 'delivered')).toBe('delivered');
	});
	it('an auto-reply is told by RFC 3834 and the common markers, a person\'s reply is not', () => {
		expect(isAutoReply({ 'Auto-Submitted': 'auto-replied' })).toBe(true);
		expect(isAutoReply({ 'auto-submitted': 'no' })).toBe(false);
		expect(isAutoReply({ 'X-Autoreply': 'yes' })).toBe(true);
		expect(isAutoReply({ Precedence: 'bulk' })).toBe(true);
		expect(isAutoReply({}, 'Automatic reply: PCN 1234')).toBe(true);
		expect(isAutoReply({}, '自动回复: PCN 1234')).toBe(true);
		expect(isAutoReply({}, 'Re: PCN 1234')).toBe(false);
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
