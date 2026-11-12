// Gmail, over its REST API, with Google's auth library for the token and for a push's JWT. A Pub/Sub push only says the
// mailbox moved: `history.list` is the log the host catches up from, with a cursor the host keeps. So a push is acknowledged
// without reading anything, and whatever it announced stays in the log until the cursor passes it.
import { Schema } from 'effect';
import type { Address, Email, Mailbox } from 'postal-mime';
import type { ChatConnection, ChatPlatform, Incoming } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
// a watch lapses after seven days, and only a watch makes Gmail push
const RENEW_MS = 86_400_000;

// ponytail: entities stay encoded in an HTML-only mail; html-to-text if they matter
const TAGS = /<(style|script)\b[\s\S]*?<\/\1>|<[^>]+>/gi;

const Text = Schema.String;
const Profile = Schema.Struct({ emailAddress: Text, historyId: Text });
const Changes = Schema.optionalKey(
	Schema.Array(Schema.Struct({ message: Schema.Struct({ id: Text, threadId: Text }) }))
);
const History = Schema.Struct({
	history: Schema.optionalKey(
		Schema.Array(Schema.Struct({ messagesAdded: Changes, messagesDeleted: Changes }))
	),
	historyId: Text,
	nextPageToken: Schema.optionalKey(Text)
});
const Message = Schema.Struct({
	id: Text,
	threadId: Text,
	internalDate: Text,
	raw: Text,
	labelIds: Schema.optionalKey(Schema.Array(Text))
});
const Thread = Schema.Struct({
	messages: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Text })))
});
const Sent = Schema.Struct({ id: Text });

const mailboxes = (list: readonly Address[] = []): readonly Mailbox[] =>
	list.flatMap((one) => (one.group === undefined ? [one] : one.group));
const addresses = (list?: readonly Address[]) =>
	mailboxes(list).map((one) => one.address.toLowerCase());
/** A 404 as nothing there: the caller says what that means. */
const absent = (error: unknown) => {
	if (error instanceof PlatformError && error.status === 404) return null;
	throw error;
};

/** `account` in To is how mail names a recipient: answering this account's message puts it there too. */
const incoming = (
	message: typeof Message.Type,
	mail: Email,
	account: string,
	bytes: (index: number) => Promise<Uint8Array>
): Incoming => {
	const [sender] = mailboxes(mail.from === undefined ? [] : [mail.from]),
		to = addresses(mail.to);
	return {
		id: message.id,
		thread: message.threadId,
		sent_at: new Date(Number(message.internalDate)).toISOString(),
		from: { handle: sender?.address.toLowerCase() ?? 'unknown', name: sender?.name || null },
		text: (mail.text || (mail.html ?? '').replace(TAGS, '')).trim(),
		group: [...to, ...addresses(mail.cc)].some((one) => one !== account),
		mentioned: to.includes(account),
		reply_to: mail.inReplyTo ?? null,
		...(mail.subject ? { title: mail.subject } : {}),
		files: mail.attachments.map((file, index) => ({
			name: file.filename ?? 'attachment',
			mime: file.mimeType,
			fetch: () => bytes(index)
		}))
	};
};
/** A deleted message's thread is gone with it, and most deletes are of mail never stored, so it goes by id alone. */
const deletion = (id: string, sent_at: string): Incoming => ({
	id,
	thread: '',
	sent_at,
	from: { handle: '', name: null },
	text: '',
	deleted: true
});

export const gmail: ChatPlatform = {
	id: 'gmail',
	name: { en: 'Gmail', zh: 'Gmail' },
	description: { en: 'A Gmail mailbox, as conversations', zh: '以会话形式使用 Gmail 邮箱' },
	via: { en: 'Official API', zh: '官方 API' },
	consistency: 'changes',
	icon: 'simple-icons:gmail',
	guide: 'https://developers.google.com/workspace/gmail/api/guides/push',
	fields: [
		{ name: 'clientId', label: { en: 'OAuth client ID', zh: 'OAuth 客户端 ID' } },
		{
			name: 'clientSecret',
			label: { en: 'OAuth client secret', zh: 'OAuth 客户端密钥' },
			secret: true
		},
		{
			name: 'refreshToken',
			label: { en: 'OAuth refresh token', zh: 'OAuth 刷新令牌' },
			secret: true
		},
		{ name: 'topicName', label: { en: 'Pub/Sub topic', zh: 'Pub/Sub 主题' } },
		{
			name: 'pushAccount',
			label: { en: 'Pub/Sub push service account', zh: 'Pub/Sub 推送服务账号' }
		}
	],
	async connect(
		{ clientId = '', clientSecret = '', refreshToken = '', topicName = '', pushAccount = '' },
		host
	) {
		const [{ OAuth2Client }, { default: PostalMime }, { default: MailComposer }] =
			await Promise.all([
				import('google-auth-library'),
				import('postal-mime'),
				import('nodemailer/lib/mail-composer')
			]);
		const google = new OAuth2Client({
			clientId,
			clientSecret,
			transporterOptions: { fetchImplementation: host.fetch }
		});
		google.setCredentials({ refresh_token: refreshToken });
		const api = async <A>(schema: Schema.Decoder<A>, path: string, body?: object) => {
			const { token } = await google.getAccessToken();
			const response = await host.fetch(`${API}/${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				...(body === undefined ? {} : { body: JSON.stringify(body) })
			});
			if (!response.ok)
				throw new PlatformError(
					`Gmail answered ${response.status}`,
					response.status,
					Number(response.headers.get('retry-after') ?? Number.NaN) * 1000 || undefined
				);
			return Schema.decodeUnknownSync(schema)(await response.json());
		};
		const read = (id: string) => api(Message, `messages/${id}?format=raw`);
		const parsed = (message: typeof Message.Type) =>
			PostalMime.parse(Buffer.from(message.raw, 'base64url'), {
				attachmentEncoding: 'arraybuffer',
				forceRfc822Attachments: true
			});
		// read again on demand, so a long catch-up holds its messages' text and not their attachments
		const attachment = (id: string) => async (index: number) => {
			const content = (await parsed(await read(id))).attachments[index]?.content;
			if (content === undefined) throw new Error('the attachment is gone');
			return typeof content === 'string' ? Buffer.from(content) : new Uint8Array(content);
		};
		const start = async () => ({
			messages: [],
			cursor: (await api(Profile, 'profile')).historyId
		});
		/** The latest mail in a thread that is not this account's own: what a reply answers. */
		const latest = async (thread: string) => {
			const { messages = [] } = await api(
				Thread,
				`threads/${thread}?format=minimal&fields=id,messages(id,threadId)`
			);
			for (const { id } of messages.toReversed()) {
				const message = await read(id);
				if (!message.labelIds?.some((label) => label === 'SENT' || label === 'DRAFT'))
					return parsed(message);
			}
			throw new PlatformError('This Gmail thread has no mail to answer', 404);
		};

		const { emailAddress } = await api(Profile, 'profile');
		const account = emailAddress.toLowerCase();
		const watch = () => api(Schema.Unknown, 'watch', { topicName });
		await watch();
		const renewal = setInterval(() => void watch().catch(() => undefined), RENEW_MS);
		renewal.unref();

		const connection: ChatConnection = {
			account,
			async deliver(request) {
				const idToken = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
				const claims =
					idToken === undefined
						? undefined
						: await google.verifyIdToken({ idToken, audience: host.webhook_url }).then(
								(ticket) => ticket.getPayload(),
								() => undefined
							);
				if (claims?.email !== pushAccount || claims.email_verified !== true)
					throw new Unverified('bad push token');
				return nothing();
			},
			async changes(cursor) {
				if (cursor === null) return start();
				const added = new Set<string>(),
					gone = new Set<string>();
				let next = cursor,
					pageToken: string | undefined;
				do {
					const query = new URLSearchParams({ startHistoryId: cursor });
					query.append('historyTypes', 'messageAdded');
					query.append('historyTypes', 'messageDeleted');
					if (pageToken !== undefined) query.set('pageToken', pageToken);
					const page = await api(History, `history?${query}`).catch(absent);
					// the cursor outlived Gmail's history: what changed in the gap cannot be read back, so the log restarts here
					if (page === null) return start();
					for (const change of page.history ?? []) {
						for (const { message } of change.messagesAdded ?? []) added.add(message.id);
						for (const { message } of change.messagesDeleted ?? []) gone.add(message.id);
					}
					next = page.historyId;
					pageToken = page.nextPageToken;
				} while (pageToken !== undefined);
				const messages: Incoming[] = [];
				for (const id of added) {
					const message = gone.has(id) ? null : await read(id).catch(absent);
					if (!message?.labelIds?.includes('INBOX') || message.labelIds.includes('SENT')) continue;
					// a mail that cannot be parsed must not hold the cursor back for good
					const mail = await parsed(message).catch(() => null);
					if (mail !== null) messages.push(incoming(message, mail, account, attachment(id)));
				}
				const now = new Date().toISOString();
				return {
					messages: [...messages, ...[...gone].map((id) => deletion(id, now))],
					cursor: next
				};
			},
			// no dedupe key: Gmail sends whatever `messages.send` is given. A thread with an @ is an address, for a first message
			async send(thread, text, _key, files) {
				const reply = thread.includes('@') ? null : await latest(thread);
				const raw = await new MailComposer({
					from: account,
					to:
						reply === null
							? thread
							: mailboxes(reply.replyTo?.length ? reply.replyTo : reply.from && [reply.from]).map(
									(one) => one.address
								),
					subject:
						reply === null ? (text.slice(0, 78).split('\n')[0] ?? '') : (reply.subject ?? ''),
					text,
					...(reply?.messageId === undefined
						? {}
						: {
								inReplyTo: reply.messageId,
								references: [...(reply.references?.match(/<[^<>\s]+>/g) ?? []), reply.messageId]
							}),
					attachments: files.map((file) => ({
						filename: file.name,
						contentType: file.mime,
						content: Buffer.from(file.bytes)
					}))
				})
					.compile()
					.build();
				const sent = await api(Sent, 'messages/send', {
					raw: raw.toString('base64url'),
					...(reply === null ? {} : { threadId: thread })
				});
				return { id: sent.id };
			},
			close: async () => clearInterval(renewal)
		};
		return connection;
	}
};
