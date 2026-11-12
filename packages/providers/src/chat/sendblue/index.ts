// iMessage through Sendblue, with Sendblue's own SDK. A direct thread is the contact's number; a group's is `group:<id>`,
// which no E.164 number can be. Sendblue shows no dedupe key on a send and no edit or unsend event, and its event stream
// calls itself no replay log, so repair is reading a thread back.
import { Schema } from 'effect';
import { parse as parseJson, fileOf } from '../http.ts';
import type { ChatConnection, ChatHost, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError } from '../adapter.ts';
import { signed } from '../verify.ts';

const Raw = Schema.Struct({
	message_handle: Schema.optionalKey(Schema.String),
	from_number: Schema.optionalKey(Schema.String),
	date_sent: Schema.optionalKey(Schema.String),
	group_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	is_outbound: Schema.optionalKey(Schema.Boolean),
	is_reaction: Schema.optionalKey(Schema.Boolean),
	status: Schema.optionalKey(Schema.String),
	sendblue_number: Schema.optionalKey(Schema.NullOr(Schema.String)),
	content: Schema.optionalKey(Schema.NullOr(Schema.String)),
	group_display_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	reply_to: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({ message_handle: Schema.optionalKey(Schema.NullOr(Schema.String)) })
		)
	),
	media_url: Schema.optionalKey(Schema.NullOr(Schema.String))
});
type Raw = typeof Raw.Type;

const GROUP = 'group:',
	HISTORY_PAGES = 20;
/** A person's message to `line`: an account's lines can share one webhook, and a reaction is no message. */
const parse = (raw: Raw, line: string, fetch: ChatHost['fetch']): Incoming | null => {
	const { message_handle: id, from_number: from, date_sent: sent_at, group_id: group } = raw;
	if (id === undefined || from === undefined || sent_at === undefined) return null;
	if (raw.is_outbound === true || raw.is_reaction === true || raw.status !== 'RECEIVED')
		return null;
	if (raw.sendblue_number != null && raw.sendblue_number !== line) return null;
	return {
		id,
		thread: group ? `${GROUP}${group}` : from,
		sent_at,
		from: { handle: from, name: null },
		text: raw.content ?? '',
		group: Boolean(group),
		title: raw.group_display_name ?? null,
		reply_to: raw.reply_to?.message_handle ?? null,
		...(raw.media_url ? { files: [fileOf(raw.media_url, fetch)] } : {})
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

		const connection: ChatConnection = {
			account: fromNumber,
			async deliver(request, body) {
				signed(request.headers.get('sb-signing-secret'), webhookSecret);
				const message = parse(await parseJson(Raw, body), fromNumber, host.fetch);
				if (message === null) return nothing();
				const replied_to =
					message.group === true &&
					typeof message.reply_to === 'string' &&
					(await client.messages.retrieve(message.reply_to).then(
						(found) => found.data?.is_outbound === true,
						() => false
					));
				return { messages: [{ ...message, replied_to }] };
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
					messages.push(...data.flatMap((raw) => parse(raw, fromNumber, host.fetch) ?? []));
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
