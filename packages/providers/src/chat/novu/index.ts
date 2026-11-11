// Novu's bridge: its agents take Slack, Teams, WhatsApp, Telegram and email, and post here only what is directed at the
// agent, so every message counts as a mention. It offers no read of a thread: a bridge call carries its own transcript, and
// that is not a repair. The API key signs the bridge too unless a separate secret is set.
import { Schema } from 'effect';
import { parse as parseJson } from '../http.ts';
import { createHmac } from 'node:crypto';
import type { ChatConnection, ChatPlatform, Incoming, IncomingFile } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { same } from '../verify.ts';

const INGEST = 'https://api.novu.co/v1/agents/events/ingest';
const MAX_AGE_MS = 5 * 60 * 1000;
const MAX_SKEW_MS = 30 * 1000;
const Attachment = Schema.Struct({
	url: Schema.optionalKey(Schema.String),
	name: Schema.optionalKey(Schema.String),
	mimeType: Schema.optionalKey(Schema.String),
	size: Schema.optionalKey(Schema.Number)
});
const Message = Schema.Struct({
	text: Schema.String,
	platformMessageId: Schema.String,
	author: Schema.Struct({
		userId: Schema.String,
		fullName: Schema.String,
		isBot: Schema.Union([Schema.Boolean, Schema.Literal('unknown')])
	}),
	timestamp: Schema.String,
	attachments: Schema.optionalKey(Schema.Array(Attachment)),
	replyTo: Schema.optionalKey(
		Schema.Struct({
			messageId: Schema.String
		})
	)
});
type Message = typeof Message.Type;
const Bridge = Schema.Struct({
	event: Schema.optionalKey(Schema.String),
	conversationId: Schema.optionalKey(Schema.String),
	message: Schema.optionalKey(Schema.Union([Message, Schema.Null])),
	previousMessage: Schema.optionalKey(Schema.Union([Message, Schema.Null])),
	subscriber: Schema.optionalKey(
		Schema.Union([
			Schema.Struct({
				subscriberId: Schema.String
			}),
			Schema.Null
		])
	),
	platformContext: Schema.optionalKey(
		Schema.Struct({
			isDM: Schema.optionalKey(Schema.Boolean)
		})
	)
});
type Bridge = typeof Bridge.Type;

/** Refuses a bridge call whose `t=<ms>,v1=<hex>` header is not an HMAC of `t.body`, or that is out of its window. */
const verify = (header: string | null, body: string, secret: string) => {
	const part = (name: string) =>
		header
			?.split(',')
			.find((one) => one.startsWith(`${name}=`))
			?.slice(name.length + 1);
	const at = part('t'),
		given = part('v1'),
		age = Date.now() - Number(at);
	if (
		at === undefined ||
		given === undefined ||
		Number.isNaN(age) ||
		age > MAX_AGE_MS ||
		age < -MAX_SKEW_MS ||
		!same(given, createHmac('sha256', secret).update(`${at}.${body}`).digest('hex'))
	)
		throw new Unverified('bad signature');
};

export const novu: ChatPlatform = {
	id: 'novu',
	name: { en: 'Novu', zh: 'Novu' },
	description: {
		en: 'Slack, Teams, WhatsApp, Telegram and email through a Novu agent',
		zh: '通过 Novu 智能体接入 Slack、Teams、WhatsApp、Telegram 和电子邮件'
	},
	via: { en: 'Via Novu', zh: '通过 Novu' },
	consistency: 'webhook',
	guide: 'https://docs.novu.co',
	fields: [
		{ name: 'apiKey', label: { en: 'API key', zh: 'API 密钥' }, secret: true },
		{ name: 'agentIdentifier', label: { en: 'Agent identifier', zh: '智能体标识' } },
		{
			name: 'bridgeSecret',
			label: { en: 'Bridge secret', zh: '桥接密钥' },
			secret: true,
			optional: true
		}
	],
	async connect({ apiKey = '', agentIdentifier = '', bridgeSecret = '' }, host) {
		const ingest = (events: readonly object[]) =>
			host.fetch(INGEST, {
				method: 'POST',
				headers: { authorization: `ApiKey ${apiKey}`, 'content-type': 'application/json' },
				body: JSON.stringify({ events })
			});
		// Novu's API key has no read to prove it on. An empty batch does nothing, so only a refused credential is taken from it
		const proof = await ingest([]);
		if (proof.status === 401 || proof.status === 403)
			throw new PlatformError(`Novu answered ${proof.status}`, proof.status);
		const files = (message: Message): IncomingFile[] =>
			(message.attachments ?? []).flatMap((attachment, index) => {
				const url = attachment.url;
				if (url === undefined) return [];
				return [
					{
						name: attachment.name ?? `novu-${message.platformMessageId}-${index}`,
						mime: attachment.mimeType ?? 'application/octet-stream',
						...(attachment.size === undefined ? {} : { bytes: attachment.size }),
						fetch: async () => {
							const response = await host.fetch(url);
							if (!response.ok) throw new PlatformError('no file', response.status);
							return new Uint8Array(await response.arrayBuffer());
						}
					}
				];
			});
		const parsed = (bridge: Bridge, thread: string, message: Message): Incoming => ({
			id: message.platformMessageId,
			thread,
			sentAt: new Date(message.timestamp).toISOString(),
			from: {
				handle: bridge.subscriber?.subscriberId ?? message.author.userId,
				name: message.author.fullName
			},
			text: message.text,
			group: bridge.platformContext?.isDM !== true,
			mentioned: true,
			replyTo: message.replyTo?.messageId ?? null,
			files: files(message)
		});
		const connection: ChatConnection = {
			account: agentIdentifier,
			async deliver(request, body) {
				if (request.method === 'GET') {
					const action = new URL(request.url).searchParams.get('action');
					if (action === 'health-check') return nothing(Response.json({ status: 'ok' }));
					if (action === 'discover')
						return nothing(
							Response.json({ workflows: [], agents: [{ agentId: agentIdentifier }] })
						);
				}
				verify(request.headers.get('novu-signature'), body, bridgeSecret || apiKey);
				const bridge = await parseJson(Bridge, body),
					thread = bridge.conversationId;
				if (thread === undefined || bridge.event === undefined)
					return nothing(new Response(null, { status: 400 }));
				const message = bridge.message;
				if (bridge.event === 'onMessageDeleted') {
					const gone = message ?? bridge.previousMessage;
					return gone === null || gone === undefined
						? nothing()
						: {
								messages: [{ ...parsed(bridge, thread, gone), text: '', files: [], deleted: true }]
							};
				}
				if (message === null || message === undefined || message.author.isBot === true)
					return nothing();
				if (bridge.event === 'onMessage') return { messages: [parsed(bridge, thread, message)] };
				if (bridge.event === 'onMessageUpdated')
					return {
						messages: [
							{
								...parsed(bridge, thread, message),
								version: new Date(message.timestamp).toISOString()
							}
						]
					};
				return nothing();
			},
			async send(thread, text) {
				const messageId = `msg_${crypto.randomUUID()}`;
				const response = await ingest([
					{
						version: 1,
						conversationId: thread,
						agentId: agentIdentifier,
						runId: `run_${crypto.randomUUID()}`,
						turnId: `turn_${crypto.randomUUID()}`,
						sequence: 1,
						timestamp: new Date().toISOString(),
						event: {
							type: 'message',
							role: 'assistant',
							messageId,
							content: { markdown: text }
						}
					}
				]);
				if (!response.ok)
					throw new PlatformError(`Novu answered ${response.status}`, response.status);
				return { id: messageId };
			}
		};
		return connection;
	}
};
