// X, through its v2 API and its Activity webhooks, with the webhook and its subscriptions set up once in X's console. Calls
// are signed with OAuth 1.0a by X's own SDK: an OAuth 2 token lasts two hours, and its rotating refresh token has nowhere to
// persist here. A mention is its own thread, because a reply must name the post it answers and an adapter keeps no map from
// a conversation to its latest post. Direct messages can be read back; X has no such read for posts.
import { Option, Schema } from 'effect';
import { parse as parseJson, json } from '../http.ts';
import type { ChatConnection, ChatField, ChatHost, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { hmac, signed } from '../verify.ts';

const API = 'https://api.x.com';
const CRC_TOKEN = /^[A-Za-z0-9+/=_-]{16,128}$/;

/** The app and account keys an X platform signs with. */
export const xFields: readonly ChatField[] = [
	{ name: 'apiKey', label: { en: 'API key', zh: 'API 密钥' } },
	{ name: 'apiSecret', label: { en: 'API key secret', zh: 'API 密钥 Secret' }, secret: true },
	{ name: 'accessToken', label: { en: 'Access token', zh: '访问令牌' }, secret: true },
	{
		name: 'accessTokenSecret',
		label: { en: 'Access token secret', zh: '访问令牌 Secret' },
		secret: true
	}
];
type Settings = Readonly<Record<string, string>>;
/** An account's signed calls to the X API. A refusal is a `PlatformError`. */
export const xApi = async (
	{ apiKey = '', apiSecret = '', accessToken = '', accessTokenSecret = '' }: Settings,
	host: Pick<ChatHost, 'fetch'>
) => {
	const { OAuth1 } = await import('@xdevplatform/xdk');
	const oauth = new OAuth1({
		apiKey,
		apiSecret,
		callback: 'oob',
		accessToken,
		accessTokenSecret
	});
	const raw = async (method: string, path: string, body?: object) => {
		const url = `${API}${path}`,
			text = body === undefined ? undefined : JSON.stringify(body);
		const response = await host.fetch(url, {
			method,
			headers: {
				authorization: await oauth.buildRequestHeader(method, url, text),
				...(text === undefined ? {} : { 'content-type': 'application/json' })
			},
			...(text === undefined ? {} : { body: text })
		});
		if (response.ok) return response;
		const reset = Number(response.headers.get('x-rate-limit-reset'));
		throw new PlatformError(
			`${method} ${path} answered ${response.status}`,
			response.status,
			reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : undefined
		);
	};
	return {
		raw,
		json: async <A>(
			schema: Schema.Decoder<A>,
			method: string,
			path: string,
			body?: object
		): Promise<A> => json(schema, await raw(method, path, body))
	};
};
export type XApi = Awaited<ReturnType<typeof xApi>>;
/** The account behind a token, which proves the keys. */
export const xAccount = async (api: XApi) => {
	const { data } = await api.json(
		Schema.Struct({
			data: Schema.optionalKey(
				Schema.Struct({
					id: Schema.String,
					username: Schema.optionalKey(Schema.String)
				})
			)
		}),
		'GET',
		'/2/users/me?user.fields=username'
	);
	if (data === undefined) throw new PlatformError('X answered no account', 401);
	return data;
};
/**
 * X's webhook checks, the same for every event it delivers: answers its CRC challenge, or refuses a POST not signed with
 * the app's secret. The challenge signs what it is given with that same key and scheme, so its token's shape is checked
 * first: signing an arbitrary one would forge any event body.
 */
export const xChallenge = (request: Request, body: string, secret: string) => {
	if (request.method !== 'GET') {
		signed(
			request.headers.get('x-twitter-webhooks-signature'),
			`sha256=${hmac(secret, body, 'base64')}`
		);
		return null;
	}
	const token = new URL(request.url).searchParams.get('crc_token');
	if (token === null || !CRC_TOKEN.test(token)) throw new Unverified('bad crc_token');
	return Response.json({ response_token: `sha256=${hmac(secret, token, 'base64')}` });
};

const User = Schema.Struct({
	id: Schema.String,
	name: Schema.optionalKey(Schema.String),
	username: Schema.optionalKey(Schema.String)
});
type User = typeof User.Type;
const Post = Schema.Struct({
	id: Schema.String,
	text: Schema.String,
	author_id: Schema.optionalKey(Schema.String),
	created_at: Schema.optionalKey(Schema.String)
});
const Payload = Schema.StructWithRest(
	Schema.Struct({
		direct_message_events: Schema.optionalKey(
			Schema.Array(
				Schema.Struct({
					id: Schema.String,
					created_timestamp: Schema.optionalKey(Schema.String),
					message_create: Schema.optionalKey(
						Schema.Struct({
							sender_id: Schema.optionalKey(Schema.String),
							message_data: Schema.optionalKey(
								Schema.Struct({
									text: Schema.optionalKey(Schema.String)
								})
							)
						})
					)
				})
			)
		),
		users: Schema.optionalKey(
			Schema.Record(
				Schema.String,
				Schema.Struct({
					data: Schema.optionalKey(User)
				})
			)
		)
	}),
	[Schema.Record(Schema.String, Schema.Json)]
);
const Activity = Schema.Struct({
	event_type: Schema.optionalKey(Schema.String),
	payload: Schema.optionalKey(Payload),
	includes: Schema.optionalKey(
		Schema.Struct({
			users: Schema.optionalKey(Schema.Array(User))
		})
	)
});
type Activity = typeof Activity.Type;
const DmEvent = Schema.Struct({
	id: Schema.String,
	text: Schema.optionalKey(Schema.String),
	sender_id: Schema.optionalKey(Schema.String),
	created_at: Schema.optionalKey(Schema.String)
});
type DmEvent = typeof DmEvent.Type;
const DmPage = Schema.Struct({
	data: Schema.optionalKey(Schema.Array(DmEvent)),
	meta: Schema.optionalKey(
		Schema.Struct({
			next_token: Schema.optionalKey(Schema.String)
		})
	)
});

const postOf = Schema.decodeUnknownOption(Post);
const direct = (id: string, sender: string, text: string, sentAt: string, name: string | null) => ({
	id,
	thread: `dm:${sender}`,
	sentAt,
	from: { handle: sender, name },
	text
});
const parse = (event: Activity, me: string): readonly Incoming[] => {
	const payload = event.payload,
		users = event.includes?.users;
	if (event.event_type === 'post.mention.create') {
		const post = [payload, payload?.['post'], payload?.['tweet'], payload?.['data']].flatMap(
			(value) => Option.toArray(postOf(value))
		)[0];
		if (post === undefined || post.author_id === me) return [];
		const author = users?.find((user) => user.id === post.author_id);
		return [
			{
				id: post.id,
				thread: `post:${post.id}`,
				sentAt: post.created_at ?? new Date().toISOString(),
				from: {
					handle: post.author_id ?? 'unknown',
					name: author?.name ?? author?.username ?? null
				},
				text: post.text,
				group: true,
				mentioned: true
			}
		];
	}
	if (event.event_type !== 'dm.received') return [];
	return (payload?.direct_message_events ?? []).flatMap((wire) => {
		const sender = wire.message_create?.sender_id;
		if (sender === undefined || sender === me) return [];
		const at = new Date(Number(wire.created_timestamp)),
			user = payload?.users?.[sender]?.data ?? users?.find((one) => one.id === sender);
		return [
			direct(
				wire.id,
				sender,
				wire.message_create?.message_data?.text ?? '',
				(Number.isNaN(at.getTime()) ? new Date() : at).toISOString(),
				user?.name ?? user?.username ?? null
			)
		];
	});
};

export const x: ChatPlatform = {
	id: 'x',
	name: { en: 'X', zh: 'X' },
	description: {
		en: 'Public mentions and direct messages on X',
		zh: 'X 上的公开提及和私信'
	},
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'history',
	icon: 'simple-icons:x',
	guide: 'https://docs.x.com/x-api/activity/introduction',
	fields: xFields,
	async connect(settings, host) {
		const api = await xApi(settings, host),
			account = await xAccount(api),
			me = account.id;
		const connection: ChatConnection = {
			account: account.username ?? me,
			async deliver(request, body) {
				const challenge = xChallenge(request, body, settings['apiSecret'] ?? '');
				if (challenge !== null) return nothing(challenge);
				const { data } = await parseJson(
					Schema.Struct({
						data: Schema.optionalKey(Schema.Union([Activity, Schema.Array(Activity)]))
					}),
					body
				);
				return { messages: [data ?? []].flat().flatMap((event) => parse(event, me)) };
			},
			async send(thread, text) {
				if (thread.startsWith('post:')) {
					const sent = await api.json(
						Schema.Struct({
							data: Schema.Struct({
								id: Schema.String
							})
						}),
						'POST',
						'/2/tweets',
						{
							text,
							reply: { in_reply_to_tweet_id: thread.slice('post:'.length) }
						}
					);
					return { id: sent.data.id };
				}
				const sent = await api.json(
					Schema.Struct({
						data: Schema.Struct({
							dm_event_id: Schema.String
						})
					}),
					'POST',
					`/2/dm_conversations/with/${encodeURIComponent(thread.replace(/^dm:/, ''))}/messages`,
					{ text }
				);
				return { id: sent.data.dm_event_id };
			},
			openDirect: async (user) => `dm:${user}`,
			async history(thread, since) {
				if (thread.startsWith('post:')) return { messages: [], complete: false };
				const user = thread.replace(/^dm:/, ''),
					from = Date.parse(since),
					messages: Incoming[] = [];
				for (let token: string | undefined; ;) {
					const after = token === undefined ? '' : `&pagination_token=${encodeURIComponent(token)}`;
					const page = await api.json(
						DmPage,
						'GET',
						`/2/dm_conversations/with/${encodeURIComponent(user)}/dm_events?dm_event.fields=id,text,sender_id,created_at&event_types=MessageCreate&max_results=100${after}`
					);
					const events = page.data ?? [],
						at = (event: DmEvent) => Date.parse(event.created_at ?? '');
					for (const event of events)
						if (event.sender_id !== me && at(event) >= from)
							messages.push(
								direct(event.id, user, event.text ?? '', new Date(at(event)).toISOString(), null)
							);
					token = page.meta?.next_token;
					if (token === undefined || events.some((event) => at(event) < from))
						return { messages, complete: true };
				}
			}
		};
		return connection;
	}
};
