import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { requireTable } from '$lib/server/collection/collection_direct.js';
import { runWithPermissionBypassAsync } from '$lib/server/collection/access_control/permission/permission_bypass_key.server.js';
import { validate as uuidValidate, v7 as uuidv7 } from 'uuid';
import { rowsPerMutationStatement } from '$lib/server/collection/mutation-batching.js';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import { readColumnCustom } from '$lib/authoring/schema/columns.js';

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

	await runWithPermissionBypassAsync(async () => {
		const auditInsertChunk = rowsPerMutationStatement(8, 5_000);
		for (let from = 0; from < payloads.length; from += auditInsertChunk) {
			await db
				.insert(requireTable(runtime, 'audit_event'))
				.values(payloads.slice(from, from + auditInsertChunk));
		}
	});
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

const SERVER_AUDIT_JSON_SQL_TYPES = new Set([
	'boolean',
	'date',
	'integer',
	'json',
	'jsonb',
	'smallint',
	'text',
	'tstzrange',
	'uuid'
]);

function normalizedSqlType(column: AnyPgColumn): string {
	return column.getSQLType().trim().replace(/\s+/g, ' ').toLowerCase();
}

function isTimestampWithTimeZone(column: AnyPgColumn): boolean {
	return /^timestamp(?:\(\d+\))? with time zone$/.test(normalizedSqlType(column));
}

function isServerAuditJsonColumn(column: AnyPgColumn): boolean {
	const custom = readColumnCustom(column);
	if (custom && 'definitionBacked' in custom) return false;
	const sqlType = normalizedSqlType(column);
	return (
		Boolean(column.enumValues?.length) ||
		SERVER_AUDIT_JSON_SQL_TYPES.has(sqlType) ||
		/^character varying(?:\(\d+\))?$/.test(sqlType) ||
		/^varchar(?:\(\d+\))?$/.test(sqlType) ||
		/^character(?:\(\d+\))?$/.test(sqlType) ||
		/^char(?:\(\d+\))?$/.test(sqlType) ||
		isTimestampWithTimeZone(column)
	);
}

/**
 * Whether PostgreSQL JSON matches the row shape Drizzle gives the ordinary audit path.
 *
 * Keep this deliberately narrow. In particular numeric, bigint, float, bytea, vector, array and
 * workspace-defined SQL types retain the ordinary returned-row audit path until their driver JSON
 * normalization has an explicit equivalence test.
 */
export function supportsServerCreatedAuditProjection(sourceTable: PgTable): boolean {
	return Object.values(getTableColumns(sourceTable)).every(isServerAuditJsonColumn);
}

function serverAuditChangesAfter(sourceTable: PgTable): SQL {
	const timestampColumns = Object.values(getTableColumns(sourceTable)).filter(
		isTimestampWithTimeZone
	);
	return timestampColumns.reduce<SQL>(
		(changesAfter, column) => {
			const sourceColumn = sql`source_row.${sql.identifier(column.name)}`;
			return sql`${changesAfter} || jsonb_build_object(
			${column.name}::text,
			CASE
				WHEN ${sourceColumn} IS NULL THEN 'null'::jsonb
				ELSE to_jsonb(to_char(
					${sourceColumn} AT TIME ZONE 'UTC',
					'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
				))
			END
		)`;
		},
		sql`to_jsonb(source_row)`
	);
}

/**
 * Write create audits from the authoritative rows already stored in PostgreSQL.
 *
 * Elevated bulk callers may only need created ids back. Pulling every wide row over the tenant
 * connection merely to JSON-encode it and send it straight back as `changes_after` made large
 * factory seeds pay for the same payload twice. This form keeps the full audit snapshot, actor,
 * checkpoint and transaction boundary unchanged, but lets PostgreSQL form `to_jsonb(source_row)`
 * beside the insert. Caller order is carried explicitly through `ordinal`.
 */
export async function sendCreatedAuditEventsFromTable(
	collectionName: string,
	sourceTable: PgTable,
	recordIds: readonly string[]
): Promise<void> {
	if (recordIds.length === 0 || collectionName === 'audit_event') return;
	const runtime = getWorkspace({ provision: true });
	const actorId = runtime.baseScope.requestor?.norbital_id;
	if (!actorId) throw new Error('Audit event requires an authenticated actor');
	const db = runtime.drizzleDb;
	if (!db) throw new Error('Tenant database is not provisioned');
	const auditTable = requireTable(runtime, 'audit_event');
	const actor = uuidValidate(actorId) ? actorId : null;
	const writtenAt = new Date().toISOString();
	const chunkSize = rowsPerMutationStatement(3, 5_000);
	const changesAfter = serverAuditChangesAfter(sourceTable);

	await runWithPermissionBypassAsync(async () => {
		for (let from = 0; from < recordIds.length; from += chunkSize) {
			const values = recordIds
				.slice(from, from + chunkSize)
				.map((recordId, index) => sql`(${uuidv7()}::uuid, ${recordId}::uuid, ${from + index})`);
			await db.execute(sql`
				WITH requested(audit_id, record_id, ordinal) AS (
					VALUES ${sql.join(values, sql`, `)}
				)
				INSERT INTO ${auditTable} (
					norbital_id,
					norbital_created_at,
					norbital_updated_at,
					event_type,
					collection_name,
					record_id,
					details,
					actor_id
				)
				SELECT
					requested.audit_id,
					${writtenAt}::timestamptz,
					${writtenAt}::timestamptz,
					'create',
					${collectionName}::text,
					requested.record_id,
					jsonb_build_object(
						'action', 'record.create',
						'entity_type', ${collectionName}::text,
						'checkpoint_id', ${runtime.manifestCtx.nodeId}::text,
						'changes_before', NULL,
						'changes_after', ${changesAfter},
						'metadata', NULL
					),
					${actor}::uuid
				FROM requested
				JOIN ${sourceTable} AS source_row
					ON source_row.norbital_id = requested.record_id
				ORDER BY requested.ordinal
			`);
		}
	});
}
