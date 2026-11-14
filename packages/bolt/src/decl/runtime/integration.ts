// One path-bound integration per `src/integration/<name>/+integration.ts`.
// A definition is the connection only: one driver (a Bolt kind or one it declares), its typed configuration and
// credential, OAuth, the HTTP base and auth, webhook verification and handler, a request rate and an inline `test` body.
// What a connection exchanges is declared on the models it syncs (`model(…).syncs`, `./sync.ts`). Bolt's conversation
// definitions (whatsapp, email, telegram, slack, discord, wechat, chat) are this same declaration in its system layer.
import type { Actor, Handle } from '../access/actor.ts';
import { Record as EffectRecord, Schema } from 'effect';
import { FieldData } from '../field-data.ts';
import { attached, type Body } from '../body.ts';
import type { Act, BodyReturn, CallerQuery, Clock, Eff, Refuse } from '../ctx.ts';
import type {
	DatabaseRequest,
	DatabaseResult,
	FacilityFailure,
	Unavailable
} from '@norbital-ai/host-api';
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
import type { InstanceId, IntegrationName, IntegrationSpecOf, Is, PolicyName } from '../names.ts';
import type {
	FileRef,
	IanaZone,
	Id,
	Instant,
	Json,
	NonEmpty,
	PlainDate,
	Rate,
	RecordRef
} from '../values.ts';
import type { SecretName } from './names.ts';

/**
 * How an integration signs incoming webhooks: `standard` (Standard Webhooks, Svix headers too), `hmac-sha256`,
 * `bearer`, or a provider's own scheme the host names; a scheme the host does not verify refuses every delivery.
 */
export type WebhookScheme = string;

/**
 * Checks the definition of a read integration instance before using its id in a definition-pinned ref (`ctx.send`,
 * `ctx.request`, a notice's `via`), without a cast; throws `RangeError` for another definition's instance.
 * @example
 * const { sys_integration } = yield* ctx.query({ sys_integration: { where: { name: { eq: 'Hotline' } }, limit: 1 } });
 * yield* ctx.send(instance_id('whatsapp', sys_integration.rows[0]), { to, text });
 */
export function instance_id<const D extends string>(
	definition: Is<D, IntegrationName>,
	instance: { readonly id: Id<'sys_integration'>; readonly integration: string }
): InstanceId<D> {
	if (!is_instance<D>(definition, instance))
		throw new RangeError(`Expected an instance of '${definition}', got '${instance.integration}'`);
	return instance.id;
}
/** Narrows a read instance and its id by its declared integration definition. */
export function is_instance<const D extends string>(
	definition: Is<D, IntegrationName>,
	instance: { readonly id: Id<'sys_integration'>; readonly integration: string }
): instance is { readonly id: InstanceId<D>; readonly integration: D } {
	return instance.integration === definition;
}

// ── drivers: a static contract each; the host implements one with its providers, registered by the driver's name ──
/** The member handle a conversation's senders are matched by (`sys_user.<kind>`). */
export const HANDLE_KINDS = ['phone', 'email', 'telegram', 'slack', 'discord'] as const;
export type HandleKind = (typeof HANDLE_KINDS)[number];
/**
 * A driver's contract: `read`, what it supplies a sync's `read` (`cursor`: the sync pages itself; `deliveries`: inbound
 * messages and delivery reports; `items`: what it pushes); `request`, what `ctx.request` takes (`http` ops or `database`
 * statements); `credential`, the definition declares the secret the host seals at pairing; `conversation`, the messages
 * it carries, the member handle a sender is matched by (`null`: none, so a private envoy admits nobody) and the
 * `address` a member's handle is sent to (`{}` stands for the handle: `'@{}'`; the handle itself by default); `items`,
 * what it pushes; `oauth`, the host may run an OAuth grant with the definition's `oauth` client; `personal`, a member's
 * own account syncs (never sends a message, never an envoy; a sync `write` may write back to it); `call`, what
 * `ctx.request` takes through a pushing driver's standing link (its provider's own API under its sign-in).
 */
export const DriverContract = Schema.Struct({
	read: Schema.Literals(['cursor', 'deliveries', 'items']),
	request: Schema.optionalKey(Schema.Literals(['http', 'database'])),
	call: Schema.optionalKey(Schema.Literal('http')),
	credential: Schema.optionalKey(Schema.Literal(true)),
	oauth: Schema.optionalKey(Schema.Literal(true)),
	personal: Schema.optionalKey(Schema.Literal(true)),
	items: Schema.optionalKey(Schema.Literal('calendar')),
	conversation: Schema.optionalKey(Schema.Struct({
		kind: Schema.Literals(['chat', 'email']),
		handle: Schema.NullOr(Schema.Literals(HANDLE_KINDS)),
		address: Schema.optionalKey(Schema.String)
	}))
});
export type DriverContract = typeof DriverContract.Type;
/**
 * Bolt's own driver kinds. Any other driver is declared by the integration that uses it (`driver: { name, ...contract }`)
 * and implemented by a host provider registered under that name; a workspace cannot supply a provider.
 */
export const DRIVERS = {
	http: { read: 'cursor', request: 'http', credential: true, oauth: true },
	sqlserver: { read: 'cursor', request: 'database', credential: true },
	email: { read: 'deliveries', conversation: { kind: 'email', handle: 'email' }, personal: true },
	/** Any chat platform the host's providers name: a connection picks one. */
	chat: { read: 'deliveries', conversation: { kind: 'chat', handle: null } },
	calendar: { read: 'items', items: 'calendar', oauth: true, personal: true, call: 'http' }
} as const satisfies Record<string, DriverContract>;
/** One of Bolt's own driver kinds. */
export type DriverName = keyof typeof DRIVERS;
/** A driver an integration declares: its name, which host providers register under, and its contract. */
export const DeclaredDriver = Schema.Struct({ name: Schema.String, ...DriverContract.fields });
/** What a definition's `driver` holds: one of Bolt's kinds by name, or a driver it declares. */
export const DriverSpec = Schema.Union([Schema.Literals(EffectRecord.keys(DRIVERS)), DeclaredDriver]);
/** The name a definition's driver is registered under (host providers declare it). */
export const driver_name = (def: Pick<IntegrationSpec, 'driver'>): string =>
	typeof def.driver === 'string' ? def.driver : def.driver.name;
/** The contract of a definition's driver. */
export const driver_of = (def: Pick<IntegrationSpec, 'driver'>): DriverContract =>
	typeof def.driver === 'string' ? DRIVERS[def.driver] : def.driver;
type Contract<D> = D extends DriverName ? (typeof DRIVERS)[D] : D;

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
type InboundMail = {
	readonly id: string;
	readonly thread: string | null;
	readonly sent_at: Instant;
	readonly from: Address;
	readonly reply_to: Address | null;
	readonly to: readonly Address[];
	readonly cc: readonly Address[];
	readonly subject: string;
	readonly text: string;
	readonly html: string | null;
	readonly headers: { readonly [name: string]: string };
	readonly attachments: readonly Attachment[];
	/**
	 * The receiving mail server vouched for `from`'s domain: its top `Authentication-Results` (from a server the mailbox
	 * trusts) shows DMARC passing, or a DKIM signature aligned with it. Without it, `from` is a claim and links no member:
	 * a public envoy answers under its own policies, a private one sends its fixed notice.
	 */
	readonly authenticated?: boolean;
};
/** An inbound chat message. `thread` is the chat; `reply_to` the message it answers. */
type InboundChat = {
	readonly id: string;
	readonly thread: string;
	readonly sent_at: Instant;
	readonly from: { readonly handle: Handle; readonly name: string | null };
	readonly reply_to: string | null;
	readonly text: string;
	readonly attachments: readonly Attachment[];
	readonly group?: boolean;
	readonly participants?: readonly { readonly handle: string; readonly name: string | null }[];
};
/** A conversation's inbound message, by its kind. */
export type Inbound<K> = K extends 'email' ? InboundMail : K extends 'chat' ? InboundChat : never;
/** An inbound message as a sync's `read` receives it: the message as stored, its `version` (an edit is a new one) and whether it was deleted or recalled. */
export type MessageItem<K> = Inbound<K> & { readonly version: string; readonly deleted: boolean };
type Common = {
	/** Provider message id this message answers. */
	reply_to?: string;
	about?: RecordRef;
};
/** What a conversation sends, by its kind: a sync `write`'s `ctx.send`, an automation's `ctx.send` and an envoy's reply. */
type Outgoing<K> = K extends 'email'
	? Common & {
			to: readonly string[];
			cc?: readonly string[];
			bcc?: readonly string[];
			subject: string;
			html?: string;
			text?: string;
			/** The correlation id replies are matched back to. */ thread?: string;
			/** Stored files only: a message row keeps references, never bytes. */
			attachments?: readonly FileRef[];
		}
	: // the handle is the provider's own: a WhatsApp number or JID, a Slack channel, a Discord channel, a WeChat openid;
		// `@<user id>` on Slack or Discord is a direct message to that person
		K extends 'chat'
		? Common & {
				to: Handle | Id<'sys_conversation'>;
				text: string;
				attachments?: readonly FileRef[];
			}
		: never;

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
/**
 * One report about a message a sync's `write` sent (`ctx.send`): the report as the provider gave it, the message it is
 * about (the `$id` that `write` returned, so `read` maps it back to its row) and, for a reply, the reply.
 */
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

// ── driver-owned read payloads ──
/** A verified webhook delivery the inbox stored for an instance (deduplicated by its delivery id), oldest first. */
export type WebhookDelivery = {
	readonly kind: 'webhook';
	/** The delivery id (`webhook-id`, Stripe's event id, Slack's `event_id`, else the body's SHA-256). */
	readonly id: string;
	readonly at: Instant;
	readonly headers: { readonly [lowercase: string]: string };
	readonly body: Json;
};
/** An inbound message a conversation instance received since the last read. */
type MessageDelivery<K> = { readonly kind: 'message'; readonly message: MessageItem<K> };
/**
 * What a sync over definition `D` receives as `deliveries`: for a conversation definition, the inbound messages and the
 * delivery reports of the messages its `write` sent (each report is one arm, discriminated by `kind`); for any other,
 * the verified webhook deliveries.
 */
export type DeliveryOf<D, K = ConversationOf<D>> = [K] extends [never]
	? WebhookDelivery
	: MessageDelivery<K> | { [E in DeliveryKind]: DeliveryEvent<E, K> }[DeliveryKind];
/** When a calendar event starts or ends: a whole day, or an instant with the zone it was set in. */
type CalendarTime =
	{ readonly date: PlainDate } | { readonly at: Instant; readonly zone: IanaZone | null };
/**
 * One event a `calendar` driver pushes to a sync's `read` (`items`); the read's `partition` is its calendar (a sync's
 * `partitions` names the text-many configuration field listing them, one cursor each). A changed calendar wakes its
 * partition; lost history (`retained: false`) starts a fresh snapshot. All-day events keep their dates, timed events
 * their instants and source zones.
 */
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
/** What definition `D`'s driver pushes to a sync's `read` as `items`; `never` for a driver that pushes nothing. */
export type DriverItemOf<D> = Contract<DriverOf<D>> extends { items: 'calendar' } ? CalendarEvent : never;

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
/**
 * An instance's live request: credential host-side, paced by the definition's `rate` (a `429` with
 * `Retry-After` is honoured); it fails with a `FacilityFailure` or `Unavailable`.
 */
interface HttpRequester {
	<const O extends InputKind>(op: HttpOp<O>): Eff<ValueOf<O>, FacilityFailure | Unavailable>;
}
/** A database instance's live request: one bounded statement, its connection string host-side. */
interface DatabaseRequester {
	(op: DatabaseRequest): Eff<DatabaseResult, FacilityFailure | Unavailable>;
}

// ── a definition's derived types ──
type Part<S, K extends string> = S extends { [P in K]: infer V } ? V : {};
type DriverIn<S> = S extends { driver: infer D } ? D : never;
/** The message kind a definition's driver carries. */
type KindIn<S> = Contract<DriverIn<S>> extends { conversation: { kind: infer K } } ? K : never;
type RequestIn<S> =
	Contract<DriverIn<S>> extends { request: infer R }
		? R
		: Contract<DriverIn<S>> extends { call: infer R }
			? R
			: never;
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
/** The driver definition `D` names: a kind's name or its declared driver. */
export type DriverOf<D> = DriverIn<IntegrationSpecOf<D>>;
type ReadMode<K> = Contract<K> extends { read: infer R } ? R : never;
/** The single read payload a definition's driver supplies to a sync. */
export type DriverReadOf<D> = ReadMode<DriverOf<D>>;
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
/** A sync body's `ctx.request` through the instance it runs for: an HTTP requester, a database requester, or `never` (a conversation driver). */
export type RequesterOf<D> = Requester<IntegrationSpecOf<D>>;
/** An instance's decoded configuration for definition `D`: every defaulted field present, an `optional` one without a default absent or null. */
export type ConfigurationOf<D> = ConfigurationIn<IntegrationSpecOf<D>>;

// ── the literal ──
type HttpAuth<C> =
	{ bearer: C } | { header: { name: string; value: C } } | { basic: { user: C; password: C } };
/** A definition literal's data: what the manifest holds (the `test` body is not data). */
export const IntegrationSpec = Schema.Struct({
	description: Schema.String,
	driver: DriverSpec,
	/** Safe settings each instance edits at run time (with history), decoded against these fields. */
	configuration: Schema.optionalKey(Schema.Record(Schema.String, FieldData)),
	/** The secret each instance pairs with, sealed host-side and never readable (`http` and `sqlserver` only). */
	credential: Schema.optionalKey(Schema.Record(Schema.String, FieldData)),
	/**
	 * The OAuth client an `oauth` driver (http, calendar) grants with, by secret name; tokens are per instance. An http
	 * definition names its `authorize` and `token` endpoints too, and its requests carry the instance's token as a bearer.
	 */
	oauth: Schema.optionalKey(Schema.Struct({
		client: Schema.String, secret: Schema.String,
		authorize: Schema.optionalKey(Schema.String), token: Schema.optionalKey(Schema.String),
		scopes: Schema.optionalKey(Schema.Array(Schema.String))
	})),
	/** `http` only: the base URL (a literal or a text configuration field) and how requests authenticate. */
	http: Schema.optionalKey(Schema.Struct({
		base_url: Schema.String,
		auth: Schema.optionalKey(Schema.Union([
			Schema.Struct({ bearer: Schema.String }),
			Schema.Struct({ header: Schema.Struct({ name: Schema.String, value: Schema.String }) }),
			Schema.Struct({ basic: Schema.Struct({ user: Schema.String, password: Schema.String }) })
		]))
	})),
	/**
	 * `http` only: how the provider signs its webhooks, verified with a credential field. The instance page shows the
	 * endpoint URL to paste into the provider. Without `handle`, a verified delivery is stored (a duplicate delivery id is
	 * acknowledged and dropped) and is a hint: the engine runs `read` of every sync over this connection at once,
	 * debounced, and passes the stored deliveries to `read` as `deliveries`; with no read sync over the definition nothing
	 * is stored and the delivery is still answered 200. With `handle`, each verified delivery runs that body instead
	 * (`WebhookBody`), holding `policies`. `standard` is Standard Webhooks (`webhook-*` and Svix's `svix-*` headers).
	 */
	webhook: Schema.optionalKey(Schema.Struct({
		verify: Schema.Struct({ scheme: Schema.String, secret: Schema.String }),
		/** The policies the handler holds; required with `handle`. */
		policies: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
		/** The manifest's mark of a handler body (the body itself is the guest's). */
		handle: Schema.optionalKey(Schema.Literal(true))
	})),
	/**
	 * At most this many requests through one instance (`'10/s'`, `'600/min'`): every sync `read`, `write` and
	 * `ctx.request` waits its turn; a `429` with `Retry-After` is honoured on top. Request drivers only.
	 */
	rate: Schema.optionalKey(Schema.String)
});
export type IntegrationSpec = typeof IntegrationSpec.Type;
/** The configuration every instance of `def` starts with, however it was made (at runtime or from permitted seed data): its configuration fields' defaults. */
export const configuration_defaults = (
	def: Pick<IntegrationSpec, 'configuration'> | undefined
): { readonly [field: string]: Json } =>
	Object.fromEntries(
		Object.entries(def?.configuration ?? {}).flatMap(([k, f]) =>
			'default' in f && f.default !== undefined ? [[k, f.default]] : []
		)
	);

/** The `text` configuration fields that are not many-valued. */
type TextField<F> = {
	[P in keyof F]: F[P] extends { kind: 'text' } ? (F[P] extends { many: true } ? never : P) : never;
}[keyof F] &
	string;
type HttpFor<S> =
	DriverIn<S> extends 'http'
		? {
				base_url: `https://${string}` | TextField<Part<S, 'configuration'>>;
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

// ── the webhook handler ──
/** A verified delivery as `handle` receives it: `text` is the raw body, `body` the same decoded as JSON (else `null`). */
export type WebhookRequest = {
	readonly method: string;
	readonly headers: { readonly [lowercase: string]: string };
	readonly query: { readonly [name: string]: string };
	readonly body: Json;
	readonly text: string;
};
/** What `handle` answers the provider: `status` (200 by default) and `body` (a string as text, other JSON as JSON). */
export type WebhookReply = { readonly status?: number; readonly body?: Json } | void;
/**
 * `handle`'s ctx: reads (`query`) and writes (`act`) as the reserved system identity holding the webhook's `policies`,
 * the receiving instance and its configuration. Each act commits on its own; one act map commits together.
 */
export type WebhookCtx<S> = Omit<Clock, 'actor'> &
	CallerQuery & {
		readonly actor: Extract<Actor, { kind: 'system' }>;
		readonly invocation_id: string;
		readonly instance: Id<'sys_integration'>;
		readonly configuration: ConfigurationIn<S>;
		act: Act;
		/** Answers the provider 422 with this message. */
		refuse: Refuse<{}>;
	};
/**
 * Runs for each verified delivery to an instance and answers the provider: what it returns is the response (a refusal
 * 422, a failure 500, so the provider redelivers). A provider that redelivers repeats the body: key an act by the
 * delivery's own id (`{ key }`) to write once.
 */
type WebhookBody<N> = (request: WebhookRequest, ctx: WebhookCtx<SpecOf<N>>) => BodyReturn<WebhookReply>;

// ── the test body ──
/** The `test` body's ctx: the instance's configuration and its live request. */
interface TestCtx<S> {
	readonly configuration: ConfigurationIn<S>;
	request: Requester<S>;
}
/** Definition `N`'s data from the generated names; the general shape until the first sync knows it. */
type SpecOf<N> = [IntegrationSpecOf<N>] extends [never] ? IntegrationSpec : IntegrationSpecOf<N>;
/** Checks a freshly paired instance (the host's `test` verb): fails with any failure to refuse the pairing. */
type TestBody<N> = (ctx: TestCtx<SpecOf<N>>) => BodyReturn<void>;
type WebhookSpec = NonNullable<IntegrationSpec['webhook']>;
/** The literal an integration takes, with its inline test and webhook handler typed by the path-derived binding. */
export type IntegrationLiteral<N> = Omit<IntegrationSpec, 'webhook'> & {
	webhook?: Omit<WebhookSpec, 'handle'> & { handle?: WebhookBody<N> };
	test?: TestBody<N>;
};
interface IntegrationFor<N, S, D = DriverIn<S>> {
	description: string;
	driver: DriverName | typeof DeclaredDriver.Type;
	configuration?: ValidInputs<Part<S, 'configuration'>>;
	credential?: Contract<D> extends { credential: true }
		? ValidInputs<Part<S, 'credential'>>
		: 'error: only an http or sqlserver integration declares its credential';
	oauth?: OAuthFor<S>;
	http?: HttpFor<S>;
	webhook?: D extends 'http'
		? {
				verify: { scheme: WebhookScheme; secret: keyof Part<S, 'credential'> & string };
				policies?: NonEmpty<PolicyName>;
				handle?: Part<S, 'webhook'> extends { policies: unknown }
					? WebhookBody<N>
					: 'error: a webhook handler holds policies: declare webhook.policies';
			}
		: 'error: only an http integration declares a webhook';
	rate?: [RequestIn<S>] extends [never] ? 'error: only a request driver takes a rate' : Rate;
	test?: TestBody<N>;
}
/** What `integration()` returns: the name, the literal, and its `test` body as the guest calls it. */
export type Integration<N extends string, S> = {
	readonly name: N;
	readonly spec: S;
	readonly bodies: { readonly test?: Body; readonly webhook?: Body };
};

/**
 * `src/integration/<name>/+integration.ts`: one external system's connection: its driver, configuration, credential,
 * OAuth client, HTTP base and auth, webhook verification and handler, and request `rate`, with an optional `test` body
 * run when an instance is paired. Its durable instances (connections) are runtime `sys_integration` rows made by people or the
 * agent; source never declares one, and a release neither provisions nor deletes them. Each row's configuration is
 * decoded with its defaults on every write; its credential is collected masked at pairing and sealed host-side, never
 * entering a guest or the browser. What it exchanges is declared on models:
 * `sync('<model>', '<sync>', { with: '<name>', read?, write? })` in the model's `+<sync>.sync.ts`. `name` must equal the folder name. The definition carries no provider protocol:
 * conversation platforms are the host's providers, which a workspace cannot supply.
 * @returns Declaration metadata and its attached pairing-test body.
 * @example
 * import { integration } from '@norbital-ai/bolt';
 * export default integration('crm', {
 * 	description: 'The CRM account.',
 * 	driver: 'http',
 * 	http: { base_url: 'https://api.crm.example', auth: { bearer: 'api_key' } },
 * 	credential: { api_key: { kind: 'text', label: 'API key' }, signing_secret: { kind: 'text', label: 'Webhook signing secret' } },
 * 	webhook: {
 * 		verify: { scheme: 'standard', secret: 'signing_secret' },
 * 		policies: ['crm_inbound'],
 * 		handle: function* (request, ctx) {
 * 			yield* ctx.act({ 'leads.import': { rows: [{ ref: String(request.headers['webhook-id']) }], on_conflict: 'keep' } });
 * 			return { status: 202 };
 * 		}
 * 	},
 * 	rate: '10/s',
 * 	test: function* (ctx) {
 * 		yield* ctx.request({ method: 'GET', path: '/me', output: { kind: 'json' } });
 * 	}
 * });
 * @param name The integration's name: its folder.
 * @param spec Driver, configuration, credentials and the optional pairing test.
 */
/* @__NO_SIDE_EFFECTS__ */
export function integration<const N extends IntegrationName, const S extends IntegrationLiteral<N>>(
	name: N,
	spec: IntegrationLiteralInput<N, S>
): Integration<N, S> {
	const handle = spec.webhook?.handle;
	return {
		name,
		spec,
		bodies: {
			...(spec.test === undefined ? {} : { test: attached(spec.test, 0) }),
			...(handle === undefined ? {} : { webhook: attached(handle, 1) })
		}
	};
}

/** An integration literal with its driver-specific checks. */
export type IntegrationLiteralInput<
	N extends IntegrationName,
	S extends IntegrationLiteral<N>
> = S & NoInfer<Checked<IntegrationLiteral<N>, S, Exact<S, IntegrationFor<N, S>>>>;
