// engine/conversations and engine/envoys, the pure half: the inbound decode at the trust boundary, the runtime `SendInput`
// check, the delivery status order and the sender handle rule. The provider codecs are `@norbital-ai/providers`' tests.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import type { Json } from '../src/decl/values.ts';
import { send_input_schema } from '../src/engine/integrations/outbound.ts';
import { conversationOf } from '../src/engine/integrations/instances.ts';
import slack from '../src/system/integration/slack/+integration.ts';
import telegram from '../src/system/integration/telegram/+integration.ts';
import wechat from '../src/system/integration/wechat/+integration.ts';
import whatsapp from '../src/system/integration/whatsapp/+integration.ts';
import { is_auto_reply, status_after } from '../src/engine/conversations/status.ts';
import { InboundMessage, normalizeInbound } from '../src/engine/conversations/inbound.ts';
import { canonicalHandle } from '../src/engine/envoys/senders.ts';

const inbound = (
	kind: 'chat' | 'email',
	original: { readonly [key: string]: Json },
	history = false
) =>
	Effect.gen(function* () {
		const decoded = yield* Schema.decodeUnknownEffect(InboundMessage)(original);
		return normalizeInbound(kind, decoded, original, history, '2026-09-25T10:00:00.000Z');
	});

describe('an inbound mail', () => {
	it.effect('keeps its full text and headers (GAP-C1) and decodes to one thread', () =>
		Effect.gen(function* () {
			const got = yield* inbound('email', {
				id: '<r1@x>',
				thread: null,
				sent_at: '2026-09-25T10:00:00Z',
				from: { address: 'Carol@Acme.com', name: 'Carol' },
				reply_to: null,
				to: [{ address: 'support@ws.example', name: null }],
				cc: [],
				subject: 'Re: your quote',
				text: 'yes please',
				html: null,
				headers: { 'in-reply-to': '<q1@ws>', references: '<root@ws> <q1@ws>' },
				attachments: []
			});
			expect(got).toMatchObject({
				id: '<r1@x>',
				sender: 'carol@acme.com',
				sender_name: 'Carol',
				thread: '<root@ws>',
				references: ['<q1@ws>', '<root@ws>'],
				invocation: 'direct',
				group: false,
				text: 'yes please'
			});
			expect(got?.email).toMatchObject({
				subject: 'Re: your quote',
				headers: { 'in-reply-to': '<q1@ws>' }
			});
		})
	);
});

describe('the inbound decode and the outbound check', () => {
	it.effect('malformed adapter output is refused; a DM is direct whatever the adapter said', () =>
		Effect.gen(function* () {
			expect(yield* inbound('chat', { id: 'x' })).toBeNull();
			expect(
				yield* inbound('email', { id: 'x', sent_at: '2026-09-25T10:00:00Z', from: {} })
			).toBeNull();
			expect(
				yield* inbound('chat', {
					id: '1',
					sent_at: '2026-09-25T10:00:00Z',
					thread: '5',
					from: { handle: '5' },
					invocation: 'ambient',
					text: 'x'
				})
			).toMatchObject({ group: false, invocation: 'direct', version: '2026-09-25T10:00:00.000Z' });
			// the chat decode is the conversation kind's, not a provider's: every chat driver and a custom chat decode alike
			expect(
				yield* inbound('chat', {
					id: '1',
					sent_at: '2026-09-25T10:00:00Z',
					thread: 'C1',
					from: { handle: 'U1', name: 'Ana' },
					group: true,
					invocation: 'mention',
					text: 'x'
				})
			).toMatchObject({ sender: 'U1', thread: 'C1', group: true, invocation: 'mention' });
		})
	);
	it.effect(
		"a chat names its mentions as `mentions` only; a provider's raw field is no mention",
		() =>
			Effect.gen(function* () {
				const group = {
					id: '1',
					sent_at: '2026-09-25T10:00:00Z',
					thread: 'G1',
					from: { handle: 'U1' },
					group: true,
					text: 'x'
				};
				expect(yield* inbound('chat', { ...group, mentions: ['me@lid', 7] })).toMatchObject({
					mentions: ['me@lid']
				});
				expect(yield* inbound('chat', { ...group, mentionedJid: ['me@lid'] })).toMatchObject({
					mentions: []
				});
			})
	);
	it.effect('OutboundFor at runtime: email needs to/subject/body; chat needs to/text', () =>
		Effect.gen(function* () {
			expect(
				yield* Schema.decodeUnknownEffect(send_input_schema('email'))({
					to: ['a@b.c'],
					subject: 's',
					text: 't'
				})
			).toMatchObject({ to: ['a@b.c'], subject: 's', text: 't' });
			expect(
				yield* Schema.decodeUnknownEffect(send_input_schema('email'))({
					to: [],
					subject: 's',
					text: 't'
				}).pipe(Effect.flip)
			).toHaveProperty('message');
			// a message row is stored as it is: a stored file's reference passes, inline bytes never do
			const ref = { id: 'f1', name: 'r.pdf', mime: 'application/pdf', bytes: 3, sha256: 'x' };
			expect(
				yield* Schema.decodeUnknownEffect(send_input_schema('email'))({
					to: ['a@b.c'],
					subject: 's',
					text: 't',
					attachments: [ref]
				})
			).toMatchObject({ attachments: [ref] });
			expect(
				yield* Schema.decodeUnknownEffect(send_input_schema('email'))({
					to: ['a@b.c'],
					subject: 's',
					text: 't',
					attachments: [{ name: 'r.pdf', mime: 'application/pdf', base64: 'AAA=' }]
				}).pipe(Effect.flip)
			).toMatchObject({ message: expect.stringContaining('never inline bytes') });
			// every chat driver and a custom chat definition take the one chat shape
			expect(
				yield* Schema.decodeUnknownEffect(send_input_schema('chat'))({ to: '659', text: 'hi' })
			).toEqual({ to: '659', text: 'hi' });
			expect(
				yield* Schema.decodeUnknownEffect(send_input_schema('chat'))({ to: '5' }).pipe(Effect.flip)
			).toMatchObject({ message: 'a chat message needs `text`' });
			expect(
				yield* Schema.decodeUnknownEffect(send_input_schema('chat'))({ text: 'hi' }).pipe(Effect.flip)
			).toMatchObject({ message: 'a chat message needs `to`' });
		})
	);
	it.effect(
		"history is the event's: every message of a backfill is history, a live event's none",
		() =>
			Effect.gen(function* () {
				const m = {
					id: '1',
					sent_at: '2026-09-25T10:00:00Z',
					thread: '5',
					from: { handle: '5' },
					text: 'x',
					history: true
				};
				expect(yield* inbound('chat', m)).toMatchObject({ history: false });
				expect(yield* inbound('chat', m, true)).toMatchObject({ history: true });
				expect(yield* inbound('chat', { id: '2', deleted: true }, true)).toMatchObject({
					thread: '',
					deleted: true,
					history: true
				});
			})
	);
	it.effect(
		"a definition carries its driver's conversation and sender handle; request drivers carry none",
		() =>
			Effect.gen(function* () {
				expect(conversationOf({ description: 'x', driver: whatsapp.spec.driver })).toEqual({
					kind: 'chat',
					handle: 'phone',
					address: '{}@s.whatsapp.net'
				});
				expect(conversationOf({ description: 'x', driver: slack.spec.driver })).toEqual({
					kind: 'chat',
					handle: 'slack',
					address: '@{}'
				});
				expect(conversationOf({ description: 'x', driver: wechat.spec.driver })).toEqual({
					kind: 'chat',
					handle: null
				});
				expect(conversationOf({ description: 'x', driver: 'email' })).toEqual({
					kind: 'email',
					handle: 'email'
				});
				expect(
					conversationOf({
						description: 'x',
						driver: telegram.spec.driver
					})
				).toEqual({ kind: 'chat', handle: 'telegram' });
				expect(conversationOf({ description: 'x', driver: 'http' })).toBeUndefined();
				expect(conversationOf({ description: 'x', driver: 'sqlserver' })).toBeUndefined();
			})
	);
});

describe('delivery status order (status.ts)', () => {
	it('advances by rank, terminal failures win, auto_replied and a lower rank change nothing', () => {
		expect(status_after('queued', 'sent')).toBe('sent');
		expect(status_after('sent', 'deferred')).toBe('deferred');
		expect(status_after('deferred', 'delivered')).toBe('delivered');
		expect(status_after('delivered', 'deferred')).toBe('delivered');
		expect(status_after('delivered', 'read')).toBe('read');
		expect(status_after('read', 'opened')).toBe('read');
		expect(status_after('opened', 'replied')).toBe('replied');
		expect(status_after('replied', 'auto_replied')).toBe('replied');
		expect(status_after('delivered', 'bounced')).toBe('bounced');
		expect(status_after('bounced', 'delivered')).toBe('bounced');
		expect(status_after('failed', 'replied')).toBe('failed');
		expect(status_after('uncertain', 'delivered')).toBe('delivered');
	});
	it("an auto-reply is told by RFC 3834 and the common markers, a person's reply is not", () => {
		expect(is_auto_reply({ 'Auto-Submitted': 'auto-replied' })).toBe(true);
		expect(is_auto_reply({ 'auto-submitted': 'no' })).toBe(false);
		expect(is_auto_reply({ 'X-Autoreply': 'yes' })).toBe(true);
		expect(is_auto_reply({ Precedence: 'bulk' })).toBe(true);
		expect(is_auto_reply({}, 'Automatic reply: PCN 1234')).toBe(true);
		expect(is_auto_reply({}, '自动回复: PCN 1234')).toBe(true);
		expect(is_auto_reply({}, 'Re: PCN 1234')).toBe(false);
	});
});

describe('sender handles (senders.ts)', () => {
	it('a WhatsApp JID drops its device suffix before the digits of a phone handle are taken', () => {
		expect(canonicalHandle('phone', '6589548277:14@s.whatsapp.net')).toBe('6589548277');
		expect(canonicalHandle('phone', '+65 8954 8277')).toBe('6589548277');
	});
	it('a leading @ is a sigil; handles fold case; email is the whole address; nothing identifying is empty', () => {
		expect(canonicalHandle('telegram', '@Alice')).toBe('alice');
		expect(canonicalHandle('email', ' Carol@Acme.com ')).toBe('carol@acme.com');
		expect(canonicalHandle('telegram', '@')).toBe('');
		expect(canonicalHandle('phone', 'no digits')).toBe('');
		expect(canonicalHandle(null, 'U1ABC')).toBe('u1abc'); // a conversation without handles still keys its rate limits
	});
});
