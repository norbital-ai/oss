// SMS and iMessage through Dial, with Dial's own SDK, which calls the global `fetch`. Every thread is a person's number.
// Dial shows no dedupe key on a message send and no edit or delete event. Call events carry no chat message.
import type { DialEvent, Message, MessageEvent } from '@getdial/sdk';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';

/** The adapter Dial publishes reads these two from a delivery; its SDK's event type has not caught up. */
type Received = MessageEvent['data'] & Pick<Message, 'replyToId' | 'reaction'>;

const TEXT_MAX = 1600;

/** The SDK folds a refusal into its message: this gets the status back, which decides whether a send retries. */
const refused = (error: Error): never => {
	const status = /^Dial API error (\d+):/.exec(error.message)?.[1];
	throw status === undefined ? error : new PlatformError(error.message, Number(status));
};

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
		const { DialClient, verifyDialSignature } = await import('@getdial/sdk');
		const client = new DialClient({ apiKey });
		const own = (await client.listNumbers()).find((number) => number.id === fromNumberId);
		if (own === undefined) throw new Error(`${fromNumberId} is not a number of this account`);
		const parse = (
			message: Pick<Received, 'from' | 'body' | 'media' | 'replyToId'> & { readonly id: string },
			sentAt: string
		): Incoming => ({
			id: message.id,
			thread: message.from,
			sentAt,
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
				const event = JSON.parse(body) as DialEvent;
				if (event.type !== 'message.received') return nothing();
				const data: Received = event.data;
				if (data.reaction) return nothing();
				return { messages: [parse({ ...data, id: data.messageId }, event.createdAt)] };
			},
			async send(thread, text) {
				const sent = await client
					.sendMessage({ to: thread, fromNumberId, body: text.slice(0, TEXT_MAX) })
					.catch(refused);
				return { id: sent.id };
			},
			typing: async (thread, on) => {
				const params = { toNumber: thread, fromNumber: own.number };
				await (on ? client.startTyping(params) : client.stopTyping(params));
			},
			// the list is the whole number's and never says it stopped short, so it cannot claim the whole window
			async history(thread, since) {
				const rows = await client.listMessages({
					numberId: fromNumberId,
					direction: 'inbound',
					since
				});
				return {
					messages: rows
						.filter((row) => row.from === thread && !row.reaction)
						.map((row) => parse(row, row.createdAt)),
					complete: false
				};
			}
		};
		return connection;
	}
};
