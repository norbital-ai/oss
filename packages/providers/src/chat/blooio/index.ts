// iMessage, RCS and SMS through Blooio's REST API; it publishes no SDK. A direct thread is the contact, a group's is
// `group:<id>`. Blooio shows no dedupe key on a send and no edit or unsend event.
import { Schema } from 'effect';
import { parse as parseJson, json, request as requestHttp, fileOf } from '../http.ts';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { fresh, hmac, signed } from '../verify.ts';

const Delivered = Schema.Struct({
	event: Schema.optionalKey(Schema.String),
	message_id: Schema.String,
	text: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
	attachments: Schema.optionalKey(Schema.Union([Schema.Array(Schema.String), Schema.Null])),
	timestamp: Schema.Number,
	received_at: Schema.optionalKey(Schema.Number),
	sender: Schema.String,
	is_group: Schema.Boolean,
	group_id: Schema.Union([Schema.String, Schema.Null]),
	group_name: Schema.Union([Schema.String, Schema.Null]),
	participants: Schema.Union([
		Schema.Array(
			Schema.Struct({
				identifier: Schema.String,
				name: Schema.Union([Schema.String, Schema.Null])
			})
		),
		Schema.Null
	])
});
const Row = Schema.Struct({
	message_id: Schema.String,
	sender: Schema.String,
	text: Schema.Union([Schema.String, Schema.Null]),
	attachments: Schema.Array(
		Schema.Union([
			Schema.String,
			Schema.Struct({
				url: Schema.optionalKey(Schema.String)
			})
		])
	),
	time_sent: Schema.Number
});
const Page = Schema.Struct({
	messages: Schema.Array(Row),
	pagination: Schema.Struct({
		total: Schema.Number
	})
});
const Me = Schema.Struct({
	devices: Schema.Array(
		Schema.Struct({
			phone_number: Schema.String
		})
	)
});

const API = 'https://backend.blooio.com/v2/api',
	GROUP = 'group:',
	HISTORY_PAGES = 20;
const chatOf = (thread: string) =>
	encodeURIComponent(thread.startsWith(GROUP) ? thread.slice(GROUP.length) : thread);

export const blooio: ChatPlatform = {
	id: 'blooio',
	name: { en: 'iMessage (Blooio)', zh: 'iMessage（Blooio）' },
	description: { en: 'iMessage, RCS and SMS', zh: 'iMessage、RCS 和短信' },
	via: { en: 'Via Blooio', zh: '通过 Blooio' },
	consistency: 'history',
	guide: 'https://blooio.com',
	fields: [
		{ name: 'apiKey', label: { en: 'API key', zh: 'API 密钥' }, secret: true },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true },
		{ name: 'fromNumber', label: { en: 'From number', zh: '发送号码' }, optional: true }
	],
	async connect({ apiKey = '', webhookSecret = '', fromNumber = '' }, host) {
		const call = async (path: string, init: RequestInit = {}) => {
			return requestHttp(host.fetch, `${API}${path}`, {
				...init,
				headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
			});
		};
		const me = await json(Me, await call('/me'));
		const file = (url: string) => fileOf(url, host.fetch);
		const connection: ChatConnection = {
			account: fromNumber || (me.devices[0]?.phone_number ?? null),
			async deliver(request, body) {
				const signature = new URLSearchParams(
					request.headers.get('x-blooio-signature')?.replaceAll(',', '&')
				);
				const at = signature.get('t') ?? '';
				if (!fresh(at)) throw new Unverified('stale timestamp');
				signed(signature.get('v1'), hmac(webhookSecret, `${at}.${body}`, 'hex'));
				const envelope = await parseJson(
					Schema.Struct({ event: Schema.optionalKey(Schema.String) }),
					body
				);
				if ((request.headers.get('x-blooio-event') ?? envelope.event) !== 'message.received')
					return nothing();
				const message = await parseJson(Delivered, body);
				const group = message.is_group && message.group_id !== null;
				return {
					messages: [
						{
							id: message.message_id,
							thread: group ? `${GROUP}${message.group_id}` : message.sender,
							sent_at: new Date(message.received_at ?? message.timestamp).toISOString(),
							from: {
								handle: message.sender,
								name:
									message.participants?.find((one) => one.identifier === message.sender)?.name ??
									null
							},
							text: message.text ?? '',
							group,
							title: message.group_name,
							files: (message.attachments ?? []).map(file)
						}
					]
				};
			},
			async send(thread, text) {
				const response = await call(`/chats/${chatOf(thread)}/messages`, {
					method: 'POST',
					body: JSON.stringify({ text, ...(fromNumber ? { from_number: fromNumber } : {}) })
				});
				return {
					id: (
						await json(
							Schema.Struct({
								message_id: Schema.String
							}),
							response
						)
					).message_id
				};
			},
			typing: async (thread, on) => {
				await call(`/chats/${chatOf(thread)}/typing`, { method: on ? 'POST' : 'DELETE' });
			},
			// newest first, read back until one is older than `since`: `since` on the API states no unit
			async history(thread, since) {
				const from = Date.parse(since),
					group = thread.startsWith(GROUP),
					messages: Incoming[] = [];
				let offset = 0;
				for (let page = 0; page < HISTORY_PAGES; page++) {
					const response = await call(
						`/chats/${chatOf(thread)}/messages?sort=desc&direction=inbound&offset=${offset}`
					);
					const { messages: rows, pagination } = await json(Page, response);
					for (const row of rows) {
						if (row.time_sent < from) return { messages, complete: true };
						messages.push({
							id: row.message_id,
							thread,
							sent_at: new Date(row.time_sent).toISOString(),
							from: { handle: row.sender, name: null },
							text: row.text ?? '',
							group,
							files: row.attachments.flatMap((one) => {
								const url = typeof one === 'string' ? one : one.url;
								return url ? [file(url)] : [];
							})
						});
					}
					offset += rows.length;
					if (rows.length === 0 || offset >= pagination.total) return { messages, complete: true };
				}
				return { messages, complete: false };
			}
		};
		return connection;
	}
};
