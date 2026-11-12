// QQ bots through the webhook callback, the simpler of QQ's two modes: no socket to keep, Ed25519 over the raw body with
// a key derived from the app secret. Webhooks only: it offers no history, edits or deletes.
// A reply names the message it answers, for five minutes, each with a new `msg_seq`. Past that, or after a restart, a
// send goes out as a message of the bot's own, which QQ limits.
import { tokenCache } from '../token.ts';
import { Schema } from 'effect';
import { parse as parseJson, download as downloadFile } from '../http.ts';
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
const File = Schema.Struct({
	content_type: Schema.optionalKey(Schema.String),
	filename: Schema.optionalKey(Schema.String),
	url: Schema.optionalKey(Schema.String),
	size: Schema.optionalKey(Schema.Number),
	voice_wav_url: Schema.optionalKey(Schema.String)
});
const Event = Schema.Struct({
	id: Schema.String,
	content: Schema.optionalKey(Schema.String),
	timestamp: Schema.String,
	author: Schema.Struct({
		id: Schema.optionalKey(Schema.String),
		username: Schema.optionalKey(Schema.String),
		bot: Schema.optionalKey(Schema.Boolean),
		user_openid: Schema.optionalKey(Schema.String),
		member_openid: Schema.optionalKey(Schema.String)
	}),
	group_openid: Schema.optionalKey(Schema.String),
	channel_id: Schema.optionalKey(Schema.String),
	guild_id: Schema.optionalKey(Schema.String),
	member: Schema.optionalKey(
		Schema.Struct({
			nick: Schema.optionalKey(Schema.String)
		})
	),
	attachments: Schema.optionalKey(Schema.Array(File))
});
type Event = typeof Event.Type;
const Hook = Schema.Struct({
	op: Schema.optionalKey(Schema.Number),
	t: Schema.optionalKey(Schema.String),
	d: Schema.optionalKey(Schema.Json)
});
type Hook = typeof Hook.Type;

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
		sent_at: new Date(event.timestamp).toISOString(),
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
const parsed = async (body: string): Promise<Hook | null> => {
	try {
		return await parseJson(Hook, body);
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
		const tokens = tokenCache(async () => {
			const response = await host.fetch(TOKEN, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ appId, clientSecret })
			});
			const answer = await Schema.decodeUnknownPromise(
				Schema.Struct({
					access_token: Schema.optionalKey(Schema.String),
					expires_in: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
					message: Schema.optionalKey(Schema.String)
				})
			)(await response.json().catch(() => ({})));
			if (answer.access_token === undefined)
				throw new PlatformError(
					answer.message ?? 'QQ refused the app credentials',
					response.ok ? 401 : response.status
				);
			return { token: answer.access_token, ttl: Number(answer.expires_in) * 1000 - 300_000 };
		});
		const content = (url: string) => downloadFile(host.fetch, url);
		await tokens.get();
		const answering = recent<{ readonly id: string; readonly at: number; seq: number }>();
		const connection: ChatConnection = {
			account: appId,
			async deliver(request, body) {
				const signature = request.headers.get('x-signature-ed25519'),
					timestamp = request.headers.get('x-signature-timestamp'),
					hook = await parsed(body);
				if (hook?.op === 13) {
					const challenge = await Schema.decodeUnknownPromise(
						Schema.Struct({ event_ts: Schema.String, plain_token: Schema.String })
					)(hook.d);
					// the setup challenge may arrive unsigned, and its answer signs what it carries: signing anything with a
					// `{` in it could hand a stranger a valid signature on a forged event
					const signing = `${challenge.event_ts}${challenge.plain_token}`;
					if (signing.includes('{')) throw new Unverified('not a challenge');
					return nothing(
						Response.json({
							plain_token: challenge.plain_token,
							signature: sign(null, Buffer.from(signing), privateKey).toString('hex')
						})
					);
				}
				const genuine =
					signature !== null &&
					timestamp !== null &&
					verify(null, Buffer.from(timestamp + body), publicKey, Buffer.from(signature, 'hex'));
				if (!genuine || hook === null) throw new Unverified('bad signature');
				const message =
					hook.op === 0 && hook.d !== undefined
						? parse(hook.t, await Schema.decodeUnknownPromise(Event)(hook.d), content)
						: null;
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
							authorization: `QQBot ${await tokens.get()}`,
							'content-type': 'application/json'
						},
						body: JSON.stringify({ content: text, msg_type: 0, ...answers })
					}
				);
				const sent = await Schema.decodeUnknownPromise(
					Schema.Struct({
						id: Schema.optionalKey(Schema.String),
						code: Schema.optionalKey(Schema.Number),
						message: Schema.optionalKey(Schema.String)
					})
				)(await response.json().catch(() => ({})));
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
