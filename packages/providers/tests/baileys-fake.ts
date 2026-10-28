// The patched Baileys over a fake WhatsApp, for the link's tests: each socket it opened, as a test drives it.
import { EventEmitter } from 'node:events';
import { Effect } from 'effect';
import type { Json } from '@norbital-ai/bolt/engine';
import {
	baileys,
	type BaileysOptions,
	type WaConfig,
	type WaMedia,
	type WaOpen,
	type WaSocket
} from '../src/baileys/index.ts';

export type Sock = {
	ev: EventEmitter<Record<string, [unknown]>>;
	socket: WaSocket;
	config: WaConfig;
	sent: { jid: string; content: unknown }[];
	receipts: string[];
	/** Presence the link sent (`available`, `composing`, `paused`), the read receipts and the chats whose typing it watches. */
	presence: [string, string | undefined][];
	read: unknown[];
	subscribed: string[];
	ended: boolean;
	media: (message: unknown, download: boolean) => Promise<WaMedia | null>;
	/** The patched receipt path: the gate, then the receipt; a refusal ends the socket unreceipted (428). */
	deliver(raw: {
		key: { id: string; remoteJid?: string };
		[field: string]: unknown;
	}): Promise<void>;
	drop(code: number, message?: string): void;
	/** Logged in, and caught up on the offline backlog. */
	ready(): void;
	/** pair-success: the creds name the account. */
	paired(): Promise<void>;
};
export const ME = '6580000000:3@s.whatsapp.net';
export const CREDS: Json = {
	me: { id: ME },
	account: { details: 'signed' },
	accountSyncCounter: 1
};
export const raw = (id: string, text = id, extra: object = {}) => ({
	key: { id, remoteJid: '659@s.whatsapp.net' },
	messageTimestamp: 1_790_000_000,
	message: { conversation: text },
	...extra
});
/**
 * The patched Baileys over a fake WhatsApp: each socket it opened, as the test drives it; `refuse` makes the next open
 * throw, and `nextOpen` holds the next open until it settles.
 */
export const fake = (log: string[] = [], options: BaileysOptions = {}) => {
	const opened: Sock[] = [];
	const control: { refuse: boolean; nextOpen?: () => Promise<void> } = { refuse: false };
	const listening = new Set<Sock>();
	const observations = new Set<{
		index: number | undefined;
		resume: (effect: Effect.Effect<Sock>) => void;
	}>();
	/** The receipt listener is installed last; observations resume only after every SDK listener is ready. */
	const socket = (index?: number) =>
		Effect.callback<Sock>((resume) => {
			const current =
				index === undefined
					? opened.find((value) => listening.has(value) && !value.ended)
					: opened[index];
			if (current !== undefined && listening.has(current)) {
				resume(Effect.succeed(current));
				return;
			}
			const observation = { index, resume };
			observations.add(observation);
			return Effect.sync(() => {
				observations.delete(observation);
			});
		});
	const open: WaOpen = async (config) => {
		const nextOpen = control.nextOpen;
		delete control.nextOpen;
		await nextOpen?.();
		if (control.refuse) {
			control.refuse = false;
			throw new Error('no network');
		}
		log.push('open');
		const ev = new EventEmitter<Record<string, [unknown]>>();
		const s: Sock = {
			ev,
			config,
			sent: [],
			receipts: [],
			presence: [],
			read: [],
			subscribed: [],
			ended: false,
			media: async () => null,
			socket: {
				ev: {
					on: (e, l) => {
						ev.on(e, l);
						if (e === 'message-receipt.update') {
							listening.add(s);
							for (const observation of observations)
								if (observation.index === undefined || opened[observation.index] === s) {
									observations.delete(observation);
									observation.resume(Effect.succeed(s));
								}
						}
					}
				},
				user: { id: ME },
				sendMessage: async (jid, content) => {
					s.sent.push({ jid, content });
					return {
						key: { id: `OUT${s.sent.length}` },
						message: { conversation: `sent ${s.sent.length}` }
					};
				},
				sendPresenceUpdate: async (type, jid) => {
					s.presence.push([type, jid]);
				},
				readMessages: async (keys) => {
					s.read.push(...keys);
				},
				presenceSubscribe: async (jid) => {
					s.subscribed.push(jid);
				},
				requestPairingCode: async () => 'ABCD-1234',
				logout: async () => {},
				end: (error) => {
					if (s.ended) return;
					s.ended = true;
					ev.emit('connection.update', { connection: 'close', lastDisconnect: { error } });
				}
			},
			async deliver(m) {
				try {
					await config.beforeReceipt(m, 'notify');
					s.receipts.push(m.key.id);
				} catch {
					s.socket.end(Object.assign(new Error('refused'), { output: { statusCode: 428 } }));
				}
			},
			drop: (code, message = 'dropped') => {
				s.ended = true;
				ev.emit('connection.update', {
					connection: 'close',
					lastDisconnect: { error: { output: { statusCode: code }, message } }
				});
			},
			ready: () => {
				ev.emit('connection.update', { connection: 'open' });
				ev.emit('connection.update', { receivedPendingNotifications: true });
			},
			paired: () =>
				config.store.update({
					me: { id: ME },
					account: { details: 'signed' },
					accountSyncCounter: 1
				})
		};
		opened.push(s);
		return { socket: s.socket, media: (m, d) => s.media(m, d) };
	};
	return {
		opened,
		socket,
		control,
		provider: baileys({ open, graceMs: 100, retryMs: 300, ...options })
	};
};
