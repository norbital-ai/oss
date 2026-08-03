import type { TablesRelationalConfig } from 'drizzle-orm';
import type { AnySchema } from '$lib/authoring/schema/types.js';
import type { DbApi } from '$lib/authoring/workspace/db-api-types.js';
import type { InvokeClientApi, InvokeMap } from '$lib/authoring/workspace/invoke-api-types.js';
import type { MergedWorkspaceSchema } from '$lib/authoring/schema/system-workspace.js';
import { isWorkspaceCollectionName } from '$lib/shared/collection-names.js';

export { isWorkspaceCollectionName };

/** Tenant schema with no tables — default bound keeps platform collections strongly typed. */
export type EmptyTenantSchema = {
	readonly tables: {};
	readonly relations: TablesRelationalConfig;
	readonly inputs: {};
};

/** Workspace client API — remote `db` reads return Pod reactive read results; invoke queries ditto. */
export type WorkspaceClient<
	S extends AnySchema = EmptyTenantSchema,
	TInvoke extends InvokeMap = InvokeMap
> = {
	readonly db: DbApi<MergedWorkspaceSchema<S>, 'remote'>;
	readonly invoke: InvokeClientApi<TInvoke>;
};
