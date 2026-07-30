import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { parseCron } from '../../host/cron.js';
import type {
	HostIntegrationDelivery,
	IntegrationDeliveryMessage,
	QueueJob
} from '../../host/types.js';
import type { HostNotificationsBinding } from '@norbital-ai/platform-utils/runtime/binding';

/** Calls the private runtime host-control entry point. */
export type RuntimeDispatch = (body: unknown) => Promise<unknown>;

export type WorkspaceJobOptions = {
	readonly manifest: NorbitalManifest;
	readonly dispatch: RuntimeDispatch;
	readonly integrationDelivery?: HostIntegrationDelivery;
	readonly notifications?: HostNotificationsBinding;
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
					const message: IntegrationDeliveryMessage = {
						integrationName: row.integration_name,
						bindingName: row.binding_name,
						collectionName: row.collection_name,
						recordId: row.record_id,
						action: row.action,
						payload
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
	const notifications = options.notifications;
	if (!notifications) throw new Error('Notification outbox job requires a notifications binding');
	return {
		name: 'pod:notification-outbox',
		schedule: 'continuous',
		async run() {
			const rows = claimedNotificationRows(
				await options.dispatch({ kind: 'notification', action: 'claim', limit: 50 })
			);
			for (const row of rows) {
				try {
					const result = await notifications.send({
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
					automationName: name,
					triggeredBy: 'CRON'
				});
			}
		});
	}

	if (options.integrationDelivery) jobs.push(integrationOutboxJob(options));
	if (options.notifications) jobs.push(notificationOutboxJob(options));

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
