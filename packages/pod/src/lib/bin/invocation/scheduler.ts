import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import { cronMatches, parseCron, type CronSchedule } from '../../host/cron.js';
import type { HostIntegrationDelivery, IntegrationDeliveryMessage } from '../../host/types.js';
import type { HostNotificationsBinding } from '@norbital-ai/platform-utils/runtime/binding';

/** Calls the private runtime host-control entry point. */
export type RuntimeDispatch = (body: unknown) => Promise<unknown>;

export type SchedulerOptions = {
	readonly manifest: NorbitalManifest;
	readonly dispatch: RuntimeDispatch;
	readonly automations: boolean;
	readonly integrationDelivery?: HostIntegrationDelivery;
	readonly notifications?: HostNotificationsBinding;
	readonly organizationId: string;
	readonly intervalMs: number;
	readonly log?: (message: string) => void;
};

export type Scheduler = { stop(): void };

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

type ScheduledAutomation = { readonly name: string; readonly schedule: CronSchedule };

/**
 * Resolve and validate every schedule trigger before the process starts serving requests.
 * A malformed schedule is a workspace build defect, not a partially-operational runtime mode.
 */
function scheduledAutomations(manifest: NorbitalManifest): readonly ScheduledAutomation[] {
	const scheduled: ScheduledAutomation[] = [];
	for (const [name, automation] of Object.entries(manifest.automations ?? {})) {
		if (!('schedule' in automation.trigger)) continue;
		try {
			scheduled.push({ name, schedule: parseCron(automation.trigger.schedule) });
		} catch (cause) {
			const detail = cause instanceof Error ? cause.message : String(cause);
			throw new Error(`Automation "${name}" has an invalid schedule: ${detail}`, { cause });
		}
	}
	return scheduled;
}

/**
 * Drive the host loops the runtime cannot drive itself.
 *
 * The sweep is deliberately minute-granular and non-catch-up: each automation records the minute it
 * last ran in, and a minute that matches runs at most once. A host that was asleep does not
 * retroactively fire the schedules it missed — a cron job that fires forty times on resume is
 * worse than one that skipped, and the runtime records every run in `automation_run` either way.
 */
export function startScheduler(options: SchedulerOptions): Scheduler {
	const log = options.log ?? ((message: string) => console.log(message));
	const automations = options.automations ? scheduledAutomations(options.manifest) : [];
	const deliver = options.integrationDelivery;
	const notifications = options.notifications;
	const hasEventAutomations = Object.values(options.manifest.automations ?? {}).some(
		(automation) => 'collection' in automation.trigger
	);
	if (automations.length === 0 && !deliver && !notifications && !hasEventAutomations) {
		return { stop: () => {} };
	}

	const lastRunMinute = new Map<string, number>();
	const inFlightAutomations = new Set<string>();
	let sweeping = false;

	const runAutomations = async (now: Date): Promise<void> => {
		// Identify the minute by epoch-minute so a schedule cannot fire twice within it, and so the
		// comparison stays correct across an hour or day boundary.
		const minuteKey = Math.floor(now.getTime() / 60_000);
		for (const automation of automations) {
			if (!cronMatches(automation.schedule, now)) continue;
			if (lastRunMinute.get(automation.name) === minuteKey) continue;
			lastRunMinute.set(automation.name, minuteKey);
			if (inFlightAutomations.has(automation.name)) {
				log(`[pod:scheduler] automation "${automation.name}" is still running; overlap skipped`);
				continue;
			}
			inFlightAutomations.add(automation.name);
			void options
				.dispatch({
					kind: 'automation',
					automationName: automation.name,
					triggeredBy: 'CRON'
				})
				.catch((cause) => {
					log(
						`[pod:scheduler] automation "${automation.name}" failed: ${
							cause instanceof Error ? cause.message : String(cause)
						}`
					);
				})
				.finally(() => inFlightAutomations.delete(automation.name));
		}
	};

	const runOutbox = async (): Promise<void> => {
		if (!deliver) return;
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
				`[pod:scheduler] integration delivery failed for ${group.ids.length} message(s): ${reason}`
			);
			await options.dispatch({
				kind: 'outbox',
				action: 'failed',
				ids: group.ids,
				error: reason,
				retryAt: new Date(Date.now() + retryDelayMs(group.attempts)).toISOString()
			});
		}
	};

	const runNotifications = async (): Promise<void> => {
		if (!notifications) return;
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
	};

	const sweep = async (): Promise<void> => {
		// A sweep that outlives its interval must not overlap itself: two concurrent outbox drains
		// would both claim, and two automation passes would both see the same unrun minute.
		if (sweeping) return;
		sweeping = true;
		try {
			await runAutomations(new Date());
			await Promise.all([
				runOutbox(),
				runNotifications(),
				hasEventAutomations
					? options.dispatch({ kind: 'automation-events', limit: 200 }).then(() => undefined)
					: Promise.resolve()
			]);
		} catch (cause) {
			log(
				`[pod:scheduler] sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`
			);
		} finally {
			sweeping = false;
		}
	};

	const timer = setInterval(() => void sweep(), Math.max(options.intervalMs, 1000));
	// The sweep must never be the reason the process stays alive; the HTTP server owns that.
	timer.unref();
	void sweep();

	log(
		`[pod:scheduler] started (${automations.length} scheduled automation(s)${hasEventAutomations ? ', event automations on' : ''}${deliver ? ', integration delivery on' : ''}${notifications ? ', notification delivery on' : ''})`
	);
	return { stop: () => clearInterval(timer) };
}
