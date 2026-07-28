import type { TApprovalConfig, TPolicy } from '@norbital-ai/platform-utils/system/types';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { error } from '../../http_error.js';
import { getPermissionBypassKey } from './permission_bypass_key.server.js';
import { loadPoliciesForTeams } from '../policy_grant_loader.server.js';

type PolicyGrant = TPolicy['grants'][number];

export type ResolvedPolicyGrant = {
	readonly norbital_id: string;
	readonly norbital_created_at: string;
	readonly norbital_updated_at: string;
	readonly team_id: string;
	readonly collection_name: PolicyGrant['collection_name'];
	readonly action: PolicyGrant['action'];
	readonly conditions: PolicyGrant['conditions'];
	readonly approval_config: TApprovalConfig | null;
};

export async function resolvePolicyGrants<
	TScope extends {
		approvalServiceBypassKey?: string;
		collectionMetadata: { collection_name: string };
	}
>(scope: TScope, action: string): Promise<ResolvedPolicyGrant[]> {
	const { approvalServiceBypassKey, collectionMetadata } = scope;

	if (approvalServiceBypassKey) {
		if (approvalServiceBypassKey !== getPermissionBypassKey()) {
			throw new Error('Invalid approval service bypass key');
		}
		return [];
	}

	const ws = getWorkspace({ provision: true });
	const authInfo = ws.baseScope.requestor;
	if (!authInfo) throw error(401, 'Authentication required');
	if (authInfo.role === 'admin') return [];

	const teamIds = authInfo.team_members.map((t) => t.norbital_id);
	if (teamIds.length === 0) return [];

	const { teams, policies } = await loadPoliciesForTeams(teamIds);
	const policyById = new Map(policies.map((policy) => [policy.norbital_id, policy]));

	const rows: ResolvedPolicyGrant[] = [];
	for (const team of teams) {
		const policy = policyById.get(team.policy_id);
		if (!policy?.is_active) continue;
		if (!Array.isArray(policy.grants)) continue;
		for (const grant of policy.grants) {
			if (grant.collection_name !== collectionMetadata.collection_name || grant.action !== action)
				continue;
			rows.push({
				norbital_id: `${team.norbital_id}:${grant.id}`,
				norbital_created_at: policy.norbital_created_at,
				norbital_updated_at: policy.norbital_updated_at,
				team_id: team.norbital_id,
				collection_name: grant.collection_name,
				action: grant.action,
				conditions: grant.conditions,
				approval_config:
					action === 'read' || !('approval_config' in grant) ? null : grant.approval_config
			});
		}
	}
	return rows;
}
