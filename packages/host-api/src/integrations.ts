// Integration drivers: what a host's providers implement and what an instance's link reports. A driver is one of a
// release's kinds or one a definition declares, by name; a provider is a host's implementation of one (Baileys or
// Twilio for `whatsapp`, a mailbox for `email`). The release's links manager opens one `Link` per instance from the
// provider the operator chose, hands it the instance's credentials under its epoch, and turns what the link reports
// into the one `InstanceStatus` the shell draws. A provider's setup is data (`SetupDescription`).
import { DateTime, Effect, Option, Schema, SchemaTransformation } from 'effect';
import { SqlServerRequest } from '@norbital-ai/store/sqlserver';
import { HOST_LIMITS, type TcpPort } from './facilities.ts';
import type { Json } from '@norbital-ai/store';

/** An optional key whose value is dropped, not fatal, when it does not decode: one stray member never hides the rest. */
const tolerant = <S extends Schema.Constraint>(schema: S) =>
	Schema.optionalKey(Schema.catchDecoding<S>(() => Effect.succeedNone)(schema));
/** The members of a list that decode as `item`, the others dropped; anything but a list is empty. */
const listOf = <A>(item: Schema.Codec<A, unknown>): Schema.Codec<ReadonlyArray<A>, unknown> =>
	Schema.Unknown.pipe(
		Schema.decodeTo(
			Schema.Array(Schema.toType(item)),
			SchemaTransformation.transform<ReadonlyArray<A>, unknown>({
				decode: (u) =>
					Array.isArray(u)
						? u.flatMap((x) => Option.toArray(Schema.decodeUnknownOption(item)(x)))
						: [],
				encode: (xs) => xs
			})
		)
	);

// ── an integration instance's status: what a link reports and the shell draws ──
/**
 * Where an instance's link is. `pairing` is the provider asking for something; `reconnecting` is a retry after a drop
 * and is progress, not failure; `error` is the only terminal one and names its own recovery in `error`.
 */
export const InstanceState = Schema.Literals([
	'unpaired',
	'connecting',
	'pairing',
	'connected',
	'reconnecting',
	'error'
]);
export type InstanceState = typeof InstanceState.Type;
/** Operator-facing text a provider supplies: English, and each framework locale it is written in (the shell picks by locale). */
export const LocalText = Schema.Union([
	Schema.String,
	Schema.Struct({ en: Schema.String, zh: tolerant(Schema.String) })
]);
export type LocalText = typeof LocalText.Type;
/** One input a provider's setup collects. `secret` is drawn masked and never echoed back in `about`. */
export const SetupField = Schema.Struct({
	name: Schema.String,
	label: LocalText,
	secret: tolerant(Schema.Boolean),
	hint: tolerant(LocalText),
	optional: tolerant(Schema.Boolean),
	/** A choice among these values (the first is the default), instead of free text. */
	options: Schema.optionalKey(listOf(Schema.Struct({ value: Schema.String, label: LocalText })))
});
export type SetupField = typeof SetupField.Type;
/**
 * One instruction, in order. `href` is where to do it (the provider's console); `copy` a value to paste there: the
 * instance's `webhook_url`, or `redirect_url` (the host's one OAuth callback, to register with an OAuth app once).
 */
export const SetupStep = Schema.Struct({
	text: LocalText,
	href: tolerant(Schema.String),
	copy: tolerant(Schema.Literals(['webhook_url', 'redirect_url']))
});
export type SetupStep = typeof SetupStep.Type;
/**
 * How a provider is set up, as data the shell renders with no provider-named component. `kind` is what `pair`
 * takes: `form` sends `fields`; `qr`/`code` sends the optional `fields` and then shows what `pairing` publishes; `oauth`
 * sends nothing and publishes a sign-in; `none` needs nothing. A `qr`, `code` or `oauth` setup starts on Connect.
 * `webhook`: the operator pastes `about.webhook_url` into the provider.
 */
export const SetupDescription = Schema.Struct({
	kind: Schema.Literals(['form', 'qr', 'code', 'oauth', 'none']),
	steps: listOf(SetupStep).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
	fields: Schema.optionalKey(listOf(SetupField)),
	webhook: tolerant(Schema.Boolean)
});
export type SetupDescription = typeof SetupDescription.Type;
/** An ISO instant with its zone or offset. */
const ImportInstant = Schema.String.check(
	Schema.makeFilter(
		(value: string) => /(Z|[+-]\d{2}:?\d{2})$/i.test(value) && Option.isSome(DateTime.make(value))
	)
);
const ImportZone = Schema.String.check(
	Schema.makeFilter((value: string) => value !== '' && Option.isSome(DateTime.zoneMakeNamed(value)))
);
/** A persisted source boundary. A missing boundary retains the instance's previous all-history behavior. */
export const ImportStart = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('all') }),
	Schema.Struct({
		kind: Schema.Literal('since'),
		at: ImportInstant,
		zone: ImportZone,
		origin: Schema.Literals(['now', 'date'])
	}),
	Schema.Struct({
		kind: Schema.Literal('native'),
		selected_at: ImportInstant,
		provider: Schema.String,
		values: Schema.Record(Schema.String, Schema.String)
	})
]);
export type ImportStart = typeof ImportStart.Type;
/** The host freezes From now and resolves a selected civil day's midnight in its chosen IANA zone. */
export const ImportStartInput = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('all') }),
	Schema.Struct({ kind: Schema.Literal('now'), zone: Schema.String }),
	Schema.Struct({ kind: Schema.Literal('since'), date: Schema.String, zone: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal('native'),
		provider: Schema.String,
		values: Schema.Record(Schema.String, Schema.String)
	})
]);
export type ImportStartInput = typeof ImportStartInput.Type;
/** Where a provider can start an import from: a `timestamp` (optionally to the second) or its own `native` fields. */
export const ImportStartCapability = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal('timestamp'),
		precision: Schema.optionalKey(Schema.Literal('second'))
	}),
	Schema.Struct({ kind: Schema.Literal('native'), fields: Schema.Array(SetupField) })
]);
export type ImportStartCapability = typeof ImportStartCapability.Type;
/** A provider as the shell offers it: a driver with several (WhatsApp) asks which, by `label`, first. */
export const ProviderChoice = Schema.Struct({
	id: Schema.String,
	label: LocalText,
	setup: SetupDescription,
	import_start: Schema.optionalKey(ImportStartCapability),
	/** Short catalogue name; the full registration label remains in `label`. */
	name: tolerant(LocalText),
	/** Concise catalogue description, localized by the authored surface. */
	description: tolerant(LocalText),
	/** Iconify provider mark, with a generic plug fallback when absent. */
	icon: tolerant(Schema.String),
	/** `false`: the host has no OAuth client for its sign-in (`Provider.oauth`), so it cannot connect here. */
	available: tolerant(Schema.Boolean)
});
export type ProviderChoice = typeof ProviderChoice.Type;
/** A connected instance's test send: a short test message, to the handle the operator types in `to` (absent: to the connected account itself). */
export const TestSend = Schema.Struct({ to: Schema.optionalKey(SetupField) });
export type TestSend = typeof TestSend.Type;
/** What the provider wants from the operator, when it wants something. `value` is the payload to draw (a QR, a code). */
export const Pairing = Schema.Struct({
	/**
	 * `qr`: scan `value`; `code`: show `value` for the operator to type; `credential`: collect a secret and send it back;
	 * `form`: collect `fields` and send them back as one object; `oauth`: open `value` (the provider's authorize URL) in a
	 * popup, where the operator signs in; the provider's redirect lands on the host's one OAuth callback.
	 */
	kind: Schema.Literals(['qr', 'code', 'credential', 'form', 'oauth']),
	value: Schema.NullOr(Schema.String).pipe(
		Schema.catchDecoding(() => Effect.succeedSome(null)),
		Schema.withDecodingDefaultKey(Effect.succeed(null))
	),
	/** The provider's own deadline for `value` (ISO), when it publishes one. */
	expires_at: tolerant(Schema.String),
	/** What to call the field, for `credential` (a Telegram bot token is not "credential"); `oauth`: the sign-in button. */
	label: tolerant(Schema.String),
	/** `form`: what to collect, sent back as `{ [name]: value }`. */
	fields: Schema.optionalKey(listOf(SetupField))
});
export type Pairing = typeof Pairing.Type;
const LinkStatusFields = {
	state: InstanceState,
	/** The verified identity it is connected as (a number with its device suffix stripped, a mailbox, a bot). */
	account: tolerant(Schema.NullOr(Schema.String)),
	/** Operator-readable context for a non-terminal state. */
	detail: tolerant(Schema.String),
	/** The recovery `error` needs, operator action. */
	error: tolerant(Schema.String),
	/** A terminal error's kind (`replaced`, `loggedOut`, `forbidden`, …), for a notice that names its action. */
	code: tolerant(Schema.String),
	/** The provider's last disconnect (its code, tag and instant). */
	last_disconnect: Schema.optionalKey(Schema.Json),
	/**
	 * Facts the connected view shows generically: `webhook_url`, `address` (email), `botName`, `workspace`/`team` (Slack),
	 * `guilds`/`inviteUrl` (Discord), `account` (WeChat), `from` (Twilio number).
	 */
	about: Schema.optionalKey(Schema.Json)
};
/** What a link reports of itself (`DriverOpen.status`): where it is, as whom, and the facts the connected view shows. */
export const LinkStatus = Schema.Struct(LinkStatusFields);
export type LinkStatus = typeof LinkStatus.Type;
/**
 * One instance as the shell shows it (`GET`/`stream` of `/__bolt/integrations/<instance>`): its link's status and the
 * host's choices. A malformed member is dropped; a malformed state, instance or driver refuses the whole answer.
 */
export const InstanceStatus = Schema.Struct({
	...LinkStatusFields,
	instance: Schema.String,
	integration: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
	/** A driver's name: one of the release's kinds or one a definition declares. */
	driver: Schema.String,
	/** Its driver carries a conversation. */
	conversation: Schema.optionalKey(Schema.Boolean),
	/** A credential is stored, so reconnecting needs no new pairing. */
	stored: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
	/** When `state` was entered. */
	since: tolerant(Schema.String),
	pairing: Schema.optionalKey(
		Schema.NullOr(Pairing).pipe(Schema.catchDecoding(() => Effect.succeedSome(null)))
	),
	/** The active provider's id (`twilio` | `baileys` for WhatsApp), once one is chosen. */
	provider: tolerant(Schema.String),
	/** What the driver can be set up with on this host; the shell asks which when there are several. */
	providers: Schema.optionalKey(listOf(ProviderChoice)),
	import_start: Schema.optionalKey(Schema.NullOr(ImportStart)),
	/** Present when the connected provider can send a test message: the shell offers Test, asking for `to` when it names one. */
	test: tolerant(TestSend)
});
export type InstanceStatus = typeof InstanceStatus.Type;

// ── delivery ──
/**
 * A provider-chosen id persisted before I/O; registration alone is no delivery acknowledgement. Registration refuses
 * another account's message, a paused or personal account, a changed id or another environment epoch.
 */
export const OutboundReference = Schema.Struct({
	message: Schema.NonEmptyString,
	provider_id: Schema.NonEmptyString
});
export type OutboundReference = typeof OutboundReference.Type;
/**
 * A send's acknowledgement, decoded once where the provider crosses into the engine: the `provider_id` delivery events
 * name, and optionally how long a quiet window lasts before the message is presumed delivered.
 */
export const SendReceipt = Schema.Struct({
	provider_id: Schema.NonEmptyString,
	presume_after_ms: Schema.optional(Schema.Number)
});
export type SendReceipt = typeof SendReceipt.Type;
/** What a provider may report about a message it sent; replies and auto-replies arrive as inbound messages instead. */
export const REPORTED_KINDS = [
	'sent',
	'deferred',
	'delivered',
	'read',
	'opened',
	'bounced',
	'failed',
	'complained'
] as const;
/** What a provider reports about one message it sent, keyed by the `provider_id` its `send` returned. */
export type DeliveryReport = {
	kind: (typeof REPORTED_KINDS)[number];
	at: string;
	provider: string;
	code?: string;
	reason?: string;
	permanent?: boolean;
	presumed?: boolean;
	approximate?: boolean;
	/** Bounded to 4 KB by the release. */
	raw?: Json;
};

// ── the driver contract ──
/**
 * What an instance's link hands the engine (`integrations.receive`): inbound conversation messages (each attachment
 * `{ name, mime, bytes, bin? }`, its bytes in `bins` at `bin`; `history` is a backfill nobody waits on), a provider's
 * report on a message it sent (`provider_id` is what its `send` answered), a chat the account cleared or deleted
 * (`clear`: every message of `thread` sent at or before `before` is tombstoned), or a pushing driver's changed sync
 * partition (`sync`: `'<model>.<sync>'`).
 */
export type DriverEvent =
	| { kind: 'messages'; messages: readonly Json[]; history?: true; bins?: readonly Uint8Array[] }
	/** Await registration before sending when the provider chooses its message id before I/O. */
	| ({ kind: 'outbound_ref' } & OutboundReference)
	| { kind: 'delivery'; provider_id: string; report: DeliveryReport }
	| { kind: 'clear'; thread: string; before: string }
	/** The sender is typing (`typing: true`) in `thread`: a held burst waits for the rest, up to its cap. */
	| { kind: 'presence'; thread: string; typing: boolean }
	| { kind: 'invalidate'; sync: string; partition: string };
/**
 * One of `message.attachments` (stored FileRefs, in order) as the release hands it to `send`: the bytes read through the
 * host's files port, all of a message's together at most the release's attachment cap. `url` is a signed link a provider
 * that fetches media itself may pass on (Twilio's MediaUrl); it throws where the host serves no file links.
 */
export type OutboundAttachment = {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
	url(expiresInS: number): Promise<string>;
};
/** A pushing driver's page of a sync partition: its items (the sync `read`'s `items`), and the page facts a `read` page carries. */
export type DriverPage = {
	items: readonly Json[];
	cursor: Json;
	more: boolean;
	snapshot?: 'begin' | 'end';
	retained?: false;
	health?: { state: 'ready' | 'attention'; code?: string; message?: string };
};
/**
 * The platform's current view of one thread since an instant (`Link.reconcile`). `messages` is what a `messages` event
 * would carry, with `bins` for its bytes: what others wrote, and a personal account's own messages marked `outbound`.
 * `complete` says it holds every message of the window, so what it lacks was deleted; a partial page repairs what it
 * shows and deletes nothing. `since` narrows the window: the instant the platform's history really reaches back to,
 * when that is later than the instant asked for.
 */
export type ReconcilePage = {
	messages: readonly Json[];
	complete: boolean;
	since?: string;
	bins?: readonly Uint8Array[];
};
/**
 * The host's live side of integration instances, by instance id: a conversation driver `send`s (and shows `typing`),
 * a request driver (http, sqlserver) answers `request` with the instance's credential host-side, a pushing driver `read`s
 * a sync partition's page. A throw is a facility failure; `SendRefused` refuses a send (permanent or retried). An http `request`
 * answers `{ status, body }`, a database one the `DatabaseResult`.
 */
export interface LinksPort {
	send?(
		instance: string,
		message: Schema.Json,
		signal: AbortSignal,
		attachments?: readonly OutboundAttachment[]
	): Promise<SendReceipt>;
	typing?(instance: string, to: string, signal: AbortSignal, on: boolean): Promise<void>;
	request?(instance: string, op: Json, signal: AbortSignal): Promise<Json>;
	read?(
		instance: string,
		sync: string,
		partition: string,
		cursor: Json | null,
		signal: AbortSignal
	): Promise<DriverPage>;
	/**
	 * A committed change of what an instance's session link opened with — its `configuration` or its pause — or its
	 * deletion: the link closes, and opens again from the row as it is then when it is active and paired (a calendar
	 * watches what it names now; a resumed instance reconnects).
	 */
	changed?(instance: string): void;
}
/** An authorization server whose OAuth client a host may provide, so a workspace need not register its own. */
/** The host path an OAuth provider redirects back to after a link's consent. */
export const OAUTH_CALLBACK = '/hooks/oauth/callback';
/** An OAuth provider a host holds a client for. */
export type OAuthVendor = 'google';
/** A host's OAuth client: its id and secret. */
export type OAuthClient = { readonly id: string; readonly secret: string };
/** One configuration or credential field a definition declares, as a provider reads it: its label and whether it may be left out. */
const IntegrationField = Schema.Struct({
	label: Schema.optionalKey(Schema.String),
	optional: Schema.optionalKey(Schema.Boolean)
});
/**
 * An integration definition as a provider reads it: its driver, its OAuth client's secret names and scopes, an `http`
 * definition's base URL and auth, and its field declarations.
 */
export const IntegrationDefinition = Schema.Struct({
	description: Schema.String,
	/** One of the release's kinds by name, or a driver the definition declares. */
	driver: Schema.Union([Schema.String, Schema.Struct({ name: Schema.String })]),
	configuration: Schema.optionalKey(Schema.Record(Schema.String, IntegrationField)),
	credential: Schema.optionalKey(Schema.Record(Schema.String, IntegrationField)),
	oauth: Schema.optionalKey(
		Schema.Struct({
			client: Schema.String,
			secret: Schema.String,
			authorize: Schema.optionalKey(Schema.String),
			token: Schema.optionalKey(Schema.String),
			scopes: Schema.optionalKey(Schema.Array(Schema.String))
		})
	),
	/** `http` only: the base URL (a literal or a text configuration field) and how requests authenticate. */
	http: Schema.optionalKey(
		Schema.Struct({
			base_url: Schema.String,
			auth: Schema.optionalKey(
				Schema.Union([
					Schema.Struct({ bearer: Schema.String }),
					Schema.Struct({ header: Schema.Struct({ name: Schema.String, value: Schema.String }) }),
					Schema.Struct({ basic: Schema.Struct({ user: Schema.String, password: Schema.String }) })
				])
			)
		})
	),
	webhook: Schema.optionalKey(Schema.Unknown)
});
export type IntegrationDefinition = typeof IntegrationDefinition.Type;
/** What the links manager hands a provider to open one instance's link. Credentials stay host-side, under the opener's epoch. */
export type DriverOpen = {
	instance: string;
	/** The instance's integration definition, including its request and credential fields. */
	definition: IntegrationDefinition;
	/** Model read syncs using this instance's definition; `name` is `'<model>.sync.<sync>'`. */
	readonly syncs: readonly {
		readonly name: string;
		/** The configuration field whose values partition this sync, otherwise one default partition. */
		readonly partitions?: string;
	}[];
	/** A personal instance (an owner's own account): it syncs and never sends a message; a command may write back to it. */
	personal: boolean;
	configuration: Json;
	/** Frozen source import boundary; absent or null retains all history. */
	import_start?: ImportStart | null;
	/** This instance's own inbound URL, shown to the operator and registered with the provider where it can. */
	webhook_url: string;
	/**
	 * The host's one OAuth redirect URI (`<public URL>/hooks/oauth/callback`), the same for every instance: register it
	 * with the OAuth app once. Its callback reaches this link's `webhook` by the `state` it carries, minted by `state()`.
	 */
	redirect_url: string;
	/**
	 * A fresh, unguessable OAuth `state` that routes its callback back to this instance; the link still checks it is its
	 * own. Asynchronous, as every call into the engine: the engine may be in another isolate.
	 */
	state(): Promise<string>;
	/** Aborted when the link closes or is replaced. */
	signal: AbortSignal;
	/** The fetch to reach the provider with (tests pass a fake). */
	fetch: typeof fetch;
	/** Raw TCP/TLS to the provider's servers (IMAP, SMTP), under the host's egress policy. */
	tcp: TcpPort;
	/**
	 * The OAuth client to grant with for `vendor`: the definition's own (`oauth.client`, `oauth.secret`, both set in the
	 * workspace's secrets), else the host's (`LinkHost.oauth`); `undefined` when neither is configured. Without a
	 * vendor, only the definition's own.
	 */
	oauth_client(vendor?: OAuthVendor): Promise<OAuthClient | undefined>;
	/**
	 * The instance's credentials as they were when the link opened (`provider` is the manager's); a write is one fenced
	 * statement retried until it lands, and rejects for good once another link opened the instance (`fenced`) — for a
	 * request link, once another call wrote since this one read.
	 */
	credentials: {
		load(): Promise<ReadonlyMap<string, Json>>;
		write(changes: ReadonlyMap<string, Json | null>): Promise<void>;
	};
	/** Into the engine: resolves after it committed; a rejection means "do not acknowledge", so the provider redelivers. */
	emit(e: DriverEvent): Promise<void>;
	/** The link moved; a durable state (connected, unpaired, error) lands on the instance row when it changed. */
	status(s: LinkStatus): Promise<void>;
	/** An ephemeral QR or code (or `null` once it is gone), streamed to the shell and never stored. */
	pairing(p: Pairing | null): void;
};
/** One instance's live link: whichever of these its driver supports. */
export type Link = { close(): Promise<void> } & Partial<{
	/** The operator's setup input (`SetupDescription`); rejects with the refusal the shell shows verbatim. */
	pair(input: Json): Promise<void>;
	/** Forgets this host at the provider; the manager destroys the credentials. */
	unpair(): Promise<void>;
	/** The provider's own test (send, then read it back); absent → the release sends a short message to the test target. */
	test(input: Json): Promise<void>;
	/**
	 * Sends one queued conversation message; answers the `provider_id` its delivery reports will name. A provider that
	 * picks the id before contacting the recipient (SMTP) first awaits `emit({ kind: 'outbound_ref', … })`, so a reply
	 * finds the queued conversation before this resolves. Throw `SendRefused` for a refusal; any other failure after
	 * handoff leaves the message `uncertain`.
	 */
	send(
		message: Schema.Json,
		signal: AbortSignal,
		attachments?: readonly OutboundAttachment[]
	): Promise<SendReceipt>;
	/** The chat shows this account typing to `to` (`on`), or stops showing it. */
	typing(to: string, signal: AbortSignal, on: boolean): Promise<void>;
	/** A request driver's op (an http `{ method, path, … }` answering `{ status, body }`, a database request its rows), or a pushing driver's `call` through this link. */
	request(op: Json, signal: AbortSignal): Promise<Json>;
	/** A pushing driver's sync page from `cursor` (its `invalidate` event names the sync and partition). */
	read(
		sync: string,
		partition: string,
		cursor: Json | null,
		signal: AbortSignal
	): Promise<DriverPage>;
	/**
	 * The platform's current view of `thread` since the instant `since`. Absent where the platform keeps no history. The
	 * links manager calls it for recent threads when the link connects and once a day after, one thread at a time.
	 */
	reconcile(thread: string, since: string, signal: AbortSignal): Promise<ReconcilePage>;
	/** The resources a configuration may name (calendars), for the operator to pick. */
	discover(): Promise<readonly { id: string; label: string }[]>;
	/** Renews what the provider expires (a calendar watch); the next instant to renew at, or `null`. */
	renew(): Promise<string | null>;
	/** Inbound HTTP on `webhook_url` and the paths under it (a pixel), and its OAuth callback on `redirect_url`, as the public request: the signature is checked here. */
	webhook(request: Request): Promise<Response>;
}>;
/**
 * A provider (`@norbital-ai/providers`, or a host's own), registered by the host for one driver by name. A release never
 * names one. It runs in the host, outside the guest wall, with sealed credentials, raw network and direct `emit`, which
 * is why a workspace cannot supply one. The contract stays Promise + AbortSignal + JSON; the engine adapts it once,
 * aborting the signal on interruption and decoding every answer. A provider acknowledges an inbound delivery only after
 * `emit` resolves, so a refused store is redelivered.
 */
export type Provider = ProviderChoice & {
	/** The driver's name: one of the release's kinds, or a driver a definition declares (`whatsapp`, `slack`, …). */
	driver: string;
	/** Required for a native boundary: validates and normalizes only this provider's declared fields. */
	validate_import_start?(
		values: Readonly<Record<string, string>>
	): Promise<Readonly<Record<string, string>>>;
	/** It imports a personal account (history and own sent messages) without sending. */
	personal?: boolean;
	/** It signs in with this vendor's OAuth client (`DriverOpen.oauth_client`); offered only where one is configured. */
	oauth?: OAuthVendor;
	/** The provider can send a test message once connected (`POST …/test`). */
	test?: TestSend;
	/**
	 * `send` is idempotent by `message.id`: a repeat reaches the customer once, so a send that timed out is sent again.
	 * Otherwise such a message stays `uncertain`, since the first send may have arrived.
	 */
	idempotent_sends?: boolean;
	/** Provider-owned registration text for a personal or a workspace instance of `definition`; credentials and pairing keep the same runtime. */
	describe?(options: {
		readonly personal: boolean;
		readonly definition: IntegrationDefinition;
	}): Pick<ProviderChoice, 'label' | 'setup'>;
	open(ctx: DriverOpen): Promise<Link>;
};

/**
 * Schema of one structured database program a guest sends through a database link (today the SQL Server shape):
 * `values`, `read`, `call`, CDC metadata and pages, and `insert_once`. The workspace names qualified tables, projected
 * columns, filters, decimal/date formats and its delete policy; the host compiles the native SQL. CDC pages reconcile
 * current rows and tombstones from an inclusive LSN/sequence/operation/key cursor. `insert_once` takes an immutable
 * key and fingerprint, a five-second native lock and one serializable header/child/procedure batch, and answers an
 * exact receipt; `call` names a procedure with typed arguments over native RPC. Cancellation, row and byte bounds, TLS
 * identity and network admission apply to every program.
 * @example
 * yield* ctx.request(erp, { op: 'read', table: { schema: 'accounting', name: 'products' }, columns: ['code', 'name'],
 * 	where: { active: true }, max_rows: 100 });
 */
export const DatabaseRequest = SqlServerRequest;
export type DatabaseRequest = typeof DatabaseRequest.Type;
/** Schema of a database link's answer: its rows as JSON column maps. */
export const DatabaseResult = Schema.Struct({
	rows: Schema.Array(Schema.Record(Schema.String, Schema.Json))
});
export type DatabaseResult = typeof DatabaseResult.Type;
/** Default most rows a database result may carry; more fails `overflow`, never a truncation. */
export const DATABASE_MAX_ROWS = 1_000;
/** Most JSON bytes a database result may carry (the crossing limit); more fails `overflow`. */
export const DATABASE_MAX_BYTES = HOST_LIMITS.crossingBytes;
/** A host's database driver (a request-only link's implementation); it must not expose its connection in answers or errors. */
export interface DatabaseDriver {
	query(credential: Json, request: DatabaseRequest, signal: AbortSignal): Promise<DatabaseResult>;
}
