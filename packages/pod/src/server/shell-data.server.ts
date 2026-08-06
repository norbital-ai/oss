import { getHostPlugins, visibleHostPlugins } from '$lib/server/host-plugins.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { loadSyncBootstrap } from '$lib/server/collection/sync/sync-endpoints.server.js';
import { loadPoliciesForTeams } from '$lib/server/collection/access_control/policy_grant_loader.server.js';
import type {
	TenantWorkspacePolicyGrant,
	TenantWorkspaceShellData
} from '$lib/ui/state/workspace_shell_types.js';
import type { TPolicy, TTeam } from '@norbital-ai/platform-utils/system/types';
import type { CollectionColumnMap } from '@norbital-ai/platform-utils/manifest/context';
import type { PodRequestEvent } from './request-context.js';
import { NORBITAL_BILLING_HEADER } from '@norbital-ai/platform-utils/runtime/binding';
import { safeParse } from '@norbital-ai/std/json';
import { z } from 'zod';

const billingSummarySchema = z.object({
	status: z.string(),
	currentPeriodEnd: z.string().datetime().nullable(),
	hasPaymentMethod: z.boolean()
});

async function fetchTeamsAndPolicies(): Promise<{
	teams: TTeam[];
	policies: TPolicy[];
}> {
	const workspace = getWorkspace({ provision: true });
	const requestor = workspace.baseScope.requestor;
	if (requestor.role === 'admin') {
		return { teams: [], policies: [] };
	}

	const teamIds = requestor.team_members.map((team) => team.norbital_id).filter(Boolean);
	if (teamIds.length === 0) return { teams: [], policies: [] };
	return loadPoliciesForTeams(teamIds);
}

function resolveAccessibleAppNames(loaded: {
	teams: TTeam[];
	policies: TPolicy[];
}): string[] | null {
	const workspace = getWorkspace({ provision: true });
	if (workspace.baseScope.requestor.role === 'admin') return null;

	const { policies } = loaded;
	const accessible = new Set<string>();
	for (const row of policies) {
		if (row.is_active !== true || !Array.isArray(row.accessible_applications)) continue;
		for (const entry of row.accessible_applications) {
			if (typeof entry !== 'string') continue;
			const appName = entry.trim();
			if (appName) accessible.add(appName);
		}
	}
	return [...accessible].sort();
}

function resolvePolicyGrants(loaded: {
	teams: TTeam[];
	policies: TPolicy[];
}): readonly TenantWorkspacePolicyGrant[] | null {
	const workspace = getWorkspace({ provision: true });
	if (workspace.baseScope.requestor.role === 'admin') return null;

	const { teams, policies } = loaded;
	const policyById = new Map(policies.map((policy) => [policy.norbital_id, policy]));
	const grants: TenantWorkspacePolicyGrant[] = [];
	for (const team of teams) {
		const policy = policyById.get(team.policy_id);
		if (!policy?.is_active) continue;
		for (const grant of policy.grants) {
			const action = grant.action;
			if (action !== 'create' && action !== 'read' && action !== 'update' && action !== 'delete') {
				continue;
			}
			const approvalConfig = Reflect.get(grant, 'approval_config');
			grants.push({
				id: grant.id,
				policy_id: policy.norbital_id,
				team_id: team.norbital_id,
				collection_name: grant.collection_name,
				action,
				conditions: grant.conditions,
				approval_config:
					approvalConfig && typeof approvalConfig === 'object' ? { ...approvalConfig } : null
			});
		}
	}
	return grants;
}

export async function loadTenantWorkspaceShellData(
	event: PodRequestEvent
): Promise<TenantWorkspaceShellData> {
	const workspace = getWorkspace({ provision: true });
	const billingHeader = event.request.headers.get(NORBITAL_BILLING_HEADER);
	const billing = billingHeader
		? billingSummarySchema.safeParse(safeParse(billingHeader))
		: { success: false as const };

	// This response is the whole critical path of a workspace load, and everything on it that
	// touches the database is independent, so none of it waits for the rest.
	//
	// The policy load in particular used to run TWICE and in series — `resolveAccessibleAppNames`
	// and `resolvePolicyGrants` each fetched the same teams and policies for themselves — so a
	// non-admin paid two sequential guest → Core → Postgres round trips to answer one question.
	// It is fetched once here and both are derived from it.
	//
	// The sync bootstrap joins the same batch. Resolving it after the shell would put a round trip
	// back on the path this change exists to shorten.
	const [sync, teamsAndPolicies] = await Promise.all([
		loadSyncBootstrap(workspace),
		fetchTeamsAndPolicies()
	]);

	const activeOrganizationId = workspace.organization.norbital_id;
	const activeOrganizationLogoUrl =
		workspace.userOrganizations.find(
			(organization) => organization.organizationId === activeOrganizationId
		)?.logoUrl ?? null;

	return {
		sync,
		user: workspace.baseScope.requestor,
		organization: {
			id: activeOrganizationId,
			name: workspace.organization.name,
			logo_url: activeOrganizationLogoUrl
		},
		initialWorkspaceLatest: {
			nodeId: workspace.manifestCtx.nodeId,
			manifest: workspace.manifestCtx.manifest,
			columns: Object.fromEntries(
				Object.keys(workspace.manifestCtx.manifest.collections).map((collectionName) => [
					collectionName,
					Object.fromEntries(
						Object.entries(workspace.manifestCtx.columnsFor(collectionName)).map(
							([fieldName, column]) => [fieldName, column]
						)
					) satisfies CollectionColumnMap
				])
			)
		},
		baseScope: workspace.baseScope,
		userOrganizations: workspace.userOrganizations,
		...(billing.success ? { billing: billing.data } : {}),
		accessibleAppNames: resolveAccessibleAppNames(teamsAndPolicies),
		policyGrants: resolvePolicyGrants(teamsAndPolicies),
		// Filtered here rather than in the browser: an entry the requestor may not see must not reach
		// the client at all, since the payload is readable whatever the sidebar chooses to render.
		hostPlugins: visibleHostPlugins(
			getHostPlugins(),
			workspace.baseScope.requestor.role === 'admin'
		)
	};
}
