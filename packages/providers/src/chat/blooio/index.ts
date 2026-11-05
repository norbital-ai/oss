// iMessage, RCS and SMS through Blooio's REST API; it publishes no SDK. A direct thread is the contact, a group's is
// `group:<id>`. Blooio shows no dedupe key on a send and no edit or unsend event.
import type { ChatConnection, ChatPlatform, Incoming, IncomingFile } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { hmac, signed } from '../verify.ts';

type Delivered = {
	readonly event?: string;
	readonly message_id: string;
	readonly text?: string | null;
	readonly attachments?: readonly string[] | null;
	readonly timestamp: number;
	readonly received_at?: number;
	readonly sender: string;
	readonly is_group: boolean;
	readonly group_id: string | null;
	readonly group_name: string | null;
	readonly participants: readonly { identifier: string; name: string | null }[] | null;
};
type Row = {
	readonly message_id: string;
	readonly sender: string;
	readonly text: string | null;
	readonly attachments: readonly (string | { url?: string })[];
	readonly time_sent: number;
};
type Page = {
	readonly messages: readonly Row[];
	readonly pagination: { readonly total: number };
};
type Me = { readonly devices: readonly { phone_number: string }[] };

const API = 'https://backend.blooio.com/v2/api',
	GROUP = 'group:',
	TOLERANCE_S = 300,
	HISTORY_PAGES = 20;
const IMAGES: Readonly<Record<string, string>> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	heic: 'image/heic',
	webp: 'image/webp'
};
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
			const response = await host.fetch(`${API}${path}`, {
				...init,
				headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
			});
			if (!response.ok)
				throw new PlatformError(
					`${response.status}: ${await response.text()}`,
					response.status,
					Number(response.headers.get('retry-after')) * 1000 || undefined
				);
			return response;
		};
		const me = (await (await call('/me')).json()) as Me;
		const fileOf = (url: string): IncomingFile => {
			const name = url.split(/[?#]/)[0]?.split('/').pop() ?? '';
			return {
				name: name || 'attachment',
				mime: IMAGES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream',
				fetch: async () => {
					const response = await host.fetch(url);
					if (!response.ok) throw new PlatformError('Blooio media', response.status);
					return new Uint8Array(await response.arrayBuffer());
				}
			};
		};
		const connection: ChatConnection = {
			account: fromNumber || (me.devices[0]?.phone_number ?? null),
			async deliver(request, body) {
				const signature = new URLSearchParams(
					request.headers.get('x-blooio-signature')?.replaceAll(',', '&')
				);
				const at = signature.get('t') ?? '';
				if (!(Math.abs(Date.now() / 1000 - Number(at)) <= TOLERANCE_S))
					throw new Unverified('stale timestamp');
				signed(signature.get('v1'), hmac(webhookSecret, `${at}.${body}`, 'hex'));
				const message = JSON.parse(body) as Delivered;
				if ((request.headers.get('x-blooio-event') ?? message.event) !== 'message.received')
					return nothing();
				const group = message.is_group && message.group_id !== null;
				return {
					messages: [
						{
							id: message.message_id,
							thread: group ? `${GROUP}${message.group_id}` : message.sender,
							sentAt: new Date(message.received_at ?? message.timestamp).toISOString(),
							from: {
								handle: message.sender,
								name:
									message.participants?.find((one) => one.identifier === message.sender)?.name ??
									null
							},
							text: message.text ?? '',
							group,
							title: message.group_name,
							files: (message.attachments ?? []).map(fileOf)
						}
					]
				};
			},
			async send(thread, text) {
				const response = await call(`/chats/${chatOf(thread)}/messages`, {
					method: 'POST',
					body: JSON.stringify({ text, ...(fromNumber ? { from_number: fromNumber } : {}) })
				});
				return { id: ((await response.json()) as { message_id: string }).message_id };
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
					const { messages: rows, pagination } = (await response.json()) as Page;
					for (const row of rows) {
						if (row.time_sent < from) return { messages, complete: true };
						messages.push({
							id: row.message_id,
							thread,
							sentAt: new Date(row.time_sent).toISOString(),
							from: { handle: row.sender, name: null },
							text: row.text ?? '',
							group,
							files: row.attachments.flatMap((one) => {
								const url = typeof one === 'string' ? one : one.url;
								return url ? [fileOf(url)] : [];
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
