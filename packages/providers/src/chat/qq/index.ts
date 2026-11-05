// QQ bots through the webhook callback, the simpler of QQ's two modes: no socket to keep, Ed25519 over the raw body with
// a key derived from the app secret. Webhooks only: it offers no history, edits or deletes.
// A reply names the message it answers, for five minutes, each with a new `msg_seq`. Past that, or after a restart, a
// send goes out as a message of the bot's own, which QQ limits.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { PlatformError, Unverified, nothing, recent } from '../adapter.ts';

const API = 'https://api.sgroup.qq.com';
const TOKEN = 'https://bots.qq.com/app/getAppAccessToken';
const MEDIA = 'https://multimedia.nt.qq.com';
const REPLY_MS = 290_000;
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SEND_TO: Readonly<Record<string, string>> = {
	c2c: '/v2/users',
	group: '/v2/groups',
	channel: '/channels',
	direct: '/dms'
};
type File = {
	readonly content_type?: string;
	readonly filename?: string;
	readonly url?: string;
	readonly size?: number;
	readonly voice_wav_url?: string;
};
type Event = {
	readonly id: string;
	readonly content?: string;
	readonly timestamp: string;
	readonly author: {
		readonly id?: string;
		readonly username?: string;
		readonly bot?: boolean;
		readonly user_openid?: string;
		readonly member_openid?: string;
	};
	readonly group_openid?: string;
	readonly channel_id?: string;
	readonly guild_id?: string;
	readonly member?: { readonly nick?: string };
	readonly attachments?: readonly File[];
};
type Hook = {
	readonly op?: number;
	readonly t?: string;
	readonly d?: Event & { readonly plain_token?: string; readonly event_ts?: string };
};

const placeOf = (type: string | undefined, event: Event) =>
	type === 'C2C_MESSAGE_CREATE'
		? `c2c:${event.author.user_openid}`
		: type === 'GROUP_AT_MESSAGE_CREATE'
			? `group:${event.group_openid}`
			: type === 'AT_MESSAGE_CREATE' || type === 'MESSAGE_CREATE'
				? `channel:${event.channel_id}`
				: type === 'DIRECT_MESSAGE_CREATE'
					? `direct:${event.guild_id}`
					: null;
const absolute = (url: string) =>
	url.startsWith('http://') || url.startsWith('https://')
		? url
		: `${MEDIA}${url.startsWith('/') ? '' : '/'}${url}`;

const parse = (
	type: string | undefined,
	event: Event,
	content: (url: string) => Promise<Uint8Array>
): Incoming | null => {
	const thread = placeOf(type, event),
		{ author } = event,
		from = author.user_openid ?? author.member_openid ?? author.id;
	if (thread === null || from === undefined || author.bot === true) return null;
	return {
		id: event.id,
		thread,
		sentAt: new Date(event.timestamp).toISOString(),
		from: { handle: from, name: event.member?.nick ?? author.username ?? null },
		text: event.content ?? '',
		group: thread.startsWith('group:') || thread.startsWith('channel:'),
		mentioned: type === 'GROUP_AT_MESSAGE_CREATE' || type === 'AT_MESSAGE_CREATE',
		files: (event.attachments ?? []).flatMap((file, index) => {
			const url = file.voice_wav_url ?? file.url;
			if (url === undefined) return [];
			return [
				{
					name: file.filename ?? `qq-${event.id}-${index}`,
					mime:
						file.voice_wav_url === undefined
							? (file.content_type ?? 'application/octet-stream')
							: 'audio/wav',
					...(file.size === undefined ? {} : { bytes: file.size }),
					fetch: () => content(absolute(url))
				}
			];
		})
	};
};
const parsed = (body: string): Hook | null => {
	try {
		return JSON.parse(body) as Hook;
	} catch {
		return null;
	}
};

export const qq: ChatPlatform = {
	id: 'qq',
	name: { en: 'QQ', zh: 'QQ' },
	description: { en: 'QQ bots', zh: 'QQ 机器人' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'webhook',
	icon: 'simple-icons:qq',
	guide: 'https://q.qq.com/',
	fields: [
		{ name: 'appId', label: { en: 'App ID', zh: '应用 ID' } },
		{ name: 'clientSecret', label: { en: 'Client secret', zh: '应用密钥' }, secret: true }
	],
	async connect({ appId = '', clientSecret = '' }, host) {
		const seed = clientSecret.repeat(Math.ceil(32 / clientSecret.length)).slice(0, 32);
		const privateKey = createPrivateKey({
				key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]),
				format: 'der',
				type: 'pkcs8'
			}),
			publicKey = createPublicKey(privateKey);
		let cached: { readonly token: string; readonly until: number } | null = null;
		const token = async () => {
			if (cached !== null && Date.now() < cached.until) return cached.token;
			const response = await host.fetch(TOKEN, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ appId, clientSecret })
			});
			const answer = (await response.json().catch(() => ({}))) as {
				readonly access_token?: string;
				readonly expires_in?: string | number;
				readonly message?: string;
			};
			if (answer.access_token === undefined)
				throw new PlatformError(
					answer.message ?? 'QQ refused the app credentials',
					response.ok ? 401 : response.status
				);
			cached = {
				token: answer.access_token,
				until: Date.now() + Number(answer.expires_in) * 1000 - 300_000
			};
			return answer.access_token;
		};
		const content = async (url: string) => {
			const response = await host.fetch(url);
			if (!response.ok) throw new PlatformError('file unavailable', response.status);
			return new Uint8Array(await response.arrayBuffer());
		};
		await token();
		const answering = recent<{ readonly id: string; readonly at: number; seq: number }>();
		const connection: ChatConnection = {
			account: appId,
			async deliver(request, body) {
				const signature = request.headers.get('x-signature-ed25519'),
					timestamp = request.headers.get('x-signature-timestamp'),
					hook = parsed(body);
				if (hook?.op === 13) {
					// the setup challenge may arrive unsigned, and its answer signs what it carries: signing anything with a
					// `{` in it could hand a stranger a valid signature on a forged event
					const signing = `${hook.d?.event_ts}${hook.d?.plain_token}`;
					if (signing.includes('{')) throw new Unverified('not a challenge');
					return nothing(
						Response.json({
							plain_token: hook.d?.plain_token,
							signature: sign(null, Buffer.from(signing), privateKey).toString('hex')
						})
					);
				}
				const genuine =
					signature !== null &&
					timestamp !== null &&
					verify(null, Buffer.from(timestamp + body), publicKey, Buffer.from(signature, 'hex'));
				if (!genuine || hook === null) throw new Unverified('bad signature');
				const message = hook.op === 0 && hook.d !== undefined ? parse(hook.t, hook.d, content) : null;
				if (message !== null)
					answering.set(message.thread, { id: message.id, at: Date.now(), seq: 0 });
				return {
					messages: message === null ? [] : [message],
					response: Response.json({ op: 12, d: {} })
				};
			},
			async send(thread, text, key) {
				const at = thread.indexOf(':'),
					to = SEND_TO[thread.slice(0, at)];
				if (to === undefined) throw new PlatformError(`no QQ thread: ${thread}`, 400);
				const reply = answering.get(thread);
				const answers =
					reply === undefined || Date.now() - reply.at > REPLY_MS
						? {}
						: { msg_id: reply.id, msg_seq: ++reply.seq };
				const response = await host.fetch(
					`${API}${to}/${encodeURIComponent(thread.slice(at + 1))}/messages`,
					{
						method: 'POST',
						headers: {
							authorization: `QQBot ${await token()}`,
							'content-type': 'application/json'
						},
						body: JSON.stringify({ content: text, msg_type: 0, ...answers })
					}
				);
				const sent = (await response.json().catch(() => ({}))) as {
					readonly id?: string;
					readonly code?: number;
					readonly message?: string;
				};
				if (!response.ok || (sent.code ?? 0) !== 0)
					throw new PlatformError(
						sent.message ?? `QQ answered ${response.status}`,
						response.ok ? 400 : response.status
					);
				return { id: sent.id ?? key };
			},
			openDirect: async (user) => `c2c:${user}`
		};
		return connection;
	}
};
