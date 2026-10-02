// `channel()` (§3.3.8, rule 61): a transport plus an address. Record-driven outbound and delivery events are pure
// functions of their argument, typed from the `from` collection and the transport.
import type { Handle } from '../access/actor.ts';
import type { Patch } from '../ctx.ts';
import type { CollectionName, PolicyName, Row } from '../names.ts';
import type { FileRef, IanaZone, Id, Instant, Json, RecordRef } from '../values.ts';
import type { WebhookScheme } from './automation.ts';
import type { ChatTransport, ConnectionName, Transport } from './names.ts';

export type Attachment = {
	readonly file: FileRef;
	readonly fileName: string;
	readonly mimeType: string;
	readonly byteLength: number;
};
type Address = { readonly address: string; readonly name: string | null };
/** An inbound email (GAP-C1: the full text and headers). */
export type InboundMail = {
	readonly id: string;
	readonly thread: string | null;
	readonly sentAt: Instant;
	readonly from: Address;
	readonly replyTo: Address | null;
	readonly to: readonly Address[];
	readonly cc: readonly Address[];
	readonly subject: string;
	readonly text: string;
	readonly html: string | null;
	readonly headers: { readonly [name: string]: string };
	readonly attachments: readonly Attachment[];
};
/** An inbound chat message (WhatsApp, Telegram, Slack, Discord, WeChat, a custom channel). `thread` is the chat; `replyTo` the message it answers. */
export type InboundChat = {
	readonly id: string;
	readonly thread: string;
	readonly sentAt: Instant;
	readonly from: { readonly handle: Handle; readonly name: string | null };
	readonly replyTo: string | null;
	readonly text: string;
	readonly attachments: readonly Attachment[];
	readonly group?: boolean;
	readonly participants?: readonly { readonly handle: string; readonly name: string | null }[];
};
/** One inbound message of a custom channel, as its `inbound` or `poll` mapping produces it. `id` deduplicates (a redelivery is one row); `thread` is the chat. */
export type ReceivedMessage = {
	id: string;
	thread: string;
	sentAt: Instant;
	from: { handle: string; name?: string | null };
	text: string;
	replyTo?: string | null;
	group?: boolean;
	participants?: readonly { handle: string; name?: string | null }[];
};
export type Inbound<T> = T extends 'email'
	? InboundMail
	: T extends ChatTransport | 'custom'
		? InboundChat
		: never;

type Common = { replyTo?: string; about?: RecordRef };
/** What `ctx.send` and an `outbound.message` produce for a transport. `inbox` takes notices (`ctx.notify`), not messages. */
export type OutboundFor<T> = T extends 'email'
	? Common & {
			to: readonly string[];
			cc?: readonly string[];
			subject: string;
			html?: string;
			text?: string;
			/** The correlation id replies are matched back to. */ thread?: string;
			/** Stored files only: a message row keeps references, never bytes (store them first with `ctx.files.put` or `bolt.upload`). */
			attachments?: readonly FileRef[];
		}
	: // the handle is the provider's own: a Twilio `whatsapp:+65…` or a WhatsApp Web JID, a Slack channel, a Discord channel, a WeChat openid
		T extends ChatTransport | 'custom'
		? Common & {
				to: Handle | Id<'sys_conversation'>;
				text: string;
				attachments?: readonly FileRef[];
			}
		: never;

/**
 * Where an outbound message stands (§5.9 "delivery status"). Every provider maps its own reports to these; bolt keeps
 * every report on the message's timeline, mapped or not.
 */
export type DeliveryKind =
	| 'queued' // accepted by bolt, not yet handed to the provider
	| 'sent' // the provider or server accepted it (SMTP 250, an API 2xx)
	| 'deferred' // a temporary failure the provider (or bolt) retries: SMTP 4xx, a DSN "delayed"
	| 'delivered' // confirmed at the recipient; `presumed` when inferred from a quiet window without a bounce
	| 'read' // a chat read receipt
	| 'opened' // an email open (tracking pixel); always `approximate`
	| 'bounced' // permanent non-delivery (DSN 5.x.x, an NDR); `permanent` false for a soft bounce
	| 'failed' // refused before or at sending (SMTP 5xx on submit, an API 4xx, a bad handle, an auth failure)
	| 'complained' // the recipient marked it spam (only providers that report it)
	| 'auto_replied' // an out-of-office or auto-responder (RFC 3834): recorded, never a status, never a reply
	| 'replied'; // a human reply in the thread
/** What a channel's `events.<E>` handler receives: the report as the provider gave it, the message it is about, and the reply. */
export type DeliveryEvent<E extends DeliveryKind = DeliveryKind, T = 'email'> = {
	readonly kind: E;
	readonly at: Instant;
	readonly message: Id<'sys_message'>;
	/** The provider that reported it (`bolt` for bolt's own `queued`, `failed` and presumed events). */
	readonly provider: string;
	/** The server's or provider's code: SMTP basic + enhanced (`550 5.1.1`), a provider error code (`63016`). */
	readonly code?: string;
	/** The reason as the server or provider gave it. */
	readonly reason?: string;
	/** bounced / failed / deferred: whether retrying can never help (a hard bounce). */
	readonly permanent?: boolean;
	/** delivered by inference, not confirmation. */
	readonly presumed?: boolean;
	/** opened: a pixel is prefetched or blocked, so an open is a hint. */
	readonly approximate?: boolean;
	/** The provider's own payload, bounded (≤ 4 KB), for support. */
	readonly raw?: Json;
} & (E extends 'replied' | 'auto_replied'
	? { readonly reply: Inbound<T> }
	: // bolt fills a failure's reason from its code when the provider gave none
		E extends 'bounced' | 'failed'
		? { readonly reason: string }
		: {});

// Callbacks sit inside this literal, so it is typed by inference sites (the transport `T`, each outbound's `from`
// collection in `O`), never by a `Checked` wrapper: a wrapper would hide the contextual type from the callbacks.
// `message` answers `null` for a row that sends nothing on this channel (a customer with no email address): skipped, not failed
type Outbound<T, O> = {
	[N in keyof O]: {
		from: O[N];
		on: 'create';
		message: (x: { record: Row<O[N]> }) => OutboundFor<T> | null;
	};
};
type Events<T, C> = [C] extends [never]
	? 'error: events are mapped onto rows `outbound` sends; declare outbound'
	: { [E in DeliveryKind]?: (e: DeliveryEvent<E, T>) => Patch<C> };
export type ChannelSpec<T = Transport, O = {}> = {
	transport: T;
	/** Allow independently sealed provider accounts. Administrators manage all accounts; members manage their own on a syncOnly channel. */
	accounts?: boolean;
	/** Personal ingestion only: import available provider history through integrations, never send or invoke an envoy. Cannot declare outbound. Only providers advertising supportsSync are offered; custom channels use their authored inbound or poll mapping. */
	syncOnly?: boolean;
	/**
	 * custom: the connection outbound messages are POSTed to (`src/connection/+<name>.connection.ts`). A custom channel
	 * also ships `src/channel/+<channel>.connect.svelte`; what that page pairs with is sealed as the channel's credential.
	 */
	send?: ConnectionName;
	/**
	 * custom: the channel's own webhook (`/hooks/bolt.custom/<channel>`, shown on its setup screen). The host checks the
	 * signature by `verify.scheme` with the credential's `verify.secret` field before anything is read; `messages` maps
	 * the verified JSON body to the messages it carries. They enter the channel as any provider's inbound does (envoys
	 * answer them, integrations mirror them), deduplicated by `id`.
	 */
	inbound?: T extends 'custom'
		? {
				verify: { scheme: WebhookScheme; secret: string };
				messages: (request: {
					body: Json;
					headers: { readonly [lowercase: string]: string };
				}) => readonly ReceivedMessage[];
			}
		: 'error: only a custom channel declares inbound; a provider channel receives through its provider';
	/** custom: on `cron`, a GET of `path` through the named connection; `messages` maps its answer (deduplicated by `id`). */
	poll?: T extends 'custom'
		? {
				connection: ConnectionName;
				cron: string;
				tz?: IanaZone;
				path: string;
				query?: { readonly [name: string]: string };
				messages: (response: { body: Json }) => readonly ReceivedMessage[];
			}
		: 'error: only a custom channel polls';
	/** The authority of the channel's own writes (delivery events, inbound rows). */
	policies?: readonly PolicyName[];
	outbound?: Outbound<T, O>;
	/** Mapped back onto the sending row through its collection's pipeline, as the channel's actor. */
	events?: Events<T, O[keyof O]>;
};

/**
 * `src/channel/+<c>.channel.ts`: a messaging channel on a transport (`email`, `whatsapp`, `telegram`, `slack`, `discord`,
 * `wechat`, or `custom` with `send` and its own `inbound` webhook or `poll`), with optional
 * collection-backed `outbound` messages and delivery `events`. Envoys answer on it; notifications may be sent through it.
 * @example
 * export default channel({ transport: 'telegram' });
 * @example
 * export default channel({ transport: 'whatsapp', accounts: true, syncOnly: true });
 *
 * Provider adapters supply setup descriptors (form, QR, code or OAuth), live state and webhook/session handlers through ChannelProvider. The shared runtime handles account ownership, sealed credentials and restoration for every transport, including tenant-authored custom mappings.
 *
 * Personal accounts register with POST /__bolt/transports/<channel>/accounts { id }; GET lists their public
 * connection states. Pair and observe each account with the standard /__bolt/transports/<channel>~<id>
 * endpoints. Credentials stay sealed on the host. Integrations receive message.sourceAccount; stored
 * sys_message.message.sourceAccount carries the same key. Imported sent messages retain outbound direction
 * without entering the send queue. WhatsApp Web imports the history the phone provides; mailbox sources
 * backfill their configured folder (INBOX by default). Add a separate Sent folder source to import sent mail.
 */
export function channel<
	const T extends Transport,
	const O extends { readonly [name: string]: CollectionName } = {}
>(spec: ChannelSpec<T, O>): ChannelSpec<T, O> {
	return spec;
}
