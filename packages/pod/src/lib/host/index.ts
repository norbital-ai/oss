/**
 * The public host surface.
 *
 * A workspace author never imports this. A *host* author does: pick an adapter per facility,
 * export a `definePodHost({ ... })` default from `pod.config.ts` at the workspace root, and
 * `pod start` will use it. Adapters are values, so a configuration file stays data — readable,
 * diffable, and checkable — instead of setup code.
 *
 * ```ts
 * import { definePodHost, env, postgresDb, localFileStorage, devIdentity } from '@norbital-ai/pod/host';
 *
 * export default definePodHost({
 *   db: postgresDb({ url: env('DATABASE_URL') }),
 *   identity: devIdentity({ ... }),
 *   fileStorage: localFileStorage({ directory: '.norbital/storage', origin: 'http://127.0.0.1:5273' }),
 *   scheduler: { automations: true }
 * });
 * ```
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
	HostSchedulerConfig,
	IntegrationDeliveryMessage,
	PodHostConfig,
	RuntimeFacilityRequirement,
	TBaseScope
} from './types.js';

// Database
export { postgresDb, PostgresHostDbBinding } from './db.js';
export type { HostDbConnection, PostgresDbOptions } from './db.js';

// Identity
export { devIdentity, trustedHeaderIdentity, TRUSTED_HOST_TOKEN_HEADER } from './identity.js';

// File storage
export { localFileStorage, STORAGE_ROUTE_PREFIX } from './file-storage.js';
export type { LocalFileStorage, LocalFileStorageOptions } from './file-storage.js';
export { s3FileStorage } from './s3.js';
export type { S3FileStorageOptions } from './s3.js';

// Notifications and maps. There is no `ai` adapter: model credentials and the agent that runs
// against a tenant's data belong to the trusted host, so this package declares that contract and
// Core implements it.
export { consoleNotifications, stubMaps } from './facilities.js';

// Scheduling
export { cronMatches, parseCron } from './cron.js';
export type { CronSchedule } from './cron.js';
