import { deflateSync } from 'node:zlib';
import { Effect, Schema } from 'effect';
import { until } from './kit.ts';
// The realm's Baileys patch, probed in the installed library (both workspaces apply the same file): a decrypted message is
// offered to `beforeReceipt`, cleaned, before its receipt leaves; a refusal sends no receipt and no nack and ends the
// socket with 428 so WhatsApp delivers the message again. History is stored before either notification receipt and then
// omitted from the SDK event buffer. If the patch is missing, the hooks are never called and these probes fail.
import { describe, expect, it } from '@effect/vitest';

type Frame = Uint8Array;
type Message = { key: { id?: string; remoteJid?: string }; message?: { conversation?: string } };
type History = { messages: Message[]; chats: { id: string }[] };
type Sock = {
	ws: { socket: unknown; emit(event: string, node: unknown): boolean };
	ev: {
		on(
			event: 'connection.update',
			listener: (u: {
				connection?: string;
				lastDisconnect?: { error?: { output?: { statusCode?: number } } };
			}) => void
		): void;
		on(event: 'messaging-history.set', listener: (u: History) => void): void;
	};
	end(error: Error | undefined): Promise<void>;
};
type Baileys = {
	default(config: object): Sock;
	initAuthCreds(): { me?: { id: string; lid?: string } };
	proto: {
		Message: { encode(m: object): { finish(): Uint8Array } };
		HistorySync: { encode(m: object): { finish(): Uint8Array } };
	};
};
const quiet = {
	level: 'silent',
	child: () => quiet,
	trace() {},
	debug() {},
	info() {},
	warn() {},
	error() {}
};

/** A real socket whose wire is a fake: every frame it would send is kept, and nothing reaches WhatsApp. */
const probe = Effect.fn('Baileys.patchFixture')(function* (
	beforeReceipt: (message: Message, type: string) => Promise<void>,
	beforeHistory?: (messages: readonly Message[]) => Promise<void>
) {
	const b = yield* Schema.decodeUnknownEffect(
		Schema.declare<Baileys>(
			(value): value is Baileys =>
				typeof value === 'object' &&
				value !== null &&
				'default' in value &&
				typeof value.default === 'function' &&
				'initAuthCreds' in value &&
				typeof value.initAuthCreds === 'function' &&
				'proto' in value &&
				typeof value.proto === 'object' &&
				value.proto !== null &&
				'Message' in value.proto &&
				(typeof value.proto.Message === 'object' || typeof value.proto.Message === 'function') &&
				value.proto.Message !== null &&
				'encode' in value.proto.Message &&
				typeof value.proto.Message.encode === 'function' &&
				'HistorySync' in value.proto &&
				(typeof value.proto.HistorySync === 'object' ||
					typeof value.proto.HistorySync === 'function') &&
				value.proto.HistorySync !== null &&
				'encode' in value.proto.HistorySync &&
				typeof value.proto.HistorySync.encode === 'function'
		)
	)(yield* Effect.tryPromise(() => import('@whiskeysockets/baileys')));
	const creds = b.initAuthCreds();
	creds.me = { id: '6580000000:1@s.whatsapp.net', lid: '9990000000:1@lid' };
	const sock = b.default({
		auth: { creds, keys: { get: async () => ({}), set: async () => {} } },
		logger: quiet,
		version: [2, 3000, 1],
		waWebSocketUrl: 'ws://127.0.0.1:1',
		beforeReceipt,
		beforeHistory
	});
	type NativeSocket = {
		removeAllListeners(): void;
		on(e: string, f: () => void): void;
		terminate(): void;
	};
	const real = yield* Schema.decodeUnknownEffect(
		Schema.declare<NativeSocket>(
			(value): value is NativeSocket =>
				typeof value === 'object' &&
				value !== null &&
				'removeAllListeners' in value &&
				typeof value.removeAllListeners === 'function' &&
				'on' in value &&
				typeof value.on === 'function' &&
				'terminate' in value &&
				typeof value.terminate === 'function'
		)
	)(sock.ws.socket);
	real.removeAllListeners();
	real.on('error', () => {});
	real.terminate();
	const frames: Frame[] = [];
	let closed: (() => void) | undefined;
	sock.ws.socket = {
		readyState: 1,
		send: (data: Frame, cb?: () => void) => {
			frames.push(data);
			cb?.();
		},
		once: (e: string, f: () => void) => {
			if (e === 'close') closed = f;
		},
		close: () => closed?.()
	};
	const ends: (number | undefined)[] = [];
	const histories: History[] = [];
	sock.ev.on('messaging-history.set', (history) => histories.push(history));
	sock.ev.on('connection.update', (u) => {
		if (u.connection === 'close') ends.push(u.lastDisconnect?.error?.output?.statusCode);
	});
	// a LID sender: Baileys decrypts for it without asking the server for a mapping first
	const message = (id: string) => ({
		tag: 'message',
		attrs: { id, from: '113377445566@lid', t: '1790000000', type: 'text', notify: 'Ben' },
		content: [
			{
				tag: 'plaintext',
				attrs: {},
				content: b.proto.Message.encode({ conversation: 'hello' }).finish()
			}
		]
	});
	yield* Effect.addFinalizer(() =>
		Effect.tryPromise(() => sock.end(undefined)).pipe(Effect.ignore)
	);
	return {
		sock,
		frames,
		ends,
		histories,
		deliver: (id: string) => sock.ws.emit('CB:message', message(id)),
		deliverHistory: (id: string, ids: readonly string[]) => {
			const conversations = ['113377445566@lid', '113377445577@lid'].map((jid, chat) => ({
				id: jid,
				messages: ids
					.filter((_, index) => index % 2 === chat)
					.map((id) => ({
						message: {
							key: { remoteJid: jid, fromMe: false, id },
							messageTimestamp: 1790000000,
							message: { conversation: `text ${id}` }
						}
					}))
			}));
			const history = b.proto.HistorySync.encode({ syncType: 0, conversations }).finish();
			// INITIAL_BOOTSTRAP (0), carried by a self-only HISTORY_SYNC_NOTIFICATION (5).
			const payload = b.proto.Message.encode({
				protocolMessage: {
					type: 5,
					historySyncNotification: {
						syncType: 0,
						initialHistBootstrapInlinePayload: deflateSync(history)
					}
				}
			}).finish();
			return sock.ws.emit('CB:message', {
				tag: 'message',
				attrs: { id, from: '9990000000:2@lid', t: '1790000000', type: 'text' },
				content: [{ tag: 'plaintext', attrs: {}, content: payload }]
			});
		}
	};
});

const historyIds = Array.from({ length: 203 }, (_, index) => `HISTORY${index}`);

describe('the Baileys patch', () => {
	it.live('offers each message to beforeReceipt before its receipt is sent', () =>
		Effect.gen(function* () {
			const offered: {
				id: string | undefined;
				text: string | undefined;
				type: string;
				framesBefore: number;
			}[] = [];
			const p = yield* probe(async (m, type) => {
				offered.push({
					id: m.key.id,
					text: m.message?.conversation,
					type,
					framesBefore: p.frames.length
				});
			});
			p.deliver('PROBE1');
			yield* until(() => p.frames.length > 0);
			expect(offered).toEqual([{ id: 'PROBE1', text: 'hello', type: 'notify', framesBefore: 0 }]);
			expect(p.frames).toHaveLength(1);
			yield* Effect.tryPromise(() => p.sock.end(undefined));
		})
	);
	it.live('a refusal sends nothing back and ends the socket with 428', () =>
		Effect.gen(function* () {
			let offered = 0;
			const p = yield* probe(async () => {
				offered++;
				throw new Error('not stored');
			});
			p.deliver('PROBE2');
			yield* until(() => p.ends.length > 0);
			expect(offered).toBe(1);
			expect(p.ends).toEqual([428]);
			expect(p.frames).toEqual([]);
		})
	);
	it.live(
		'stores every decoded history message before either receipt and avoids buffering it again',
		() =>
			Effect.gen(function* () {
				let release = () => {};
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				const offered: (readonly Message[])[] = [];
				let notifications = 0;
				const p = yield* probe(
					async () => {
						notifications++;
					},
					async (messages) => {
						offered.push(messages);
						await gate;
					}
				);
				yield* Effect.addFinalizer(() => Effect.sync(release));
				p.deliverHistory('HIST1', historyIds);
				yield* until(() => offered.length > 0);
				expect(offered).toHaveLength(1);
				expect(offered[0]?.map((m) => m.key.id).sort()).toEqual([...historyIds].sort());
				expect(offered[0]?.map((m) => m.message?.conversation).sort()).toEqual(
					historyIds.map((id) => `text ${id}`).sort()
				);
				expect(notifications).toBe(1);
				expect(p.frames).toEqual([]);
				expect(p.histories).toEqual([]);
				p.deliverHistory('HIST1-NEXT', ['NEXT']);
				yield* Effect.sleep('10 millis');
				expect(offered).toHaveLength(1);
				expect(notifications).toBe(1);
				release();
				yield* until(() => p.frames.length === 4 && p.histories.length === 2);
				expect(offered).toHaveLength(2);
				expect(offered[1]?.map((m) => m.key.id)).toEqual(['NEXT']);
				expect(notifications).toBe(2);
				expect(p.histories[0]?.messages).toEqual([]);
				expect(p.histories[1]?.messages).toEqual([]);
				expect(p.histories[0]?.chats).toHaveLength(2);
				expect(p.ends).toEqual([]);
			})
	);
	it.live('a history refusal sends no notification receipts or nack and ends with 428', () =>
		Effect.gen(function* () {
			const offered: (readonly Message[])[] = [];
			const p = yield* probe(
				async () => {},
				async (messages) => {
					offered.push(messages);
					throw new Error('history not stored');
				}
			);
			p.deliverHistory('HIST2', historyIds);
			yield* until(() => p.ends.length > 0);
			expect(offered).toHaveLength(1);
			expect(offered[0]).toHaveLength(historyIds.length);
			expect(p.ends).toEqual([428]);
			expect(p.frames).toEqual([]);
			expect(p.histories).toEqual([]);
		})
	);
	it.live('preserves the history event when no durable hook is configured', () =>
		Effect.gen(function* () {
			const p = yield* probe(async () => {});
			p.deliverHistory('HIST3', historyIds);
			yield* until(() => p.frames.length === 2 && p.histories.length > 0);
			expect(p.histories).toHaveLength(1);
			expect(p.histories[0]?.messages.map((m) => m.key.id).sort()).toEqual([...historyIds].sort());
			expect(p.ends).toEqual([]);
		})
	);
	it.live(
		'a chat cleared on another device is a messages.delete bounded by its last cleared message',
		() =>
			Effect.gen(function* () {
				type Sync = {
					processSyncAction(
						action: object,
						ev: { emit(event: string, data: unknown): void },
						me: object
					): void;
				};
				const b = yield* Schema.decodeUnknownEffect(
					Schema.declare<Sync>(
						(value): value is Sync =>
							typeof value === 'object' &&
							value !== null &&
							'processSyncAction' in value &&
							typeof value.processSyncAction === 'function'
					)
				)(yield* Effect.tryPromise(() => import('@whiskeysockets/baileys')));
				const emitted: [string, unknown][] = [];
				const ev = { emit: (event: string, data: unknown) => void emitted.push([event, data]) };
				const clear = (value: object) =>
					b.processSyncAction(
						{ syncAction: { value }, index: ['clearChat', '659@s.whatsapp.net', '1', '0'] },
						ev,
						{ id: '6580000000:1@s.whatsapp.net' }
					);
				clear({
					timestamp: 1_790_000_100_000,
					clearChatAction: { messageRange: { lastMessageTimestamp: 1_790_000_000 } }
				});
				clear({ timestamp: 1_790_000_100_000, clearChatAction: {} });
				expect(emitted).toEqual([
					['messages.delete', { jid: '659@s.whatsapp.net', all: true, before: 1_790_000_000_000 }],
					['messages.delete', { jid: '659@s.whatsapp.net', all: true, before: 1_790_000_100_000 }]
				]);
			})
	);
});
