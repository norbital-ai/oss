// Twitch, through its Helix API and EventSub webhooks. Twitch has no history API, and it cuts or drops what runs past its
// limits, so a message is sent as one line. Chat goes out on an app token this adapter mints; a whisper needs the bot's own
// user token, which lasts until it expires because a refreshed one has nowhere to persist here. The EventSub subscriptions
// are created once by hand: Twitch checks a new one by calling the webhook, which is not live while `connect` runs.
import { Schema } from 'effect';
import { parse as parseJson, json } from '../http.ts';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { hmac, signed } from '../verify.ts';

const API = 'https://api.twitch.tv/helix';
const TOKEN = 'https://id.twitch.tv/oauth2/token';
const MAX_AGE_MS = 10 * 60 * 1000;
const EARLY_MS = 60_000;
const LIMIT = 500;
const Chat = Schema.Struct({
	message_id: Schema.String,
	broadcaster_user_id: Schema.String,
	broadcaster_user_name: Schema.optionalKey(Schema.String),
	source_broadcaster_user_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
	chatter_user_id: Schema.String,
	chatter_user_login: Schema.optionalKey(Schema.String),
	chatter_user_name: Schema.optionalKey(Schema.String),
	message: Schema.Struct({
		text: Schema.String,
		fragments: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					type: Schema.String,
					mention: Schema.optionalKey(
						Schema.Union([
							Schema.Struct({
								user_id: Schema.optionalKey(Schema.String)
							}),
							Schema.Null
						])
					)
				})
			)
		)
	}),
	reply: Schema.optionalKey(
		Schema.Union([
			Schema.Struct({
				parent_message_id: Schema.String,
				parent_user_id: Schema.String
			}),
			Schema.Null
		])
	)
});
type Chat = typeof Chat.Type;
const Whisper = Schema.Struct({
	whisper_id: Schema.String,
	from_user_id: Schema.String,
	from_user_login: Schema.optionalKey(Schema.String),
	from_user_name: Schema.optionalKey(Schema.String),
	whisper: Schema.Struct({
		text: Schema.String
	})
});
type Whisper = typeof Whisper.Type;
const Notification = Schema.Struct({
	challenge: Schema.optionalKey(Schema.String),
	subscription: Schema.optionalKey(
		Schema.Struct({
			type: Schema.optionalKey(Schema.String)
		})
	),
	event: Schema.optionalKey(Schema.Unknown)
});

const clip = (text: string) =>
	Array.from(text.replace(/\s*\n\s*/g, ' '))
		.slice(0, LIMIT)
		.join('');
const chat = (event: Chat, sentAt: string, me: string): Incoming => ({
	id: event.message_id,
	thread: event.broadcaster_user_id,
	sentAt,
	from: {
		handle: event.chatter_user_id,
		name: event.chatter_user_name ?? event.chatter_user_login ?? null
	},
	text: event.message.text,
	group: true,
	mentioned:
		event.message.fragments?.some(
			(fragment) => fragment.type === 'mention' && fragment.mention?.user_id === me
		) === true,
	repliedTo: event.reply?.parent_user_id === me,
	replyTo: event.reply?.parent_message_id ?? null,
	...(event.broadcaster_user_name === undefined ? {} : { title: event.broadcaster_user_name })
});
const whisper = (event: Whisper, sentAt: string): Incoming => ({
	id: event.whisper_id,
	thread: `whisper:${event.from_user_id}`,
	sentAt,
	from: {
		handle: event.from_user_id,
		name: event.from_user_name ?? event.from_user_login ?? null
	},
	text: event.whisper.text
});

export const twitch: ChatPlatform = {
	id: 'twitch',
	name: { en: 'Twitch', zh: 'Twitch' },
	description: { en: 'Twitch channel chat and whispers', zh: 'Twitch 频道聊天和私聊' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'webhook',
	icon: 'simple-icons:twitch',
	guide: 'https://dev.twitch.tv/docs/eventsub/handling-webhook-events/',
	fields: [
		{ name: 'clientId', label: { en: 'Client ID', zh: '客户端 ID' } },
		{ name: 'clientSecret', label: { en: 'Client secret', zh: '客户端密钥' }, secret: true },
		{ name: 'webhookSecret', label: { en: 'EventSub secret', zh: 'EventSub 密钥' }, secret: true },
		{ name: 'botUsername', label: { en: 'Bot username', zh: '机器人用户名' } },
		{
			name: 'userAccessToken',
			label: { en: 'Bot user token, for whispers', zh: '机器人用户令牌（用于私聊）' },
			secret: true,
			optional: true
		}
	],
	async connect(
		{
			clientId = '',
			clientSecret = '',
			webhookSecret = '',
			botUsername = '',
			userAccessToken = ''
		},
		host
	) {
		if (webhookSecret.length < 10 || webhookSecret.length > 100)
			throw new PlatformError('the EventSub secret must be 10 to 100 characters', 400);
		let app: { readonly token: string; readonly until: number } | null = null;
		const appToken = async () => {
			if (app !== null && app.until > Date.now()) return app.token;
			const response = await host.fetch(TOKEN, {
				method: 'POST',
				body: new URLSearchParams({
					client_id: clientId,
					client_secret: clientSecret,
					grant_type: 'client_credentials'
				})
			});
			if (!response.ok)
				throw new PlatformError(`Twitch answered ${response.status}`, response.status);
			const made = await json(
				Schema.Struct({
					access_token: Schema.String,
					expires_in: Schema.optionalKey(Schema.Number)
				}),
				response
			);
			app = {
				token: made.access_token,
				until: Date.now() + (made.expires_in ?? 3600) * 1000 - EARLY_MS
			};
			return made.access_token;
		};
		const helix = async (path: string, token: string, body?: object): Promise<Response> => {
			const response = await host.fetch(`${API}${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'client-id': clientId,
					...(body === undefined ? {} : { 'content-type': 'application/json' })
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			});
			if (response.ok) return response;
			const reset = Number(response.headers.get('ratelimit-reset'));
			throw new PlatformError(
				`${path} answered ${response.status}`,
				response.status,
				reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : undefined
			);
		};
		/** With the app's token; one Twitch refuses is dropped and minted again, once. */
		const asApp = async (path: string, body?: object) => {
			const token = await appToken();
			return helix(path, token, body).catch((error: unknown) => {
				if (!(error instanceof PlatformError) || error.status !== 401) throw error;
				app = null;
				return appToken().then((fresh) => helix(path, fresh, body));
			});
		};
		const { data = [] } = await json(
			Schema.Struct({
				data: Schema.optionalKey(
					Schema.Array(
						Schema.Struct({
							id: Schema.String,
							login: Schema.String
						})
					)
				)
			}),
			await asApp(`/users?login=${encodeURIComponent(botUsername)}`)
		);
		const bot = data[0];
		if (bot === undefined) throw new PlatformError(`no Twitch user ${botUsername}`, 404);
		const me = bot.id;
		const connection: ChatConnection = {
			account: bot.login,
			async deliver(request, body) {
				const header = (name: string) => request.headers.get(`twitch-eventsub-message-${name}`);
				const id = header('id') ?? '',
					timestamp = header('timestamp') ?? '';
				signed(header('signature'), `sha256=${hmac(webhookSecret, id + timestamp + body, 'hex')}`);
				// its fractions run to nanoseconds, past what a Date reads
				const at = Date.parse(timestamp.replace(/\.(\d{3})\d+/, '.$1'));
				if (Number.isNaN(at) || Date.now() - at > MAX_AGE_MS) throw new Unverified('stale');
				const payload = await parseJson(Notification, body),
					kind = header('type');
				if (kind === 'webhook_callback_verification')
					return nothing(
						new Response(payload.challenge, { headers: { 'content-type': 'text/plain' } })
					);
				if (kind !== 'notification') return nothing();
				const event = payload.event,
					type = payload.subscription?.type,
					sentAt = new Date(at).toISOString();
				if (type === 'channel.chat.message') {
					const message = await Schema.decodeUnknownPromise(Chat)(event);
					const copied =
						message.source_broadcaster_user_id !== undefined &&
						message.source_broadcaster_user_id !== null &&
						message.source_broadcaster_user_id !== message.broadcaster_user_id;
					return message.chatter_user_id === me || copied
						? nothing()
						: { messages: [chat(message, sentAt, me)] };
				}
				if (type === 'user.whisper.message') {
					const message = await Schema.decodeUnknownPromise(Whisper)(event);
					return message.from_user_id === me ? nothing() : { messages: [whisper(message, sentAt)] };
				}
				return nothing();
			},
			async send(thread, text, key) {
				if (thread.startsWith('whisper:')) {
					if (userAccessToken === '')
						throw new PlatformError('a whisper needs the bot user token', 400);
					const to = encodeURIComponent(thread.slice('whisper:'.length));
					await helix(`/whispers?from_user_id=${me}&to_user_id=${to}`, userAccessToken, {
						message: clip(text)
					});
					return { id: key };
				}
				const sent = await json(
					Schema.Struct({
						data: Schema.optionalKey(
							Schema.Array(
								Schema.Struct({
									message_id: Schema.String,
									is_sent: Schema.Boolean,
									drop_reason: Schema.optionalKey(
										Schema.Union([
											Schema.Struct({
												message: Schema.optionalKey(Schema.String)
											}),
											Schema.Null
										])
									)
								})
							)
						)
					}),
					await asApp('/chat/messages', {
						broadcaster_id: thread,
						sender_id: me,
						message: clip(text)
					})
				);
				const result = sent.data?.[0];
				if (result?.is_sent !== true)
					throw new PlatformError(
						`Twitch dropped the message: ${result?.drop_reason?.message ?? 'no reason given'}`,
						400
					);
				return { id: result.message_id };
			},
			openDirect: async (user) => `whisper:${user}`
		};
		return connection;
	}
};
