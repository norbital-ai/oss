import type {
	HostAiBinding,
	HostAppPlugin,
	HostDbBinding,
	HostFileStorageBinding,
	HostMapsBinding,
	HostMessagingBinding,
	RuntimeFacilityName
} from '@norbital-ai/platform-utils/runtime/binding';
import type { TBaseScope } from '@norbital-ai/platform-utils/scope/types';
import type { HostDbAdapter } from './db.js';

/**
 * Read a required value from the host's environment.
 *
 * Config files use this instead of `process.env.X!` so a missing value fails at startup naming the
 * variable, rather than reaching a driver as `undefined` and surfacing as a connection error that
 * says nothing about which setting was left out.
 */
export function env(name: string, fallback?: string): string {
	const value = process.env[name]?.trim();
	if (value) return value;
	if (fallback !== undefined) return fallback;
	throw new Error(`Missing required environment variable: ${name}`);
}

/**
 * The host contract for a Pod workspace.
 *
 * A built workspace declares the facilities it needs; a host declares the facilities it supplies.
 * Core is one host. `pod start` is another. Anything that implements this file is a third — which
 * is the whole point: the workspace bundle is identical in every case, and only the identity
 * source and the credential-holding implementations differ.
 */

/**
 * Who a request belongs to.
 *
 * A provider must establish the requestor and the organisation. It may stop there — Pod resolves
 * the rest of the scope (role, status, team membership) from the tenant database, which is what
 * `resolveRequestorBaseScope` already does for a header-only identity. A provider that already
 * holds a complete, trusted scope (Core does) returns it as `baseScope` and skips that lookup.
 */
export type HostIdentity = {
	readonly userId: string;
	readonly organizationId: string;
	readonly organizationName: string;
	/** A pre-resolved scope. Supplied only by a host that is itself the authority on it. */
	readonly baseScope?: TBaseScope;
};

/**
 * A person a provider has authenticated but cannot name a workspace user for.
 *
 * This is what lets a provider verify a credential without owning the user directory. A provider that
 * knows only "this address was proven" returns a subject; Pod resolves it against `user.email` —
 * matching an existing row, accepting a pending invitation and creating one, or refusing. Requiring a
 * `userId` is what previously forced the directory to live wherever the credential did.
 */
export type HostSubject = {
	readonly email: string;
	/** A stable provider-side identifier, when the provider has one (an OIDC `sub`). */
	readonly externalId?: string;
	readonly displayName?: string;
};

export type HostVerifiedSubject = {
	readonly subject: HostSubject;
	readonly organizationId: string;
	readonly organizationName: string;
};

/**
 * What a provider may return for a request.
 *
 * `HostIdentity` and `HostVerifiedSubject` are both "authenticated". A `Response` means "not
 * authenticated, and here is how to fix it" — a redirect to a login page, or a `WWW-Authenticate`
 * challenge — which is what makes a browser-facing provider expressible: `null` produces a bare 401,
 * and a 401 cannot send anyone anywhere.
 */
export type HostAuthentication = HostIdentity | HostVerifiedSubject | Response | null;

export function isVerifiedSubject(value: HostAuthentication): value is HostVerifiedSubject {
	return value != null && !(value instanceof Response) && 'subject' in value;
}

/**
 * Authenticates an inbound request.
 *
 * Returning `null` means "not authenticated" and produces a 401 — it is not an error path, so a
 * provider must not throw for an anonymous request. Throwing is reserved for a provider that is
 * itself misconfigured, and surfaces as a 500 rather than silently denying every request.
 *
 * `handleRoute` lets a provider own endpoints of its own (a login form, an OIDC callback, a
 * logout). It is consulted before authentication on every request, and returning `null` means
 * "not my route". This is what makes a redirect-based provider expressible without Pod knowing
 * anything about the protocol it speaks.
 */
export type HostIdentityProvider = {
	/** Diagnostic name, reported on startup so a misconfigured host is obvious in the log. */
	readonly name: string;
	authenticate(request: Request): Promise<HostAuthentication> | HostAuthentication;
	handleRoute?(request: Request): Promise<Response | null> | Response | null;
};

/**
 * A built-in provider named as data rather than constructed.
 *
 * The built-in providers need things a configuration file cannot reach: a mailer (the host's messaging
 * facility) and the invitation table (inside the tenant database). Asking an operator to wire those
 * would be asking them to reach past the boundary the host contract draws — so the config names the
 * provider and its policy, and the runner binds the rest. That keeps `pod.host.ts` data, which is
 * what makes it readable, diffable, and checkable.
 */
export type HostIdentityDescriptor = {
	readonly provider: 'email-otp';
	/** Signing secret for the session cookie and the code challenge. At least 32 bytes. */
	readonly secret: string;
	/** Code lifetime in seconds. Defaults to 10 minutes. */
	readonly codeTtlSeconds?: number;
	/** Session lifetime in seconds. Defaults to 30 days. */
	readonly sessionTtlSeconds?: number;
	/** Code requests per address per 15 minutes. Defaults to 5. */
	readonly maxRequestsPerWindow?: number;
	/**
	 * Send session and challenge cookies over HTTPS only. Defaults to `true`; set it false only for a
	 * loopback development bind, where there is no TLS to require.
	 */
	readonly secureCookies?: boolean;
};

/** Email one-time codes, with no password stored anywhere. Bound to the runtime by `pod start`. */
export function emailOtp(
	options: Omit<HostIdentityDescriptor, 'provider'>
): HostIdentityDescriptor {
	if (Buffer.byteLength(options.secret, 'utf8') < 32) {
		throw new Error('emailOtp secret must contain at least 32 bytes');
	}
	return { provider: 'email-otp', ...options };
}

export function isIdentityDescriptor(
	value: HostIdentityProvider | HostIdentityDescriptor
): value is HostIdentityDescriptor {
	return 'provider' in value;
}

/** One unit of recurring work the runtime cannot drive for itself. */
export type QueueJob = {
	/**
	 * Stable identity. A host must never run two instances of the same name at once — an overlapping
	 * outbox drain would claim the same rows twice, and an overlapping automation would see the same
	 * unrun schedule.
	 */
	readonly name: string;
	/**
	 * A five-field cron expression, or `'continuous'` for a drain loop the host paces itself.
	 * `parseCron` is exported for a host that has to match cron by hand.
	 */
	readonly schedule: string;
	run(): Promise<void>;
};

/**
 * Durable execution for the loops the runtime cannot run for itself. Satisfies `queue`.
 *
 * The runtime exposes a private host-control function and then waits to be driven — it has no timer
 * and, in a hosted container, no network. Tenant HTTP requests cannot reach that function.
 *
 * Pod decides *what* runs and in what order and hands over the whole job set at startup; the host
 * supplies timing, persistence across restarts, and the non-overlap guarantee above. Returns a
 * function that stops every job.
 *
 * This is host-process code rather than a `RuntimeFacilityBinding` for a concrete reason: bindings
 * cross the isolate boundary by structured clone, so they cannot carry a callback.
 */
export type HostQueue = (jobs: readonly QueueJob[]) => Promise<() => void>;

/** One message a host received on a transport and is handing to the workspace. */
export type ChannelInboundMessage = {
	/** The declared channel this arrived on — the filename in `src/channels/+<key>.channel.ts`. */
	readonly channel: string;
	/** Transport-native conversation address: a chat id, a phone number, a thread id. */
	readonly conversationId: string;
	/**
	 * The transport's own message id.
	 *
	 * Deduplication is keyed on it, so it must be the provider's identifier and not one the host
	 * invented per attempt — a fresh id per redelivery defeats the ledger and runs the agent twice.
	 */
	readonly messageId: string;
	readonly text: string;
	/** Who sent it, in the transport's own terms. They may have no workspace user at all. */
	readonly sender?: { readonly id: string; readonly displayName?: string };
};

export type ChannelInboundResult = {
	/** `duplicate` means the message was already handled and no agent ran. */
	readonly status: 'answered' | 'duplicate' | 'silent';
	readonly text?: string;
	/** Whether the reply actually left over the transport. */
	readonly delivered?: boolean;
};

/**
 * Where a channel's inbound messages come from. Host-process code, like `HostQueue`.
 *
 * Pod deliberately serves no inbound HTTP route for channels. Proving a message really came from
 * Telegram means checking Telegram's secret, and the credential belongs to whoever holds the wire —
 * which is never the tenant, and under Core is never even a process with a socket. So the host
 * authenticates the wire its own way and calls `deliver`; the workspace is handed something already
 * proven, and there is no public endpoint that could be persuaded to speak for a stranger.
 *
 * Called once at startup with the delivery function and returns a function that stops listening. A
 * host that drives channels some other way (Core, through its own control-plane sender) simply does
 * not supply this.
 */
export type HostChannelListener = (
	deliver: (message: ChannelInboundMessage) => Promise<ChannelInboundResult>
) => Promise<() => void>;

/** One claimed outbox row, already transformed by the workspace's outbound pipeline. */
export type IntegrationDeliveryMessage = {
	readonly integrationName: string;
	readonly bindingName: string;
	readonly collectionName: string;
	readonly recordId: string;
	readonly action: string;
	/** Whatever the binding's `transform` returned — the body to deliver. */
	readonly payload: unknown;
};

/**
 * Performs the outbound network call for one integration message. Satisfies `integrationDelivery`.
 *
 * This is a host function rather than a binding because it is the step that holds the endpoint and
 * its credential. The workspace decides *what* to send; the host decides *where* and proves it may.
 * Throwing schedules a retry with backoff; returning marks the row delivered.
 */
export type HostIntegrationDelivery = (message: IntegrationDeliveryMessage) => Promise<void>;

/**
 * Validates a host plugin set at startup, so a bad `entry` fails naming the plugin rather than
 * rendering into every user's sidebar.
 *
 * A plugin is host *configuration*, never request data. It is set once at startup — by the runner from
 * `pod.host.ts`, or by the isolate `configure` frame under Core — and deliberately does not travel in
 * a header the way the billing summary does. A header a browser can set would let anyone put an
 * arbitrary link, under the host's own label, into the workspace sidebar.
 */
export function assertHostPlugins(plugins: readonly HostAppPlugin[]): void {
	const seen = new Set<string>();
	for (const plugin of plugins) {
		if (!plugin.key.trim()) throw new Error('Host plugin key must not be empty');
		if (seen.has(plugin.key)) throw new Error(`Duplicate host plugin key: ${plugin.key}`);
		seen.add(plugin.key);
		const entry = plugin.entry.trim();
		const safe = entry.startsWith('/') ? !entry.startsWith('//') : entry.startsWith('https://');
		if (!safe) {
			throw new Error(
				`Host plugin ${plugin.key} has an unsupported entry (${plugin.entry}); use a site-relative path or an https URL`
			);
		}
	}
}

/** Core owns all runtime bindings; this file only declares the deployment target. */
export type CorePodHostConfig = {
	readonly mode: 'core';
};

/**
 * Everything an independent host supplies.
 *
 * `db` and `identity` are required. Optional facilities are present only when this host has a real
 * provider for them; tenant source never duplicates this declaration.
 */
export type SelfHostedPodHostConfig = {
	readonly mode: 'self-hosted';
	readonly db: HostDbAdapter;
	/**
	 * Either a built-in provider named as data (`emailOtp({ ... })`) or a provider you implement
	 * yourself for a specific IdP.
	 */
	readonly identity: HostIdentityProvider | HostIdentityDescriptor;
	/**
	 * The origin this workspace is reachable at, e.g. `https://crm.acme.com`.
	 *
	 * Required because an invitation link has to be absolute: the token travels by email, so there is
	 * no request to derive an origin from at the moment the link is built. A relative link would
	 * arrive unusable, so a missing value fails at startup rather than at the first invite.
	 */
	readonly publicUrl: string;
	readonly fileStorage?: HostFileStorageBinding;
	readonly ai?: HostAiBinding;
	readonly messaging?: HostMessagingBinding;
	readonly maps?: HostMapsBinding;
	readonly integrationDelivery?: HostIntegrationDelivery;
	readonly queue?: HostQueue;
	/**
	 * Where declared channels receive from. Outbound already goes out through `messaging.sendVia`;
	 * this is the other half, and without it a channel can send but never be spoken to.
	 */
	readonly channels?: HostChannelListener;
	/** Host-owned surfaces linked into the workspace sidebar. Validated at startup. */
	readonly hostPlugins?: readonly HostAppPlugin[];
};

export type PodHostConfig = CorePodHostConfig | SelfHostedPodHostConfig;

/** Identity function that exists for its type inference; a config file gets checked on write. */
export function definePodHost<const TConfig extends PodHostConfig>(config: TConfig): TConfig {
	return config;
}

/**
 * The facility requirements a host configuration actually satisfies.
 *
 * This is the value `assertStandaloneFacilities` compares the manifest against. Deriving it from
 * the configuration — rather than from a hardcoded constant — is what makes the gate honest: a
 * host that adds file storage starts passing workspaces with file fields, with no change here.
 */
export function satisfiedFacilities(
	config: SelfHostedPodHostConfig
): ReadonlySet<RuntimeFacilityName> {
	const satisfied = new Set<RuntimeFacilityName>(['db']);
	if (config.fileStorage) satisfied.add('fileStorage');
	if (config.maps) satisfied.add('maps');
	if (config.ai) satisfied.add('ai');
	if (config.messaging) satisfied.add('messaging');
	if (config.queue) satisfied.add('queue');
	if (config.integrationDelivery) satisfied.add('integrationDelivery');
	return satisfied;
}

export type {
	HostAiBinding,
	HostDbAdapter,
	HostDbBinding,
	HostFileStorageBinding,
	HostMapsBinding
};
export type { HostAppPlugin, HostMessagingBinding, RuntimeFacilityName, TBaseScope };
