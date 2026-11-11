// LINE, through its Messaging API with LINE's own SDK. Webhooks only: LINE has no history API, and it retries a
// delivery only when redelivery is switched on in its console.
import { Schema } from 'effect';
import { parse as parseJson } from '../http.ts';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing } from '../adapter.ts';
import { hmac, signed } from '../verify.ts';

const Source = Schema.Union([
	Schema.Struct({
		type: Schema.Literal('group'),
		groupId: Schema.String,
		userId: Schema.optionalKey(Schema.String)
	}),
	Schema.Struct({
		type: Schema.Literal('room'),
		roomId: Schema.String,
		userId: Schema.optionalKey(Schema.String)
	}),
	Schema.Struct({ type: Schema.Literal('user'), userId: Schema.String })
]);
const Event = Schema.Struct({
	type: Schema.String,
	timestamp: Schema.Number,
	source: Schema.optionalKey(Source),
	message: Schema.optionalKey(Schema.Unknown),
	unsend: Schema.optionalKey(Schema.Unknown)
});
const Message = Schema.Union([
	Schema.Struct({
		type: Schema.Literal('text'),
		id: Schema.String,
		text: Schema.String,
		mention: Schema.optionalKey(
			Schema.Struct({
				mentionees: Schema.Array(
					Schema.Struct({ type: Schema.String, isSelf: Schema.optionalKey(Schema.Boolean) })
				)
			})
		)
	}),
	Schema.Struct({ type: Schema.Literals(['image', 'video', 'audio']), id: Schema.String }),
	Schema.Struct({
		type: Schema.Literal('file'),
		id: Schema.String,
		fileName: Schema.String,
		fileSize: Schema.Number
	}),
	Schema.Struct({ type: Schema.Literals(['sticker', 'location']) })
]);

const threadOf = (source: typeof Source.Type | undefined) =>
	source?.type === 'group'
		? source.groupId
		: source?.type === 'room'
			? source.roomId
			: source?.type === 'user'
				? source.userId
				: undefined;
const senderOf = (source: typeof Source.Type | undefined) =>
	source !== undefined && 'userId' in source ? source.userId : undefined;

const parse = async (
	raw: unknown,
	content: (id: string) => Promise<Uint8Array>
): Promise<Incoming | null> => {
	const event = await Schema.decodeUnknownPromise(Event)(raw);
	const thread = threadOf(event.source),
		from = senderOf(event.source),
		sentAt = new Date(event.timestamp).toISOString();
	if (thread === undefined || from === undefined) return null;
	const base = {
		thread,
		sentAt,
		from: { handle: from, name: null },
		group: event.source?.type !== 'user'
	};
	if (event.type === 'unsend') {
		const unsend = await Schema.decodeUnknownPromise(Schema.Struct({ messageId: Schema.String }))(
			event.unsend
		);
		return { ...base, id: unsend.messageId, text: '', deleted: true };
	}
	if (event.type !== 'message') return null;
	const message = await Schema.decodeUnknownPromise(Message)(event.message);
	if (message.type === 'text')
		return {
			...base,
			id: message.id,
			text: message.text,
			mentioned:
				message.mention?.mentionees.some((one) => one.type === 'user' && one.isSelf === true) ===
				true
		};
	if (message.type === 'image' || message.type === 'video' || message.type === 'audio')
		return {
			...base,
			id: message.id,
			text: '',
			files: [
				{
					name: `line-${message.id}`,
					mime: `${message.type}/*`,
					fetch: () => content(message.id)
				}
			]
		};
	if (message.type === 'file')
		return {
			...base,
			id: message.id,
			text: '',
			files: [
				{
					name: message.fileName,
					mime: 'application/octet-stream',
					bytes: message.fileSize,
					fetch: () => content(message.id)
				}
			]
		};
	return null;
};

export const line: ChatPlatform = {
	id: 'line',
	name: { en: 'LINE', zh: 'LINE' },
	description: { en: 'LINE official accounts', zh: 'LINE 官方账号' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'webhook',
	idempotent: true,
	icon: 'simple-icons:line',
	guide: 'https://developers.line.biz/en/docs/messaging-api/getting-started/',
	fields: [
		{
			name: 'channelAccessToken',
			label: { en: 'Channel access token', zh: '频道访问令牌' },
			secret: true
		},
		{ name: 'channelSecret', label: { en: 'Channel secret', zh: '频道密钥' }, secret: true }
	],
	async connect({ channelAccessToken = '', channelSecret = '' }) {
		const { messagingApi } = await import('@line/bot-sdk');
		const client = new messagingApi.MessagingApiClient({ channelAccessToken }),
			blobs = new messagingApi.MessagingApiBlobClient({ channelAccessToken });
		const bot = await client.getBotInfo();
		const content = async (id: string) => {
			const chunks: Buffer[] = [];
			for await (const chunk of await blobs.getMessageContent(id)) chunks.push(Buffer.from(chunk));
			return new Uint8Array(Buffer.concat(chunks));
		};
		const connection: ChatConnection = {
			account: bot.basicId,
			async deliver(request, body) {
				signed(request.headers.get('x-line-signature'), hmac(channelSecret, body, 'base64'));
				const { events } = await parseJson(
					Schema.Struct({ events: Schema.Array(Schema.Json) }),
					body
				);
				return events.length === 0
					? nothing()
					: {
							messages: (await Promise.all(events.map((event) => parse(event, content)))).flatMap(
								(message) => message ?? []
							)
						};
			},
			// LINE dedupes on the retry key for 24 hours, so a resend after an unknown outcome is safe
			async send(thread, text, key) {
				const sent = await client.pushMessage(
					{ to: thread, messages: [{ type: 'text', text }] },
					key
				);
				return { id: sent.sentMessages[0]?.id ?? key };
			},
			typing: async (thread, on) => {
				if (on) await client.showLoadingAnimation({ chatId: thread, loadingSeconds: 20 });
			}
		};
		return connection;
	}
};
