// The channel simulator: a separate process that stands where WhatsApp and Telegram stand, so a real host runs its
// whole channel pipeline and only the far end is pretend. It speaks each provider's own shapes: a raw Baileys message
// over a stream, the Telegram Bot API and its webhook. A third channel, `chat`, keeps a readable history, so a delivery
// can be dropped and a message deleted with no event, as a real platform does. Its state is memory, and it binds
// loopback: a test tool, no service.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Schema } from 'effect';
import { parse } from '../chat/http.ts';

type SimulatedMessage = {
	readonly seq: number;
	readonly channel: 'whatsapp' | 'telegram' | 'chat';
	/** The connected account: a WhatsApp number, a bot's token id or a chat connection. */
	readonly account: string;
	/** A `chat` message's id, to delete it by. */
	readonly id?: string;
	readonly direction: 'in' | 'out';
	readonly peer: string;
	readonly text: string;
	readonly at: string;
};
const Json = Schema.Record(Schema.String, Schema.Unknown);
type Json = typeof Json.Type;
type Bot = { readonly token: string; url?: string; secret?: string };
/** A message as the `chat` channel's history holds it, and as its webhook carries it. */
export const SimulatedChatMessage = Schema.Struct({
	id: Schema.String,
	thread: Schema.String,
	from: Schema.String,
	name: Schema.String,
	text: Schema.String,
	sent_at: Schema.String
});
export type SimulatedChatMessage = typeof SimulatedChatMessage.Type;
type Chat = { url: string; secret: string; readonly history: SimulatedChatMessage[] };

const BODY_BYTES = 1_048_576;
const digits = (value: unknown) => String(value).replace(/\D/g, '');
const named = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
const send = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
};
const bodyOf = async (req: IncomingMessage): Promise<Json> => {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += bytes.byteLength;
		if (size > BODY_BYTES) throw new Error('body too large');
		chunks.push(bytes);
	}
	const text = Buffer.concat(chunks).toString('utf8');
	if (!(req.headers['content-type'] ?? '').includes('json') || text === '') return {};
	return parse(Json, text);
};

/** The whole-page phone: pick a connected account, write as the customer, read what came back. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>Channel simulator</title>
<style>body{font:15px system-ui;max-width:640px;margin:32px auto;padding:0 16px;color:#222}
#log{border:1px solid #ccc;border-radius:8px;padding:12px;height:52vh;overflow:auto;background:#fafafa}
.m{margin:6px 0;padding:6px 10px;border-radius:8px;max-width:80%;width:fit-content;white-space:pre-wrap}
.in{background:#fff;border:1px solid #ddd}.out{background:#dcf8c6;margin-left:auto}
small{display:block;color:#777}form{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
input,select,button{font:inherit;padding:8px}#text{flex:1;min-width:200px}
.x{float:right;border:0;background:none;color:#a00;padding:0 0 0 8px;cursor:pointer}</style>
<h1>Channel simulator</h1><div id="log"></div>
<form id="f"><select id="to"></select><input id="from" value="6591234567" size="11" aria-label="From">
<input id="text" placeholder="Message as the customer" aria-label="Message" required><button>Send</button>
<label><input id="drop" type="checkbox"> Drop the delivery (chat)</label></form>
<script>
const log=document.getElementById('log'),to=document.getElementById('to');
const refresh=async()=>{const s=await(await fetch('/state')).json();
const kept=to.value;to.replaceChildren(...s.accounts.map(a=>new Option(a.channel+' '+a.account,a.channel+'|'+a.account)));
if(kept)to.value=kept;
log.replaceChildren(...s.messages.map(m=>{const d=document.createElement('div');d.className='m '+m.direction;
const c=document.createElement('small');c.textContent=m.channel+' · '+m.peer;
if(m.id){const x=document.createElement('button');x.className='x';x.textContent='×';x.title='Delete, with no event';
x.onclick=async()=>{await fetch('/chat/delete',{method:'POST',headers:{'content-type':'application/json'},
body:JSON.stringify({account:m.account,id:m.id})});refresh()};c.append(x)}
d.append(c,m.text);return d}));
log.scrollTop=log.scrollHeight};
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const [channel,account]=to.value.split('|');
const t=document.getElementById('text');await fetch('/inbound',{method:'POST',headers:{'content-type':'application/json'},
body:JSON.stringify({channel,account,from:document.getElementById('from').value,text:t.value,drop:document.getElementById('drop').checked})});t.value='';refresh()};
refresh();setInterval(refresh,1000);
</script>`;

/** Listens on loopback at `port` (0 picks one); `url` is what a host's `simulatedProviders` connect to. */
export async function startSimulator(port = 0) {
	const streams = new Map<string, Set<ServerResponse>>(),
		bots = new Map<string, Bot>(),
		chats = new Map<string, Chat>(),
		log: SimulatedMessage[] = [];
	let sent = 0;
	const record = (message: Omit<SimulatedMessage, 'seq' | 'at'>) =>
		log.push({ ...message, seq: log.length + 1, at: new Date().toISOString() });
	const botId = (token: string) => token.split(':')[0] ?? token;
	const whatsappIn = ({ account, from, name, text }: Json) => {
		const open = streams.get(named(account, ''));
		if (open === undefined || open.size === 0) return false;
		// what Baileys hands the link for a plain text message
		const raw = {
			key: {
				id: randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase(),
				remoteJid: `${digits(from)}@s.whatsapp.net`,
				fromMe: false
			},
			messageTimestamp: Math.floor(Date.now() / 1000),
			pushName: named(name, 'Simulated customer'),
			message: { conversation: named(text, '') }
		};
		for (const stream of open) stream.write(`data: ${JSON.stringify(raw)}\n\n`);
		return true;
	};
	const telegramIn = async ({ account, from, name, text }: Json) => {
		const bot = [...bots.values()].find((one) => botId(one.token) === named(account, ''));
		if (bot?.url === undefined) return false;
		const id = Number(digits(from)),
			date = Math.floor(Date.now() / 1000),
			chat = { id, type: 'private', first_name: named(name, 'Simulated customer') };
		// the update Telegram posts to a bot's webhook, with the secret the bot registered
		const response = await fetch(bot.url, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-telegram-bot-api-secret-token': bot.secret ?? ''
			},
			body: JSON.stringify({
				update_id: date,
				message: { message_id: log.length + 1, date, chat, from: chat, text }
			})
		});
		return response.ok;
	};
	/** A `chat` message joins the history; unless `drop` asks for a lost delivery, the signed webhook follows. */
	const chatIn = async ({ account, from, name, text, drop, at }: Json) => {
		const chat = chats.get(named(account, ''));
		if (chat === undefined) return null;
		const message: SimulatedChatMessage = {
			id: randomUUID(),
			thread: digits(from),
			from: digits(from),
			name: named(name, 'Simulated customer'),
			text: named(text, ''),
			sent_at: named(at, new Date().toISOString())
		};
		chat.history.push(message);
		if (drop !== true) {
			const body = JSON.stringify(message);
			await fetch(chat.url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-simulator-signature': createHmac('sha256', chat.secret).update(body).digest('hex')
				},
				body
			});
		}
		return message.id;
	};
	/** The Bot API methods the telegram provider calls with text; anything else answers as Telegram would refuse it. */
	const botApi = (token: string, method: string, body: Json) => {
		const bot = bots.get(token) ?? { token };
		bots.set(token, bot);
		switch (method) {
			case 'getMe':
				return { id: Number(botId(token)), is_bot: true, username: `simulated_${botId(token)}_bot` };
			case 'setWebhook':
				bot.url = named(body['url'], '');
				bot.secret = named(body['secret_token'], '');
				return true;
			case 'deleteWebhook':
				delete bot.url;
				return true;
			case 'sendChatAction':
				return true;
			case 'sendMessage':
				sent += 1;
				record({
					channel: 'telegram',
					account: botId(token),
					direction: 'out',
					peer: String(body['chat_id']),
					text: named(body['text'], '')
				});
				return { message_id: sent };
			default:
				return null;
		}
	};
	const server = createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? '/', 'http://simulator'),
				path = url.pathname;
			if (req.method === 'GET' && path === '/') {
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				return res.end(PAGE);
			}
			if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
			if (req.method === 'GET' && path === '/state')
				return send(res, 200, {
					accounts: [
						...[...streams]
							.filter(([, open]) => open.size > 0)
							.map(([account]) => ({ channel: 'whatsapp', account })),
						...[...bots.values()]
							.filter((bot) => bot.url !== undefined)
							.map((bot) => ({ channel: 'telegram', account: botId(bot.token) })),
						...[...chats.keys()].map((account) => ({ channel: 'chat', account }))
					],
					messages: log
				});
			if (req.method === 'GET' && path === '/chat/history') {
				const since = Date.parse(url.searchParams.get('since') ?? ''),
					thread = url.searchParams.get('thread');
				return send(res, 200, {
					messages: (chats.get(url.searchParams.get('account') ?? '')?.history ?? []).filter(
						(one) => one.thread === thread && Date.parse(one.sent_at) >= since
					)
				});
			}
			if (req.method === 'GET' && path === '/whatsapp/stream') {
				const account = url.searchParams.get('account') ?? '',
					open = streams.get(account) ?? new Set();
				streams.set(account, open);
				open.add(res);
				res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
				res.write(': open\n\n');
				req.on('close', () => open.delete(res));
				return;
			}
			const bot = /^\/bot([^/]+)\/(\w+)$/.exec(path);
			if (req.method === 'POST' && bot !== null) {
				const result = botApi(bot[1] ?? '', bot[2] ?? '', await bodyOf(req));
				return result === null
					? send(res, 404, { ok: false, error_code: 404, description: 'Not Found' })
					: send(res, 200, { ok: true, result });
			}
			if (req.method !== 'POST') return send(res, 404, { error: 'no such route' });
			const body = await bodyOf(req);
			if (path === '/whatsapp/send') {
				sent += 1;
				const content = body['content'],
					text =
						typeof content === 'object' && content !== null && 'text' in content
							? named(content.text, '')
							: '[attachment]';
				record({
					channel: 'whatsapp',
					account: named(body['account'], ''),
					direction: 'out',
					peer: digits(named(body['jid'], '').split('@')[0]),
					text
				});
				return send(res, 200, {
					key: { id: `SIM${sent}` },
					message: { conversation: text }
				});
			}
			if (path === '/chat/connect') {
				const url = named(body['url'], ''),
					account = createHash('sha256').update(url).digest('hex').slice(0, 8),
					known = chats.get(account);
				chats.set(account, {
					url,
					secret: named(body['secret'], ''),
					history: known?.history ?? []
				});
				return send(res, 200, { account });
			}
			if (path === '/chat/send') {
				sent += 1;
				record({
					channel: 'chat',
					account: named(body['account'], ''),
					direction: 'out',
					peer: named(body['thread'], ''),
					text: named(body['text'], '')
				});
				return send(res, 200, { id: `SIM${sent}` });
			}
			if (path === '/chat/delete') {
				const history = chats.get(named(body['account'], ''))?.history ?? [],
					at = history.findIndex((one) => one.id === body['id']);
				if (at >= 0) history.splice(at, 1);
				const entry = log.find((one) => one.id === body['id']);
				if (entry !== undefined) log.splice(log.indexOf(entry), 1);
				return send(res, 200, { deleted: at >= 0 });
			}
			if (path === '/inbound') {
				const channel =
						body['channel'] === 'telegram' || body['channel'] === 'chat'
							? body['channel']
							: 'whatsapp',
					id = channel === 'chat' ? await chatIn(body) : undefined,
					delivered =
						channel === 'chat'
							? id !== null
							: await (channel === 'telegram' ? telegramIn(body) : whatsappIn(body));
				if (!delivered)
					return send(res, 409, { error: `Nothing is connected to that ${channel} account.` });
				record({
					channel,
					account: named(body['account'], ''),
					direction: 'in',
					peer: digits(body['from']),
					text: named(body['text'], ''),
					...(typeof id === 'string' ? { id } : {})
				});
				return send(res, 200, { seq: log.length, ...(typeof id === 'string' ? { id } : {}) });
			}
			return send(res, 404, { error: 'no such route' });
		})().catch((error: unknown) => {
			if (!res.headersSent) send(res, 500, { error: String(error) });
		});
	});
	await new Promise<void>((listening) => server.listen(port, '127.0.0.1', listening));
	const address = server.address();
	const bound = address !== null && typeof address === 'object' ? address.port : port;
	return {
		url: `http://127.0.0.1:${bound}`,
		messages: () => log,
		close: () =>
			new Promise<void>((closed) => {
				server.closeAllConnections();
				server.close(() => closed());
			})
	};
}
