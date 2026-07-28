import type {
	CollectionGroupedQuery,
	CollectionQuery
} from '$lib/authoring/workspace/db-api-types.js';
import { toRelationsFilter, toRelationsWith } from '$lib/authoring/workspace/relations-filter.js';
import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import { Guard, requireAuthMiddleware } from '$lib/remote/guard.server.js';
import {
	runCollectionExportPipeline,
	runCollectionImportPipeline
} from '$lib/server/run/tenant_run.js';
import { findRecordHistory } from '$lib/server/collection/record_history.server.js';
import { ensureOrganizationAdmin, getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import {
	countRecords as runCountRecords,
	createMany as runCreateMany,
	createRecord as runCreateRecord,
	deleteRecord as runDeleteRecord,
	findGrouped as runFindGrouped,
	findFirst as runFindFirst,
	findMany as runFindMany,
	findManyPage as runFindManyPage,
	updateMany as runUpdateMany,
	updateRecord as runUpdateRecord
} from '$lib/server/collection/collection_ops.server.js';
import { runWithBypassSecretIfValidAsync } from '$lib/server/collection/access_control/permission/permission_bypass_key.server.js';
import { error } from '$lib/runtime/http.js';
import {
	CountWireSchema,
	CreateManyWireSchema,
	CreateWireSchema,
	DeleteWireSchema,
	ExportRecordsWireSchema,
	FindGroupedWireSchema,
	FindHistoryWireSchema,
	FindFirstWireSchema,
	FindManyWireSchema,
	ImportRecordsWireSchema,
	UpdateManyWireSchema,
	UpdateWireSchema
} from '@norbital-ai/platform-utils/remote/collection_wire_schemas';
import { noInputSchema } from '@norbital-ai/platform-utils/remote';
import { z } from 'zod';

const authenticated = Guard.init().use(requireAuthMiddleware());

export const getCollectionDefinitions = authenticated.query(
	noInputSchema,
	() => getTenantWorkspace().collectionDefinitions
);

function requireCollection(collection: string): void {
	const workspace = getWorkspace({ provision: true });
	if (!(collection in workspace.manifestCtx.manifest.collections)) {
		throw error(404, `Unknown collection "${collection}".`);
	}
}

export const findMany = authenticated.query(FindManyWireSchema, async (params) => {
	const ctx = getWorkspace({ provision: true });
	requireCollection(params.collection);
	const { collection, bypass_secret, filters, after, ...query } = params;
	return runWithBypassSecretIfValidAsync(bypass_secret, () =>
		runFindManyPage(
			ctx,
			collection,
			{ ...query, after } as CollectionQuery & { after?: string },
			filters
		)
	);
});

export const findFirst = authenticated.query(FindFirstWireSchema, async (params) => {
	const ctx = getWorkspace({ provision: true });
	requireCollection(params.collection);
	const { collection, bypass_secret, ...query } = params;
	return runWithBypassSecretIfValidAsync(bypass_secret, () =>
		runFindFirst(ctx, collection, {
			...query,
			with: toRelationsWith(query.with),
			where: query.where ? toRelationsFilter(query.where) : undefined
		})
	);
});

export const findHistory = authenticated.query(FindHistoryWireSchema, async (params) => {
	const ctx = getWorkspace({ provision: true });
	requireCollection(params.collection);
	return findRecordHistory(ctx, params);
});

export const findGrouped = authenticated.query(FindGroupedWireSchema, async (params) => {
	const ctx = getWorkspace({ provision: true });
	requireCollection(params.collection);
	const { collection, bypass_secret, filters, ...query } = params;
	return runWithBypassSecretIfValidAsync(bypass_secret, () =>
		runFindGrouped(ctx, collection, query as CollectionGroupedQuery, filters)
	);
});

export const count = authenticated.query(CountWireSchema, async (params) => {
	const ctx = getWorkspace({ provision: true });
	requireCollection(params.collection);
	const { collection, bypass_secret, filters, ...query } = params;
	return runWithBypassSecretIfValidAsync(bypass_secret, () =>
		runCountRecords(ctx, collection, query as CollectionQuery, filters)
	);
});

export const create = authenticated.command(CreateWireSchema, async (params) => {
	const ctx = getWorkspace({ provision: true });
	requireCollection(params.collection);
	return runWithBypassSecretIfValidAsync(params.bypass_secret, () =>
		runCreateRecord(ctx, params.collection, params.input)
	);
});

export const createMany = authenticated.command(CreateManyWireSchema, async (params) => {
	const ctx = getWorkspace({ provision: true });
	requireCollection(params.collection);
	return runWithBypassSecretIfValidAsync(params.bypass_secret, () =>
		runCreateMany(ctx, params.collection, params.inputs)
	);
});

export const update = authenticated.command(UpdateWireSchema, async (params) => {
	const ctx = getWorkspace({ provision: true });
	requireCollection(params.collection);
	return runWithBypassSecretIfValidAsync(params.bypass_secret, () =>
		runUpdateRecord(ctx, params.collection, params.record_id, params.input)
	);
});

export const updateMany = authenticated.command(UpdateManyWireSchema, async (params) => {
	const ctx = getWorkspace({ provision: true });
	requireCollection(params.collection);
	return runWithBypassSecretIfValidAsync(params.bypass_secret, () =>
		runUpdateMany(
			ctx,
			params.collection,
			params.updates.map((entry) => ({ recordId: entry.record_id, input: entry.input }))
		)
	);
});

export const deleteRecord = authenticated.command(DeleteWireSchema, async (params) => {
	const ctx = getWorkspace({ provision: true });
	requireCollection(params.collection);
	await runWithBypassSecretIfValidAsync(params.bypass_secret, () =>
		runDeleteRecord(ctx, params.collection, params.record_id)
	);
});

export const AdminSystemCollectionSchema = z.enum(['team', 'policy', 'team_members']);
export const AdminSystemCreateSchema = z.object({
	collection: AdminSystemCollectionSchema,
	input: z.record(z.string(), z.unknown())
});
export const AdminSystemUpdateSchema = AdminSystemCreateSchema.extend({ record_id: z.string() });
export const AdminSystemDeleteSchema = z.object({
	collection: AdminSystemCollectionSchema,
	record_id: z.string()
});

export const adminCreateSystemRecord = authenticated.command(
	AdminSystemCreateSchema,
	async (params) => {
		ensureOrganizationAdmin();
		const ctx = getWorkspace({ provision: true });
		return runCreateRecord(ctx, params.collection, params.input, { isElevated: true });
	}
);

export const adminUpdateSystemRecord = authenticated.command(
	AdminSystemUpdateSchema,
	async (params) => {
		ensureOrganizationAdmin();
		const ctx = getWorkspace({ provision: true });
		return runUpdateRecord(ctx, params.collection, params.record_id, params.input, {
			isElevated: true
		});
	}
);

export const adminDeleteSystemRecord = authenticated.command(
	AdminSystemDeleteSchema,
	async (params) => {
		ensureOrganizationAdmin();
		const ctx = getWorkspace({ provision: true });
		await runDeleteRecord(ctx, params.collection, params.record_id, { isElevated: true });
	}
);

export const exportPipeline = authenticated.command(ExportRecordsWireSchema, async (input) => {
	const ctx = getWorkspace({ provision: true });
	const collectionName = input.collection_name;
	requireCollection(collectionName);
	const collectionMeta = ctx.manifestCtx.getCollection(collectionName);
	if (!collectionMeta.pipelines?.export) {
		throw error(404, `Collection '${collectionName}' has no export pipeline configured.`);
	}

	return runWithBypassSecretIfValidAsync(input.bypass_secret, async () => {
		const recordIds = input.record_ids?.filter((id) => id.length > 0) ?? [];
		const records =
			recordIds.length > 0
				? await runFindMany(ctx, collectionName, {
						with: toRelationsWith(input.with),
						where: toRelationsFilter({
							[SYSTEM_COLUMN_NAMES.PKEY]: { in: recordIds }
						}),
						limit: recordIds.length
					})
				: await runFindMany(ctx, collectionName, {
						with: toRelationsWith(input.with),
						where: input.where ? toRelationsFilter(input.where) : undefined,
						limit: input.limit ?? 10_000
					});

		return runCollectionExportPipeline({
			collectionName,
			context: { scope: { records }, collection: { name: collectionName } }
		});
	});
});

export const importPipeline = authenticated.command(ImportRecordsWireSchema, async (input) => {
	const ctx = getWorkspace({ provision: true });
	const collectionName = input.collection_name;
	requireCollection(collectionName);
	const collectionMeta = ctx.manifestCtx.getCollection(collectionName);
	if (!collectionMeta.pipelines?.import) {
		throw error(404, `Collection '${collectionName}' has no import pipeline configured.`);
	}

	return runWithBypassSecretIfValidAsync(input.bypass_secret, async () => {
		const payloads = await runCollectionImportPipeline({
			collectionName,
			context: {
				scope: { import_data: input.import_data },
				collection: { name: collectionName }
			}
		});

		if (!Array.isArray(payloads) || payloads.length === 0) {
			throw error(400, 'Import pipeline returned no records.');
		}

		return runCreateMany(ctx, collectionName, payloads);
	});
});
