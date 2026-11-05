// Direct messages on the social accounts connected to Zernio, one key for all of them. A thread is the account and its
// conversation, the two every call names. Post comments are left out: nothing shows how one is answered.
import type { ChatConnection, ChatPlatform, Incoming, IncomingFile } from '../adapter.ts';
import { nothing, PlatformError } from '../adapter.ts';
import { hmac, signed } from '../verify.ts';

const API = 'https://zernio.com/api';
const PAGE = 100;
type Attachment = { readonly type: string; readonly url?: string };
type Inbound = {
	readonly id: string;
	readonly conversationId: string;
	readonly platformMessageId?: string;
	readonly direction: 'incoming' | 'outgoing';
	readonly text?: string | null;
	readonly attachments?: readonly Attachment[];
	readonly sender: { readonly id: string; readonly name?: string; readonly username?: string };
	readonly sentAt: string;
};
type Webhook = {
	readonly event?: string;
	readonly message: Inbound;
	readonly account: { readonly id: string };
	readonly metadata?: { readonly quotedMessageId?: string };
};
/** A message as the list endpoint flattens it: its body in `message`, its sender in `senderId`. */
type Listed = {
	readonly id: string;
	readonly platformMessageId?: string;
	readonly direction: 'incoming' | 'outgoing';
	readonly message?: string | null;
	readonly text?: string | null;
	readonly senderId?: string;
	readonly senderName?: string;
	readonly sentAt?: string;
	readonly createdAt?: string;
};
type Page = {
	readonly messages?: readonly Listed[];
	readonly pagination?: { readonly nextCursor?: string | null };
	readonly sortOrderApplied?: 'asc' | 'desc';
};

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
		const call = async <A>(path: string, body?: object): Promise<A> => {
			const response = await host.fetch(`${API}${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					authorization: `Bearer ${apiKey}`,
					'content-type': 'application/json'
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			});
			if (response.ok) return response.json();
			const after = Number(response.headers.get('retry-after'));
			throw new PlatformError(
				`${path} answered ${response.status}`,
				response.status,
				after > 0 ? after * 1000 : undefined
			);
		};
		await call('/v1/inbox/conversations?limit=1');
		const file = (id: string, attachment: Attachment, index: number): IncomingFile[] => {
			const url = attachment.url;
			if (url === undefined || url === '') return [];
			const media = ['image', 'video', 'audio'].includes(attachment.type);
			return [
				{
					name: `zernio-${id}-${index}`,
					mime: media ? `${attachment.type}/*` : 'application/octet-stream',
					fetch: async () => {
						const response = await host.fetch(url);
						if (!response.ok) throw new PlatformError('no file', response.status);
						return new Uint8Array(await response.arrayBuffer());
					}
				}
			];
		};
		const inbound = ({ message, account, metadata }: Webhook): Incoming => {
			const id = message.platformMessageId || message.id;
			return {
				id,
				thread: `${account.id}:${message.conversationId}`,
				sentAt: message.sentAt,
				from: {
					handle: message.sender.id,
					name: message.sender.name ?? message.sender.username ?? null
				},
				text: message.text ?? '',
				replyTo: metadata?.quotedMessageId ?? null,
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
				const payload = JSON.parse(body) as Webhook;
				return payload.event === 'message.received' && payload.message.direction === 'incoming'
					? { messages: [inbound(payload)] }
					: nothing();
			},
			async send(thread, text) {
				const { accountId, conversation } = split(thread);
				const { data }: { data?: { messageId?: string; id?: string } } = await call(
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
				await call(`/v1/inbox/conversations/${conversation}/typing`, { accountId });
			},
			async history(thread, since) {
				const { accountId, conversation } = split(thread),
					from = Date.parse(since),
					messages: Incoming[] = [];
				for (let cursor: string | null | undefined; ; ) {
					const query = new URLSearchParams({
						accountId,
						limit: String(PAGE),
						sortOrder: 'desc',
						...(cursor === undefined || cursor === null ? {} : { cursor })
					});
					const page = await call<Page>(`/v1/inbox/conversations/${conversation}/messages?${query}`);
					const rows = page.messages ?? [],
						at = (row: Listed) => Date.parse(row.sentAt ?? row.createdAt ?? '');
					for (const row of rows)
						if (row.direction === 'incoming' && at(row) >= from)
							messages.push({
								id: row.platformMessageId ?? row.id,
								thread,
								sentAt: new Date(at(row)).toISOString(),
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
