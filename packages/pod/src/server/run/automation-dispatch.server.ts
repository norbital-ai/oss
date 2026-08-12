import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import {
	readSyncOutboxBatch,
	OUTBOX_CURSOR_START,
	type OutboxCursor
} from '$lib/server/collection/sync/outbox-tailer.server.js';
import { runAutomation } from './tenant_run.js';

/**
 * The change feed has two consumers: the client sync stream (reads) and this dispatcher
 * (effects). Automations declared with `on: '<collection>.<event>'` subscribe to committed
 * changes and run server-only, post-commit — so effects (email, webhooks, further writes) fire
 * exactly once off the authoritative feed, never on an optimistic client preview.
 */

export type ChangeAction = 'create' | 'update' | 'delete';
export type AutomationEvent = 'created' | 'updated' | 'deleted';

export function eventForAction(action: ChangeAction): AutomationEvent {
	return action === 'create' ? 'created' : action === 'update' ? 'updated' : 'deleted';
}

type RegisteredAutomation = {
	readonly trigger?: unknown;
};

type AutomationJob = {
	readonly norbital_id: string;
	readonly automation_name: string;
	readonly collection: string;
	readonly record_id: string;
	readonly action: ChangeAction;
	readonly attempts: number;
};

// Provider calls are billed. Serial execution keeps the trial-cap check, provider call and usage
// record ordered until billing owns an atomic spend reservation primitive.
const AUTOMATION_JOB_CONCURRENCY = 1;
const AUTOMATION_JOB_MAX_ATTEMPTS = 5;
const AUTOMATION_JOB_LEASE_SECONDS = 120;

/** Pure: the automations whose collection-event trigger matches this change. */
export function matchChangeAutomations(
	automations: Record<string, RegisteredAutomation> | undefined,
	collection: string,
	event: AutomationEvent
): string[] {
	if (!automations) return [];
	const matched: string[] = [];
	for (const [name, automation] of Object.entries(automations)) {
		const trigger = automation?.trigger;
		if (!trigger || typeof trigger !== 'object' || !('trigger' in trigger)) continue;
		const spec = (trigger as { trigger: { collection?: unknown; event?: unknown } }).trigger;
		if (spec?.collection === collection && spec?.event === event) matched.push(name);
	}
	return matched.sort();
}

/** Run every automation subscribed to `collection.<event>` with `scope.incoming_record = record`. */
export async function dispatchChangeToAutomations(
	ctx: ProvisionedContext,
	change: { collection: string; action: ChangeAction; record: Record<string, unknown> }
): Promise<string[]> {
	// Registered definitions hold the executable handler/spec; the manifest is only the serializable
	// projection drained through the `queue` facility.
	const registered = getTenantWorkspace().registered.automations as
		Record<string, RegisteredAutomation> | undefined;
	const names = matchChangeAutomations(
		registered,
		change.collection,
		eventForAction(change.action)
	);
	for (const automationName of names) {
		try {
			await runAutomation({
				automationName,
				scope: { incoming_record: change.record }
			});
		} catch (err) {
			// runAutomation already records the failure in automation_run; keep dispatching the rest.
			console.error('[automation-dispatch]', { automationName, err });
		}
	}
	return names;
}

/**
 * Pump: drain the change feed and dispatch automations, advancing the safe-watermark cursor. A
 * worker calls this on the outbox tail (the same feed the sync stream consumes). Exactly-once
 * relative to the cursor; the record is fetched fresh so the automation sees committed state.
 */
export async function pumpAutomations(
	ctx: ProvisionedContext,
	cursor: OutboxCursor = OUTBOX_CURSOR_START,
	limit = 200,
	onAdvance?: (cursor: OutboxCursor) => Promise<void>
): Promise<OutboxCursor> {
	const batch = await readSyncOutboxBatch(ctx, cursor, limit);
	for (const row of batch.rows) {
		if (row.action === 'delete') {
			await dispatchChangeToAutomations(ctx, {
				collection: row.collection,
				action: 'delete',
				record: { norbital_id: row.recordId }
			});
		} else {
			const record = await fetchRecord(ctx, row.collection, row.recordId);
			if (record) {
				await dispatchChangeToAutomations(ctx, {
					collection: row.collection,
					action: row.action === 'create' ? 'create' : 'update',
					record
				});
			}
		}
		await onAdvance?.({ xid: row.xid, seq: row.seq });
	}
	return batch.cursor;
}

/**
 * Materialize committed matching events as durable jobs, then advance the independent scan cursor.
 * A repeated scan is harmless: the event identity is unique per automation.
 */
export async function enqueueRegisteredAutomations(
	ctx: ProvisionedContext,
	limit = 200
): Promise<OutboxCursor> {
	const enqueue = async (tenantDb: ProvisionedContext['tenantDb']): Promise<OutboxCursor> => {
		const txCtx = { ...ctx, tenantDb };
		const stored = await tenantDb.query<{ xid: string; seq: string }>(
			`SELECT xid::text AS xid, seq::text AS seq
			   FROM _norbital_automation_cursor
			  WHERE singleton = TRUE
			  FOR UPDATE`
		);
		const cursor = stored.rows[0] ?? OUTBOX_CURSOR_START;
		const batch = await readSyncOutboxBatch(txCtx, cursor, limit);
		const registered = getTenantWorkspace().registered.automations as
			Record<string, RegisteredAutomation> | undefined;
		const jobs = batch.rows.flatMap((row) =>
			matchChangeAutomations(registered, row.collection, eventForAction(row.action)).map(
				(automationName) => ({ row, automationName })
			)
		);
		if (jobs.length > 0) {
			const params: unknown[] = [];
			const values = jobs.map(({ row, automationName }, index) => {
				const base = index * 6;
				params.push(automationName, row.xid, row.seq, row.collection, row.recordId, row.action);
				return `($${base + 1}, $${base + 2}::xid8, $${base + 3}::bigint, $${base + 4}, $${base + 5}::uuid, $${base + 6})`;
			});
			await tenantDb.query(
				`INSERT INTO _norbital_automation_job
				   (automation_name, event_xid, event_seq, collection, record_id, action)
				 VALUES ${values.join(', ')}
				 ON CONFLICT (automation_name, event_xid, event_seq) DO NOTHING`,
				params
			);
		}
		if (batch.rows.length > 0) {
			await tenantDb.query(
				`UPDATE _norbital_automation_cursor
				    SET xid = $1::xid8, seq = $2::bigint
				  WHERE singleton = TRUE`,
				[batch.cursor.xid, batch.cursor.seq]
			);
		}
		return batch.cursor;
	};

	return ctx.tenantDb.transaction
		? ctx.tenantDb.transaction(async (tx) => enqueue(tx))
		: enqueue(ctx.tenantDb);
}

async function claimAutomationJobs(
	ctx: ProvisionedContext,
	limit: number
): Promise<readonly AutomationJob[]> {
	const result = await ctx.tenantDb.query<AutomationJob>(
		`WITH claimable AS (
		   SELECT norbital_id
		     FROM _norbital_automation_job
		    WHERE attempts < $1
		      AND next_attempt_at <= CURRENT_TIMESTAMP
		      AND (status = 'pending' OR (status = 'processing' AND lease_until <= CURRENT_TIMESTAMP))
		    ORDER BY event_xid, event_seq, automation_name
		    FOR UPDATE SKIP LOCKED
		    LIMIT $2
		 )
		 UPDATE _norbital_automation_job AS job
		    SET status = 'processing',
		        attempts = attempts + 1,
		        lease_until = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
		        updated_at = CURRENT_TIMESTAMP
		   FROM claimable
		  WHERE job.norbital_id = claimable.norbital_id
		 RETURNING job.norbital_id::text, job.automation_name, job.collection,
		           job.record_id::text, job.action, job.attempts`,
		[AUTOMATION_JOB_MAX_ATTEMPTS, Math.min(Math.max(limit, 1), 200), AUTOMATION_JOB_LEASE_SECONDS]
	);
	return result.rows;
}

async function runAutomationJob(ctx: ProvisionedContext, job: AutomationJob): Promise<void> {
	try {
		const record =
			job.action === 'delete'
				? { norbital_id: job.record_id }
				: await fetchRecord(ctx, job.collection, job.record_id);
		if (record) {
			await runAutomation({
				automationName: job.automation_name,
				scope: { incoming_record: record }
			});
		}
		await ctx.tenantDb.query(
			`UPDATE _norbital_automation_job
			    SET status = 'succeeded', lease_until = NULL, last_error = NULL,
			        updated_at = CURRENT_TIMESTAMP
			  WHERE norbital_id = $1::uuid`,
			[job.norbital_id]
		);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		const dead = job.attempts >= AUTOMATION_JOB_MAX_ATTEMPTS;
		const retrySeconds = Math.min(2 ** job.attempts, 3600);
		await ctx.tenantDb.query(
			`UPDATE _norbital_automation_job
			    SET status = $2,
			        next_attempt_at = CURRENT_TIMESTAMP + ($3 * INTERVAL '1 second'),
			        lease_until = NULL,
			        last_error = $4,
			        updated_at = CURRENT_TIMESTAMP
			  WHERE norbital_id = $1::uuid`,
			[job.norbital_id, dead ? 'dead' : 'pending', retrySeconds, message]
		);
	}
}

async function runClaimedAutomationJobs(ctx: ProvisionedContext, limit: number): Promise<void> {
	const jobs = await claimAutomationJobs(ctx, limit);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(AUTOMATION_JOB_CONCURRENCY, jobs.length) }, async () => {
			while (next < jobs.length) {
				const job = jobs[next++];
				if (job) await runAutomationJob(ctx, job);
			}
		})
	);
}

/** Tenant-wide event pump. Scanning is durable and external effects run from leased jobs. */
export async function pumpRegisteredAutomations(
	ctx: ProvisionedContext,
	limit = 200
): Promise<OutboxCursor> {
	const cursor = await enqueueRegisteredAutomations(ctx, limit);
	await runClaimedAutomationJobs(ctx, limit);
	return cursor;
}

async function fetchRecord(
	ctx: ProvisionedContext,
	collection: string,
	id: string
): Promise<Record<string, unknown> | undefined> {
	if (!/^[a-z_][a-z0-9_]*$/i.test(collection)) return undefined;
	const result = await ctx.tenantDb.query<Record<string, unknown>>(
		`SELECT * FROM "${collection}" WHERE norbital_id = $1`,
		[id]
	);
	return result.rows[0];
}
