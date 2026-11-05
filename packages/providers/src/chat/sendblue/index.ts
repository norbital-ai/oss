// iMessage through Sendblue, with Sendblue's own SDK. A direct thread is the contact's number; a group's is `group:<id>`,
// which no E.164 number can be. Sendblue shows no dedupe key on a send and no edit or unsend event, and its event stream
// calls itself no replay log, so repair is reading a thread back.
import type SendblueAPI from 'sendblue';
import type { ChatConnection, ChatPlatform, Incoming, IncomingFile } from '../adapter.ts';
import { nothing, PlatformError } from '../adapter.ts';
import { signed } from '../verify.ts';

type Raw = SendblueAPI.MessageListResponse.Data;
type Download = (url: string) => Promise<Uint8Array>;

const GROUP = 'group:',
	HISTORY_PAGES = 20;
const IMAGES: Readonly<Record<string, string>> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	heic: 'image/heic',
	webp: 'image/webp'
};

/** `media_url` is a link, or the file itself as a data URL. */
const fileOf = (url: string, download: Download): IncomingFile => {
	const inline = /^data:([^;,]+)/.exec(url)?.[1];
	const name = inline === undefined ? (url.split(/[?#]/)[0]?.split('/').pop() ?? '') : '';
	return {
		name: name || 'attachment',
		mime:
			inline ?? IMAGES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream',
		fetch: async () =>
			inline === undefined
				? download(url)
				: new Uint8Array(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))
	};
};

/** A person's message to `line`: an account's lines can share one webhook, and a reaction is no message. */
const parse = (raw: Raw, line: string, download: Download): Incoming | null => {
	const { message_handle: id, from_number: from, date_sent: sentAt, group_id: group } = raw;
	if (id === undefined || from === undefined || sentAt === undefined) return null;
	if (raw.is_outbound === true || raw.is_reaction === true || raw.status !== 'RECEIVED')
		return null;
	if (raw.sendblue_number != null && raw.sendblue_number !== line) return null;
	return {
		id,
		thread: group ? `${GROUP}${group}` : from,
		sentAt,
		from: { handle: from, name: null },
		text: raw.content ?? '',
		group: Boolean(group),
		title: raw.group_display_name ?? null,
		replyTo: raw.reply_to?.message_handle ?? null,
		...(raw.media_url ? { files: [fileOf(raw.media_url, download)] } : {})
	};
};

export const sendblue: ChatPlatform = {
	id: 'sendblue',
	name: { en: 'iMessage (Sendblue)', zh: 'iMessage（Sendblue）' },
	description: { en: 'iMessage, SMS and RCS', zh: 'iMessage、短信和 RCS' },
	via: { en: 'Via Sendblue', zh: '通过 Sendblue' },
	consistency: 'history',
	guide: 'https://docs.sendblue.com',
	fields: [
		{ name: 'apiKey', label: { en: 'API key', zh: 'API 密钥' }, secret: true },
		{ name: 'apiSecret', label: { en: 'API secret', zh: 'API Secret' }, secret: true },
		{ name: 'fromNumber', label: { en: 'From number', zh: '发送号码' } },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true }
	],
	async connect({ apiKey = '', apiSecret = '', fromNumber = '', webhookSecret = '' }, host) {
		const { default: Sendblue } = await import('sendblue');
		// a send has no dedupe key, so a retry inside the SDK could deliver it twice
		const client = new Sendblue({ apiKey, apiSecret, fetch: host.fetch, maxRetries: 0 });
		await client.lines.getState();
		const refused = (error: unknown): never => {
			if (error instanceof Sendblue.APIError && error.status !== undefined)
				throw new PlatformError(
					error.message,
					error.status,
					Number(error.headers?.get('retry-after')) * 1000 || undefined
				);
			throw error;
		};
		const download: Download = async (url) => {
			const response = await host.fetch(url);
			if (!response.ok) throw new PlatformError('Sendblue media', response.status);
			return new Uint8Array(await response.arrayBuffer());
		};
		const connection: ChatConnection = {
			account: fromNumber,
			async deliver(request, body) {
				signed(request.headers.get('sb-signing-secret'), webhookSecret);
				const message = parse(JSON.parse(body) as Raw, fromNumber, download);
				if (message === null) return nothing();
				const repliedTo =
					message.group === true &&
					typeof message.replyTo === 'string' &&
					(await client.messages.retrieve(message.replyTo).then(
						(found) => found.data?.is_outbound === true,
						() => false
					));
				return { messages: [{ ...message, repliedTo }] };
			},
			async send(thread, text, key) {
				const sent = await (
					thread.startsWith(GROUP)
						? client.groups.sendMessage({
								from_number: fromNumber,
								group_id: thread.slice(GROUP.length),
								content: text
							})
						: client.messages.send({ from_number: fromNumber, number: thread, content: text })
				).catch(refused);
				if (sent.status === 'ERROR') throw new PlatformError(sent.error_message ?? 'refused', 400);
				return { id: sent.message_handle ?? key };
			},
			// Sendblue has no typing indicator in a group
			typing: async (thread, on) => {
				if (!thread.startsWith(GROUP))
					await client.typingIndicators.send({
						from_number: fromNumber,
						number: thread,
						state: on ? 'start' : 'stop'
					});
			},
			async history(thread, since) {
				const group = thread.startsWith(GROUP),
					messages: Incoming[] = [];
				let offset = 0;
				for (let page = 0; page < HISTORY_PAGES; page++) {
					const { data = [], pagination } = await client.messages.list({
						...(group
							? { group_id: thread.slice(GROUP.length), message_type: 'group' as const }
							: { number: thread, message_type: 'message' as const }),
						sendblue_number: fromNumber,
						is_outbound: 'false',
						sent_at_gte: since,
						order_by: 'sentAt',
						order_direction: 'asc',
						limit: 100,
						offset
					});
					messages.push(...data.flatMap((raw) => parse(raw, fromNumber, download) ?? []));
					offset += data.length;
					if (data.length === 0 || pagination?.hasMore === false)
						return { messages, complete: true };
				}
				return { messages, complete: false };
			}
		};
		return connection;
	}
};
