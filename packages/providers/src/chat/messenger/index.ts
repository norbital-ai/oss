// Facebook Messenger through a Page and the Graph API. Webhooks only: no history read and no dedupe key on a send are
// known here. Every conversation is one person's, so the thread is their page-scoped id.
import { Schema } from 'effect';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { appFields, filesOf, graph, messaging, pieces, verified, Attachment } from '../meta.ts';

const API = 'https://graph.facebook.com/v21.0';
const LIMIT = 2000;
const Event = Schema.Struct({
	sender: Schema.Struct({ id: Schema.String }),
	timestamp: Schema.Number,
	message: Schema.optionalKey(
		Schema.Struct({
			mid: Schema.String,
			text: Schema.optionalKey(Schema.String),
			is_echo: Schema.optionalKey(Schema.Boolean),
			attachments: Schema.optionalKey(Schema.Array(Attachment))
		})
	)
});
type Event = typeof Event.Type;

const parse = (
	{ sender, timestamp, message }: Event,
	fetch: typeof globalThis.fetch
): Incoming | null => {
	if (message === undefined || message.is_echo === true) return null;
	const files = filesOf(message.attachments, fetch),
		text = message.text ?? '';
	if (text === '' && files.length === 0) return null;
	return {
		id: message.mid,
		thread: sender.id,
		sent_at: new Date(timestamp).toISOString(),
		from: { handle: sender.id, name: null },
		text,
		files
	};
};

export const messenger: ChatPlatform = {
	id: 'messenger',
	name: { en: 'Messenger', zh: 'Messenger' },
	description: { en: 'Facebook Page messages', zh: 'Facebook 主页消息' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'webhook',
	icon: 'simple-icons:messenger',
	guide: 'https://developers.facebook.com/docs/messenger-platform',
	fields: [
		{
			name: 'pageAccessToken',
			label: { en: 'Page access token', zh: '主页访问令牌' },
			secret: true
		},
		...appFields
	],
	async connect({ pageAccessToken = '', appSecret = '', verifyToken = '' }, host) {
		const call = <A>(schema: Schema.Decoder<A>, path: string, body?: object) =>
			graph(
				schema,
				host.fetch,
				`${API}/${path}?access_token=${encodeURIComponent(pageAccessToken)}`,
				{},
				body
			);
		const page = await call(
			Schema.Struct({
				id: Schema.String,
				name: Schema.optionalKey(Schema.String)
			}),
			'me'
		);
		const connection: ChatConnection = {
			account: page.name ?? page.id,
			async deliver(request, body) {
				const handshake = verified(request, body, verifyToken, appSecret);
				if (handshake !== null) return handshake;
				return {
					messages: (await messaging(Event, body, 'page')).flatMap(
						(event) => parse(event, host.fetch) ?? []
					)
				};
			},
			async send(thread, text) {
				let id = '';
				for (const piece of pieces(text, LIMIT))
					({ message_id: id } = await call(
						Schema.Struct({
							message_id: Schema.String
						}),
						'me/messages',
						{
							recipient: { id: thread },
							message: { text: piece },
							messaging_type: 'RESPONSE'
						}
					));
				return { id };
			},
			typing: async (thread, on) => {
				if (on)
					await call(Schema.Json, 'me/messages', {
						recipient: { id: thread },
						sender_action: 'typing_on'
					});
			}
		};
		return connection;
	}
};
