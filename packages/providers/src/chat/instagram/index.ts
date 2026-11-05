// Instagram Direct through the Instagram API with Instagram Login. Webhooks only: no history read and no dedupe key on a
// send are known here. Every conversation is one person's, so the thread is their id.
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { appFields, filesOf, graph, messaging, pieces, verified, type Attachment } from '../meta.ts';

const API = 'https://graph.instagram.com/v26.0';
const BYTES = 1000;
type Event = {
	readonly sender: { readonly id: string };
	readonly timestamp: number;
	readonly message?: {
		readonly mid: string;
		readonly text?: string;
		readonly is_echo?: boolean;
		readonly is_deleted?: boolean;
		readonly attachments?: readonly Attachment[];
		readonly reply_to?: { readonly mid?: string };
	};
};

const parse = ({ sender, timestamp, message }: Event, fetch: typeof globalThis.fetch): Incoming | null => {
	if (message === undefined || message.is_echo === true) return null;
	const base = {
		id: message.mid,
		thread: sender.id,
		sentAt: new Date(timestamp).toISOString(),
		from: { handle: sender.id, name: null }
	};
	if (message.is_deleted === true) return { ...base, text: '', deleted: true };
	const files = filesOf(message.attachments, fetch),
		text = message.text ?? '',
		replyTo = message.reply_to?.mid;
	if (text === '' && files.length === 0) return null;
	return { ...base, text, files, ...(replyTo === undefined ? {} : { replyTo }) };
};

export const instagram: ChatPlatform = {
	id: 'instagram',
	name: { en: 'Instagram', zh: 'Instagram' },
	description: { en: 'Instagram Direct messages', zh: 'Instagram 私信' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'webhook',
	icon: 'simple-icons:instagram',
	guide: 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api',
	fields: [
		{ name: 'accessToken', label: { en: 'Access token', zh: '访问令牌' }, secret: true },
		...appFields,
		{ name: 'accountId', label: { en: 'Account ID', zh: '账号 ID' } }
	],
	async connect({ accessToken = '', appSecret = '', verifyToken = '', accountId = '' }, host) {
		const auth = { authorization: `Bearer ${accessToken}` };
		const profile = await graph<{ readonly name?: string; readonly username?: string }>(
			host.fetch,
			`${API}/${accountId}?fields=id,name,username`,
			auth
		);
		const post = (body: object) =>
			graph<{ readonly message_id: string }>(host.fetch, `${API}/${accountId}/messages`, auth, body);
		const connection: ChatConnection = {
			account: profile.username ?? profile.name ?? accountId,
			async deliver(request, body) {
				const handshake = verified(request, body, verifyToken, appSecret);
				if (handshake !== null) return handshake;
				return {
					messages: messaging<Event>(body, 'instagram').flatMap(
						(event) => parse(event, host.fetch) ?? []
					)
				};
			},
			async send(thread, text) {
				let id = '';
				for (const piece of pieces(text, BYTES, Buffer.byteLength))
					({ message_id: id } = await post({
						recipient: { id: thread },
						message: { text: piece },
						messaging_type: 'RESPONSE'
					}));
				return { id };
			},
			typing: async (thread, on) => {
				if (on) await post({ recipient: { id: thread }, sender_action: 'typing_on' });
			}
		};
		return connection;
	}
};
