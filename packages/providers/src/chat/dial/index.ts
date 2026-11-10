// SMS and iMessage through Dial. Every thread is a person's number.
// Dial shows no dedupe key on a message send and no edit or delete event. Call events carry no chat message.
import { Result, Schema } from 'effect';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';

const API = 'https://api.getdial.ai/api/v1';
const TEXT_MAX = 1600;

const Numbers = Schema.Struct({
	numbers: Schema.Array(Schema.Struct({ id: Schema.String, number: Schema.String }))
});
const Sent = Schema.Struct({ message: Schema.Struct({ id: Schema.String }) });
const messageFields = {
	from: Schema.String,
	body: Schema.String,
	media: Schema.Array(
		Schema.Struct({ id: Schema.String, url: Schema.String, contentType: Schema.String })
	),
	replyToId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	reaction: Schema.optionalKey(Schema.NullOr(Schema.String))
};
const Message = Schema.Struct({ ...messageFields, id: Schema.String, createdAt: Schema.String });
const History = Schema.Struct({ messages: Schema.Array(Message) });
const envelope = Schema.decodeUnknownResult(
	Schema.fromJsonString(
		Schema.Struct({
			type: Schema.String,
			createdAt: Schema.optionalKey(Schema.Unknown),
			data: Schema.optionalKey(Schema.Unknown)
		})
	)
);
const received = Schema.decodeUnknownResult(
	Schema.Struct({
		createdAt: Schema.String,
		data: Schema.Struct({ ...messageFields, messageId: Schema.String })
	})
);

export const dial: ChatPlatform = {
	id: 'dial',
	name: { en: 'Dial', zh: 'Dial' },
	description: { en: 'SMS and iMessage', zh: '短信和 iMessage' },
	via: { en: 'Via Dial', zh: '通过 Dial' },
	consistency: 'history',
	guide: 'https://docs.getdial.ai',
	fields: [
		{ name: 'apiKey', label: { en: 'API key', zh: 'API 密钥' }, secret: true },
		{ name: 'fromNumberId', label: { en: 'From number ID', zh: '发送号码 ID' } },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true }
	],
	async connect({ apiKey = '', fromNumberId = '', webhookSecret = '' }, host) {
		const { verifyDialSignature } = await import('@getdial/sdk');
		const request = async (path: string, body?: object) => {
			const response = await host.fetch(`${API}${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			});
			if (!response.ok)
				throw new PlatformError(`Dial API answered ${response.status}`, response.status);
			return response;
		};
		const { numbers } = Schema.decodeUnknownSync(Numbers)(await (await request('/numbers')).json());
		const own = numbers.find((number) => number.id === fromNumberId);
		if (own === undefined) throw new Error(`${fromNumberId} is not a number of this account`);
		const parse = (message: typeof Message.Type): Incoming => ({
			id: message.id,
			thread: message.from,
			sentAt: message.createdAt,
			from: { handle: message.from, name: null },
			text: message.body,
			replyTo: message.replyToId ?? null,
			files: message.media.map((item) => ({
				name: item.id,
				mime: item.contentType,
				fetch: async () => {
					const response = await host.fetch(item.url);
					if (!response.ok) throw new PlatformError('Dial media', response.status);
					return new Uint8Array(await response.arrayBuffer());
				}
			}))
		});
		const connection: ChatConnection = {
			account: own.number,
			async deliver(request, body) {
				const signature = request.headers.get('x-dial-signature') ?? '';
				if (!verifyDialSignature(webhookSecret, signature, body))
					throw new Unverified('bad signature');
				const parsed = envelope(body);
				if (Result.isFailure(parsed)) return nothing(new Response(null, { status: 400 }));
				if (parsed.success.type !== 'message.received') return nothing();
				const event = received(parsed.success);
				if (Result.isFailure(event)) return nothing(new Response(null, { status: 400 }));
				const { createdAt, data } = event.success;
				if (data.reaction) return nothing();
				return { messages: [parse({ ...data, id: data.messageId, createdAt })] };
			},
			async send(thread, text) {
				const response = await request('/messages', {
					to: thread,
					fromNumberId,
					...(text === '' ? {} : { body: text.slice(0, TEXT_MAX) })
				});
				return Schema.decodeUnknownSync(Sent)(await response.json()).message;
			},
			typing: async (thread, on) => {
				const response = await request('/typing', {
					toNumber: thread,
					fromNumber: own.number,
					value: on
				});
				await response.json();
			},
			// the list is the whole number's and never says it stopped short, so it cannot claim the whole window
			async history(thread, since) {
				const query = new URLSearchParams({
					numberId: fromNumberId,
					direction: 'inbound',
					since
				});
				const response = await request(`/messages?${query}`);
				const { messages } = Schema.decodeUnknownSync(History)(await response.json());
				return {
					messages: messages.filter((row) => row.from === thread && !row.reaction).map(parse),
					complete: false
				};
			}
		};
		return connection;
	}
};
