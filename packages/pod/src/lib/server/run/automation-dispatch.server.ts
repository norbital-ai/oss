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
	// The manifest only projects cron_schedule; collection-event triggers live in the registered
	// workspace automations, keyed name → { trigger, spec }.
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
				triggeredBy: 'EVENT',
				scope: { incoming_record: change.record }
			});
		} catch (err) {
			// runAutomation already records the failure in automation_run; keep dispatching the rest.
			console.error('[automation-dispatch]', { automationName, err });
		}
	}
	return names;
}

/** Where the dispatcher left off, durable so a restart neither re-runs nor skips effects. */
async function readAutomationCursor(ctx: ProvisionedContext): Promise<OutboxCursor> {
	const result = await ctx.tenantDb.query<{ xid: string; seq: string }>(
		`SELECT xid, seq FROM _norbital_automation_cursor WHERE singleton = TRUE`
	);
	const row = result.rows[0];
	return row ? { xid: row.xid, seq: row.seq } : OUTBOX_CURSOR_START;
}

async function writeAutomationCursor(ctx: ProvisionedContext, cursor: OutboxCursor): Promise<void> {
	await ctx.tenantDb.query(
		`UPDATE _norbital_automation_cursor
		    SET xid = $1, seq = $2, pumped_at = CURRENT_TIMESTAMP
		  WHERE singleton = TRUE`,
		[cursor.xid, cursor.seq]
	);
}

/**
 * Drain the change feed and dispatch collection-event automations, then advance the durable cursor.
 *
 * This is the driver the declared `{ trigger: { collection, event } }` form depends on: without a
 * host calling it, such an automation is matched by nothing and never runs. Effects fire post-commit
 * off the authoritative feed, never on an optimistic client preview, and the record is re-read so
 * the automation sees committed state. The cursor advances only after the batch has dispatched, so
 * a crash repeats a batch rather than losing it.
 */
export async function pumpAutomations(
	ctx: ProvisionedContext,
	limit = 200
): Promise<{ readonly cursor: OutboxCursor; readonly dispatched: number }> {
	const cursor = await readAutomationCursor(ctx);
	const batch = await readSyncOutboxBatch(ctx, cursor, limit);
	if (batch.rows.length === 0) return { cursor, dispatched: 0 };
	let dispatched = 0;
	for (const row of batch.rows) {
		if (row.action === 'delete') {
			dispatched += (
				await dispatchChangeToAutomations(ctx, {
					collection: row.collection,
					action: 'delete',
					record: { norbital_id: row.recordId }
				})
			).length;
			continue;
		}
		const record = await fetchRecord(ctx, row.collection, row.recordId);
		if (!record) continue;
		dispatched += (
			await dispatchChangeToAutomations(ctx, {
				collection: row.collection,
				action: row.action === 'create' ? 'create' : 'update',
				record
			})
		).length;
	}
	await writeAutomationCursor(ctx, batch.cursor);
	return { cursor: batch.cursor, dispatched };
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
