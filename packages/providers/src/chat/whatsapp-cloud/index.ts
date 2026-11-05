// WhatsApp Business Cloud, Meta's own API. Webhooks only: it offers no message history and no dedupe key on a send. Its
// typing indicator answers one inbound message, which would take a message id per thread, so it is left out.
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { appFields, download, graph, pieces, verified } from '../meta.ts';

const API = 'https://graph.facebook.com/v25.0';
const LIMIT = 4096;
const MEDIA = ['image', 'document', 'audio', 'video', 'voice', 'sticker'] as const;
/** Where a media URL may point: the access token is sent to it. */
const MEDIA_HOST = /(^|\.)(fbcdn\.net|fbsbx\.com)$|^graph\.facebook\.com$/;
/** A business-scoped user id, for someone who shares no phone number. */
const SCOPED_USER = /^[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/;
type Media = {
	readonly id: string;
	readonly mime_type: string;
	readonly caption?: string;
	readonly filename?: string;
};
type Inbound = Partial<Record<(typeof MEDIA)[number], Media>> & {
	readonly id: string;
	readonly timestamp: string;
	readonly from?: string;
	readonly from_user_id?: string;
	readonly text?: { readonly body: string };
	readonly context?: { readonly id?: string };
};
type Contact = {
	readonly wa_id?: string;
	readonly user_id?: string;
	readonly profile?: { readonly name?: string };
};
type Hook = {
	readonly entry?: readonly {
		readonly changes?: readonly {
			readonly field: string;
			readonly value: {
				readonly metadata?: { readonly phone_number_id?: string };
				readonly contacts?: readonly Contact[];
				readonly messages?: readonly Inbound[];
			};
		}[];
	}[];
};

const parse = (
	message: Inbound,
	contacts: readonly Contact[],
	content: (id: string) => Promise<Uint8Array>
): Incoming | null => {
	const user = message.from ?? message.from_user_id;
	const media = MEDIA.flatMap((kind) => {
		const one = message[kind];
		return one === undefined ? [] : [{ ...one, kind }];
	});
	const text = message.text?.body ?? media[0]?.caption ?? '';
	if (user === undefined || (text === '' && media.length === 0)) return null;
	const contact = contacts.find((one) => one.wa_id === user || one.user_id === user),
		replyTo = message.context?.id;
	return {
		id: message.id,
		thread: user,
		sentAt: new Date(Number(message.timestamp) * 1000).toISOString(),
		from: { handle: user, name: contact?.profile?.name ?? null },
		text,
		...(replyTo === undefined ? {} : { replyTo }),
		files: media.map((one) => ({
			name: one.filename ?? one.kind,
			mime: one.mime_type,
			fetch: () => content(one.id)
		}))
	};
};

export const whatsappCloud: ChatPlatform = {
	id: 'whatsapp-cloud',
	driver: 'whatsapp',
	name: { en: 'WhatsApp Business Cloud', zh: 'WhatsApp Business Cloud' },
	description: { en: "Meta's official WhatsApp API", zh: 'Meta 官方 WhatsApp API' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'webhook',
	icon: 'simple-icons:whatsapp',
	guide: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
	fields: [
		{ name: 'accessToken', label: { en: 'Access token', zh: '访问令牌' }, secret: true },
		...appFields,
		{ name: 'phoneNumberId', label: { en: 'Phone number ID', zh: '电话号码 ID' } }
	],
	async connect({ accessToken = '', appSecret = '', verifyToken = '', phoneNumberId = '' }, host) {
		const auth = { authorization: `Bearer ${accessToken}` };
		const call = <A>(path: string, body?: object) =>
			graph<A>(host.fetch, `${API}/${path}`, auth, body);
		await call(`${phoneNumberId}/whatsapp_business_profile`);
		const content = async (id: string) => {
			const { url } = await call<{ readonly url: string }>(id);
			const target = new URL(url);
			if (target.protocol !== 'https:' || !MEDIA_HOST.test(target.hostname))
				throw new Error('a media URL off Meta’s hosts gets no token');
			return download(host.fetch, url, auth);
		};
		const connection: ChatConnection = {
			account: phoneNumberId,
			async deliver(request, body) {
				const handshake = verified(request, body, verifyToken, appSecret);
				if (handshake !== null) return handshake;
				const { entry = [] } = JSON.parse(body) as Hook;
				// one app can serve several numbers: another number's message is not this link's to answer
				const changes = entry
					.flatMap((one) => one.changes ?? [])
					.filter(
						({ field, value }) =>
							field === 'messages' && value.metadata?.phone_number_id === phoneNumberId
					);
				return {
					messages: changes.flatMap(({ value }) =>
						(value.messages ?? []).flatMap(
							(message) => parse(message, value.contacts ?? [], content) ?? []
						)
					)
				};
			},
			async send(thread, text) {
				let id: string | undefined;
				for (const piece of pieces(text, LIMIT)) {
					const sent = await call<{ readonly messages?: readonly { readonly id: string }[] }>(
						`${phoneNumberId}/messages`,
						{
							messaging_product: 'whatsapp',
							recipient_type: 'individual',
							...(SCOPED_USER.test(thread) ? { recipient: thread } : { to: thread }),
							type: 'text',
							text: { preview_url: false, body: piece }
						}
					);
					id = sent.messages?.[0]?.id;
				}
				if (id === undefined) throw new Error('WhatsApp answered no message id');
				return { id };
			}
		};
		return connection;
	}
};
