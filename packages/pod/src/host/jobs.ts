import type {
	ManifestIntegrationDestination,
	ManifestIntegrationOrigin,
	NorbitalManifest
} from '@norbital-ai/platform-utils/manifest/types';
import { parseCron } from './cron.js';
import type {
	HostIntegrationDelivery,
	HostSecretResolver,
	IntegrationDeliveryMessage,
	QueueJob
} from './types.js';
import { processEnvSecrets, resolveSecretHeaders } from './integration-http.js';
import type { HostMessagingBinding } from '@norbital-ai/platform-utils/runtime/binding';

/** Calls the private runtime host-control entry point. */
export type RuntimeDispatch = (body: unknown) => Promise<unknown>;

export type WorkspaceJobOptions = {
	readonly manifest: NorbitalManifest;
	readonly dispatch: RuntimeDispatch;
	readonly integrationDelivery?: HostIntegrationDelivery;
	readonly messaging?: HostMessagingBinding;
	/** Resolves the secret names a declared connection references. Defaults to `process.env`. */
	readonly secrets?: HostSecretResolver;
	/** The network the pull jobs use. Injectable so a test can drive them without a socket. */
	readonly fetch?: typeof globalThis.fetch;
	readonly organizationId: string;
	readonly log?: (message: string) => void;
};

/** Backoff for a failed outbox row, capped so a permanently broken endpoint still retries hourly. */
function retryDelayMs(attempts: number): number {
	return Math.min(2 ** Math.max(attempts, 1) * 1000, 60 * 60 * 1000);
}

type ClaimedOutboxRow = {
	readonly norbital_id: string;
	readonly integration_name: string;
	readonly binding_name: string;
	readonly collection_name: string;
	readonly record_id: string;
	readonly action: string;
	readonly payload: Record<string, unknown>;
	readonly attempts: number;
};

type ClaimedNotificationRow = {
	readonly norbital_id: string;
	readonly channel: string;
	readonly recipient_user_id: string;
	readonly subject: string;
	readonly message: string;
	readonly cta_label: string | null;
	readonly cta_url: string | null;
	readonly attempts: number;
};

function claimedRows(result: unknown): readonly ClaimedOutboxRow[] {
	if (!Array.isArray(result)) return [];
	return result.filter(
		(row): row is ClaimedOutboxRow =>
			typeof row === 'object' &&
			row != null &&
			typeof (row as ClaimedOutboxRow).norbital_id === 'string' &&
			typeof (row as ClaimedOutboxRow).integration_name === 'string'
	);
}

function claimedNotificationRows(result: unknown): readonly ClaimedNotificationRow[] {
	if (!Array.isArray(result)) return [];
	return result.filter(
		(row): row is ClaimedNotificationRow =>
			typeof row === 'object' &&
			row != null &&
			typeof (row as ClaimedNotificationRow).norbital_id === 'string' &&
			typeof (row as ClaimedNotificationRow).channel === 'string'
	);
}

/**
 * Validate every schedule before the process starts serving requests.
 *
 * A malformed schedule is a workspace build defect, not a partially-operational runtime mode. The
 * parsed value is discarded — the host owns cron matching — but parsing here means a bad expression
 * fails at startup naming the automation instead of silently never firing.
 */
function assertSchedule(name: string, expression: string): string {
	try {
		parseCron(expression);
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`Automation "${name}" has an invalid schedule: ${detail}`, { cause });
	}
	return expression;
}

/**
 * The event body a `system-event` destination carries.
 *
 * A transform is free to return an array or a scalar, but a system event's payload is a record — so
 * anything else is wrapped under `value` rather than silently dropped or refused. The receiving
 * binding sees `{ event_id, event, payload }` either way, which is the only shape its import
 * pipeline was ever written against.
 */
function systemEventPayload(payload: unknown, row: ClaimedOutboxRow): Record<string, unknown> {
	if (payload != null && typeof payload === 'object' && !Array.isArray(payload)) {
		return payload as Record<string, unknown>;
	}
	return { value: payload ?? null, record_id: row.record_id, action: row.action };
}

/** Where one outbound binding was declared to send, as the manifest recorded it. */
function outboundDestination(
	manifest: NorbitalManifest,
	integrationName: string,
	bindingName: string
): ManifestIntegrationDestination | undefined {
	return manifest.integrations?.[integrationName]?.definition.outbound?.[bindingName]?.destination;
}

function integrationOutboxJob(options: WorkspaceJobOptions): QueueJob {
	const deliver = options.integrationDelivery;
	if (!deliver) throw new Error('Integration outbox job requires an integrationDelivery provider');
	const log = options.log ?? ((message: string) => console.log(message));
	return {
		name: 'pod:integration-outbox',
		schedule: 'continuous',
		async run() {
			const rows = claimedRows(
				await options.dispatch({ kind: 'outbox', action: 'claim', limit: 50 })
			);
			if (rows.length === 0) return;

			const delivered: string[] = [];
			// Failures are grouped by message so each distinct error settles in one call, and every
			// claimed row is settled exactly once — a row left in `processing` is invisible until its
			// five-minute lease expires.
			const failures = new Map<string, { ids: string[]; attempts: number }>();

			for (const row of rows) {
				try {
					const payload = await options.dispatch({
						kind: 'integration',
						direction: 'send',
						integrationName: row.integration_name,
						bindingName: row.binding_name,
						collectionName: row.collection_name,
						records: [row.payload]
					});
					const destination = outboundDestination(
						options.manifest,
						row.integration_name,
						row.binding_name
					);
					// A system event was never going anywhere: it is this workspace talking to itself, and
					// handing it to `integrationDelivery` asked a host to POST an event somewhere it had no
					// URL for. Route it back in, and the matching `receive` binding finally has a caller.
					if (destination?.type === 'system-event') {
						await options.dispatch({
							kind: 'system-event',
							eventId: row.norbital_id,
							event: destination.event,
							payload: systemEventPayload(payload, row)
						});
						delivered.push(row.norbital_id);
						continue;
					}
					const message: IntegrationDeliveryMessage = {
						integrationName: row.integration_name,
						bindingName: row.binding_name,
						collectionName: row.collection_name,
						recordId: row.record_id,
						action: row.action,
						payload,
						...(destination ? { destination } : {})
					};
					await deliver(message);
					delivered.push(row.norbital_id);
				} catch (cause) {
					const reason = cause instanceof Error ? cause.message : String(cause);
					const group = failures.get(reason) ?? { ids: [], attempts: row.attempts };
					group.ids.push(row.norbital_id);
					group.attempts = Math.max(group.attempts, row.attempts);
					failures.set(reason, group);
				}
			}

			if (delivered.length > 0) {
				await options.dispatch({ kind: 'outbox', action: 'delivered', ids: delivered });
			}
			for (const [reason, group] of failures) {
				log(
					`[pod:queue] integration delivery failed for ${group.ids.length} message(s): ${reason}`
				);
				await options.dispatch({
					kind: 'outbox',
					action: 'failed',
					ids: group.ids,
					error: reason,
					retryAt: new Date(Date.now() + retryDelayMs(group.attempts)).toISOString()
				});
			}
		}
	};
}

function notificationOutboxJob(options: WorkspaceJobOptions): QueueJob {
	const messaging = options.messaging;
	if (!messaging) throw new Error('Notification outbox job requires a messaging binding');
	return {
		name: 'pod:notification-outbox',
		schedule: 'continuous',
		async run() {
			const rows = claimedNotificationRows(
				await options.dispatch({ kind: 'notification', action: 'claim', limit: 50 })
			);
			for (const row of rows) {
				try {
					const result = await messaging.send({
						organizationId: options.organizationId,
						channel: row.channel,
						recipientUserId: row.recipient_user_id,
						subject: row.subject,
						message: row.message,
						cta: row.cta_label && row.cta_url ? { label: row.cta_label, url: row.cta_url } : null
					});
					if (!result.sent)
						throw new Error(result.reason ?? 'Notification provider refused delivery');
					await options.dispatch({
						kind: 'notification',
						action: 'delivered',
						ids: [row.norbital_id]
					});
				} catch (cause) {
					const reason = cause instanceof Error ? cause.message : String(cause);
					await options.dispatch({
						kind: 'notification',
						action: 'failed',
						ids: [row.norbital_id],
						error: reason,
						retryAt: new Date(Date.now() + retryDelayMs(row.attempts)).toISOString()
					});
				}
			}
		}
	};
}

/**
 * One scheduled `receive` binding: fetch the remote, hand the body to the import pipeline, resume.
 *
 * The fetch happens here rather than inside the workspace for the same reason outbound delivery
 * does — this is the side that holds the credential, and under Core the isolate has no socket at
 * all. What crosses back in is the response body and nothing else.
 *
 * The cursor is read before the call and written after the rows land, so a crash between the two
 * re-pulls a page rather than skipping one. That direction is deliberate: an import pipeline that
 * writes the same remote id twice is a collection an author can de-duplicate, and a page silently
 * skipped is data that never arrives and nothing to notice it by.
 */
function integrationPullJob(
	options: WorkspaceJobOptions,
	integrationName: string,
	bindingName: string,
	origin: Extract<ManifestIntegrationOrigin, { type: 'api-pull' }>,
	collectionName: string
): QueueJob {
	const secrets = options.secrets ?? processEnvSecrets;
	const call = options.fetch ?? globalThis.fetch;
	const describe = `Integration ${integrationName}.${bindingName}`;
	const log = options.log ?? ((message: string) => console.log(message));
	return {
		name: `pod:integration-pull:${integrationName}:${bindingName}`,
		schedule: assertSchedule(describe, origin.schedule),
		async run() {
			const stored = (await options.dispatch({
				kind: 'integration-cursor',
				action: 'read',
				integrationName,
				bindingName
			})) as { readonly cursor?: string | null };
			const cursor = stored?.cursor ?? null;
			const url = new URL(origin.url);
			if (origin.cursorQuery && cursor) url.searchParams.set(origin.cursorQuery, cursor);
			try {
				const response = await call(url, {
					method: origin.method ?? 'GET',
					headers: {
						accept: 'application/json',
						...resolveSecretHeaders(origin.secretHeaders, secrets, describe)
					}
				});
				if (!response.ok) {
					throw new Error(`${describe} pull was refused by ${url.origin} — ${response.status}`);
				}
				const importData: unknown = await response.json();
				const outcome = (await options.dispatch({
					kind: 'integration',
					direction: 'receive',
					integrationName,
					bindingName,
					collectionName,
					importData
				})) as { readonly status?: string; readonly reason?: string };
				// A body the binding's `input` schema turns down comes back as a result rather than a throw,
				// because a webhook host needs to answer its sender. A pull has no sender to answer, so the
				// refusal has to become the failure it is or the cursor would advance past a page that
				// imported nothing.
				if (outcome?.status === 'refused') {
					throw new Error(
						`${describe} pull returned a body the binding refused — ${outcome.reason ?? 'no reason given'}`
					);
				}
				await options.dispatch({
					kind: 'integration-cursor',
					action: 'write',
					integrationName,
					bindingName,
					cursor: origin.nextCursorHeader
						? (response.headers.get(origin.nextCursorHeader) ?? cursor)
						: cursor,
					error: null
				});
			} catch (cause) {
				const reason = cause instanceof Error ? cause.message : String(cause);
				log(`[pod:queue] ${describe} pull failed: ${reason}`);
				// The cursor is left where it was, so the next tick retries the same page. Only the
				// reason is recorded, and only so an operator can see it without reading the log.
				await options
					.dispatch({
						kind: 'integration-cursor',
						action: 'write',
						integrationName,
						bindingName,
						cursor,
						error: reason
					})
					.catch(() => undefined);
				throw cause;
			}
		}
	};
}

/** Every `api-pull` binding in the manifest, as jobs. */
function integrationPullJobs(options: WorkspaceJobOptions): QueueJob[] {
	return Object.entries(options.manifest.integrations ?? {}).flatMap(
		([integrationName, integration]) =>
			Object.entries(integration.definition.inbound ?? {}).flatMap(([bindingName, binding]) =>
				binding.origin.type === 'api-pull'
					? [
							integrationPullJob(
								options,
								integrationName,
								bindingName,
								binding.origin,
								binding.collection
							)
						]
					: []
			)
	);
}

/**
 * Every recurring job this workspace needs, derived from its manifest.
 *
 * The set is host-agnostic on purpose: Core registers it with pgboss and `pod start` hands it to
 * whichever queue the operator configured, so both deployments run the same job definitions and
 * differ only in what drives them.
 */
export function workspaceJobs(options: WorkspaceJobOptions): readonly QueueJob[] {
	const jobs: QueueJob[] = [];

	for (const [name, automation] of Object.entries(options.manifest.automations ?? {})) {
		if (!('schedule' in automation.trigger)) continue;
		jobs.push({
			name: `pod:automation:${name}`,
			schedule: assertSchedule(name, automation.trigger.schedule),
			run: async () => {
				await options.dispatch({
					kind: 'automation',
					automationName: name
				});
			}
		});
	}

	if (options.integrationDelivery) jobs.push(integrationOutboxJob(options));
	if (options.messaging) jobs.push(notificationOutboxJob(options));
	// Unconditional, unlike the outbox drain: a pull needs no host provider at all, only the
	// schedule the workspace declared. Gating it on `integrationDelivery` would have made an inbound
	// binding depend on the outbound facility, which is the confusion that left it unreachable.
	jobs.push(...integrationPullJobs(options));

	const hasEventAutomations = Object.values(options.manifest.automations ?? {}).some(
		(automation) => 'collection' in automation.trigger
	);
	if (hasEventAutomations) {
		jobs.push({
			name: 'pod:automation-events',
			schedule: 'continuous',
			run: async () => {
				await options.dispatch({ kind: 'automation-events', limit: 200 });
			}
		});
	}

	return jobs;
}
