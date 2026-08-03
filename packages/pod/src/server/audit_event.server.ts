import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { requireTable } from '$lib/server/collection/collection_direct.js';
import { runWithPermissionBypassAsync } from '$lib/server/collection/access_control/permission/permission_bypass_key.server.js';
import { validate as uuidValidate, v7 as uuidv7 } from 'uuid';

export type AuditEventParams = {
	action: string;
	entityType: string;
	entityId?: string;
	changesBefore?: Record<string, unknown> | null;
	changesAfter?: Record<string, unknown> | null;
	metadata?: Record<string, unknown>;
};

export function buildAuditEventPayload(input: {
	collectionName: string;
	eventType: string;
	params: AuditEventParams;
	checkpointId: string;
	actorId: string;
}): Record<string, unknown> {
	const { params } = input;
	const now = new Date().toISOString();
	return {
		norbital_id: uuidv7(),
		norbital_created_at: now,
		norbital_updated_at: now,
		event_type: input.eventType,
		collection_name: input.collectionName,
		record_id: params.entityId && uuidValidate(params.entityId) ? params.entityId : null,
		details: {
			action: params.action,
			entity_type: params.entityType,
			checkpoint_id: input.checkpointId,
			changes_before: params.changesBefore ?? null,
			changes_after: params.changesAfter ?? null,
			metadata: params.metadata ?? null
		},
		actor_id: uuidValidate(input.actorId) ? input.actorId : null
	};
}

export type AuditEventInput = {
	readonly collectionName: string;
	readonly params: AuditEventParams;
	readonly eventLabel: string;
};

async function writeAuditEvents(events: readonly AuditEventInput[]): Promise<void> {
	const runtime = getWorkspace({ provision: true });
	const actorId = runtime.baseScope.requestor?.norbital_id;
	if (!actorId) throw new Error('Audit event requires an authenticated actor');
	const db = runtime.drizzleDb;
	if (!db) throw new Error('Tenant database is not provisioned');

	const payloads = events
		.filter(({ collectionName }) => collectionName !== 'audit_event')
		.map(({ collectionName, params, eventLabel }) =>
			buildAuditEventPayload({
				collectionName,
				eventType: eventLabel,
				params,
				checkpointId: runtime.manifestCtx.nodeId,
				actorId
			})
		);
	if (payloads.length === 0) return;

	await runWithPermissionBypassAsync(() =>
		db.insert(requireTable(runtime, 'audit_event')).values(payloads)
	);
}

export async function sendAuditEvent(
	collectionName: string,
	params: AuditEventParams,
	eventLabel: string
): Promise<void> {
	await sendAuditEvents([{ collectionName, params, eventLabel }]);
}

export async function sendAuditEvents(events: readonly AuditEventInput[]): Promise<void> {
	if (events.length === 0) return;
	await writeAuditEvents(events);
}
