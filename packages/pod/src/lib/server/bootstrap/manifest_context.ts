import type { PgTable } from 'drizzle-orm/pg-core';
import {
	ManifestContext,
	type CollectionColumnMap
} from '@norbital-ai/platform-utils/manifest/context';
import { getTableColumnDefs, portableCollectionField } from '$lib/authoring/schema/table.js';
import { systemWorkspace } from '$lib/authoring/schema/system-workspace.js';
import { buildNorbitalManifest } from '$lib/manifest/index.js';
import { mergeSystemCollections } from '$lib/authoring/schema/system-workspace.js';
import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import type { WorkspaceZone } from './workspace_store.js';

function manifestNodeId(zone: WorkspaceZone, organizationId: string): string {
	return zone === 'preview' ? `preview-file:${organizationId}` : `file:${organizationId}`;
}

type StaticManifestSlice = {
	manifest: ReturnType<typeof mergeSystemCollections>;
	columns: Record<string, CollectionColumnMap>;
};

let staticManifestSlice: StaticManifestSlice | undefined;

function getStaticManifestSlice(): StaticManifestSlice {
	if (staticManifestSlice) return staticManifestSlice;

	const workspace = getTenantWorkspace();
	const manifest = mergeSystemCollections(
		buildNorbitalManifest({
			...workspace,
			registered: workspace.registered
		})
	);
	const tables = {
		...Object.fromEntries(
			Object.entries(systemWorkspace).map(([name, entry]) => [name, entry.table])
		),
		...workspace.tables
	};
	const columns = Object.fromEntries(
		Object.entries(tables).map(([name, table]) => [
			name,
			Object.fromEntries(
				Object.entries(getTableColumnDefs(table as PgTable)).map(([fieldName, column]) => {
					const field = portableCollectionField(fieldName, column);
					return [
						fieldName,
						{
							dataType: field.kind,
							notNull: !field.nullable,
							...(field.array ? { array: true } : {}),
							...(field.values ? { values: field.values } : {}),
							...(field.options ? { options: field.options } : {}),
							...(field.currencies ? { currencies: field.currencies } : {}),
							...(field.mimeTypes ? { mimeTypes: field.mimeTypes } : {}),
							...(field.variant ? { variant: field.variant } : {})
						}
					];
				})
			)
		])
	);
	staticManifestSlice = { manifest, columns };
	return staticManifestSlice;
}

const manifestContextCache = new Map<string, ManifestContext>();

export function getManifestContext(zone: WorkspaceZone, organizationId: string): ManifestContext {
	const orgId = organizationId.trim();
	const cacheKey = `${zone}:${orgId}`;
	const cached = manifestContextCache.get(cacheKey);
	if (cached) return cached;

	const { manifest, columns } = getStaticManifestSlice();
	const manifestCtx = new ManifestContext({
		manifest,
		nodeId: manifestNodeId(zone, orgId),
		columns
	});
	manifestContextCache.set(cacheKey, manifestCtx);
	return manifestCtx;
}
