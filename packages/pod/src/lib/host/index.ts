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
export { definePodHost, env, satisfiedFacilities } from './types.js';
export type {
	HostAiBinding,
	HostDbAdapter,
	HostDbBinding,
	HostFileStorageBinding,
	HostIdentity,
	HostIdentityProvider,
	HostIntegrationDelivery,
	HostMapsBinding,
	HostNotificationsBinding,
	HostQueue,
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

// Identity
export { devIdentity, trustedHeaderIdentity, TRUSTED_HOST_TOKEN_HEADER } from './identity.js';

// File storage
export { localFileStorage } from './file-storage.js';
export type { LocalFileStorageOptions } from './file-storage.js';
export { s3FileStorage } from './s3.js';
export type { S3FileStorageOptions } from './s3.js';

// Notifications and maps. There is no `ai` adapter: model credentials and the agent that runs
// against a tenant's data belong to the trusted host, so this package declares that contract and
// Core implements it.
export {
	consoleNotifications,
	notificationProviders,
	type NotificationProvider
} from './facilities.js';

// Queue. Pod ships no durable implementation: a real queue is the host's to choose, and the
// `intervalQueue` below is explicitly the development one.
export { intervalQueue } from './interval-queue.js';
export type { IntervalQueueOptions } from './interval-queue.js';
export { cronMatches, parseCron } from './cron.js';
export type { CronSchedule } from './cron.js';
