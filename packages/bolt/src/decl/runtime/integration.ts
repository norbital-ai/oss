// `integration('<name>', literal)`: one definition per `src/integration/<name>/+integration.ts` (the folder is the name).
// A definition names one driver kind, its typed configuration and credential, the feeds that write collections from the
// external account and the outbound rules that send or command for records. X-2: the literal holds the shapes; the bodies
// (`test`, `feed`, `outbound`, `receive`, `send`) attach after it by name, so no literal's type depends on a body. Bolt's
// conversation definitions (whatsapp, email, telegram, slack, discord, wechat) are this same declaration in its system
// layer.
import type { Handle } from '../access/actor.ts';
import { attached, type Body } from '../collection.ts';
import type { BodyReturn, Eff, InputSel, Loose, Patch, QueryCtx, WorkspaceReads } from '../ctx.ts';
import type { FacilityFailure, Unavailable } from '../errors.ts';
import type {
	Checked,
	Exact,
	InputFields,
	InputKind,
	Simplify,
	ValidInput,
	ValidInputs,
	ValueOf
} from '../fields.ts';
import type {
	CollectionName,
	ColumnValue,
	InstanceId,
	IntegrationName,
	IntegrationSpecOf,
	OmittableOnInsert,
	OneRels,
	ReadField,
	Row,
	WritableField
} from '../names.ts';
import type { Where } from '../where.ts';
import type { FileRef, IanaZone, Id, Instant, Json, PlainDate, RecordRef } from '../values.ts';
import type { DatabaseRequest, DatabaseResult } from '../../engine/integrations/database.ts';
import type { Cron, WebhookScheme } from './automation.ts';
import type { ConnectionsOf, SecretName } from './names.ts';

// ── drivers: Bolt's kinds, each a static contract; the host implements a kind with its providers ──
/**
 * Each driver's contract: `request`, what `ctx.request` takes (`http` ops or `database` statements); `credential`, the
 * definition declares the secret the host seals at pairing; `conversation`, the messages it carries and the member handle
 * a sender is matched by (`null`: none, so a private envoy admits nobody); `feed`, the items it pushes; `oauth`, the host
 * may run an OAuth grant with the definition's `oauth` client; `personal`, a member's own account syncs (never sends, never an envoy).
 */
export const DRIVERS = {
	http: { request: 'http', credential: true, oauth: true },
	sqlserver: { request: 'database', credential: true },
	whatsapp: { conversation: { kind: 'chat', handle: 'phone' }, personal: true },
	email: { conversation: { kind: 'email', handle: 'email' }, personal: true },
	telegram: { conversation: { kind: 'chat', handle: 'telegram' } },
	slack: { conversation: { kind: 'chat', handle: null } },
	discord: { conversation: { kind: 'chat', handle: null } },
	wechat: { conversation: { kind: 'chat', handle: null } },
	calendar: { feed: 'calendar', oauth: true, personal: true }
} as const;
/** A driver kind: what a definition's `driver` names. */
export type DriverName = keyof typeof DRIVERS;
type Contract<D> = D extends DriverName ? (typeof DRIVERS)[D] : never;
/** The member handle a conversation's senders are matched by. */
export type HandleKind = 'phone' | 'email' | 'telegram';

// ── messages ──
/** A file a message carries: `id` names the stored file; none when the row could not store its bytes (too large, never received). */
export type Attachment = {
	readonly id?: Id<'sys_file'>;
	readonly name: string;
	readonly mime: string;
	readonly bytes: number;
};
type Address = { readonly address: string; readonly name: string | null };
/** An inbound email: the full text and headers. */
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
/** An inbound chat message. `thread` is the chat; `replyTo` the message it answers. */
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
/** A conversation's inbound message, by its kind. */
export type Inbound<K> = K extends 'email' ? InboundMail : K extends 'chat' ? InboundChat : never;
/** A message a `from: 'messages'` feed maps: the message as stored, its `version` (an edit is a new one) and whether it was deleted or recalled. */
export type MessageItem<K> = Inbound<K> & { readonly version: string; readonly deleted: boolean };
type Common = { replyTo?: string; about?: RecordRef };
/** What a conversation sends, by its kind: an outbound rule's `build`, `ctx.send` and an envoy's reply. */
export type Outgoing<K> = K extends 'email'
	? Common & {
			to: readonly string[];
			cc?: readonly string[];
			subject: string;
			html?: string;
			text?: string;
			/** The correlation id replies are matched back to. */ thread?: string;
			/** Stored files only: a message row keeps references, never bytes. */
			attachments?: readonly FileRef[];
		}
	: // the handle is the provider's own: a WhatsApp number or JID, a Slack channel, a Discord channel, a WeChat openid
		K extends 'chat'
		? Common & {
				to: Handle | Id<'sys_conversation'>;
				text: string;
				attachments?: readonly FileRef[];
			}
		: never;
/** One chat message a custom conversation's `receive` maps a verified webhook body to; `id` deduplicates. */
export type ReceivedChat = {
	id: string;
	thread: string;
	sentAt: Instant;
	from: { handle: string; name?: string | null };
	text: string;
	replyTo?: string | null;
	group?: boolean;
	/** Why a group message is addressed to the envoy. */
	invocation?: 'mention' | 'reply';
	participants?: readonly { handle: string; name?: string | null }[];
};
/** One email a custom conversation's `receive` maps a verified webhook body to; `id` deduplicates. */
export type ReceivedMail = {
	id: string;
	thread?: string | null;
	sentAt: Instant;
	from: { address: string; name?: string | null };
	to?: readonly string[];
	subject: string;
	text: string;
	html?: string | null;
};
type Received<K> = K extends 'email' ? ReceivedMail : ReceivedChat;

/**
 * Where an outbound message stands. Every provider maps its own reports to these; bolt keeps every report on the
 * message's timeline, mapped or not.
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
/** What an outbound rule's `events.<E>` receives: the report as the provider gave it, the message it is about, and the reply. */
export type DeliveryEvent<E extends DeliveryKind = DeliveryKind, K = 'email'> = {
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
	? { readonly reply: Inbound<K> }
	: // bolt fills a failure's reason from its code when the provider gave none
		E extends 'bounced' | 'failed'
		? { readonly reason: string }
		: {});

// ── driver feed items ──
/** When a calendar event starts or ends: a whole day, or an instant with the zone it was set in. */
export type CalendarTime =
	{ readonly date: PlainDate } | { readonly at: Instant; readonly zone: IanaZone | null };
/** One event a `calendar` driver feed pushes; `ctx.partition` is its calendar. */
export type CalendarEvent = {
	readonly id: string;
	readonly summary: string | null;
	readonly description: string | null;
	readonly location: string | null;
	readonly url: string | null;
	readonly status: 'confirmed' | 'tentative' | 'cancelled';
	readonly start: CalendarTime;
	readonly end: CalendarTime;
	/** Original provider event, including attendees, recurrence and identifiers needed by authored business rules. */
	readonly source: Json;
};
type DriverItem<D> = D extends 'calendar' ? CalendarEvent : never;

// ── requests ──
/** An HTTP request through an `http` instance: `path` resolves under the definition's base URL (never another host). */
export type HttpOp<O> = {
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	path: string;
	query?: { readonly [name: string]: string | number | boolean };
	headers?: { readonly [name: string]: string };
	body?: Json;
	output: O & Checked<InputKind, O, Exact<O, ValidInput<O>>>;
};
/** An instance's live request: journalled, credential host-side; it fails with a `FacilityFailure` or `Unavailable`. */
export interface HttpRequester {
	<const O extends InputKind>(op: HttpOp<O>): Eff<ValueOf<O>, FacilityFailure | Unavailable>;
}
/** A database instance's live request: one bounded statement, journalled, its connection string host-side. */
export interface DatabaseRequester {
	(op: DatabaseRequest): Eff<DatabaseResult, FacilityFailure | Unavailable>;
}

// ── a definition's derived types ──
type Part<S, K extends string> = S extends { [P in K]: infer V } ? V : {};
type DriverIn<S> = S extends { driver: infer D } ? D : never;
/** The message kind a definition's conversation carries: its own `conversation` (a custom chat), else its driver's. */
type KindIn<S> = S extends { conversation: { kind: infer K } }
	? K
	: Contract<DriverIn<S>> extends { conversation: { kind: infer K } }
		? K
		: never;
type RequestIn<S> = Contract<DriverIn<S>> extends { request: infer R } ? R : never;
// distributive over the request kind: no kind (a conversation driver) is no request
type Requester<S, R = RequestIn<S>> = R extends 'http'
	? HttpRequester
	: R extends 'database'
		? DatabaseRequester
		: never;
/** The fields a stored configuration may lack: the `optional` ones with no default, since decoding fills every default. */
type Unset<F> = {
	[P in keyof F]-?: F[P] extends { optional: true }
		? F[P] extends { default: unknown }
			? never
			: P
		: never;
}[keyof F];
// what every body reads: the stored configuration, never the input that made it (whose defaulted fields may be omitted)
type ConfigurationIn<S, F = Part<S, 'configuration'>> = Simplify<
	{ readonly [P in Exclude<keyof F, Unset<F>>]: ValueOf<F[P]> } & {
		readonly [P in Unset<F>]?: ValueOf<F[P]>;
	}
>;
/** The driver definition `D` names. */
export type DriverOf<D> = DriverIn<IntegrationSpecOf<D>>;
/** The message kind definition `D` carries (`chat` | `email`); `never` for a definition with no conversation. */
export type ConversationOf<D> = KindIn<IntegrationSpecOf<D>>;
/** What a send through an instance of definition `D` takes. */
export type SendInput<D> = Outgoing<ConversationOf<D>>;
/** What `ctx.request` takes through an instance of definition `D`: an HTTP op or a database statement. */
export type RequestOf<D, O = InputKind, R = RequestIn<IntegrationSpecOf<D>>> = R extends 'http'
	? HttpOp<O>
	: R extends 'database'
		? DatabaseRequest
		: never;
/** What `ctx.request` answers through an instance of definition `D`. */
export type RequestResult<D, O = InputKind, R = RequestIn<IntegrationSpecOf<D>>> = R extends 'http'
	? ValueOf<O>
	: R extends 'database'
		? DatabaseResult
		: never;
/** An instance's decoded configuration for definition `D`: every defaulted field present, an `optional` one without a default absent or null. */
export type ConfigurationOf<D> = ConfigurationIn<IntegrationSpecOf<D>>;

// ── feed targets ──
type InstanceFkIn<C> = {
	[F in keyof OneRels<C> & string]: OneRels<C>[F] extends { to: 'sys_integration' } ? F : never;
}[keyof OneRels<C> & string];
/** The FKs of `C` to `sys_integration` pinned to definition `N` (`where: { integration: { eq: N } }`). */
type InstanceFk<C, N> = {
	[F in keyof OneRels<C> & string]: OneRels<C>[F] extends {
		to: 'sys_integration';
		where: { integration: { eq: N } };
	}
		? F
		: never;
}[keyof OneRels<C> & string];
/** A feed target's local fields: its collection's `update` columns, which the feed never writes and only they may change. */
export type LocalField<C> = SelectionColumns<InputSel<C, 'update'>>;
type SelectionColumns<Sel> = Sel extends { columns: readonly (infer P)[] } ? P & string : never;
/** The fields a feed writes into `C`: writable, less its instance FK (the engine stamps it) and its local fields. */
export type FeedField<C> = Exclude<WritableField<C>, InstanceFkIn<C> | LocalField<C>>;
/** One row a feed upserts into `C`: its feed fields, required as an insert requires them. */
export type FeedRow<C> = FeedRowOf<C>;
type FeedRowOf<C, F extends string = FeedField<C>> = Simplify<
	{
		readonly [P in F as OmittableOnInsert<C, P> extends true ? never : P]: Loose<ColumnValue<C, P>>;
	} & {
		readonly [P in F as OmittableOnInsert<C, P> extends true ? P : never]?: Loose<
			ColumnValue<C, P>
		>;
	}
>;
type KeyRow<C, K extends string> = { readonly [P in K]: Loose<ColumnValue<C, P>> };
/** One change a feed commits: a row upserted by its key, or a key removed (the feed's `removed` decides what that does). */
export type Change<R, K = R> = { readonly upsert: R } | { readonly delete: K };
/** A feed's sync health: `attention` raises the instance's status (and any automation watching it). */
export type Health = {
	readonly state: 'ready' | 'attention';
	readonly code?: string;
	readonly message?: string;
};
/**
 * One page a `read` returns. The engine commits its changes, the cursor and the row markers in one statement. `more`
 * reads on in the same run; `retained: false` (the source lost its history) starts a fresh snapshot, and after the page
 * marked `snapshot: 'end'` the rows the snapshot did not see are reconciled through `removed`.
 */
export type FeedPage<R, K = R> = {
	readonly changes: readonly Change<R, K>[];
	readonly cursor: Json;
	readonly more: boolean;
	readonly snapshot?: 'begin' | 'end';
	readonly retained?: false;
	readonly health?: Health;
};

// ── the literal ──
type HttpAuth<C> =
	{ bearer: C } | { header: { name: string; value: C } } | { basic: { user: C; password: C } };
/** One feed: rows of one collection from the account. */
export type FeedSpec = {
	/** The collection it writes; its model key is the instance FK (pinned to this definition) and `key`. */
	into: string;
	/** The remote identity: the model key's fields beside the instance FK. */
	key: readonly string[];
	/** `read` (default): pulled on `cron`; `driver`: pushed by the driver; `messages`: this definition's conversation messages. */
	from?: 'read' | 'driver' | 'messages';
	cron?: string;
	/** A text-many configuration field: one cursor per value (calendar ids); a dropped value releases its cursor and markers, and its rows stay. */
	partitions?: string;
	/** What a remote delete, or a row a snapshot no longer has, does: a patch of feed fields, or `'delete'` (default). */
	removed?: object | 'delete';
};
/** One outbound rule: a send or command for each committed row of `from` matching `on` and `when`. */
export type OutboundSpec = {
	from: string;
	/** Default `'create'`; queued in the row's own commit, once the write is effective (after approval). */
	on?: 'create' | 'update' | readonly ('create' | 'update')[];
	when?: object;
	/** The instance it goes through: a connection of this definition, or an FK of `from` pinned to it. */
	via: string;
	/** The field whose value keys the send (one per record and value); default the record id (one per record). */
	version?: string;
};
/** A definition literal's general shape. */
export type IntegrationSpec = {
	description: string;
	driver: DriverName;
	/** Safe settings each instance edits at run time (with history), decoded against these fields. */
	configuration?: InputFields;
	/** The secret each instance pairs with, sealed host-side and never readable (`http` and `sqlserver` only). */
	credential?: InputFields;
	/**
	 * The OAuth client an `oauth` driver (http, calendar) grants with, by secret name; tokens are per instance. An http
	 * definition names its `authorize` and `token` endpoints too, and its requests carry the instance's token as a bearer.
	 */
	oauth?: {
		client: string;
		secret: string;
		authorize?: string;
		token?: string;
		scopes?: readonly string[];
	};
	/** `http` only: the base URL (a literal or a text configuration field) and how requests authenticate. */
	http?: { baseUrl: string; auth?: HttpAuth<string> };
	/** `http` with a conversation: the signed webhook messages arrive by, verified with a credential field. */
	webhook?: { scheme: WebhookScheme; secret: string };
	/** `http` only: a custom conversation (`receive` and `send` bodies) and the member handle its senders carry. */
	conversation?: { kind: 'chat' | 'email'; handle: HandleKind };
	feeds?: { readonly [feed: string]: FeedSpec };
	outbound?: { readonly [rule: string]: OutboundSpec };
};
/**
 * The configuration every instance of `def` starts with, however it was made (at run time, from a seed pack, or as a
 * `+workspace.ts` connection): its configuration fields' defaults.
 */
export const configurationDefaults = (
	def: Pick<IntegrationSpec, 'configuration'> | undefined
): { readonly [field: string]: Json } =>
	Object.fromEntries(
		Object.entries(def?.configuration ?? {}).flatMap(([k, f]) =>
			'default' in f && f.default !== undefined ? [[k, f.default as Json]] : []
		)
	);

/** The `text` configuration fields, the many-valued ones when `Many`. */
type TextField<F, Many> = {
	[P in keyof F]: F[P] extends { kind: 'text' }
		? (F[P] extends { many: true } ? true : false) extends Many
			? P
			: never
		: never;
}[keyof F] &
	string;
type FeedFor<S, F> = F extends { into: infer C }
	? {
			into: F extends { from: 'driver' | 'messages' } | { cron: string }
				? CollectionName
				: 'error: a read feed declares its cron';
			key: readonly FeedField<C>[];
			from?: F extends { from: 'driver' }
				? Contract<DriverIn<S>> extends { feed: string }
					? 'driver'
					: 'error: only a driver that pushes items takes from: driver'
				: F extends { from: 'messages' }
					? [KindIn<S>] extends [never]
						? 'error: only a conversation integration takes from: messages'
						: 'messages'
					: 'read';
			cron?: F extends { from: 'driver' | 'messages' }
				? 'error: a pushed feed has no cron'
				: F extends { cron: infer K }
					? Cron<K>
					: string;
			partitions?: TextField<Part<S, 'configuration'>, true>;
			removed?: 'delete' | { readonly [P in FeedField<C>]?: Loose<ColumnValue<C, P>> };
		}
	: FeedSpec;
type OutboundFor<N, O> = O extends { from: infer C }
	? {
			from: CollectionName;
			on?: 'create' | 'update' | readonly ('create' | 'update')[];
			when?: Where<C>;
			via: ConnectionsOf<N> | InstanceFk<C, N>;
			version?: ReadField<C>;
		}
	: OutboundSpec;
type HttpFor<S> =
	DriverIn<S> extends 'http'
		? {
				baseUrl: `https://${string}` | TextField<Part<S, 'configuration'>, false>;
				auth?: S extends { oauth: unknown }
					? 'error: an oauth integration authenticates with its token; drop auth'
					: HttpAuth<keyof Part<S, 'credential'> & string>;
			}
		: 'error: only an http integration declares http';
/** An http definition names the endpoints of its grant; another oauth driver's provider knows them. */
type OAuthFor<S, D = DriverIn<S>> =
	Contract<D> extends { oauth: true }
		? D extends 'http'
			? Part<S, 'oauth'> extends { authorize: string; token: string }
				? {
						client: SecretName;
						secret: SecretName;
						authorize: string;
						token: string;
						scopes?: readonly string[];
					}
				: 'error: an http grant names its authorize and token endpoints'
			: { client: SecretName; secret: SecretName; scopes?: readonly string[] }
		: 'error: only an oauth driver (http, calendar) declares oauth';
interface IntegrationFor<N, S, D = DriverIn<S>> {
	description: string;
	driver: DriverName;
	configuration?: ValidInputs<Part<S, 'configuration'>>;
	credential?: Contract<D> extends { credential: true }
		? ValidInputs<Part<S, 'credential'>>
		: 'error: only an http or sqlserver integration declares its credential';
	oauth?: OAuthFor<S>;
	http?: HttpFor<S>;
	webhook?: D extends 'http'
		? S extends { conversation: unknown }
			? { scheme: WebhookScheme; secret: keyof Part<S, 'credential'> & string }
			: 'error: a webhook carries a custom conversation; declare conversation'
		: 'error: only an http integration declares a webhook';
	conversation?: D extends 'http'
		? S extends { webhook: unknown }
			? { kind: 'chat' | 'email'; handle: HandleKind }
			: 'error: a custom conversation receives through its webhook; declare webhook'
		: 'error: a conversation driver carries its own conversation';
	feeds?: { [F in keyof Part<S, 'feeds'>]: FeedFor<S, Part<S, 'feeds'>[F]> };
	outbound?: { [R in keyof Part<S, 'outbound'>]: OutboundFor<N, Part<S, 'outbound'>[R]> };
}

// ── the bodies ──
type Feeds<S> = Part<S, 'feeds'>;
type Outbounds<S> = Part<S, 'outbound'>;
/** What integration bodies read: unmasked stored rows, as a transform reads (bodies are trusted source). */
interface IntegrationReads extends Pick<WorkspaceReads, 'read' | 'get'> {}
/** `i.test`'s ctx: the instance's configuration and its live request. */
export interface TestCtx<S> {
	readonly configuration: ConfigurationIn<S>;
	request: Requester<S>;
}
/** A feed body's ctx: the instance and partition it runs for, its configuration and trusted reads; writes are only its changes. */
export interface FeedCtx<N extends string, S>
	extends IntegrationReads, Pick<QueryCtx, 'now' | 'today' | 'tz'> {
	readonly instance: InstanceId<N>;
	/** The partition value (a calendar id) for a partitioned feed, else `null`. */
	readonly partition: string | null;
	readonly configuration: ConfigurationIn<S>;
}
/** A `read` body's ctx: a feed's, with the instance's live request. */
export interface ReadCtx<N extends string, S> extends FeedCtx<N, S> {
	request: Requester<S>;
}
/** An outbound `run` and a custom `send`'s ctx: `key` is the send's immutable idempotency key, for the remote side. */
export interface RunCtx<N extends string, S> extends IntegrationReads {
	readonly instance: InstanceId<N>;
	readonly key: string;
	readonly configuration: ConfigurationIn<S>;
	request: Requester<S>;
}
// `P` keeps the returned rows checkable: an inferred callback's return is never excess-checked, so a local field (or a
// misspelt one) in an upsert would pass unseen. Each upsert names only the row's fields.
type OnlyFields<P, R> = P extends readonly (infer E)[]
	? readonly (E extends { readonly upsert: infer U }
			? { readonly upsert: { readonly [K in Exclude<keyof U, keyof R>]: never } }
			: unknown)[]
	: unknown;
type FeedBody<N extends string, S, F, P> = F extends {
	into: infer C;
	key: readonly (infer K extends string)[];
}
	? F extends { from: 'driver' | 'messages' }
		? {
				map: (
					items: readonly (F extends { from: 'messages' }
						? MessageItem<KindIn<S>>
						: DriverItem<DriverIn<S>>)[],
					ctx: FeedCtx<N, S>
				) => BodyReturn<
					P & readonly Change<FeedRow<C>, KeyRow<C, K>>[] & OnlyFields<P, FeedRow<C>>
				>;
			}
		: {
				read: (
					cursor: Json | null,
					ctx: ReadCtx<N, S>
				) => BodyReturn<
					FeedPage<FeedRow<C>, KeyRow<C, K>> & { readonly changes: P & OnlyFields<P, FeedRow<C>> }
				>;
			}
	: never;
type From<S, R> = Outbounds<S>[R & keyof Outbounds<S>] extends { from: infer C } ? C : never;
/**
 * A conversation definition's rule builds the message, and its `events` patch the row; any other definition's builds a
 * command payload its `run` performs. `build` is pure and runs at delivery over the committed row; `null` skips the send.
 */
type Outbound<N extends string, S> = [KindIn<S>] extends [never]
	? <R extends keyof Outbounds<S> & string, const P extends Json>(
			name: R,
			body: {
				build: (row: Row<From<S, R>>) => P | null;
				run: (payload: NoInfer<P>, ctx: RunCtx<N, S>) => BodyReturn<{ readonly id: string }>;
			}
		) => void
	: <R extends keyof Outbounds<S> & string>(
			name: R,
			body: {
				build: (row: Row<From<S, R>>) => Outgoing<KindIn<S>> | null;
				events?: { [E in DeliveryKind]?: (e: DeliveryEvent<E, KindIn<S>>) => Patch<From<S, R>> };
			}
		) => void;
type Custom<S, T> = S extends { conversation: unknown }
	? T
	: 'error: only a custom conversation (http with conversation) receives and sends';
type ReceiveBody<S> = (request: {
	readonly body: Json;
	readonly headers: { readonly [lowercase: string]: string };
	readonly configuration: ConfigurationIn<S>;
}) => BodyReturn<{ readonly messages: readonly Received<KindIn<S>>[] }>;
type SendBody<N extends string, S> = (
	message: Outgoing<KindIn<S>> & { readonly thread: string | null },
	ctx: RunCtx<N, S>
) => BodyReturn<{ readonly id: string }>;
/** The attached bodies, read by the compiler (a missing feed, outbound or `run` body is `load/missing-body`). */
type IntegrationBodies = {
	test?: Body;
	receive?: Body;
	send?: Body;
	feeds: Record<string, { read?: Body; map?: Body }>;
	outbound: Record<
		string,
		{ build?: Body; run?: Body; events?: Partial<Record<DeliveryKind, Body>> }
	>;
};
/** What `integration()` returns: the literal, and the bodies it attaches by name. */
export type Integration<N extends string, S> = {
	readonly name: N;
	readonly spec: S;
	readonly bodies: IntegrationBodies;
	/** Checks a freshly paired instance (the host's `test` verb). */
	test(body: (ctx: TestCtx<S>) => BodyReturn<void>): void;
	/** A declared feed's body: `read` for a pulled feed, `map` for a pushed or message feed. */
	feed<F extends keyof Feeds<S> & string, P = unknown>(
		name: F,
		body: FeedBody<N, S, Feeds<S>[F], P>
	): void;
	/** A declared outbound rule's body. */
	outbound: Outbound<N, S>;
	/** A custom conversation's inbound: the verified webhook body → the messages it carries (committed before the 200). */
	receive(body: Custom<S, ReceiveBody<S>>): void;
	/** A custom conversation's outbound: envoy replies, rules and `ctx.send` through an instance. */
	send(body: Custom<S, SendBody<N, S>>): void;
};

/**
 * `src/integration/<name>/+integration.ts`: one external system's definition. Its instances are `sys_integration` rows
 * (a `+workspace.ts` connection names one); feeds write collections from each instance and outbound rules send for records.
 * @example
 * const routes = integration('google_routes', {
 * 	description: 'Drive times for matching and the ETA watch.',
 * 	driver: 'http',
 * 	credential: { apiKey: { kind: 'text', label: 'Routes API key' } },
 * 	http: { baseUrl: 'https://routes.googleapis.com/', auth: { header: { name: 'X-Goog-Api-Key', value: 'apiKey' } } }
 * });
 * export default routes;
 * routes.test(function* (ctx) { yield* ctx.request({ method: 'GET', path: 'healthz', output: { kind: 'json' } }); });
 */
export function integration<const N extends IntegrationName, const S extends IntegrationSpec>(
	name: N,
	spec: S & NoInfer<Checked<IntegrationSpec, S, Exact<S, IntegrationFor<N, S>>>>
): Integration<N, S> {
	const bodies: IntegrationBodies = { feeds: {}, outbound: {} };
	const once = (what: string, attached: unknown) => {
		if (attached !== undefined) throw new Error(`integration ${name}: ${what} is attached twice`);
	};
	const declared = (part: 'feeds' | 'outbound', key: string) => {
		if (!Object.hasOwn((spec as IntegrationSpec)[part] ?? {}, key))
			throw new Error(`integration ${name}: ${part} '${key}' is not declared`);
		once(`${part} '${key}'`, bodies[part][key]);
	};
	return {
		name,
		spec,
		bodies,
		test(body) {
			once('test', bodies.test);
			bodies.test = attached(body, 0);
		},
		feed(key, body) {
			declared('feeds', key);
			const f = body as { read?: Body; map?: Body };
			bodies.feeds[key] =
				f.read !== undefined
					? { read: attached(f.read, 1) }
					: f.map !== undefined
						? { map: attached(f.map, 1) }
						: {};
		},
		outbound: ((key: string, body: IntegrationBodies['outbound'][string]) => {
			declared('outbound', key);
			bodies.outbound[key] =
				body.run === undefined ? body : { ...body, run: attached(body.run, 1) };
		}) as Integration<N, S>['outbound'],
		receive(body) {
			once('receive', bodies.receive);
			bodies.receive = attached(body as Body, -1);
		},
		send(body) {
			once('send', bodies.send);
			bodies.send = attached(body as Body, 1);
		}
	};
}
