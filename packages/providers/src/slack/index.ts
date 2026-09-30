// Slack: a Slack app on the Events API. Pairing takes the bot token and the signing secret: `auth.test` names the
// workspace and the bot. Inbound events arrive on this channel's webhook, verified with `X-Slack-Signature` (HMAC-SHA256
// over `v0:<timestamp>:<body>` under the signing secret, the timestamp within five minutes); sends are `chat.postMessage`,
// then the attachments through the files upload v2 flow (getUploadURLExternal, the bytes, completeUploadExternal) in the same place.
// A chat is a Slack channel (`C…`, a DM `D…`); a thread in it is `<channel>:<thread_ts>`.
import { createHmac } from 'node:crypto';
import { connection, type ChannelProvider } from '@norbital-ai/bolt/engine';
import { field, isObj, refusal, same, str, type Obj } from '../util.ts';

const API = 'https://slack.com/api';
const TRANSIENT = new Set(['ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout']);
const SKEW_S = 300;

export function slack(o: { api?: string; now?: () => number } = {}): ChannelProvider {
	const api = o.api ?? API, now = o.now ?? Date.now;
	return {
		transport: 'slack', id: 'slack', label: { en: 'Slack app', zh: 'Slack 应用' },
		setup: { kind: 'form', webhook: true, steps: [
			{ text: { en: 'Create a Slack app for your workspace ("From scratch").', zh: '为您的 Slack 工作区创建一个应用（“From scratch”）。' }, href: 'https://api.slack.com/apps' },
			{ text: { en: 'OAuth & Permissions → Bot Token Scopes: add chat:write, files:write, channels:history, groups:history, im:history, mpim:history, users:read. Install the app to the workspace.',
				zh: 'OAuth & Permissions → Bot Token Scopes：添加 chat:write、files:write、channels:history、groups:history、im:history、mpim:history、users:read，然后将应用安装到工作区。' } },
			{ text: { en: 'Event Subscriptions: turn them on and paste this Request URL; subscribe to the bot events message.channels, message.groups, message.im and message.mpim.',
				zh: 'Event Subscriptions：开启后粘贴此 Request URL；订阅机器人事件 message.channels、message.groups、message.im 和 message.mpim。' }, copy: 'webhookUrl' },
			{ text: { en: 'Paste the Bot User OAuth Token (xoxb-…) and, from Basic Information, the Signing Secret below. Invite the bot to a channel with /invite.',
				zh: '在下方粘贴 Bot User OAuth Token（xoxb-…）以及 Basic Information 中的 Signing Secret。用 /invite 将机器人邀请到频道。' } },
		], fields: [
			{ name: 'botToken', label: { en: 'Bot User OAuth Token', zh: 'Bot User OAuth 令牌' }, secret: true, hint: 'xoxb-…' },
			{ name: 'signingSecret', label: { en: 'Signing Secret', zh: '签名密钥' }, secret: true },
		] },
		test: { to: { name: 'to', label: { en: 'Channel id', zh: '频道 ID' }, hint: { en: 'C… — a channel the bot is in', zh: 'C…——机器人所在的频道' } } },
		async open(ctx) {
			type Cred = { botToken: string; signingSecret: string; botUser: string; team: string; teamId: string; botName: string };
			let cred: Cred | null = isObj(ctx.credential) && typeof ctx.credential['botToken'] === 'string' ? ctx.credential as unknown as Cred : null;
			// the upload methods take a form, not JSON
			const call = async (token: string, method: string, body: Obj | URLSearchParams, signal?: AbortSignal): Promise<Obj> => {
				const form = body instanceof URLSearchParams;
				const res = await ctx.fetch(`${api}/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`,
					'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8' },
					body: form ? body : JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
				const j = await res.json().catch(() => ({})) as Obj;
				// Slack answers 200 with `ok: false`; its own transient errors are retried like a 5xx
				if (j['ok'] !== true) throw refusal(`Slack ${method}: ${String(j['error'] ?? res.status)}`,
					!res.ok ? res.status : TRANSIENT.has(String(j['error'])) ? 503 : 400, typeof j['error'] === 'string' ? j['error'] : undefined);
				return j;
			};
			return {
				connection: () => cred === null ? connection(ctx.channel, 'slack', 'unpaired')
					: connection(ctx.channel, 'slack', 'connected', { stored: true, pairedAs: cred.botName, about: { workspace: cred.team, team: cred.teamId, botName: cred.botName } }),
				async pair(input) {
					const botToken = field(input, 'botToken', 'The bot token', /^xoxb-/), signingSecret = field(input, 'signingSecret', 'The signing secret', /^[0-9a-f]{16,}$/i);
					const me = await call(botToken, 'auth.test', {});
					cred = { botToken, signingSecret, botUser: String(me['user_id'] ?? ''), team: String(me['team'] ?? ''), teamId: String(me['team_id'] ?? ''), botName: String(me['user'] ?? '') };
					await ctx.save(cred);
					ctx.changed();
				},
				async unpair() { cred = null; await ctx.save(null); },
				async close() {},
				async send(_channel, message, signal, files = []) {
					if (cred === null) throw new Error('the Slack app is not connected');
					const m = message as { to: string; text: string };
					const [channel, thread] = String(m.to).split(':');
					const sent = await call(cred.botToken, 'chat.postMessage', { channel: channel!, text: m.text, ...(thread === undefined ? {} : { thread_ts: thread }) }, signal);
					const uploaded: { id: string; title: string }[] = [];
					for (const f of files) {
						const got = await call(cred.botToken, 'files.getUploadURLExternal', new URLSearchParams({ filename: f.name, length: String(f.bytes.byteLength) }), signal);
						const put = await ctx.fetch(String(got['upload_url']), { method: 'POST', headers: { 'content-type': f.mime }, body: f.bytes.slice(), signal });
						if (!put.ok) throw refusal(`Slack file upload: ${put.status}`, put.status);
						uploaded.push({ id: String(got['file_id']), title: f.name });
					}
					if (uploaded.length > 0) await call(cred.botToken, 'files.completeUploadExternal', new URLSearchParams({ files: JSON.stringify(uploaded), channel_id: channel!,
						...(thread === undefined ? {} : { thread_ts: thread }) }), signal);
					return { providerId: `${String(sent['channel'] ?? channel)}:${String(sent['ts'])}` };
				},
				async webhook(request) {
					const body = await request.text();
					if (cred === null || !slackVerified(request.headers, body, cred.signingSecret, now())) return new Response(null, { status: 401 });
					let payload: unknown;
					try { payload = JSON.parse(body); } catch { return new Response(null, { status: 400 }); }
					if (isObj(payload) && payload['type'] === 'url_verification') return Response.json({ challenge: payload['challenge'] });
					const message = slackEvent(payload, cred.botUser);
					if (message !== null) await ctx.emit({ kind: 'inbound', channel: ctx.channel, message });
					return new Response(null, { status: 200 });
				},
			};
		},
	};
}

/** `X-Slack-Signature` over `v0:<timestamp>:<raw body>`; a timestamp more than five minutes off is a replay. */
export function slackVerified(headers: Headers, body: string, secret: string, nowMs: number): boolean {
	const ts = headers.get('x-slack-request-timestamp') ?? '', sig = headers.get('x-slack-signature') ?? '';
	if (!/^\d+$/.test(ts) || Math.abs(nowMs / 1000 - Number(ts)) > SKEW_S) return false;
	return same(sig, `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`);
}

/** One Events API callback → the wire message, or `null` (a bot's own message, an edit notice, anything not a message). */
export function slackEvent(payload: unknown, botUser: string): Obj | null {
	if (!isObj(payload) || payload['type'] !== 'event_callback' || !isObj(payload['event'])) return null;
	const e = payload['event'];
	if (e['type'] !== 'message' || e['subtype'] !== undefined && e['subtype'] !== 'file_share' || e['bot_id'] !== undefined || e['user'] === botUser) return null;
	const channel = str(e['channel']), ts = str(e['ts']), user = str(e['user']);
	if (channel === null || ts === null || user === null) return null;
	const text = typeof e['text'] === 'string' ? e['text'] : '', thread = str(e['thread_ts']);
	const group = e['channel_type'] !== 'im';
	const invocation = !group ? 'direct' : botUser !== '' && text.includes(`<@${botUser}>`) ? 'mention' : e['parent_user_id'] === botUser ? 'reply' : 'ambient';
	return { id: `${channel}:${ts}`, thread: thread === null || thread === ts ? channel : `${channel}:${thread}`, sentAt: new Date(Number(ts) * 1000).toISOString(),
		from: { handle: user, name: null }, text, group, invocation, replyTo: thread === null || thread === ts ? null : `${channel}:${thread}`, attachments: [] };
}
