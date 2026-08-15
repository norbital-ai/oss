import { platformSchema, systemWorkspace } from '$lib/authoring/schema/system-workspace.js';
import type { TUserRole } from '@norbital-ai/platform-utils/system/types';
import { defineRelations } from 'drizzle-orm';
import type { TBaseScope } from '$lib/shared/scope.js';
import type { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';
import { error } from '$lib/server/http.js';
import { drizzle, type PgRemoteDatabase } from 'drizzle-orm/pg-proxy';
import type { PgTable } from 'drizzle-orm/pg-core';
import { createAsyncStore } from '$lib/server/async-store.js';
import { currentPodCallOrNull, withPodCallField } from '$lib/server/pod-call.js';

export type WorkspaceZone = 'live' | 'preview';
export type TenantDbQueryResult<T = Record<string, unknown>> = {
	readonly rows: readonly T[];
	readonly rowCount?: number;
};
export type TenantDbQueryInput =
	| string
	| {
			readonly text?: string;
			readonly values?: unknown[];
			readonly params?: unknown[];
			readonly rowMode?: 'array';
	  };

export type TenantDbQueryFn = <T = Record<string, unknown>>(
	queryText: string | TenantDbQueryInput,
	params?: unknown[]
) => Promise<TenantDbQueryResult<T>>;
export type TenantDbClient = {
	query: TenantDbQueryFn;
	end?: () => Promise<void>;
	transaction?: <T>(fn: (tx: { query: TenantDbQueryFn }) => Promise<T>) => Promise<T>;
	/** One host RPC for many compiled drizzle statements. */
	batch?: (
		statements: readonly TenantDbQueryInput[]
	) => Promise<readonly TenantDbQueryResult[]>;
};

export type UserOrganizationInfo = {
	readonly organizationId: string;
	readonly organizationName: string;
	readonly organizationSlug: string;
	readonly logoUrl: string | null;
	readonly role: TUserRole;
	readonly userStatus: 'active' | 'inactive' | 'pending_invitation';
};

export type ProvisionedContext = {
	provision: 'provisioned';
	manifestCtx: ManifestContext;
	organization: { norbital_id: string; name: string };
	baseScope: TBaseScope;
	userOrganizations: readonly UserOrganizationInfo[];
	zone: WorkspaceZone;
	tenantDb: TenantDbClient;
	chatId?: string;
	/** Drizzle ORM database instance (lazy-init from tenantDb). */
	drizzleDb?: PgRemoteDatabase;
	/** Drizzle table objects keyed by collection name. */
	tableRegistry?: Record<string, PgTable>;
};

let _storage: ReturnType<typeof createAsyncStore<ProvisionedContext>> | undefined;
function getStorage(): ReturnType<typeof createAsyncStore<ProvisionedContext>> {
	if (!_storage) _storage = createAsyncStore<ProvisionedContext>();
	return _storage;
}

function currentWorkspaceContext(): ProvisionedContext | undefined {
	return currentPodCallOrNull()?.workspace ?? getStorage().getStore();
}

export function withRequestWorkspaceCtx<R>(ctx: ProvisionedContext, fn: () => R): R {
	if (currentPodCallOrNull()) {
		return withPodCallField('workspace', ctx, fn) as R;
	}
	return getStorage().run(ctx, fn);
}

export function getWorkspace(): ProvisionedContext;
export function getWorkspace(options: { provision: true }): ProvisionedContext;
export function getWorkspace(options?: { provision?: true }): ProvisionedContext {
	const ctx = currentWorkspaceContext();
	if (!ctx) {
		throw new Error(
			'No workspace context — use withRequestWorkspaceCtx'
		);
	}
	if (options?.provision && ctx.provision !== 'provisioned') {
		throw new Error('Workspace is not provisioned');
	}
	return ctx;
}

export type CreateProvisionedParams = {
	provision: 'provisioned';
	manifestCtx: ManifestContext;
	organization: { norbital_id: string; name: string };
	baseScope: TBaseScope;
	userOrganizations?: readonly UserOrganizationInfo[];
	zone?: WorkspaceZone;
	chatId?: string;
	tenantDb: TenantDbClient;
	drizzleDb?: PgRemoteDatabase;
	tableRegistry?: Record<string, PgTable>;
	relationsRegistry?: Record<string, unknown>;
};

function buildProvisionedDrizzleDb(
	client: TenantDbClient,
	relations: Record<string, unknown>
): PgRemoteDatabase {
	return drizzle(async (sqlText, params, method) => {
		const result = await client.query(
			method === 'all'
				? { text: sqlText, values: params, rowMode: 'array' }
				: { text: sqlText, values: params }
		);
		return { rows: [...result.rows] };
	}, { relations } as never);
}

/** Run `operation` on the facility-pinned connection. pg-proxy has no drizzle.transaction. */
export async function withTenantSqlTransaction<T>(
	ctx: ProvisionedContext,
	operation: (db: PgRemoteDatabase) => Promise<T>
): Promise<T> {
	const db = ctx.drizzleDb;
	if (!db) {
		throw error(500, 'Tenant database is not provisioned');
	}
	if (!ctx.tenantDb.transaction) {
		throw error(500, 'Tenant database does not support atomic collection transactions.');
	}
	return ctx.tenantDb.transaction(() => operation(db));
}

export function createWorkspaceContext(params: CreateProvisionedParams): ProvisionedContext {
	const zone = params.zone ?? 'live';
	const tableRegistry = {
		...Object.fromEntries(
			Object.entries(systemWorkspace).map(([name, entry]) => [name, entry.table])
		),
		...params.tableRegistry
	};
	// Drizzle RQB v2 only reads `relations` — passing `schema` silently disables
	// db.query.* finders (and with them all where/with handling). Platform
	// relations (e.g. approval_request.requestor) layer over the bare table
	// entries; tenant relations layer over both.
	const relations = {
		...defineRelations(tableRegistry),
		...platformSchema.relations,
		...params.relationsRegistry
	};
	return {
		...params,
		provision: 'provisioned',
		userOrganizations: params.userOrganizations ?? [],
		zone,
		drizzleDb: params.drizzleDb ?? buildProvisionedDrizzleDb(params.tenantDb, relations),
		tableRegistry
	};
}

export function ensureOrganizationAdmin(
	message = 'Only organization admins can perform this action'
): void {
	const authInfo = getWorkspace().baseScope.requestor;
	if (!authInfo || authInfo.role !== 'admin') {
		throw error(403, message);
	}
}

export function requireWorkspaceAuth(): ProvisionedContext {
	const ctx = currentWorkspaceContext();
	if (!ctx || ctx.provision !== 'provisioned') {
		throw error(401, { message: 'Unauthorized' });
	}
	if (!ctx.baseScope.requestor) {
		throw error(401, { message: 'Unauthorized' });
	}
	return ctx;
}
