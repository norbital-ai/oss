// iMessage and SMS through Linq, with Linq's own SDK. A webhook subscription must use `webhook_version: "2026-02-03"`
// (`?version=2026-02-03` on its URL): only that version has `message.edited` and the payload parsed here. Linq sends no
// delete event. `to:<handle>` is a person with no chat yet, since Linq creates a chat only with its first message.
import type { Message } from '@linqapp/sdk/resources/messages/messages';
import type {
	MessageEditedWebhookEvent,
	MessageEventV2,
	UnwrapWebhookEvent
} from '@linqapp/sdk/resources/webhooks';
import type { ChatConnection, ChatPlatform, Incoming, IncomingFile } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';

type Part = MessageEventV2['parts'][number] | NonNullable<Message['parts']>[number];

const NEW = 'to:',
	HISTORY_MAX = 500;

const contentOf = (parts: readonly Part[], download: (url: string) => Promise<Uint8Array>) => ({
	text: parts
		.flatMap((part) => (part.type === 'text' || part.type === 'link' ? [part.value] : []))
		.join('\n'),
	files: parts.flatMap((part): IncomingFile[] =>
		part.type === 'media'
			? [
					{
						name: part.filename,
						mime: part.mime_type,
						bytes: part.size_bytes,
						fetch: () => download(part.url)
					}
				]
			: []
	)
});

export const linq: ChatPlatform = {
	id: 'linq',
	name: { en: 'iMessage (Linq)', zh: 'iMessage（Linq）' },
	description: { en: 'iMessage and SMS', zh: 'iMessage 和短信' },
	via: { en: 'Via Linq', zh: '通过 Linq' },
	consistency: 'history',
	idempotent: true,
	guide: 'https://docs.linqapp.com',
	fields: [
		{ name: 'apiKey', label: { en: 'API key', zh: 'API 密钥' }, secret: true },
		{
			name: 'signingSecret',
			label: { en: 'Webhook signing secret', zh: 'Webhook 签名密钥' },
			secret: true
		}
	],
	async connect({ apiKey = '', signingSecret = '' }, host) {
		const { LinqAPIV3 } = await import('@linqapp/sdk');
		const client = new LinqAPIV3({ apiKey, webhookSecret: signingSecret, fetch: host.fetch });
		const { phone_numbers: numbers } = await client.phoneNumbers.list();
		const refused = (error: unknown): never => {
			if (error instanceof LinqAPIV3.APIError && error.status !== undefined)
				throw new PlatformError(
					error.message,
					error.status,
					Number(error.headers?.get('retry-after')) * 1000 || undefined
				);
			throw error;
		};
		const download = async (url: string) => {
			const response = await host.fetch(url);
			if (!response.ok) throw new PlatformError('Linq media', response.status);
			return new Uint8Array(await response.arrayBuffer());
		};
		const received = async (data: MessageEventV2, sentAt: string): Promise<Incoming> => {
			const group = data.chat.is_group ?? (await client.chats.retrieve(data.chat.id)).is_group,
				replyTo = data.reply_to?.message_id ?? null,
				owner = data.chat.owner_handle?.handle;
			return {
				id: data.id,
				thread: data.chat.id,
				sentAt,
				from: { handle: data.sender_handle.handle, name: null },
				group,
				replyTo,
				mentioned: data.parts.some(
					(part) => part.type === 'text' && part.mention != null && part.mention === owner
				),
				repliedTo:
					group &&
					replyTo !== null &&
					(await client.messages.retrieve(replyTo).then(
						(found) => found.is_from_me,
						() => false
					)),
				...contentOf(data.parts, download)
			};
		};
		const connection: ChatConnection = {
			account: numbers[0]?.phone_number ?? null,
			async deliver(request, body) {
				let event: UnwrapWebhookEvent;
				try {
					event = client.webhooks.unwrap(body, { headers: Object.fromEntries(request.headers) });
				} catch {
					throw new Unverified('bad signature');
				}
				if (event.event_type === 'message.edited') {
					const data = event.data as MessageEditedWebhookEvent.Data;
					if (data.direction !== 'inbound') return nothing();
					return {
						messages: [
							{
								id: data.id,
								thread: data.chat.id,
								sentAt: data.edited_at,
								version: data.edited_at,
								from: { handle: data.sender_handle.handle, name: null },
								text: data.part.text,
								group: data.chat.is_group === true
							}
						]
					};
				}
				if (event.event_type !== 'message.received') return nothing();
				const data = event.data as MessageEventV2;
				if (data.direction !== 'inbound') return nothing();
				return { messages: [await received(data, data.sent_at ?? event.created_at)] };
			},
			async send(thread, text, key) {
				const message = { parts: [{ type: 'text' as const, value: text }], idempotency_key: key };
				const sent = await (
					thread.startsWith(NEW)
						? client.messages.create({ to: [thread.slice(NEW.length)], message })
						: client.chats.messages.send(thread, { message })
				).catch(refused);
				return { id: sent.message.id };
			},
			typing: async (thread, on) => {
				await (on ? client.chats.typing.start(thread) : client.chats.typing.stop(thread));
			},
			openDirect: async (user) => `${NEW}${user}`,
			// the list takes no instant and names no order, so the thread is walked, up to a bound
			async history(thread, since) {
				const { is_group: group } = await client.chats.retrieve(thread),
					from = Date.parse(since),
					messages: Incoming[] = [];
				let seen = 0;
				for await (const message of client.chats.messages.list(thread)) {
					if (++seen > HISTORY_MAX) return { messages, complete: false };
					const sentAt = message.sent_at ?? message.created_at;
					if (message.is_from_me || Date.parse(sentAt) < from) continue;
					messages.push({
						id: message.id,
						thread,
						sentAt,
						from: { handle: message.from_handle?.handle ?? '', name: null },
						group,
						replyTo: message.reply_to?.message_id ?? null,
						...contentOf(message.parts ?? [], download)
					});
				}
				return { messages, complete: true };
			}
		};
		return connection;
	}
};
