// XChat: X's real chat-xdk crypto on both sides of a conversation. The bot's adapter and a person each hold real keys, and
// events are assembled the way X's server wraps what a client sends, so decryption and signature checks are real. The one
// stub is Juicebox's client (its realms speak their own protocol, not `fetch`), through chat-xdk's own test seam.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { vi } from 'vitest';
import { createChat, type SendPayload } from '@xdevplatform/chat-xdk';
import { chatProvider } from '../../src/chat/adapter.ts';
import { xchat } from '../../src/chat/xchat/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const juicebox = vi.hoisted(() => ({
	secret: new Uint8Array(),
	pins: [] as string[],
	tokens: [] as unknown[]
}));
vi.mock('@xdevplatform/chat-xdk', async (original) => {
	const real = await original<typeof import('@xdevplatform/chat-xdk')>();
	class Configuration {}
	class Client {
		async register(_pin: Uint8Array, secret: Uint8Array) {
			juicebox.secret = secret.slice();
		}
		async recover(pin: Uint8Array) {
			const typed = new TextDecoder().decode(pin);
			juicebox.pins.push(typed);
			if (typed !== '7391') throw { reason: 0, guesses_remaining: 19 };
			juicebox.tokens.push(await Reflect.get(globalThis, 'JuiceboxGetAuthToken')('realm1'));
			return juicebox.secret.slice();
		}
	}
	return {
		...real,
		createChat: (options: Parameters<typeof real.createChat>[0]) => {
			const stubbed = { ...options, juiceboxModule: { Client, Configuration } };
			return real.createChat(stubbed);
		}
	};
});

const peer = async (id: string, version: string) => {
	const chat = await createChat({ juiceboxConfig: '{}', getAuthToken: async () => '' });
	const { publicKey } = chat.generateKeypairs();
	await chat.setup('7391');
	chat.setIdentity(id, version);
	return { chat, publicKey, version };
};
const bot = await peer('100', '1700000000000');
const secret = juicebox.secret;
const human = await peer('200', '1700000000001');
juicebox.secret = secret;
const change = human.chat.prepareConversationKeyChange({
	publicKeys: [bot, human].map((one, index) => ({
		userId: index === 0 ? '100' : '200',
		publicKey: one.publicKey.publicKey,
		keyVersion: one.version
	}))
});
const conversation = change.conversationId,
	key = change.conversationKey,
	keyVersion = change.conversationKeyVersion;

// Thrift's binary protocol, for the event X's server wraps around what a client sends
const string = (value: string | Buffer) => {
	const bytes = Buffer.from(value),
		length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.length);
	return Buffer.concat([length, bytes]);
};
const field = (type: number, id: number, body: Buffer) => {
	const head = Buffer.alloc(3);
	head[0] = type;
	head.writeUInt16BE(id, 1);
	return Buffer.concat([head, body]);
};
const END = Buffer.from([0]);
const STRING = 11,
	STRUCT = 12;
const CREATED = '1790000000000';
const event = (
	sequence: string,
	messageId: string,
	sender: string,
	detail: Buffer,
	signature?: Buffer,
	conversationId = conversation
) =>
	Buffer.concat([
		field(STRING, 1, string(sequence)),
		field(STRING, 2, string(messageId)),
		field(STRING, 3, string(sender)),
		field(STRING, 4, string(conversationId)),
		field(STRING, 6, string(CREATED)),
		field(STRUCT, 7, detail),
		...(signature === undefined ? [] : [field(STRUCT, 9, signature)]),
		END
	]).toString('base64');
const written = (
	sequence: string,
	payload: SendPayload,
	sender = '200',
	conversationId = conversation
) =>
	event(
		sequence,
		payload.messageId,
		sender,
		Buffer.concat([field(STRUCT, 1, Buffer.from(payload.encryptedContent, 'base64')), END]),
		Buffer.from(payload.encodedEventSignature, 'base64'),
		conversationId
	);
const keyEvent = event(
	'1',
	change.actionSignatures[0]?.messageId ?? '',
	'200',
	Buffer.from(change.actionSignatures[0]?.encodedMessageEventDetail ?? '', 'base64')
);
const sealed = { conversationId: conversation, conversationKey: key, conversationKeyVersion: keyVersion };
const quoting = (text: string, conversationId = conversation) =>
	human.chat.encryptReply({
		...sealed,
		conversationId,
		text,
		replyToSequenceId: '9',
		replyToSenderId: '100',
		replyToText: 'the bot said'
	});
const says = (sequence: string, text: string, ttlMsec: number | null = null) =>
	written(sequence, human.chat.encryptMessage({ ...sealed, text, ttlMsec }));

const settings = {
	apiKey: 'consumer',
	apiSecret: 'consumer-secret',
	accessToken: 'token',
	accessTokenSecret: 'token-secret',
	pin: '7391'
};
const keyRow = (one: typeof bot) => ({
	public_key_version: one.version,
	public_key: one.publicKey.publicKey,
	signing_public_key: one.publicKey.signingPublicKey,
	identity_public_key_signature: one.publicKey.identityPublicKeySignature
});
const answering =
	(rows: readonly object[] = [], next?: (call: Call) => Response | undefined) =>
	(call: Call) =>
		next?.(call) ??
		(call.url.includes('/2/users/me')
			? json({ data: { id: '100', username: 'nor_bot' } })
			: call.url.includes('/2/users/100/public_keys')
				? json({
						data: [
							{
								...keyRow(bot),
								juicebox_config: {
									key_store_token_map_json: '{}',
									token_map: [{ key: 'realm1', value: { token: 'realm-token' } }]
								}
							}
						]
					})
				: call.url.includes('/2/users/200/public_keys')
					? json({ data: [keyRow(human)] })
					: call.url.includes('/events')
						? json({ data: rows, meta: { conversation_key_events: [keyEvent] } })
						: call.url.endsWith('/messages')
							? json({ data: {} }, 201)
							: json({}));
const sign = (body: string) => ({
	'x-twitter-webhooks-signature': `sha256=${createHmac('sha256', 'consumer-secret').update(body).digest('base64')}`
});
const activity = (
	encoded: string,
	type = 'chat.received',
	sender = '200',
	conversationId = conversation
) =>
	JSON.stringify({
		data: {
			event_type: type,
			payload: { conversation_id: conversationId, sender_id: sender, encoded_event: encoded }
		}
	});
const connect = () =>
	Effect.promise(() =>
		xchat.connect(settings, { fetch, webhookUrl: 'https://hook.test/', receive: async () => {} })
	);

describe('XChat', () => {
	it.live('decrypts and stores a message a person sent, with exact fields', () =>
		Effect.gen(function* () {
			yield* platformApi(answering());
			const h = yield* connected(xchat, settings),
				body = activity(says('11', 'hello there'));
			expect(h.status).toMatchObject({ state: 'connected', account: 'nor_bot' });
			expect(juicebox.tokens.at(-1)).toBe('realm-token');
			expect((yield* h.link.webhook!(webhook(body, sign(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: '11',
						thread: conversation,
						text: 'hello there',
						sentAt: new Date(Number(CREATED)).toISOString(),
						from: { handle: '200' },
						group: false,
						invocation: 'direct'
					}
				]
			});
		})
	);
	it.live('takes the conversation key a delivery carries when the API has none', () =>
		Effect.gen(function* () {
			yield* platformApi(
				answering([], (call) =>
					call.url.includes('/events') ? json({ data: [] }) : undefined
				)
			);
			const h = yield* connected(xchat, settings);
			const wrapped = change.participantKeys.find((one) => one.userId === '100')?.encryptedKey;
			const body = JSON.stringify({
				data: {
					event_type: 'chat.received',
					payload: {
						conversation_id: conversation,
						sender_id: '200',
						encoded_event: says('12', 'carried'),
						encrypted_conversation_key: wrapped,
						conversation_key_version: keyVersion
					}
				}
			});
			expect((yield* h.link.webhook!(webhook(body, sign(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({ messages: [{ id: '12', text: 'carried' }] });
		})
	);
	it.live('an edit keeps the id it targets, and a delete for everyone names it', () =>
		Effect.gen(function* () {
			yield* platformApi(answering());
			const h = yield* connected(xchat, settings);
			const edit = activity(
				written(
					'13',
					human.chat.encryptEdit({
						...sealed,
						updatedText: 'edited',
						targetMessageSequenceId: '11'
					})
				)
			);
			const action = human.chat.prepareMessageDelete({
				conversationId: conversation,
				sequenceIds: ['11'],
				deleteForAll: true
			});
			const gone = activity(
				event(
					'14',
					action.messageId,
					'200',
					Buffer.from(action.encodedMessageEventDetail, 'base64'),
					Buffer.concat([
						field(STRING, 1, string(action.signature)),
						field(STRING, 2, string(action.publicKeyVersion)),
						field(STRING, 3, string(action.signatureVersion)),
						END
					])
				)
			);
			yield* h.link.webhook!(webhook(edit, sign(edit)));
			yield* h.link.webhook!(webhook(gone, sign(gone)));
			const at = new Date(Number(CREATED)).toISOString();
			expect(h.events[0]).toMatchObject({ messages: [{ id: '11', text: 'edited', version: at }] });
			expect(h.events[1]).toMatchObject({ messages: [{ id: '11', text: '', deleted: true }] });
		})
	);
	it.live('a reply names what it answers', () =>
		Effect.gen(function* () {
			yield* platformApi(answering());
			const h = yield* connected(xchat, settings);
			const reply = activity(written('15', quoting('quoted')));
			yield* h.link.webhook!(webhook(reply, sign(reply)));
			expect(h.events[0]).toMatchObject({
				messages: [{ id: '15', replyTo: '9', invocation: 'direct' }]
			});
		})
	);
	it.live('in a group, only a mention or a reply to the bot invokes it', () =>
		Effect.gen(function* () {
			yield* platformApi(answering());
			const h = yield* connected(xchat, settings),
				group = { ...sealed, conversationId: 'g1' };
			const wrote = (sequence: string, payload: SendPayload) =>
				activity(written(sequence, payload, '200', 'g1'), 'chat.received', '200', 'g1');
			for (const body of [
				wrote('41', human.chat.encryptMessage({ ...group, text: 'hi @NOR_BOT' })),
				wrote('42', human.chat.encryptMessage({ ...group, text: 'mail nor_bot@acme.test' })),
				wrote('43', human.chat.encryptMessage({ ...group, text: 'hi @nor_bot2' })),
				wrote('44', quoting('quoted', 'g1'))
			])
				yield* h.link.webhook!(webhook(body, sign(body)));
			expect(h.events).toMatchObject([
				{ messages: [{ thread: 'g1', group: true, invocation: 'mention' }] },
				{ messages: [{ invocation: 'ambient' }] },
				{ messages: [{ invocation: 'ambient' }] },
				{ messages: [{ invocation: 'reply' }] }
			]);
		})
	);
	it.live('a file arrives decrypted', () =>
		Effect.gen(function* () {
			const bytes = new TextEncoder().encode('a real image');
			const encrypted = human.chat.encryptStream(bytes, key);
			yield* platformApi(
				answering([], (call) =>
					call.url.includes('/2/chat/media/') ? new Response(encrypted.slice()) : undefined
				)
			);
			const h = yield* connected(xchat, settings);
			const body = activity(
				written(
					'16',
					human.chat.encryptMessage({
						...sealed,
						text: '',
						attachments: [
							{
								attachment_type: 'media',
								media_hash_key: 'hash1',
								width: 10,
								height: 10,
								filesize_bytes: bytes.length,
								filename: 'photo.png',
								media_type: 2
							}
						]
					})
				)
			);
			yield* h.link.webhook!(webhook(body, sign(body)));
			const stored = h.events[0];
			expect(stored).toMatchObject({
				messages: [
					{
						id: '16',
						text: '',
						attachments: [{ name: 'photo.png', mime: 'image/*', bytes: bytes.length, bin: 0 }]
					}
				]
			});
			expect(stored?.kind === 'messages' ? new TextDecoder().decode(stored.bins?.[0]) : '').toBe(
				'a real image'
			);
		})
	);
	it.live('refuses a bad webhook signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answering());
			const h = yield* connected(xchat, settings),
				body = activity(says('17', 'hello'));
			const refused = yield* h.link.webhook!(
				webhook(body, { 'x-twitter-webhooks-signature': 'sha256=forged' })
			);
			expect(refused.status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('an event not signed by its sender is not believed, and not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answering());
			const h = yield* connected(xchat, settings);
			const payload = human.chat.encryptMessage({ ...sealed, text: 'forged' });
			const unsigned = activity(
				event(
					'18',
					payload.messageId,
					'200',
					Buffer.concat([field(STRUCT, 1, Buffer.from(payload.encryptedContent, 'base64')), END])
				)
			);
			const failure = yield* Effect.flip(h.link.webhook!(webhook(unsigned, sign(unsigned))));
			expect(failure.message).toContain('decrypted and verified');
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answering());
			const h = yield* connected(xchat, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = activity(says('19', 'hello'));
			expect((yield* h.link.webhook!(webhook(body, sign(body)))).status).toBe(500);
		})
	);
	it.live('ignores the bot own messages and a join', () =>
		Effect.gen(function* () {
			yield* platformApi(answering());
			const h = yield* connected(xchat, settings),
				own = activity('ignored', 'chat.received', '100'),
				sent = activity('ignored', 'chat.sent'),
				join = activity('ignored', 'chat.conversation_join');
			for (const body of [own, sent, join]) yield* h.link.webhook!(webhook(body, sign(body)));
			expect(h.events).toEqual([]);
		})
	);
	it.live('answers the CRC challenge, and signs nothing that is not a token', () =>
		Effect.gen(function* () {
			yield* platformApi(answering());
			const h = yield* connected(xchat, settings),
				token = 'abcdefghijklmnop1234';
			const answered = yield* h.link.webhook!(
				new Request(`https://hook.test/?crc_token=${token}`)
			);
			expect(yield* Effect.promise(() => answered.json())).toEqual({
				response_token: `sha256=${createHmac('sha256', 'consumer-secret').update(token).digest('base64')}`
			});
			const oracle = yield* h.link.webhook!(
				new Request(`https://hook.test/?crc_token=${encodeURIComponent('{"data":{}}')}`)
			);
			expect(oracle.status).toBe(401);
		})
	);
	it.live('sends what only the conversation can read, on its disappearing clock', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(
				answering([
					{
						sender_id: '200',
						encoded_event: says('20', 'gone in a minute', 60_000),
						conversation_token: 'conv-token'
					}
				])
			);
			const h = yield* connected(xchat, settings);
			const sent = yield* h.link.send!({ to: conversation, text: 'Hello back' }, []);
			const call = api.calls.at(-1),
				body = JSON.parse(call?.body ?? '');
			expect(call?.url).toBe('https://api.x.com/2/chat/conversations/200/messages');
			expect(body).toMatchObject({ message_id: sent.providerId, conversation_token: 'conv-token' });
			expect(body.encoded_message_create_event).not.toContain('Hello');
			const read = human.chat.decryptEvent(
				written(
					'21',
					{
						messageId: body.message_id,
						encryptedContent: body.encoded_message_create_event,
						encodedEventSignature: body.encoded_message_event_signature,
						signature: '',
						signatureInfo: { publicKeyVersion: bot.version, signatureVersion: '7' },
						conversationKeyVersion: keyVersion,
						shouldNotify: true
					},
					'100'
				),
				{ [keyVersion]: key },
				[
					{
						userId: '100',
						publicKeyVersion: bot.version,
						publicKey: bot.publicKey.signingPublicKey,
						identityPublicKey: bot.publicKey.publicKey,
						identityPublicKeySignature: bot.publicKey.identityPublicKeySignature
					}
				]
			);
			expect(read).toMatchObject({
				senderId: '100',
				verified: true,
				ttlMsec: 60_000,
				content: { text: 'Hello back' }
			});
		})
	);
	it.live('no conversation key is no send', () =>
		Effect.gen(function* () {
			yield* platformApi(
				answering([], (call) => (call.url.includes('/events') ? json({ data: [] }) : undefined))
			);
			const h = yield* connected(xchat, settings);
			const failure = yield* Effect.flip(h.link.send!({ to: conversation, text: 'hi' }, []));
			expect(failure.message).toContain('no conversation key');
		})
	);
	it.live('typing goes to the conversation, only while on', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answering());
			const h = yield* connected(xchat, settings);
			yield* h.link.typing!(conversation, true);
			expect(api.calls.at(-1)?.url).toBe('https://api.x.com/2/chat/conversations/200/typing');
			const before = api.calls.length;
			yield* h.link.typing!(conversation, false);
			expect(api.calls).toHaveLength(before);
		})
	);
	it.live('a wrong PIN fails pairing, and so does a token X refuses', () =>
		Effect.gen(function* () {
			yield* platformApi(answering());
			const wrong = yield* host(chatProvider(xchat), fetch);
			yield* Effect.flip(wrong.link.pair!({ ...settings, pin: '0000' }));
			expect(juicebox.pins.at(-1)).toBe('0000');
			expect(wrong.values.size).toBe(0);
		}).pipe(
			Effect.andThen(
				Effect.gen(function* () {
					yield* platformApi(() => json({ title: 'Unauthorized' }, 401));
					const refused = yield* host(chatProvider(xchat), fetch);
					yield* Effect.flip(refused.link.pair!(settings));
					expect(refused.values.size).toBe(0);
				})
			)
		)
	);
	it.live('an account without chat keys fails pairing', () =>
		Effect.gen(function* () {
			yield* platformApi(
				answering([], (call) =>
					call.url.includes('/2/users/100/public_keys') ? json({ data: [] }) : undefined
				)
			);
			const h = yield* host(chatProvider(xchat), fetch);
			const failure = yield* Effect.flip(h.link.pair!(settings));
			expect(failure.message).toContain('no XChat keys');
		})
	);
	it.live('reads a conversation back across pages to the window', () =>
		Effect.gen(function* () {
			const old = '2026-09-01T10:00:00.000Z',
				inWindow = '2026-10-01T10:00:00.000Z';
			yield* platformApi(
				answering([], (call) =>
					!call.url.includes('/events')
						? undefined
						: call.url.includes('pagination_token=p2')
							? json({
									data: [
										{ sender_id: '200', encoded_event: says('32', 'earlier'), created_at: inWindow },
										{ sender_id: '200', encoded_event: says('31', 'too old'), created_at: old }
									],
									meta: { conversation_key_events: [keyEvent] }
								})
							: json({
									data: [
										{
											sender_id: '100',
											encoded_event: written(
												'34',
												bot.chat.encryptMessage({ ...sealed, text: 'mine' }),
												'100'
											),
											created_at: inWindow
										},
										{ sender_id: '200', encoded_event: says('33', 'newest'), created_at: inWindow }
									],
									meta: { conversation_key_events: [keyEvent], next_token: 'p2' }
								})
				)
			);
			const connection = yield* connect();
			const read = yield* Effect.promise(() =>
				connection.history!(conversation, '2026-09-15T00:00:00.000Z')
			);
			expect(read.complete).toBe(true);
			expect(read.messages.map((message) => [message.id, message.text])).toEqual([
				['33', 'newest'],
				['32', 'earlier']
			]);
			yield* Effect.promise(async () => connection.close?.());
		})
	);
	it.live('a window with an event that cannot be proved is not whole', () =>
		Effect.gen(function* () {
			yield* platformApi(
				answering([{ sender_id: '200', encoded_event: 'not-an-event', created_at: '2026-10-01T10:00:00.000Z' }])
			);
			const connection = yield* connect();
			const read = yield* Effect.promise(() =>
				connection.history!(conversation, '2026-09-15T00:00:00.000Z')
			);
			expect(read).toEqual({ messages: [], complete: false });
		})
	);
});
