import type {
	HostAiBinding,
	HostDbBinding,
	HostFileStorageBinding,
	HostMapsBinding,
	HostNotificationsBinding,
	RuntimeFacilityRequirement
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
	authenticate(request: Request): Promise<HostIdentity | null> | HostIdentity | null;
	handleRoute?(request: Request): Promise<Response | null> | Response | null;
};

/**
 * Driving the loops the runtime cannot run for itself.
 *
 * The runtime exposes a private host-control function and then waits to be driven — it has no timer
 * and, in a hosted container, no network. Tenant HTTP requests cannot reach that function.
 */
export type HostSchedulerConfig = {
	/** Run cron-scheduled automations. Satisfies `queue`. */
	readonly automations?: boolean;
	/** How often to sweep, in milliseconds. Defaults to 30s; floored at 1s. */
	readonly intervalMs?: number;
};

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
 * Everything a host supplies.
 *
 * `db` is required and the rest are optional, which mirrors the facility gate exactly: a workspace
 * that cannot reach a database is not a workspace, while every other facility is needed only by
 * workspaces that use the feature behind it.
 */
export type PodHostConfig = {
	readonly db: HostDbAdapter;
	readonly identity: HostIdentityProvider;
	readonly fileStorage?: HostFileStorageBinding;
	readonly ai?: HostAiBinding;
	readonly notifications?: HostNotificationsBinding;
	readonly maps?: HostMapsBinding;
	readonly integrationDelivery?: HostIntegrationDelivery;
	readonly scheduler?: HostSchedulerConfig;
};

/** Identity function that exists for its type inference; a config file gets checked on write. */
export function definePodHost(config: PodHostConfig): PodHostConfig {
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
	config: PodHostConfig
): ReadonlySet<RuntimeFacilityRequirement> {
	const satisfied = new Set<RuntimeFacilityRequirement>();
	if (config.db) satisfied.add('db');
	if (config.fileStorage) satisfied.add('fileStorage');
	if (config.maps) satisfied.add('maps');
	if (config.ai) satisfied.add('ai');
	if (config.notifications) satisfied.add('notifications');
	if (config.scheduler?.automations) satisfied.add('queue');
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
export type { HostNotificationsBinding, RuntimeFacilityRequirement, TBaseScope };
