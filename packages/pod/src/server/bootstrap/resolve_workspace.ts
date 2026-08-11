import { getTenantWorkspace } from '$lib/server/bootstrap/tenant_workspace.server.js';
import type { TBaseScope, TScopeRequestor } from '$lib/shared/scope.js';
import { documentAssetDownloadUrl, UserInfoSchema } from '@norbital-ai/platform-utils/scope/types';
import {
	qualifiedRelationshipTable,
	qualifiedTableName
} from '@norbital-ai/platform-utils/tenant_db/schema';
import { getManifestContext } from './manifest_context.js';
import {
	createWorkspaceContext,
	type ProvisionedContext,
	type TenantDbClient,
	type WorkspaceZone
} from './workspace_store.js';

function readRecordId(row: Record<string, unknown>): string {
	const id = row.norbital_id;
	if (typeof id === 'string') return id;
	throw new Error('norbital_id_missing');
}

function scopeRequestorFromRows(
	userRow: Record<string, unknown>,
	teamMembers: readonly Record<string, unknown>[]
): TScopeRequestor | null {
	const candidate = {
		norbital_id: readRecordId(userRow),
		user_name: userRow.name,
		email: userRow.email,
		role: userRow.role,
		user_status: userRow.status,
		team_members: teamMembers.map((member) => ({
			norbital_id: readRecordId(member),
			name: member.name,
			description: member.description,
			parent_id: member.parent_id,
			is_active: member.is_active
		})),
		// The joined asset's key, resolved to a URL the shell can load directly. A user with no
		// uploaded avatar joins to nothing and renders the initials fallback.
		avatar_url:
			typeof userRow.avatar_storage_key === 'string'
				? documentAssetDownloadUrl(userRow.avatar_storage_key)
				: null,
		deactivated_at: null
	};
	const parsed = UserInfoSchema.safeParse(candidate);
	if (!parsed.success) return null;
	return parsed.data;
}

/** Jail-native: same requestor shaping as Core, org from injected identity (no system DB). */
function resolveUserAndBaseScope(params: {
	organization: { norbital_id: string; name: string };
	userRow?: Record<string, unknown>;
	teamMembers: readonly Record<string, unknown>[];
}): { user: TScopeRequestor; baseScope: TBaseScope } | null {
	const userRow = params.userRow;
	if (!userRow || typeof userRow !== 'object') {
		return null;
	}

	if (userRow.status !== 'active') {
		return null;
	}

	const requestor = scopeRequestorFromRows(userRow, params.teamMembers);
	if (!requestor) return null;

	const baseScope: TBaseScope = {
		requestor,
		organization: {
			norbital_id: params.organization.norbital_id,
			name: params.organization.name
		}
	};

	return { user: requestor, baseScope };
}

export async function resolveRequestorBaseScope(params: {
	tenantDb: TenantDbClient;
	organization: { norbital_id: string; name: string };
	userId: string;
}): Promise<{ baseScope: TBaseScope } | null> {
	const userTable = qualifiedTableName('user');
	const teamTable = qualifiedTableName('team');
	const assetTable = qualifiedTableName('document_asset');
	const teamMembersTable = qualifiedRelationshipTable('team_members', 'user', 'team');
	const userResult = await params.tenantDb.query(
		`SELECT u.*, a.storage_key AS avatar_storage_key
		   FROM ${userTable} u
		   LEFT JOIN ${assetTable} a ON a.norbital_id = u.avatar_asset_id
		  WHERE u.norbital_id = $1
		  LIMIT 1`,
		[params.userId]
	);
	const row = userResult.rows[0];
	if (!row || typeof row !== 'object') {
		return null;
	}

	const teamsResult = await params.tenantDb.query(
		`SELECT t.*
		 FROM ${teamTable} t
		 INNER JOIN ${teamMembersTable} tm ON tm.team_id = t.norbital_id
		 WHERE tm.user_id = $1`,
		[params.userId]
	);

	const resolved = resolveUserAndBaseScope({
		organization: params.organization,
		userRow: row,
		teamMembers: teamsResult.rows
	});
	if (!resolved) return null;
	return { baseScope: resolved.baseScope };
}
