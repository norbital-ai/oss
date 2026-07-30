/**
 * The public host surface.
 *
 * A workspace author never imports this. A *host* author does: pick an adapter per facility,
 * export a `definePodHost({ ... })` default from `pod.host.ts` at the workspace root, and
 * `pod start` will use it. Adapters are values, so a configuration file stays data — readable,
 * diffable, and checkable — instead of setup code.
 *
 * ```ts
 * import { definePodHost, env, postgresDb, localFileStorage, devIdentity } from '@norbital-ai/pod/host';
 *
 * export default definePodHost({
 *   mode: 'self-hosted',
 *   db: postgresDb({ url: env('DATABASE_URL') }),
 *   identity: devIdentity({ ... }),
 *   fileStorage: localFileStorage({ directory: '.norbital/storage' }),
 *   queue: intervalQueue()
 * });
 * ```
 *
 * `queue` is the one facility with no production adapter here. Cron automations and outbox draining
 * need durability, restart survival, and single-flight execution that a timer cannot give, so a
 * deployed workspace points it at pg-boss or an equivalent; `intervalQueue` is for development.
 */
export {
	assertHostPlugins,
	definePodHost,
	emailOtp,
	env,
	isIdentityDescriptor,
	isVerifiedSubject,
	satisfiedFacilities
} from './types.js';
export type {
	HostAiBinding,
	HostAppPlugin,
	HostDbAdapter,
	HostDbBinding,
	HostFileStorageBinding,
	HostIdentity,
	HostIdentityProvider,
	HostIntegrationDelivery,
	HostAuthentication,
	HostIdentityDescriptor,
	HostMapsBinding,
	HostMessagingBinding,
	HostQueue,
	HostSubject,
	HostVerifiedSubject,
	IntegrationDeliveryMessage,
	QueueJob,
	PodHostConfig,
	CorePodHostConfig,
	SelfHostedPodHostConfig,
	RuntimeFacilityName,
	TBaseScope
} from './types.js';

// Database
export { postgresDb, PostgresHostDbBinding } from './db.js';
export type { HostDbConnection, PostgresDbOptions } from './db.js';

// Identity. `emailOtpIdentity` is the zero-configuration default: it stores no password, sends its
// codes through the host's messaging facility, and ships the login, code-entry, and invitation-accept
// pages, so a workspace author writes no auth code and no auth markup.
export { devIdentity, trustedHeaderIdentity, TRUSTED_HOST_TOKEN_HEADER } from './identity.js';
export { emailOtpIdentity } from './email-otp.js';
export type { EmailOtpIdentityOptions, EmailOtpDeliver } from './email-otp.js';
export { cookieSession, hashToken, mintToken, subjectHmac } from './session.js';
export type { CookieSession, CookieSessionOptions, SessionClaims } from './session.js';

// File storage
export { localFileStorage } from './file-storage.js';
export type { LocalFileStorageOptions } from './file-storage.js';
export { s3FileStorage } from './s3.js';
export type { S3FileStorageOptions } from './s3.js';

// Maps
export { googleMaps } from './maps.js';
export type { GoogleMapsOptions } from './maps.js';

// Messaging. There is no `ai` adapter: model credentials and the agent that runs against a
// tenant's data belong to the trusted host, so this package declares that contract and Core
// implements it (on `@tanstack/ai`, defaulting to OpenRouter).
export {
	consoleMessaging,
	messagingProviders,
	type MessagingTransport,
	type NotificationProvider
} from './facilities.js';

// Queue. Pod ships no durable implementation: a real queue is the host's to choose, and the
// `intervalQueue` below is explicitly the development one.
export { intervalQueue } from './interval-queue.js';
export type { IntervalQueueOptions } from './interval-queue.js';
export { cronMatches, parseCron } from './cron.js';

/**
 * The job set a `HostQueue` is defined to receive.
 *
 * Exported here because a host cannot implement `HostQueue` without it: the contract says the host is
 * handed Pod's whole job set and returns a stop function, and this is the only thing that produces
 * that set. It was unreachable from outside the package, which made `queue` a facility no host could
 * actually satisfy.
 */
/**
 * Reconcile a workspace's declared policies into a tenant database.
 *
 * Exported because a host must run this at its own migrate seam. Policies moved from Core's seed into
 * workspace source, and nothing else creates the rows — a host that migrates a tenant without calling
 * this leaves it with no policies at all, and `team.policy_id` pointing at nothing.
 *
 * Upserts by key and never deletes an undeclared row, so it is safe to run on every migrate.
 */
export { reconcileDeclaredPolicies } from '../server/bootstrap/policy_reconcile.server.js';
export type {
	PolicyReconcileClient,
	PolicyReconcileResult
} from '../server/bootstrap/policy_reconcile.server.js';

export { workspaceJobs } from '../bin/invocation/jobs.js';
export type { WorkspaceJobOptions } from '../bin/invocation/jobs.js';
export type { CronSchedule } from './cron.js';
