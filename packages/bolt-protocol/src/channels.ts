import { Schema } from 'effect';

/**
 * Channels: one primitive for communication (RFC channels.md).
 *
 * A **transport** is a kind of endpoint a host can operate. A **channel** is a workspace's declared
 * instance of one (`src/channels/+<name>.ts`). Bolt knows each transport's shape — what arrives
 * (an envelope), what leaves (a message), what the provider reports back (an event) — and the host
 * owns the adapter that speaks to the provider. Templates name a transport, never a provider.
 */
export const Transport = Schema.Literals(['inbox', 'email', 'whatsapp', 'telegram', 'http']);
export type Transport = typeof Transport.Type;
export const TRANSPORTS: ReadonlyArray<Transport> = ['inbox', 'email', 'whatsapp', 'telegram', 'http'];
/** Transports a person can be reached on: `api.notify` and collection notification rules. */
export const PERSON_TRANSPORTS: ReadonlyArray<Transport> = ['inbox', 'email', 'whatsapp', 'telegram'];
/** Transports an envoy can hold a conversation on. */
export const CONVERSATION_TRANSPORTS: ReadonlyArray<Transport> = ['email', 'whatsapp', 'telegram'];
/** The transports whose adapter lives in the host; `inbox` is delivered by Bolt itself. */
export const HOST_TRANSPORTS: ReadonlyArray<Transport> = ['email', 'whatsapp', 'telegram', 'http'];

const Instant = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/)
);
const ProviderMessageId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(998));

/**
 * The hard wire bound on one attachment crossing the host boundary.
 *
 * Per-kind caps live in the adapter — this is the outer ceiling that keeps one invocation from
 * carrying an unbounded payload. Bytes are absent when the provider could not supply them (an
 * over-cap video, an expired document), which is recorded rather than dropped.
 */
const MaxInboundAttachmentBytes = 32 * 1024 * 1024;
export const InboundAttachment = Schema.Struct({
	provider: Schema.NonEmptyString,
	attachmentId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	kind: Schema.Literals(['image', 'video', 'audio', 'document', 'sticker', 'other']),
	mimeType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
	fileName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	byteLength: Schema.Number.check(
		Schema.isInt(),
		Schema.isBetween({ minimum: 1, maximum: MaxInboundAttachmentBytes })
	),
	bytesBase64: Schema.optionalKey(
		Schema.String.check(
			Schema.isMinLength(1),
			Schema.isMaxLength(Math.ceil(MaxInboundAttachmentBytes / 3) * 4),
			Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
		)
	)
});
export interface InboundAttachment extends Schema.Schema.Type<typeof InboundAttachment> {}
const Attachments = Schema.Array(InboundAttachment).check(
	Schema.makeFilter(
		(attachments) => attachments.length <= 8 || 'at most 8 inbound attachments are accepted'
	)
);

/** One chat message a host took off WhatsApp or Telegram: wire facts, no claimed authority. */
export const ChatEnvelope = Schema.TaggedStruct('chat', {
	conversationId: Schema.NonEmptyString,
	conversationKind: Schema.Literals(['dm', 'group']),
	messageId: ProviderMessageId,
	sentAt: Instant,
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient']),
	text: Schema.String,
	attachments: Attachments,
	sender: Schema.optionalKey(
		Schema.Struct({
			id: Schema.NonEmptyString,
			displayName: Schema.optionalKey(Schema.NonEmptyString),
			username: Schema.optionalKey(Schema.NonEmptyString)
		})
	)
});
export interface ChatEnvelope extends Schema.Schema.Type<typeof ChatEnvelope> {}

const MailAddress = Schema.Struct({
	address: Schema.NonEmptyString,
	name: Schema.optionalKey(Schema.String)
});
export interface MailAddress extends Schema.Schema.Type<typeof MailAddress> {}

/**
 * One mail the host received at a channel's minted address.
 *
 * `threadId` is the root `Message-ID` of the thread (the first `References` entry, else
 * `In-Reply-To`, else this message's own id), so a thread is one conversation however the replies
 * arrive. `inReplyTo` is what correlates a reply with a message this channel sent.
 */
export const EmailEnvelope = Schema.TaggedStruct('email', {
	messageId: ProviderMessageId,
	threadId: ProviderMessageId,
	inReplyTo: Schema.optionalKey(ProviderMessageId),
	from: MailAddress,
	to: Schema.Array(MailAddress),
	cc: Schema.Array(MailAddress),
	replyTo: Schema.optionalKey(MailAddress),
	subject: Schema.String,
	text: Schema.String,
	html: Schema.optionalKey(Schema.String),
	attachments: Attachments,
	sentAt: Instant,
	/** Headers the adapter preserved verbatim (lower-cased names). */
	headers: Schema.Record(Schema.String, Schema.String)
});
export interface EmailEnvelope extends Schema.Schema.Type<typeof EmailEnvelope> {}

/** One verified delivery to an `http` channel's webhook. */
export const HttpDelivery = Schema.TaggedStruct('http', {
	messageId: ProviderMessageId,
	headers: Schema.Record(Schema.String, Schema.String),
	body: Schema.Json,
	sentAt: Instant
});
export interface HttpDelivery extends Schema.Schema.Type<typeof HttpDelivery> {}

export const ChannelEnvelope = Schema.Union([ChatEnvelope, EmailEnvelope, HttpDelivery]);
export type ChannelEnvelope = typeof ChannelEnvelope.Type;

/**
 * One change to a channel's history, the channel's form of the integrations engine's `Change`.
 *
 * `version` orders changes to one message: an edit carries a greater version than the message it
 * edits, and a change older than the stored version is dropped. `origin` says whether the host saw
 * it live or read it back (backfill, reconnect reconcile) — only a live inbound row can be answered.
 */
export const HistoryChange = Schema.TaggedUnion({
	Upsert: {
		envelope: ChannelEnvelope,
		version: Schema.String,
		origin: Schema.Literals(['live', 'sync']),
		direction: Schema.Literals(['inbound', 'outbound'])
	},
	Tombstone: { messageId: ProviderMessageId }
});
export type HistoryChange = typeof HistoryChange.Type;

/** The history sync's lifecycle as the host observes it. */
export const HistoryState = Schema.Literals(['unlinked', 'backfilling', 'live', 'reconciling', 'failed']);
export type HistoryState = typeof HistoryState.Type;

/** Outbound inline bytes are bounded well under a mail provider's per-message ceiling. */
const MaxOutboundInlineBytes = 10 * 1024 * 1024;

/**
 * A file an outbound message attaches: a tenant file by key, or bytes the write built inline (a
 * report rendered in the same transaction that queued the message).
 */
export const OutboundFile = Schema.Union([
	Schema.Struct({
		key: Schema.NonEmptyString,
		name: Schema.NonEmptyString,
		mimeType: Schema.NonEmptyString
	}),
	Schema.Struct({
		name: Schema.NonEmptyString,
		mimeType: Schema.NonEmptyString,
		contentBase64: Schema.String.check(
			Schema.isMinLength(1),
			Schema.isMaxLength(Math.ceil(MaxOutboundInlineBytes / 3) * 4)
		)
	})
]);
export type OutboundFile = typeof OutboundFile.Type;


export const ChatMessage = Schema.Struct({
	to: Schema.NonEmptyString,
	text: Schema.NonEmptyString,
	attachments: Schema.optionalKey(Schema.Array(OutboundFile))
});
export interface ChatMessage extends Schema.Schema.Type<typeof ChatMessage> {}

export const EmailMessage = Schema.Struct({
	to: Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1)),
	cc: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
	subject: Schema.NonEmptyString,
	html: Schema.optionalKey(Schema.String),
	text: Schema.optionalKey(Schema.String),
	attachments: Schema.optionalKey(Schema.Array(OutboundFile)),
	/** A thread key: replies in-thread when it names a thread this channel has seen or started. */
	thread: Schema.optionalKey(Schema.NonEmptyString)
});
export interface EmailMessage extends Schema.Schema.Type<typeof EmailMessage> {}

export const InboxMessage = Schema.Struct({
	recipients: Schema.Array(
		Schema.Union([Schema.NonEmptyString, Schema.Struct({ team: Schema.NonEmptyString })])
	),
	title: Schema.NonEmptyString,
	body: Schema.String
});
export interface InboxMessage extends Schema.Schema.Type<typeof InboxMessage> {}

export const HttpRequest = Schema.Struct({
	method: Schema.Literals(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
	path: Schema.String,
	query: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	body: Schema.optionalKey(Schema.Json)
});
export interface HttpRequest extends Schema.Schema.Type<typeof HttpRequest> {}

/** The message schema for each transport; `MessageFor<T>` in authoring is this table's type. */
export const MessageSchemas = {
	inbox: InboxMessage,
	email: EmailMessage,
	whatsapp: ChatMessage,
	telegram: ChatMessage,
	http: HttpRequest
} as const;

/** A provider report about one outbound message. `replied` is derived by Bolt from history. */
export const ChannelEventKind = Schema.Literals(['delivered', 'bounced', 'opened', 'replied', 'failed']);
export type ChannelEventKind = typeof ChannelEventKind.Type;
export const ChannelEvent = Schema.Struct({
	providerMessageId: ProviderMessageId,
	kind: ChannelEventKind,
	observedAt: Instant,
	detail: Schema.Record(Schema.String, Schema.Json)
});
export interface ChannelEvent extends Schema.Schema.Type<typeof ChannelEvent> {}

/** One declared channel as a host sees it in the release manifest. */
export const ManifestChannel = Schema.Struct({
	name: Schema.NonEmptyString,
	transport: Transport,
	/** An email channel's local part; the host mints the full address. */
	address: Schema.optionalKey(Schema.NonEmptyString),
	/**
	 * Whether the host mints an inbound binding for it. Session and mail transports always receive;
	 * an `http` channel receives only when it declares a webhook, and its deliveries are verified by
	 * the runtime (`webhooks.receive`), which holds the secret.
	 */
	receives: Schema.Boolean
}).annotate({ identifier: 'BoltManifestChannel' });
export interface ManifestChannel extends Schema.Schema.Type<typeof ManifestChannel> {}

export const ChannelStatus = Schema.Struct({
	channel: Schema.NonEmptyString,
	transport: Transport,
	history: HistoryState,
	/** The earliest message history holds when the provider could not list further back. */
	horizon: Schema.NullOr(Schema.String),
	lastInboundAt: Schema.NullOr(Schema.String),
	received: Schema.Number,
	sent: Schema.Number,
	pending: Schema.Number,
	failed: Schema.Number
}).annotate({ identifier: 'BoltChannelStatus' });
export interface ChannelStatus extends Schema.Schema.Type<typeof ChannelStatus> {}

/** What `PushSubscription.toJSON()` gives a browser: the endpoint and the two keys it minted. */
export const PushSubscription = Schema.Struct({
	endpoint: Schema.NonEmptyString,
	keys: Schema.Struct({ p256dh: Schema.NonEmptyString, auth: Schema.NonEmptyString })
});
export interface PushSubscription extends Schema.Schema.Type<typeof PushSubscription> {}
