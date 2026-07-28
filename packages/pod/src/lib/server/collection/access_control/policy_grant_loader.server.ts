import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import {
	PolicySchema,
	TeamSchema,
	type TPolicy,
	type TTeam
} from '@norbital-ai/platform-utils/system/types';
import { toRelationsFilter } from '$lib/authoring/workspace/relations-filter.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { directFindMany } from '../direct/collection_direct.js';
import { error } from '../http_error.js';
import { runWithPermissionBypassAsync } from './permission/permission_bypass_key.server.js';

function teamFromRow(row: Record<string, unknown>): TTeam {
	const parsed = TeamSchema.safeParse(row);
	if (parsed.success) return parsed.data;
	throw error(500, 'Invalid team row loaded from tenant database.');
}

function policyFromRow(row: Record<string, unknown>): TPolicy {
	const parsed = PolicySchema.safeParse(row);
	if (parsed.success) return parsed.data;
	throw error(500, 'Invalid policy row loaded from tenant database.');
}

export async function loadPoliciesForTeams(teamIds: readonly string[]): Promise<{
	teams: TTeam[];
	policies: TPolicy[];
}> {
	if (teamIds.length === 0) {
		return { teams: [], policies: [] };
	}

	const ctx = getWorkspace({ provision: true });
	const teamRows = await runWithPermissionBypassAsync(() =>
		directFindMany(ctx, 'team', {
			where: toRelationsFilter({ [SYSTEM_COLUMN_NAMES.PKEY]: { in: [...teamIds] } }),
			limit: 500
		})
	);
	const teams = teamRows.map(teamFromRow);

	const policyIds = [...new Set(teams.map((team) => team.policy_id))];
	if (policyIds.length === 0) {
		return { teams, policies: [] };
	}

	const policyRows = await runWithPermissionBypassAsync(() =>
		directFindMany(ctx, 'policy', {
			where: toRelationsFilter({ [SYSTEM_COLUMN_NAMES.PKEY]: { in: policyIds } }),
			limit: policyIds.length
		})
	);

	return { teams, policies: policyRows.map(policyFromRow) };
}

export async function loadAllPolicies(): Promise<TPolicy[]> {
	const ctx = getWorkspace({ provision: true });
	const rows = await runWithPermissionBypassAsync(() =>
		directFindMany(ctx, 'policy', { limit: 500 })
	);
	return rows.map(policyFromRow);
}

export async function loadUserById(userId: string): Promise<Record<string, unknown> | undefined> {
	const ctx = getWorkspace({ provision: true });
	const rows = await runWithPermissionBypassAsync(() =>
		directFindMany(ctx, 'user', {
			where: toRelationsFilter({ [SYSTEM_COLUMN_NAMES.PKEY]: userId }),
			limit: 1
		})
	);
	return rows[0];
}
