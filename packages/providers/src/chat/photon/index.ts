// iMessage through Photon's Spectrum Cloud. Messages arrive by signed webhook; sends, typing and files go over gRPC, and
// edits, unsends and anything a webhook missed come from the durable event log. `Spectrum()` itself is not used: it hooks
// SIGINT and SIGTERM to exit the process, and its send takes no dedupe key. Its platform definition's own `lifecycle`
// makes the same clients, renews their token and closes them. Tokens and gRPC go around `host.fetch`.
import { parse as parseJson } from '../http.ts';
import { Predicate, Schema } from 'effect';
import type { imessage } from '@spectrum-ts/imessage';
import type { ChatConnection, ChatPlatform, Incoming, IncomingFile } from '../adapter.ts';
import { nothing, PlatformError, Unverified } from '../adapter.ts';
import { fresh, hmac, signed } from '../verify.ts';

type Lines = Awaited<
	ReturnType<ReturnType<typeof imessage.config>['__def']['lifecycle']['createClient']>
>;
type Line = Lines[number];
type Logged =
	ReturnType<Line['client']['events']['catchUp']> extends AsyncIterable<infer A> ? A : never;
type Content = {
	readonly type: string;
	readonly text?: string;
	readonly url?: string;
	readonly id?: string;
	readonly name?: string;
	readonly mimeType?: string;
	readonly size?: number;
	readonly content?: Content;
	readonly target?: { readonly id?: string };
	readonly items?: readonly { readonly content?: Content }[];
};
const Content: Schema.Codec<Content> = Schema.suspend(() =>
	Schema.Struct({
		type: Schema.String,
		text: Schema.optionalKey(Schema.String),
		url: Schema.optionalKey(Schema.String),
		id: Schema.optionalKey(Schema.String),
		name: Schema.optionalKey(Schema.String),
		mimeType: Schema.optionalKey(Schema.String),
		size: Schema.optionalKey(Schema.Number),
		content: Schema.optionalKey(Content),
		target: Schema.optionalKey(Schema.Struct({ id: Schema.optionalKey(Schema.String) })),
		items: Schema.optionalKey(Schema.Array(Schema.Struct({ content: Schema.optionalKey(Content) })))
	})
);
const Space = Schema.Struct({
	id: Schema.String,
	phone: Schema.optionalKey(Schema.String),
	platform: Schema.optionalKey(Schema.String)
});
type Space = typeof Space.Type;
const Envelope = Schema.Struct({
	event: Schema.String,
	space: Schema.optionalKey(Space),
	message: Schema.optionalKey(Schema.Unknown)
});
const Message = Schema.Struct({
	id: Schema.String,
	platform: Schema.optionalKey(Schema.String),
	direction: Schema.optionalKey(Schema.String),
	timestamp: Schema.optionalKey(Schema.String),
	sender: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
	space: Space,
	content: Content
});

const SHARED = 'shared',
	/** Apple's placeholder for an attachment inside a message's text. */
	OBJECT = /\uFFFC/g;
const isGroup = (chat: string) => chat.includes(';+;');
/** The text and files of a message, through its replies and multi-part groups. */
const leaves = (content: Content | undefined): readonly Content[] =>
	content === undefined
		? []
		: content.type === 'reply'
			? leaves(content.content)
			: content.type === 'group'
				? (content.items ?? []).flatMap((item) => leaves(item.content))
				: [content];
/** A permanent refusal: the SDK says when a retry cannot help. */
const refused = (error: Error): never => {
	throw Predicate.hasProperty(error, 'retryable') && error.retryable === false
		? new PlatformError(error.message, 400)
		: error;
};
/** The server no longer holds this place in its log: the SDK's `ValidationError`, by its gRPC status. */
const lostCursor = (error: unknown) =>
	Predicate.hasProperty(error, 'grpcCode') && (error.grpcCode === 3 || error.grpcCode === 9);

export const photon: ChatPlatform = {
	id: 'photon',
	name: { en: 'iMessage (Photon)', zh: 'iMessage（Photon）' },
	description: { en: 'iMessage through Photon', zh: '通过 Photon 使用 iMessage' },
	via: { en: 'Via Photon', zh: '通过 Photon' },
	consistency: 'changes',
	guide: 'https://photon.codes/docs/webhooks/overview',
	fields: [
		{ name: 'projectId', label: { en: 'Project ID', zh: '项目 ID' } },
		{ name: 'projectSecret', label: { en: 'Project secret', zh: '项目密钥' }, secret: true },
		{ name: 'webhookSecret', label: { en: 'Webhook secret', zh: 'Webhook 密钥' }, secret: true }
	],
	async connect({ projectId = '', projectSecret = '', webhookSecret = '' }) {
		const { imessage } = await import('@spectrum-ts/imessage');
		const { lifecycle } = imessage.config().__definition;
		const lines: Lines = await lifecycle.createClient({ config: {}, projectId, projectSecret });
		const [first] = lines;
		if (first === undefined) {
			await lifecycle.destroyClient?.({ client: lines });
			throw new Error('this Photon project has no iMessage line');
		}
		const streams = new Set<{ close(): Promise<void> }>();
		let closing = false;
		/** A stream `close` can end. An ended one throws, so a partial read is never taken for the whole. */
		const read = async function* <A>(stream: AsyncIterable<A> & { close(): Promise<void> }) {
			streams.add(stream);
			try {
				yield* stream;
				if (closing) throw new Error('Photon closed');
			} finally {
				streams.delete(stream);
				await stream.close();
			}
		};
		const threadOf = (chat: string, phone: string) =>
			lines.length > 1 ? `${chat}~${phone}` : chat;
		const route = (thread: string) => {
			const cut = lines.length > 1 ? thread.lastIndexOf('~') : -1,
				phone = thread.slice(cut + 1);
			return {
				chat: cut === -1 ? thread : thread.slice(0, cut),
				line: lines.find((line) => line.phone === phone) ?? first
			};
		};
		const download = async (line: Line, id: string) => {
			const chunks: Uint8Array[] = [];
			for await (const frame of read(line.client.attachments.downloadStream(id)))
				if (frame.type === 'primaryChunk') chunks.push(frame.data);
			return new Uint8Array(Buffer.concat(chunks));
		};
		const change = (event: Logged, line: Line): Incoming | null => {
			if (event.type === 'catchup.complete' || event.isFromMe) return null;
			const base = {
				thread: threadOf(event.chatGuid, line.phone),
				group: isGroup(event.chatGuid),
				from: { handle: event.actor?.address ?? '', name: null }
			};
			if (event.type === 'message.unsent')
				return {
					...base,
					id: event.messageGuid,
					sent_at: event.retractedAt.toISOString(),
					text: '',
					deleted: true
				};
			if (event.type === 'message.edited')
				return {
					...base,
					id: event.messageGuid,
					sent_at: event.editedAt.toISOString(),
					version: event.editedAt.toISOString(),
					text: event.content.text ?? ''
				};
			if (event.type !== 'message.received') return null;
			// `occurredAt` is the webhook's timestamp, so a message replayed after its delivery reads the same
			const { message } = event,
				{ content } = message;
			if (message.isFromMe || message.reaction !== undefined || message.itemType !== 'normal')
				return null;
			return {
				...base,
				id: message.guid,
				sent_at: event.occurredAt.toISOString(),
				from: { handle: message.sender?.address ?? '', name: null },
				text: content.text?.replace(OBJECT, '').trim() ?? '',
				title: message.groupTitle ?? null,
				reply_to: message.replyTargetGuid ?? message.threadOriginatorGuid ?? null,
				mentioned: content.mentions.some((mention) => mention.address === line.phone),
				files: content.attachments.map((file): IncomingFile => ({
					name: file.fileName,
					mime: file.mimeType,
					bytes: file.totalBytes,
					fetch: () => download(line, file.guid)
				}))
			};
		};
		/** Everything after `since`; without one, only where the log ends. */
		const replay = async (line: Line, since?: number) => {
			const messages: Incoming[] = [];
			for await (const event of read(line.client.events.catchUp(since))) {
				if (event.type === 'catchup.complete') return { messages, head: event.headSequence };
				const message = since === undefined ? null : change(event, line);
				if (message !== null) messages.push(message);
			}
			throw new Error('Photon ended its catch-up early');
		};
		const connection: ChatConnection = {
			account: first.phone === SHARED ? projectId : first.phone,
			async deliver(request, body) {
				const at = request.headers.get('x-spectrum-timestamp') ?? '';
				if (!fresh(at)) throw new Unverified('stale timestamp');
				signed(
					request.headers.get('x-spectrum-signature'),
					`v0=${hmac(webhookSecret, `v0:${at}:${body}`, 'hex')}`
				);
				const { event, space, message: raw } = await parseJson(Envelope, body);
				if (event !== 'messages') return nothing();
				const message = await Schema.decodeUnknownPromise(Message)(raw);
				const platform = message.platform ?? message.space.platform;
				if (message.direction === 'outbound') return nothing();
				if (platform !== undefined && platform !== 'iMessage') return nothing();
				const parts = leaves(message.content),
					text = parts
						.flatMap((part) => (part.type === 'richlink' ? [part.url] : [part.text]))
						.filter(Boolean)
						.join('\n'),
					attached = parts.filter((part) => part.type === 'attachment');
				// reactions, renames and member changes carry neither
				if (text === '' && attached.length === 0) return nothing();
				const phone = message.space.phone ?? space?.phone,
					line = lines.find((one) => one.phone === phone) ?? first,
					chat = message.space.id,
					target = message.content.type === 'reply' ? message.content.target?.id : undefined,
					reply_to = target?.replace(/^p:\d+\//, '') ?? null;
				return {
					messages: [
						{
							id: message.id,
							thread: threadOf(chat, line.phone),
							sent_at: message.timestamp ?? new Date(Number(at) * 1000).toISOString(),
							from: { handle: message.sender?.id ?? '', name: null },
							text,
							group: isGroup(chat),
							reply_to,
							replied_to:
								isGroup(chat) &&
								reply_to !== null &&
								(await line.client.messages.get(reply_to).then(
									(found) => found.isFromMe,
									() => false
								)),
							files: attached.map((file) => ({
								name: file.name ?? 'attachment',
								mime: file.mimeType ?? 'application/octet-stream',
								...(file.size === undefined ? {} : { bytes: file.size }),
								fetch: () => download(line, file.id ?? '')
							}))
						}
					]
				};
			},
			async send(thread, text, key) {
				const { chat, line } = route(thread);
				const sent = await line.client.messages
					.sendText(chat, text, { clientMessageId: key })
					.catch(refused);
				return { id: sent.guid, idempotent: true };
			},
			typing: async (thread, on) => {
				const { chat, line } = route(thread);
				await line.client.chats.setTyping(chat, on);
			},
			openDirect: async (user) => {
				if (first.phone === SHARED) return `any;-;${user}`;
				const { chat } = await first.client.chats.create([user]);
				return threadOf(chat.guid, first.phone);
			},
			// each line keeps its own log, so the cursor holds one place per line
			async changes(cursor) {
				const held =
						cursor === null
							? {}
							: await parseJson(Schema.Record(Schema.String, Schema.Number), cursor),
					places: Record<string, number> = {},
					messages: Incoming[] = [];
				let gap = false;
				for (const line of lines) {
					const since = held[line.phone];
					const answer = await replay(line, since).catch((error: unknown) => {
						if (since === undefined || !lostCursor(error)) throw error;
						gap = true;
						return replay(line);
					});
					messages.push(...answer.messages);
					places[line.phone] = answer.head;
				}
				return { messages, cursor: JSON.stringify(places), ...(gap ? { gap } : {}) };
			},
			async close() {
				closing = true;
				await Promise.allSettled([...streams].map((stream) => stream.close()));
				await lifecycle.destroyClient?.({ client: lines });
			}
		};
		return connection;
	}
};
