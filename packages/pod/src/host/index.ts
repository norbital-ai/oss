/**
 * The public host surface.
 *
 * A workspace author never imports this. A *host* author does: pick an adapter per facility,
 * export a `definePodHost({ ... })` default from `pod.host.ts` at the workspace root, and
 * `pod start` (the reference host) will use it. Adapters are values, so a configuration file
 * stays data — readable, diffable, and checkable — instead of setup code. You are running a
 * host, not “opening Pod.”
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
 * `queue` is infrastructure crons only — integration outbox, pulls, notification drain. It is not
 * how functions run. `intervalQueue` is a development timer: it loses work on process death.
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
	ChannelInboundMessage,
	ChannelInboundResult,
	HostChannelListener,
	HostWebhookListener,
	DeclaredWebhookBinding,
	WebhookInboundDelivery,
	WebhookInboundResult,
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
	HostSecretResolver,
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

/**
 * Agent tools the host implements.
 *
 * The counterpart to a workspace's `defineAgentTool`: same idea, other side of the isolate. Put them
 * on `agentTools` in `definePodHost`. Sandbox-gated tools are offered when the session has a bound
 * sandbox; other host tools appear only when the running spec names them in `hostTools`.
 * `assertHostAgentTools` is exported for a host that assembles its own startup (Core does):
 * `pod start` already runs it.
 */
/**
 * The outbound call a `request` destination describes, made for real.
 *
 * Supply it as `integrationDelivery` and every declared HTTP send binding works with no per-host
 * code: the URL and headers come from the manifest, the credential from `secrets` (`process.env` by
 * default). A host that needs to route deliveries somewhere else still writes its own function — the
 * destination arrives on the message either way.
 */
export { httpIntegrationDelivery, processEnvSecrets } from './integration-http.js';

/**
 * The same facility, logged instead of sent — what `pod dev` supplies so that a workspace declaring an
 * integration still boots on a machine that holds no endpoint credentials. It is a development
 * stand-in, not a fallback: a deployed host names `httpIntegrationDelivery()` or its own function.
 */
export { consoleIntegrationDelivery } from './facilities.js';

/**
 * The inbound half of an integration, on a socket this host owns.
 *
 * `httpWebhookListener` mounts one endpoint per declared `webhook` binding; `verifyWebhookSignature`
 * is the check Pod runs before any delivery reaches the workspace, exported for a host that receives
 * on a wire of its own and wants the same constant-time comparison rather than a hand-rolled one.
 */
export {
	DEFAULT_WEBHOOK_SIGNATURE_HEADER,
	httpWebhookListener,
	verifyWebhookSignature
} from './webhooks.js';
export type { HttpWebhookListenerOptions } from './webhooks.js';

/**
 * The delivery half, for a host that owns the socket itself.
 *
 * `httpWebhookListener` is the whole answer for a host that can open a port. The isolate has no
 * listener; Core owns the socket, receives on its own route, and hands the result inward across
 * the host-command plane.
 *
 * Exported because the alternative is what actually happened — Core reimplemented this, and its copy
 * dropped `eventId`, so Pod's `integration_inbound_event` ledger never deduped and every provider
 * retry re-imported the same rows. Two implementations of one wire protocol is not a boundary, it is
 * a place for them to disagree; the second one was wrong for months without saying so.
 *
 * Same reasoning as `workspaceJobs`: Pod owns what the contract means, the host owns where the bytes
 * came from.
 */
export { declaredWebhookBindings, webhookInboundDeliverer } from './webhook-inbound.js';
export type { WebhookInboundOptions } from './webhook-inbound.js';

export { assertHostAgentTools, hostAgentTools } from './agent-tools.js';
export type { HostAgentTool } from './agent-tools.js';
export type {
	HostAgentToolBinding,
	HostAgentToolSpec
} from '@norbital-ai/platform-utils/runtime/binding';

// Database
export { postgresDb, PostgresHostDbBinding } from './db.js';
export type { HostDbConnection, PostgresDbOptions } from './db.js';

// Identity. `emailOtpIdentity` is the zero-configuration default: it stores no password, sends its
// codes through the host's messaging facility, and ships the login, code-entry, and invitation-accept
// pages, so a workspace author writes no auth code and no auth markup.
export {
	devIdentity,
	trustedHeaderIdentity,
	TRUSTED_HOST_TOKEN_HEADER,
	TRUSTED_PERMISSION_BYPASS_HEADER
} from './identity.js';
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

/**
 * The one built-in transport: Telegram, both halves.
 *
 * `transport` goes into `messagingProviders` and carries replies out; `listen` goes into `channels`
 * and brings messages in. Telegram is here rather than left to every host because it is the only
 * wire cheap enough to build in — long polling means no public endpoint, no webhook secret, and no
 * signature model. WhatsApp stays host-supplied: it needs a socket, `node:fs` auth state, and a
 * pairing flow, none of which belong in a package a scale-to-zero tenant runs behind.
 */
export { telegramBot, telegramInboundMessage } from './telegram.js';
export type { TelegramBotOptions } from './telegram.js';

// Queue. Infrastructure crons only. `intervalQueue` is the development timer; it is not how
// functions run.
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

/**
 * Generate authored workspace migrations through Pod's schema boundary.
 *
 * Hosts may provide the editor and the build sandbox, but Pod owns the migration semantics. In
 * particular, this projection keeps every typed temporal-history table in lockstep with its live
 * collection. Calling drizzle-kit directly from a host produces only the live-table half and is not
 * a valid Pod migration.
 */
export { generatePodMigrations } from '../vite/migrations.js';

/**
 * Give every declared channel the workspace user its agent answers as.
 *
 * Runs at the same migrate seam as `reconcileDeclaredPolicies` and immediately after it, because the
 * principal's team points at a declared policy. A host that skips it leaves inbound channel messages
 * failing with "channel has no principal" — nothing else creates those rows.
 */
export {
	reconcileDeclaredChannels,
	channelPrincipalEmail,
	channelPrincipalTeamName
} from '../server/bootstrap/channel_reconcile.server.js';
export type { ChannelReconcileResult } from '../server/bootstrap/channel_reconcile.server.js';

export {
	ADMIT_ARTIFACT_HEADER,
	admitArtifactSchema,
	parseAdmitArtifact,
	serializeAdmitArtifact,
	withAdmitArtifact
} from './admit-artifact.js';
export type { AdmitArtifact } from './admit-artifact.js';
export { workspaceJobs } from './jobs.js';
export {
	dispatchHostOrGuest,
	integrationBindingKey,
	isHostMailCommand,
	runHostIntegrationCursor,
	runHostMail,
	runHostNotification,
	runHostOutbox
} from './mail.js';
export type {
	HostIntegrationCursorCommand,
	HostMailCommand,
	HostMailInput,
	HostNotificationCommand,
	HostOutboxCommand
} from './mail.js';
export {
	inviteeEmailForTokenOnDb,
	seatCensusOnDb,
	workspaceMembershipOnDb
} from './directory.js';
export { settleHostReceiptEffect, SETTLE_RECEIPT_EFFECT_SQL } from './settle-receipt-effect.js';
export { isHostSyncStreamPath, serveHostSyncStream } from './sync-stream.js';
export type { HostSyncStreamInput, HostSyncStreamResponse } from './sync-stream.js';
export {
	attachSyncWakeToDb,
	createInProcessSyncWakeBus,
	cursorMatchesLastSeq,
	decodeCursorSeq,
	sqlWritesSyncOutbox
} from './sync-wake.js';
export type { SyncWakeBus } from './sync-wake.js';
export type {
	HostSettleEffect,
	HostSettleOutcome,
	HostSettleQuery
} from './settle-receipt-effect.js';

/**
 * Refuse a workspace whose channels name a transport this host cannot carry.
 *
 * Exported for the same reason `workspaceJobs` is: the check belongs to whoever knows the host's
 * transports, and only the host does. `pod start` runs it before it listens; Core must run it before
 * it accepts traffic for a tenant, or the tenant boots with a channel that silently carries nothing.
 */
export { assertChannelTransportsAreSupported } from '../authoring/channels/channels.js';
export type { WorkspaceJobOptions } from './jobs.js';
export type {
	DurableAutomationAiEffect,
	DurableAutomationAiOutcome,
	DurableHostEffectImage,
	DurableHostEffectRequest
} from './types.js';
export type { CronSchedule } from './cron.js';
