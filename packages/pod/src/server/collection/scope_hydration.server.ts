import type { ManifestCollectionEntry } from '$lib/manifest/index.js';
import type { ContextNavStackItem, TBreadcrumbItem } from '$lib/shared/scope.js';
import { ApprovalRequestResolvedSchema } from '$lib/shared/approval.js';
import { isWorkspaceCollectionName } from '$lib/shared/collection-names.js';
import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import { toRelationsFilter, toRelationsWith } from '$lib/authoring/workspace/relations-filter.js';
import { resolveRecordDisplayLabel } from '@norbital-ai/platform-utils/manifest/context';
import type {
	TApprovalConfig,
	TApprovalRequestStepNode
} from '@norbital-ai/platform-utils/system/types';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { error } from '$lib/server/http.js';
import {
	findMany,
	NorbitalDBRecordSchema,
	type TNorbitalDBRecord
} from './collection_ops.server.js';
import { runWithPermissionBypassAsync } from './access_control/permission/permission_bypass_key.server.js';

export type THydratedCollectionItem = {
	readonly collection_name: string;
	record: TNorbitalDBRecord;
	breadcrumb: TBreadcrumbItem;
	collectionMetadata: ManifestCollectionEntry;
};

async function readCollectionRecord(params: {
	collection_name: string;
	record_id: string;
	with?: Record<string, unknown>;
	notFoundMessage: string;
}): Promise<TNorbitalDBRecord> {
	const ctx = getWorkspace({ provision: true });
	const rows = await runWithPermissionBypassAsync(() =>
		findMany(ctx, params.collection_name, {
			with: toRelationsWith(params.with),
			where: toRelationsFilter({
				[SYSTEM_COLUMN_NAMES.PKEY]: { in: [params.record_id] }
			}),
			limit: 1
		})
	);
	const row = rows[0];
	if (!row) {
		throw error(404, { message: params.notFoundMessage });
	}
	return row as TNorbitalDBRecord;
}

function buildRecordBreadcrumb(
	collectionMetadata: ManifestCollectionEntry,
	record: TNorbitalDBRecord
): TBreadcrumbItem {
	try {
		const candidate = NorbitalDBRecordSchema.parse(record);
		const { text } = resolveRecordDisplayLabel(collectionMetadata, candidate);
		return { label: text, warn: false };
	} catch {
		return { label: '[record unavailable]', warn: true };
	}
}

async function resolveApprovalConfig(
	approvalConfigId: string
): Promise<NonNullable<TApprovalConfig>> {
	const ctx = getWorkspace({ provision: true });
	const policies = await runWithPermissionBypassAsync(() =>
		findMany(ctx, 'policy', { limit: 500 })
	);
	for (const policy of policies) {
		const grants = Array.isArray(policy.grants) ? policy.grants : [];
		for (const grant of grants) {
			const policyCfg = Reflect.get(grant as object, 'approval_config') as
				TApprovalConfig | null | undefined;
			if (policyCfg?.norbital_id === approvalConfigId) return policyCfg;
		}
	}

	throw error(500, { message: 'Could not resolve approval config metadata' });
}

async function enrichCollectionRecord(
	collectionName: string,
	record: TNorbitalDBRecord
): Promise<TNorbitalDBRecord> {
	if (collectionName !== 'approval_request') {
		return record;
	}

	const runtime = getWorkspace({ provision: true });
	const stepStack = (record.approval_step_nodes as TApprovalRequestStepNode[][] | undefined) ?? [];
	const currentStepGroup = stepStack.at(-1) ?? [];
	const approvalConfig = await resolveApprovalConfig(String(record.approval_config_id));
	const teamKeyList = currentStepGroup.flatMap((node) => node.teams_that_can_approve);
	const teamRows =
		teamKeyList.length === 0
			? []
			: await runWithPermissionBypassAsync(() =>
					findMany(runtime, 'team', {
						where: toRelationsFilter({
							[SYSTEM_COLUMN_NAMES.PKEY]: { in: teamKeyList }
						}),
						limit: teamKeyList.length
					})
				);
	const teams = teamRows;

	const resolved = {
		...record,
		norbital_id: String(record.norbital_id),
		organization_id: runtime.organization.norbital_id,
		label: String(record.label),
		approval_config_id: String(record.approval_config_id),
		requestor: String(record.requestor),
		approval_config: approvalConfig,
		teams
	};
	ApprovalRequestResolvedSchema.parse(resolved);
	return resolved;
}

export async function hydrateCollectionRecord(
	item: ContextNavStackItem
): Promise<THydratedCollectionItem> {
	const runtime = getWorkspace({ provision: true });
	const collection = runtime.manifestCtx.findCollection(item.collection_name);
	if (!collection) {
		throw error(404, { message: `Collection ${item.collection_name} not found` });
	}

	isWorkspaceCollectionName(runtime.manifestCtx, item.collection_name, { throw: true });
	const collectionName = item.collection_name;
	const collectionMetadata =
		collection.collection_name === collectionName
			? collection
			: { ...collection, collection_name: collectionName };
	const rawRecord = await readCollectionRecord({
		collection_name: collectionName,
		record_id: item.record_id,
		with: item.with as Record<string, unknown> | undefined,
		notFoundMessage: `Record ${item.record_id} not found in collection ${item.collection_name}`
	});
	const record = await enrichCollectionRecord(
		collectionName,
		NorbitalDBRecordSchema.parse(rawRecord)
	);

	return {
		collection_name: collectionName,
		record,
		breadcrumb: buildRecordBreadcrumb(collectionMetadata, record),
		collectionMetadata
	};
}
