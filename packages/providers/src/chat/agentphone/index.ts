// SMS and iMessage through AgentPhone's REST API; it publishes no SDK. Every thread is a person's number. All its source
// shows is a send and a reaction: no read, history, typing, dedupe key, edit or delete. Call and reaction events carry
// no chat message.
import type { ChatConnection, ChatPlatform, IncomingFile } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { hmac, signed } from '../verify.ts';

type Delivered = {
	readonly event: string;
	readonly data: {
		readonly messageId: string;
		readonly from: string;
		readonly contact: { readonly name: string | null } | null;
		readonly message: string;
		readonly mediaUrls?: readonly string[];
		readonly direction: 'inbound' | 'outbound';
		readonly receivedAt: string;
	};
};

const API = 'https://api.agentphone.ai',
	TEXT_MAX = 1600,
	TOLERANCE_S = 300;
const IMAGES: Readonly<Record<string, string>> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	heic: 'image/heic',
	webp: 'image/webp'
};

export const agentphone: ChatPlatform = {
	id: 'agentphone',
	name: { en: 'AgentPhone', zh: 'AgentPhone' },
	description: { en: 'SMS and iMessage', zh: '短信和 iMessage' },
	via: { en: 'Via AgentPhone', zh: '通过 AgentPhone' },
	consistency: 'webhook',
	guide: 'https://docs.agentphone.to',
	fields: [
		{ name: 'apiKey', label: { en: 'API key', zh: 'API 密钥' }, secret: true },
		{ name: 'agentId', label: { en: 'Agent ID', zh: '智能体 ID' } },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true }
	],
	async connect({ apiKey = '', agentId = '', webhookSecret = '' }, host) {
		const post = (to: string, text: string) =>
			host.fetch(`${API}/v1/messages`, {
				method: 'POST',
				headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
				body: JSON.stringify({ agent_id: agentId, to_number: to, body: text })
			});
		// ponytail: no read endpoint is visible, so a send to nobody, which cannot deliver, proves the key and the agent.
		// A server that validates the body before the key would let a bad key through; use a read if one is published.
		const probe = await post('', '');
		if ([401, 403, 404].includes(probe.status))
			throw new PlatformError(`${probe.status}: ${await probe.text()}`, probe.status);
		const fileOf = (url: string): IncomingFile => {
			const name = url.split(/[?#]/)[0]?.split('/').pop() ?? '';
			return {
				name: name || 'attachment',
				mime: IMAGES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream',
				fetch: async () => {
					const response = await host.fetch(url);
					if (!response.ok) throw new PlatformError('AgentPhone media', response.status);
					return new Uint8Array(await response.arrayBuffer());
				}
			};
		};
		const connection: ChatConnection = {
			account: agentId,
			async deliver(request, body) {
				const at = request.headers.get('x-webhook-timestamp') ?? '';
				if (!(Math.abs(Date.now() / 1000 - Number(at)) <= TOLERANCE_S))
					throw new Unverified('stale timestamp');
				signed(
					request.headers.get('x-webhook-signature'),
					`sha256=${hmac(webhookSecret, `${at}.${body}`, 'hex')}`
				);
				const { event, data } = JSON.parse(body) as Delivered;
				if (event !== 'agent.message' || data.direction !== 'inbound') return nothing();
				return {
					messages: [
						{
							id: data.messageId,
							thread: data.from,
							sentAt: data.receivedAt,
							from: { handle: data.from, name: data.contact?.name ?? null },
							text: data.message,
							files: (data.mediaUrls ?? []).map(fileOf)
						}
					]
				};
			},
			async send(thread, text) {
				const response = await post(thread, text.slice(0, TEXT_MAX));
				if (!response.ok)
					throw new PlatformError(
						`${response.status}: ${await response.text()}`,
						response.status,
						Number(response.headers.get('retry-after')) * 1000 || undefined
					);
				return { id: ((await response.json()) as { id: string }).id };
			}
		};
		return connection;
	}
};
