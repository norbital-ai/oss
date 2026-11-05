// `@norbital-ai/providers/simulator`: the real WhatsApp and Telegram providers aimed at the channel simulator
// (`server.ts`). A connection picks one like any other provider, so a host offers them beside the real ones and
// everything but the far end of the wire is the production path. `simulated-chat` is a platform on the chat contract
// whose history can be read, for what a real one does unasked: lose a delivery, or delete a message with no event.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Schema } from 'effect';
import type { ProviderDef } from '../abi.ts';
import { baileys, type WaOpen, type WaSocket } from '../baileys/index.ts';
import { chatProvider, type ChatPlatform, type Incoming } from '../chat/adapter.ts';
import { hmac, signed } from '../chat/verify.ts';
import { telegram } from '../telegram/index.ts';
import type { SimulatedChatMessage } from './server.ts';

const Paired = Schema.Struct({ me: Schema.Struct({ id: Schema.String }) });
const accountOf = (creds: unknown) => {
	const paired = Schema.decodeUnknownOption(Paired)(creds);
	return paired._tag === 'Some' ? paired.value.me.id.split(':')[0] : undefined;
};
const closed = (statusCode: number, message: string) =>
	Object.assign(new Error(message), { output: { statusCode } });

/** A socket over the simulator: pairing, the connection's events and the patched receipt path, as Baileys runs them. */
export const simulatedSocket =
	(url: string): WaOpen =>
	async (config) => {
		const ev = new EventEmitter<Record<string, [unknown]>>(),
			abort = new AbortController(),
			known = accountOf(config.store.creds),
			account = known ?? `6580${String(Date.now()).slice(-6)}`;
		const end = (error: Error | undefined) => {
			if (abort.signal.aborted) return;
			abort.abort();
			ev.emit('connection.update', { connection: 'close', lastDisconnect: { error } });
		};
		const socket: WaSocket = {
			ev: { on: (event, listener) => void ev.on(event, listener) },
			user: { id: `${account}:1@s.whatsapp.net` },
			sendMessage: async (jid, content) => {
				const response = await fetch(`${url}/whatsapp/send`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ account, jid, content })
				});
				if (!response.ok) throw new Error(`the simulator refused a send: ${response.status}`);
				return Schema.decodeUnknownSync(
					Schema.Struct({
						key: Schema.Struct({ id: Schema.String }),
						message: Schema.Unknown
					})
				)(await response.json());
			},
			requestPairingCode: async () => 'SIMULATED',
			logout: async () => {},
			end
		};
		/** A first connection: the QR, its scan, and the restart WhatsApp asks of a newly paired device (515). */
		const pair = async () => {
			ev.emit('connection.update', { qr: 'simulated' });
			await new Promise((scanned) => setTimeout(scanned, 300));
			await config.store.update({
				me: { id: `${account}:1@s.whatsapp.net` },
				account: { details: 'simulated' },
				accountSyncCounter: 1
			});
			end(closed(515, 'restart required'));
		};
		const stream = async () => {
			const response = await fetch(`${url}/whatsapp/stream?account=${account}`, {
				signal: abort.signal
			});
			if (!response.ok || response.body === null)
				return end(closed(408, 'the simulator is unavailable'));
			ev.emit('connection.update', { connection: 'open' });
			ev.emit('connection.update', { receivedPendingNotifications: true });
			let held = '';
			for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
				held += chunk;
				const frames = held.split('\n\n');
				held = frames.pop() ?? '';
				for (const frame of frames)
					if (frame.startsWith('data: '))
						await config
							.beforeReceipt(JSON.parse(frame.slice('data: '.length)), 'notify')
							.catch(() => end(closed(428, 'the message was refused')));
			}
			end(closed(408, 'the simulator closed the stream'));
		};
		// the link installs its listeners once this returns
		setTimeout(() => {
			(known === undefined ? pair() : stream()).catch((error: unknown) => {
				if (!abort.signal.aborted) end(closed(408, String(error)));
			});
		}, 0);
		return { socket, media: async () => null };
	};

const SIMULATED = { en: 'Simulated (no real account)', zh: '模拟（无需真实账号）' };

const incoming = (message: SimulatedChatMessage): Incoming => ({
	id: message.id,
	thread: message.thread,
	sentAt: message.sentAt,
	from: { handle: message.from, name: message.name },
	text: message.text
});
const simulatedChat = (url: string): ChatPlatform => ({
	id: 'simulated-chat',
	name: { en: 'Simulated chat', zh: '模拟聊天' },
	description: {
		en: 'A channel that can lose a delivery and delete with no event',
		zh: '可模拟投递丢失和无事件删除的渠道'
	},
	via: SIMULATED,
	consistency: 'history',
	guide: url,
	fields: [],
	async connect(_settings, host) {
		const secret = randomUUID();
		const call = async <A>(path: string, body: object) => {
			const response = await fetch(`${url}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!response.ok) throw new Error(`the simulator refused ${path}: ${response.status}`);
			return (await response.json()) as A;
		};
		const { account } = await call<{ account: string }>('/chat/connect', {
			url: host.webhookUrl,
			secret
		});
		return {
			account,
			async deliver(request, body) {
				signed(request.headers.get('x-simulator-signature'), hmac(secret, body, 'hex'));
				return { messages: [incoming(JSON.parse(body) as SimulatedChatMessage)] };
			},
			send: (thread, text) => call<{ id: string }>('/chat/send', { account, thread, text }),
			async history(thread, since) {
				const found = new URLSearchParams({ account, thread, since });
				const response = await fetch(`${url}/chat/history?${found}`);
				const { messages } = (await response.json()) as {
					readonly messages: readonly SimulatedChatMessage[];
				};
				return { messages: messages.map(incoming), complete: true };
			}
		};
	}
});

/** The real providers against `url`. They reach it with the plain fetch: a host's fetch refuses loopback. */
export const simulatedProviders = (url: string): readonly ProviderDef[] => {
	const whatsapp = baileys({ open: simulatedSocket(url) }),
		bot = telegram({ api: url });
	return [
		{
			...whatsapp,
			id: 'simulated-whatsapp',
			name: 'Simulated WhatsApp',
			label: SIMULATED,
			setup: {
				kind: 'qr',
				steps: [
					{
						text: {
							en: 'No phone needed: this connects to the channel simulator.',
							zh: '无需手机：此连接使用渠道模拟器。'
						}
					}
				]
			}
		},
		{
			...bot,
			id: 'simulated-telegram',
			name: 'Simulated Telegram',
			label: SIMULATED,
			open: (ctx) => bot.open({ ...ctx, fetch })
		},
		chatProvider(simulatedChat(url))
	];
};
export { startSimulator, type SimulatedMessage } from './server.ts';
