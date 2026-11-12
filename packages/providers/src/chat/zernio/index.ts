// Direct messages on the social accounts connected to Zernio, one key for all of them. A thread is the account and its
// conversation, the two every call names. Post comments are left out: nothing shows how one is answered.
import { Schema } from 'effect';
import { parse as parseJson, json, request as requestHttp, download } from '../http.ts';
import type { ChatConnection, ChatPlatform, Incoming, IncomingFile } from '../adapter.ts';
import { nothing, PlatformError } from '../adapter.ts';
import { hmac, signed } from '../verify.ts';

const API = 'https://zernio.com/api';
const PAGE = 100;
const Attachment = Schema.Struct({
	type: Schema.String,
	url: Schema.optionalKey(Schema.String)
});
type Attachment = typeof Attachment.Type;
const Inbound = Schema.Struct({
	id: Schema.String,
	conversationId: Schema.String,
	platformMessageId: Schema.optionalKey(Schema.String),
	direction: Schema.Union([Schema.Literal('incoming'), Schema.Literal('outgoing')]),
	text: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
	attachments: Schema.optionalKey(Schema.Array(Attachment)),
	sender: Schema.Struct({
		id: Schema.String,
		name: Schema.optionalKey(Schema.String),
		username: Schema.optionalKey(Schema.String)
	}),
	sentAt: Schema.String
});
const Webhook = Schema.Struct({
	event: Schema.optionalKey(Schema.String),
	message: Inbound,
	account: Schema.Struct({
		id: Schema.String
	}),
	metadata: Schema.optionalKey(
		Schema.Struct({
			quotedMessageId: Schema.optionalKey(Schema.String)
		})
	)
});
type Webhook = typeof Webhook.Type;
/** A message as the list endpoint flattens it: its body in `message`, its sender in `senderId`. */
const Listed = Schema.Struct({
	id: Schema.String,
	platformMessageId: Schema.optionalKey(Schema.String),
	direction: Schema.Union([Schema.Literal('incoming'), Schema.Literal('outgoing')]),
	message: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
	text: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
	senderId: Schema.optionalKey(Schema.String),
	senderName: Schema.optionalKey(Schema.String),
	sentAt: Schema.optionalKey(Schema.String),
	createdAt: Schema.optionalKey(Schema.String)
});
type Listed = typeof Listed.Type;
const Page = Schema.Struct({
	messages: Schema.optionalKey(Schema.Array(Listed)),
	pagination: Schema.optionalKey(
		Schema.Struct({
			nextCursor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]))
		})
	),
	sortOrderApplied: Schema.optionalKey(
		Schema.Union([Schema.Literal('asc'), Schema.Literal('desc')])
	)
});

const split = (thread: string) => {
	const at = thread.indexOf(':');
	return {
		accountId: thread.slice(0, at),
		conversation: encodeURIComponent(thread.slice(at + 1))
	};
};

export const zernio: ChatPlatform = {
	id: 'zernio',
	name: { en: 'Zernio', zh: 'Zernio' },
	description: {
		en: 'Social direct messages through one Zernio account',
		zh: '通过一个 Zernio 账号收发社交平台私信'
	},
	via: { en: 'Via Zernio', zh: '通过 Zernio' },
	consistency: 'history',
	guide: 'https://zernio.com/api',
	fields: [
		{ name: 'apiKey', label: { en: 'API key', zh: 'API 密钥' }, secret: true },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true }
	],
	async connect({ apiKey = '', webhookSecret = '' }, host) {
		const call = async <A>(schema: Schema.Decoder<A>, path: string, body?: object): Promise<A> => {
			const response = await requestHttp(host.fetch, `${API}${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					authorization: `Bearer ${apiKey}`,
					'content-type': 'application/json'
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			});
			return json(schema, response);
		};
		await call(Schema.Json, '/v1/inbox/conversations?limit=1');
		const file = (id: string, attachment: Attachment, index: number): IncomingFile[] => {
			const url = attachment.url;
			if (url === undefined || url === '') return [];
			const media = ['image', 'video', 'audio'].includes(attachment.type);
			return [
				{
					name: `zernio-${id}-${index}`,
					mime: media ? `${attachment.type}/*` : 'application/octet-stream',
					fetch: () => download(host.fetch, url)
				}
			];
		};
		const inbound = ({ message, account, metadata }: Webhook): Incoming => {
			const id = message.platformMessageId || message.id;
			return {
				id,
				thread: `${account.id}:${message.conversationId}`,
				sent_at: message.sentAt,
				from: {
					handle: message.sender.id,
					name: message.sender.name ?? message.sender.username ?? null
				},
				text: message.text ?? '',
				reply_to: metadata?.quotedMessageId ?? null,
				files: (message.attachments ?? []).flatMap((one, index) => file(id, one, index))
			};
		};
		const connection: ChatConnection = {
			account: null,
			async deliver(request, body) {
				signed(
					request.headers.get('x-zernio-signature') ?? request.headers.get('x-late-signature'),
					hmac(webhookSecret, body, 'hex')
				);
				const envelope = await parseJson(
					Schema.Struct({ event: Schema.optionalKey(Schema.String) }),
					body
				);
				if (envelope.event !== 'message.received') return nothing();
				const payload = await parseJson(Webhook, body);
				return payload.event === 'message.received' && payload.message.direction === 'incoming'
					? { messages: [inbound(payload)] }
					: nothing();
			},
			async send(thread, text) {
				const { accountId, conversation } = split(thread);
				const { data } = await call(
					Schema.Struct({
						data: Schema.optionalKey(
							Schema.Struct({
								messageId: Schema.optionalKey(Schema.String),
								id: Schema.optionalKey(Schema.String)
							})
						)
					}),
					`/v1/inbox/conversations/${conversation}/messages`,
					{ accountId, message: text }
				);
				const id = data?.messageId ?? data?.id;
				if (id === undefined) throw new PlatformError('Zernio answered no message', 502);
				return { id };
			},
			typing: async (thread, on) => {
				if (!on) return;
				const { accountId, conversation } = split(thread);
				await call(Schema.Json, `/v1/inbox/conversations/${conversation}/typing`, { accountId });
			},
			async history(thread, since) {
				const { accountId, conversation } = split(thread),
					from = Date.parse(since),
					messages: Incoming[] = [];
				for (let cursor: string | null | undefined; ;) {
					const query = new URLSearchParams({
						accountId,
						limit: String(PAGE),
						sortOrder: 'desc',
						...(cursor === undefined || cursor === null ? {} : { cursor })
					});
					const page = await call(
						Page,
						`/v1/inbox/conversations/${conversation}/messages?${query}`
					);
					const rows = page.messages ?? [],
						at = (row: Listed) => Date.parse(row.sentAt ?? row.createdAt ?? '');
					for (const row of rows)
						if (row.direction === 'incoming' && at(row) >= from)
							messages.push({
								id: row.platformMessageId ?? row.id,
								thread,
								sent_at: new Date(at(row)).toISOString(),
								from: { handle: row.senderId ?? '', name: row.senderName ?? null },
								text: row.text ?? row.message ?? ''
							});
					cursor = page.pagination?.nextCursor;
					// a live-API platform may ignore the order asked for, and then only the last page ends the window
					const passed = page.sortOrderApplied !== 'asc' && rows.some((row) => at(row) < from);
					if (cursor === undefined || cursor === null || passed)
						return { messages, complete: true };
				}
			}
		};
		return connection;
	}
};
