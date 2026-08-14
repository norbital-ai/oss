import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import {
	CollectionRecordHistoryEntrySchema,
	type FindHistoryWireSchema
} from '@norbital-ai/platform-utils/remote/collection_wire_schemas';
import type { CollectionRecordHistoryEntry } from '@norbital-ai/platform-utils/collection';
import {
	qualifiedHistoryTableName,
	qualifiedTableName
} from '@norbital-ai/platform-utils/tenant_db/schema';
import type { z } from 'zod';
import { toRelationsFilter } from '$lib/authoring/workspace/relations-filter.js';
import type { ProvisionedContext, TenantDbClient } from '../bootstrap/workspace_store.js';
import { findFirst } from './collection_ops.server.js';
import { error } from '$lib/server/http.js';
import { requestI18nOrDefault } from '$lib/server/i18n.js';

type RecordHistoryInput = z.infer<typeof FindHistoryWireSchema>;

export async function loadRecordHistorySnapshots(
	tenantDb: TenantDbClient,
	input: RecordHistoryInput
): Promise<readonly CollectionRecordHistoryEntry[]> {
	const result = await tenantDb.query(
		`SELECT DISTINCT ON (version) "values", "validFrom", "validTo", version
		   FROM (
		     SELECT to_jsonb(history_row) AS "values",
		            lower(history_row.norbital_sys_period)::text AS "validFrom",
		            upper(history_row.norbital_sys_period)::text AS "validTo",
		            history_row.norbital_row_version AS version
		       FROM ${qualifiedHistoryTableName(input.collection)} history_row
		      WHERE history_row.norbital_id = $1::uuid
		     UNION ALL
		     SELECT to_jsonb(current_row) AS "values",
		            lower(current_row.norbital_sys_period)::text AS "validFrom",
		            upper(current_row.norbital_sys_period)::text AS "validTo",
		            current_row.norbital_row_version AS version
		       FROM ${qualifiedTableName(input.collection)} current_row
		      WHERE current_row.norbital_id = $1::uuid
		   ) snapshots
		  ORDER BY version DESC, "validTo" DESC NULLS FIRST
		  LIMIT $2`,
		[input.record_id, input.limit]
	);

	return result.rows.map((row) => CollectionRecordHistoryEntrySchema.parse(row));
}

export async function findRecordHistory(ctx: ProvisionedContext, input: RecordHistoryInput) {
	const current = await findFirst(ctx, input.collection, {
		where: toRelationsFilter({ [SYSTEM_COLUMN_NAMES.PKEY]: input.record_id })
	});
	if (!current) throw error(404, requestI18nOrDefault().t('pod.server.recordNotFoundSimple'));
	return loadRecordHistorySnapshots(ctx.tenantDb, input);
}
