// The host contract of integration drivers (§4.5). A driver is a kind bolt names (`DRIVERS`); a provider is a host's
// implementation of one (Baileys or Twilio for `whatsapp`, a mailbox for `email`, the host's own for `http`/`sqlserver`).
// The host registers its providers; the links manager (`links.ts`) opens one `Link` per instance from the provider the
// operator chose at pairing (sealed as the credential `provider`), hands it the instance's credentials under its epoch,
// and turns what the link reports into the one `InstanceStatus` the shell draws. Nothing here knows a provider (P18):
// a provider's setup is data (`SetupDescription`), its state one of a few words, its facts an `about` object.
import type { DriverName, IntegrationSpec } from '../../decl/runtime/integration.ts';
import type { Json } from '../../decl/values.ts';
import type { DriverEvent, DriverPage, OutboundAttachment, TcpPort } from '../contracts.ts';
import type {
	ImportStart,
	LinkStatus,
	Pairing,
	ProviderChoice,
	TestSend
} from '../../protocol/instance-status.ts';

/** An authorization server whose OAuth client a host may provide, so a workspace need not register its own. */
export type OAuthVendor = 'google';
export type OAuthClient = { readonly id: string; readonly secret: string };
/** The client `DriverOpen.oauthClient` answers: the definition's own when both its secrets are set, else the host's. */
export const oauthClientOf = (
	definition: Pick<IntegrationSpec, 'oauth'>,
	secrets: Readonly<Record<string, string>> | undefined,
	host: Partial<Record<OAuthVendor, OAuthClient>> | undefined,
	vendor?: OAuthVendor
): OAuthClient | undefined => {
	const id = definition.oauth === undefined ? undefined : secrets?.[definition.oauth.client],
		secret = definition.oauth === undefined ? undefined : secrets?.[definition.oauth.secret];
	return id !== undefined && id !== '' && secret !== undefined && secret !== ''
		? { id, secret }
		: vendor === undefined
			? undefined
			: host?.[vendor];
};

/** What the links manager hands a provider to open one instance's link. Credentials stay host-side, under the opener's epoch. */
export type DriverOpen = {
	instance: string;
	/** The instance's integration definition, including its request and credential fields. */
	definition: IntegrationSpec;
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
	importStart?: ImportStart | null;
	/** This instance's own inbound URL, shown to the operator and registered with the provider where it can. */
	webhookUrl: string;
	/**
	 * The host's one OAuth redirect URI (`<public URL>/hooks/oauth/callback`), the same for every instance: register it
	 * with the OAuth app once. Its callback reaches this link's `webhook` by the `state` it carries, minted by `state()`.
	 */
	redirectUrl: string;
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
	 * workspace's secrets), else the host's (`LinksHost.oauth`); `undefined` when neither is configured. Without a
	 * vendor, only the definition's own.
	 */
	oauthClient(vendor?: OAuthVendor): Promise<OAuthClient | undefined>;
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
	/** The provider's own test (send, then read it back); absent → bolt sends a short message to the test target. */
	test(input: Json): Promise<void>;
	send(
		message: Json,
		signal: AbortSignal,
		attachments?: readonly OutboundAttachment[]
	): Promise<{ providerId: string; presumeAfterMs?: number }>;
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
	/** The resources a configuration may name (calendars), for the operator to pick. */
	discover(): Promise<readonly { id: string; label: string }[]>;
	/** Renews what the provider expires (a calendar watch); the next instant to renew at, or `null`. */
	renew(): Promise<string | null>;
	/** Inbound HTTP on `webhookUrl` and the paths under it (a pixel), and its OAuth callback on `redirectUrl`, as the public request: the signature is checked here. */
	webhook(request: Request): Promise<Response>;
}>;
/** A provider (`@norbital-ai/providers`, or a host's own), registered by the host for one driver kind. Bolt never names one. */
export type Provider = ProviderChoice & {
	driver: DriverName;
	/** Required for a native boundary: validates and normalizes only this provider's declared fields. */
	validateImportStart?(
		values: Readonly<Record<string, string>>
	): Promise<Readonly<Record<string, string>>>;
	/** It imports a personal account (history and own sent messages) without sending. */
	personal?: boolean;
	/** It signs in with this vendor's OAuth client (`DriverOpen.oauthClient`); offered only where one is configured. */
	oauth?: OAuthVendor;
	/** The provider can send a test message once connected (`POST …/test`). */
	test?: TestSend;
	/** Provider-owned registration text for a personal or a workspace instance of `definition`; credentials and pairing keep the same runtime. */
	describe?(options: {
		readonly personal: boolean;
		readonly definition: IntegrationSpec;
	}): Pick<ProviderChoice, 'label' | 'setup'>;
	open(ctx: DriverOpen): Promise<Link>;
};
