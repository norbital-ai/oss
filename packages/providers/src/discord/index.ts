// Discord: a bot on the Gateway. Pairing takes the bot token: `GET /users/@me` names the bot, then one Gateway websocket
// per channel (heartbeat, IDENTIFY with the guild-message, direct-message and message-content intents) carries
// MESSAGE_CREATE inbound. Sends are REST `POST /channels/{id}/messages` (multipart with the attachments). A chat is a Discord
// channel id; a DM's too.
import { connection, type ChannelProvider, type Json } from '@norbital-ai/bolt/engine';
import { blobOf, field, isObj, refusal, str, type Obj } from '../util.ts';

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
/** GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES, MESSAGE_CONTENT (a privileged intent the operator enables in the portal). */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
/** send 2048 + read history 65536 + view channel 1024 + attach files 32768 */
const PERMISSIONS = 101_376;

/** The part of a websocket this link uses: the platform `WebSocket`, or a test's fake. */
export type GatewaySocket = {
	send(data: string): void;
	close(code?: number): void;
	addEventListener(type: 'message' | 'close', listener: (e: { data?: unknown; code?: number }) => void): void;
};
export type DiscordOptions = { api?: string; socket?: (url: string) => GatewaySocket; backoffMs?: (attempt: number) => number };

export function discord(o: DiscordOptions = {}): ChannelProvider {
	const api = o.api ?? API, socketOf = o.socket ?? ((url: string) => new WebSocket(url) as unknown as GatewaySocket);
	const backoffMs = o.backoffMs ?? ((n: number) => Math.min(60_000, 1_000 * 2 ** n));
	return {
		transport: 'discord', id: 'bot', label: { en: 'Discord bot', zh: 'Discord 机器人' },
		setup: { kind: 'form', steps: [
			{ text: { en: 'Create an application in the Discord Developer Portal, then open Bot and reset the token to copy it.',
				zh: '在 Discord 开发者门户创建应用，然后打开 Bot 页面并重置令牌以复制它。' }, href: 'https://discord.com/developers/applications' },
			{ text: { en: 'On the same Bot page, turn on the Message Content Intent.', zh: '在同一 Bot 页面开启 Message Content Intent。' } },
			{ text: { en: 'Paste the token below, then add the bot to your server with the invite link shown once it connects.',
				zh: '在下方粘贴令牌，连接后使用显示的邀请链接将机器人加入您的服务器。' } },
		], fields: [{ name: 'botToken', label: { en: 'Bot token', zh: '机器人令牌' }, secret: true }] },
		test: { to: { name: 'to', label: { en: 'Channel id', zh: '频道 ID' }, hint: { en: 'Copy it with Developer Mode on', zh: '开启开发者模式后复制' } } },
		async open(ctx) {
			type Cred = { botToken: string; botId: string; botName: string };
			let cred: Cred | null = isObj(ctx.credential) && typeof ctx.credential['botToken'] === 'string' ? ctx.credential as unknown as Cred : null;
			let state: 'connecting' | 'connected' | 'reconnecting' | 'error' = 'connecting', detail = '';
			let ws: GatewaySocket | undefined, beat: ReturnType<typeof setInterval> | undefined, retry: ReturnType<typeof setTimeout> | undefined;
			let seq: number | null = null, attempt = 0, closed = false;
			const guilds = new Set<string>();
			const set = (s: typeof state, d = '') => { state = s; detail = d; ctx.changed(); };
			const rest = async (method: string, path: string, body?: Json | FormData, signal?: AbortSignal, token = cred?.botToken): Promise<Obj> => {
				const json = body !== undefined && !(body instanceof FormData);
				const res = await ctx.fetch(`${api}${path}`, { method, headers: { authorization: `Bot ${token ?? ''}`, ...(json ? { 'content-type': 'application/json' } : {}) },
					...(body === undefined ? {} : { body: json ? JSON.stringify(body) : body }), ...(signal === undefined ? {} : { signal }) });
				const j = res.status === 204 ? {} : await res.json().catch(() => ({})) as Obj;
				if (!res.ok) throw refusal(`Discord ${method} ${path.replace(/\d{5,}/g, '…')}: ${res.status} ${String(j['message'] ?? '')}`.trim(), res.status,
					j['code'] === undefined ? undefined : String(j['code']));
				return j;
			};
			const stop = () => { clearInterval(beat); clearTimeout(retry); const s = ws; ws = undefined; s?.close(1000); };

			function gateway(): void {
				if (cred === null) return;
				const token = cred.botToken, s = socketOf(GATEWAY);
				ws = s;
				s.addEventListener('message', (e) => {
					if (ws !== s) return;
					let p: unknown;
					try { p = JSON.parse(String(e.data)); } catch { return; }
					if (!isObj(p)) return;
					if (typeof p['s'] === 'number') seq = p['s'];
					const d = isObj(p['d']) ? p['d'] : {};
					if (p['op'] === 10) {
						clearInterval(beat);
						beat = setInterval(() => s.send(JSON.stringify({ op: 1, d: seq })), Number(d['heartbeat_interval'] ?? 41_250));
						s.send(JSON.stringify({ op: 2, d: { token, intents: INTENTS, properties: { os: 'linux', browser: 'norbital', device: 'norbital' } } }));
					} else if (p['op'] === 1) s.send(JSON.stringify({ op: 1, d: seq }));
					else if (p['op'] === 7 || p['op'] === 9) s.close(4000); // reconnect / invalid session: start over
					else if (p['t'] === 'READY') {
						attempt = 0;
						for (const g of Array.isArray(d['guilds']) ? d['guilds'] : []) if (isObj(g) && typeof g['id'] === 'string') guilds.add(g['id']);
						set('connected');
					} else if (p['t'] === 'GUILD_CREATE' && typeof d['id'] === 'string') { guilds.add(d['id']); ctx.changed(); }
					else if (p['t'] === 'GUILD_DELETE' && typeof d['id'] === 'string') { guilds.delete(d['id']); ctx.changed(); }
					else if (p['t'] === 'MESSAGE_CREATE') {
						const message = discordMessage(d, cred?.botId ?? '');
						if (message !== null) void ctx.emit({ kind: 'inbound', channel: ctx.channel, message }).catch((x: unknown) => console.error('[providers] discord message not stored', x));
					}
				});
				s.addEventListener('close', (e) => {
					if (ws !== s) return;
					clearInterval(beat);
					ws = undefined;
					if (closed) return;
					// 4004: the token was refused; 4014: a privileged intent is not enabled — neither heals by retrying
					if (e.code === 4004) return set('error', 'Discord refused the bot token; pair again with a new one');
					if (e.code === 4014) return set('error', 'Turn on the Message Content Intent on the bot page of the Developer Portal, then reconnect');
					set('reconnecting', `gateway closed (${e.code ?? 'no code'})`);
					retry = setTimeout(gateway, backoffMs(attempt++));
				});
			}
			if (cred !== null) gateway();

			return {
				connection: () => {
					if (cred === null) return connection(ctx.channel, 'discord', 'unpaired');
					const about = { botName: cred.botName, guilds: guilds.size, inviteUrl: `https://discord.com/oauth2/authorize?client_id=${cred.botId}&scope=bot&permissions=${PERMISSIONS}` };
					return state === 'error' ? connection(ctx.channel, 'discord', 'error', { error: detail, stored: true, about })
						: connection(ctx.channel, 'discord', state, { stored: true, pairedAs: cred.botName, about, ...(detail === '' ? {} : { detail }) });
				},
				async pair(input) {
					const botToken = field(input, 'botToken', 'The bot token');
					const me = await rest('GET', '/users/@me', undefined, undefined, botToken);
					stop();
					cred = { botToken, botId: String(me['id']), botName: String(me['username'] ?? '') };
					await ctx.save(cred);
					closed = false;
					attempt = 0;
					guilds.clear();
					set('connecting');
					gateway();
				},
				async unpair() { closed = true; stop(); cred = null; await ctx.save(null); },
				async close() { closed = true; stop(); },
				async send(_channel, message, signal, files = []) {
					if (cred === null) throw new Error('the Discord bot is not connected');
					const m = message as { to: string; text: string };
					let body: Json | FormData = { content: m.text };
					if (files.length > 0) {
						body = new FormData();
						body.set('payload_json', JSON.stringify({ content: m.text, attachments: files.map((f, id) => ({ id, filename: f.name })) }));
						files.forEach((f, i) => (body as FormData).set(`files[${i}]`, blobOf(f), f.name));
					}
					const sent = await rest('POST', `/channels/${encodeURIComponent(m.to)}/messages`, body, signal);
					return { providerId: String(sent['id']) };
				},
				async typing(_channel, to, signal) { if (cred !== null) await rest('POST', `/channels/${encodeURIComponent(to)}/typing`, undefined, signal); },
			};
		},
	};
}

/** One MESSAGE_CREATE → the wire message, or `null` for a bot's (ours included) or an empty one. */
export function discordMessage(d: Obj, botId: string): Obj | null {
	const author = isObj(d['author']) ? d['author'] : null, id = str(d['id']), thread = str(d['channel_id']);
	if (author === null || author['bot'] === true || id === null || thread === null) return null;
	const group = d['guild_id'] !== undefined && d['guild_id'] !== null;
	const mentions = (Array.isArray(d['mentions']) ? d['mentions'] : []).flatMap((m) => isObj(m) && typeof m['id'] === 'string' ? [m['id']] : []);
	const ref = isObj(d['referenced_message']) && isObj(d['referenced_message']['author']) ? d['referenced_message']['author']['id'] : null;
	const attachments = (Array.isArray(d['attachments']) ? d['attachments'] : []).flatMap((a) => isObj(a) && typeof a['filename'] === 'string'
		? [{ fileName: a['filename'], mimeType: str(a['content_type']) ?? 'application/octet-stream', byteLength: Number(a['size'] ?? 0) }] : []);
	return { id, thread, sentAt: str(d['timestamp']) ?? new Date().toISOString(), text: typeof d['content'] === 'string' ? d['content'] : '', group, mentions,
		from: { handle: String(author['id']), name: str(author['global_name']) ?? str(author['username']) },
		replyTo: isObj(d['message_reference']) ? str(d['message_reference']['message_id']) : null,
		invocation: !group ? 'direct' : mentions.includes(botId) ? 'mention' : ref === botId ? 'reply' : 'ambient', attachments };
}
