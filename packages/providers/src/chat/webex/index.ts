// Webex, through its REST API: no Webex SDK is installed. A webhook only names a message, so each delivery reads it back,
// and a bot reads a group room only for the messages that mention it, which is also all its webhook hears of one. The
// webhook is created by hand with the secret given here. Its `messages` `created` event is the only one parsed: edits
// and deletes are not in what we could read of the platform, so `history` repairs them, and Webex has no typing call.
import { Schema } from 'effect';
import { parse as parseJson, json, request as requestHttp } from '../http.ts';
import { createHmac } from 'node:crypto';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError } from '../adapter.ts';
import { signed } from '../verify.ts';

const API = 'https://webexapis.com/v1';
const PAGE = 100;
const PAGES = 10;
const Message = Schema.Struct({
	id: Schema.String,
	roomId: Schema.String,
	roomType: Schema.optionalKey(Schema.String),
	parentId: Schema.optionalKey(Schema.String),
	personId: Schema.String,
	personEmail: Schema.optionalKey(Schema.String),
	personDisplayName: Schema.optionalKey(Schema.String),
	text: Schema.optionalKey(Schema.String),
	markdown: Schema.optionalKey(Schema.String),
	created: Schema.String,
	mentionedPeople: Schema.optionalKey(Schema.Array(Schema.String)),
	files: Schema.optionalKey(Schema.Array(Schema.String))
});
type Message = typeof Message.Type;
const Hook = Schema.Struct({
	resource: Schema.optionalKey(Schema.String),
	event: Schema.optionalKey(Schema.String),
	data: Schema.optionalKey(
		Schema.Struct({
			id: Schema.optionalKey(Schema.String)
		})
	)
});

const threadOf = ({ roomId, parentId }: Message) =>
	parentId === undefined ? roomId : `${roomId}:${parentId}`;

export const webex: ChatPlatform = {
	id: 'webex',
	name: { en: 'Webex', zh: 'Webex' },
	description: { en: 'Webex spaces and threads', zh: 'Webex 空间与话题' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'history',
	icon: 'simple-icons:webex',
	guide: 'https://developer.webex.com/docs/webhooks',
	fields: [
		{ name: 'botToken', label: { en: 'Bot token', zh: '机器人令牌' }, secret: true },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true }
	],
	async connect({ botToken = '', webhookSecret = '' }, host) {
		const call = async (url: string, body?: object) => {
			return requestHttp(host.fetch, url, {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					authorization: `Bearer ${botToken}`,
					...(body === undefined ? {} : { 'content-type': 'application/json' })
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			});
		};
		const api = async <A>(schema: Schema.Decoder<A>, path: string, body?: object) =>
			json(schema, await call(`${API}/${path}`, body));
		const me = await api(
			Schema.Struct({
				id: Schema.String,
				nickName: Schema.optionalKey(Schema.String),
				displayName: Schema.optionalKey(Schema.String)
			}),
			'people/me'
		);
		const parse = (message: Message): Incoming => ({
			id: message.id,
			thread: threadOf(message),
			sent_at: message.created,
			from: {
				handle: message.personId,
				name: message.personDisplayName ?? message.personEmail ?? null
			},
			text: message.text ?? message.markdown ?? '',
			group: message.roomType !== 'direct',
			mentioned:
				message.mentionedPeople?.some((person) => person === me.id || person === 'all') === true,
			reply_to: message.parentId ?? null,
			files: (message.files ?? []).map((url) => ({
				name: new URL(url).pathname.split('/').at(-1) || 'attachment',
				mime: 'application/octet-stream',
				fetch: async () => new Uint8Array(await (await call(url)).arrayBuffer())
			}))
		});
		const connection: ChatConnection = {
			account: me.nickName ?? me.displayName ?? me.id,
			async deliver(request, body) {
				signed(
					request.headers.get('x-spark-signature'),
					createHmac('sha1', webhookSecret).update(body).digest('hex')
				);
				const { resource, event, data } = await parseJson(Hook, body);
				if (resource !== 'messages' || event !== 'created' || data?.id === undefined)
					return nothing();
				const message = await api(Message, `messages/${encodeURIComponent(data.id)}`).catch(
					(error: unknown) => {
						if (error instanceof PlatformError && error.status === 404) return null;
						throw error;
					}
				);
				return message === null || message.personId === me.id
					? nothing()
					: { messages: [parse(message)] };
			},
			// no dedupe key in what the source shows, so a send is not idempotent
			async send(thread, text) {
				const [roomId, parentId] = thread.split(':');
				const sent = await api(
					Schema.Struct({
						id: Schema.String
					}),
					'messages',
					{ roomId, parentId, markdown: text }
				);
				return { id: sent.id };
			},
			// newest first, so a page older than `since` ends it; a page bound leaves the window unfinished
			async history(thread, since) {
				const [roomId = ''] = thread.split(':');
				const room = await api(
					Schema.Struct({
						type: Schema.optionalKey(Schema.String)
					}),
					`rooms/${encodeURIComponent(roomId)}`
				);
				const query = new URLSearchParams({ roomId, max: String(PAGE) });
				if (room.type === 'group') query.set('mentionedPeople', 'me');
				const from = Date.parse(since),
					messages: Incoming[] = [];
				for (let page = 0; page < PAGES; page++) {
					const { items } = await api(
						Schema.Struct({
							items: Schema.Array(Message)
						}),
						`messages?${query}`
					);
					for (const item of items) {
						if (Date.parse(item.created) < from) return { messages, complete: true };
						if (item.personId !== me.id && threadOf(item) === thread) messages.push(parse(item));
					}
					const last = items.at(-1);
					if (last === undefined || items.length < PAGE) return { messages, complete: true };
					query.set('beforeMessage', last.id);
				}
				return { messages, complete: false };
			}
		};
		return connection;
	}
};
