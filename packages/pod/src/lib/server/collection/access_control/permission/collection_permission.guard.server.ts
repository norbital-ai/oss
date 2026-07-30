import type { ManifestCollectionEntry } from '$lib/manifest/index.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { error } from '../../http_error.js';
import type {
	PermissionEvaluationResult,
	TCollectionActionContext,
	TCollectionPermissionScopeInput,
	TCollectionPermissionScopeOutput
} from '../approval_scope_types.js';
import {
	resolvePolicyGrants,
	type ResolvedPolicyGrant
} from './permission_record_resolution.server.js';
import { loadPoliciesForTeams } from '../policy_grant_loader.server.js';
import { mutationConditionsApply } from '../approval_step_conditions.server.js';
import { isUnconditionalPolicyWhere } from '../policy_sql.server.js';

type PolicyActionKey = ResolvedPolicyGrant['action'];
type TCollectionReadPermissionScopeBase = {
	approvalServiceBypassKey?: TCollectionPermissionScopeInput['approvalServiceBypassKey'];
	collectionMetadata: TCollectionPermissionScopeInput['collectionMetadata'];
	context: TCollectionPermissionScopeInput['context'];
};
type TCollectionReadPermissionResolvedFields = {
	policyGrants: TCollectionPermissionScopeOutput['policyGrants'];
	reducedCondition?: TCollectionPermissionScopeOutput['reducedCondition'];
};

/**
 * Evaluates policy grants for an operation and resolves a single decision:
 * - `hasDirectAccess` — a write condition matched, or a read grant is unconditional.
 * - `reducedCondition` — a residual row-level condition for reads.
 * - `approvalConfig` — the first matching gated path for write operations.
 */
export async function evaluatePolicyGrants(params: {
	policyGrants: ResolvedPolicyGrant[];
	context: TCollectionActionContext;
	collectionMetadata: ManifestCollectionEntry;
}): Promise<PermissionEvaluationResult> {
	const result: PermissionEvaluationResult = {
		hasDirectAccess: false,
		reducedCondition: null,
		approvalConfig: null
	};
	const mutationContext =
		params.context.type === 'list' || params.context.type === 'view' ? null : params.context;
	let gatedConfig: PermissionEvaluationResult['approvalConfig'] = null;

	// stupidity:allow A6 -- grant order controls the first gated config and direct-access short circuit.
	for (const policyGrant of params.policyGrants) {
		const { conditions } = policyGrant;
		const approval_config = 'approval_config' in policyGrant ? policyGrant.approval_config : null;
		if (mutationContext) {
			if (
				!(await mutationConditionsApply(
					conditions,
					mutationContext,
					params.collectionMetadata.collection_name
				))
			) {
				continue;
			}
			if (
				approval_config &&
				(await mutationConditionsApply(
					approval_config.conditions,
					mutationContext,
					params.collectionMetadata.collection_name
				))
			) {
				gatedConfig ??= {
					...approval_config,
					collection_name: params.collectionMetadata.collection_name
				};
				continue;
			}
			result.hasDirectAccess = true;
			return result;
		}

		if (isUnconditionalPolicyWhere(conditions)) {
			result.hasDirectAccess = true;
			return result;
		}

		result.reducedCondition = conditions;
	}
	result.approvalConfig = gatedConfig;

	return result;
}

/**
 * Workflow-metadata read fallback for authenticated members without explicit grants.
 * The tenant approval UI needs `approval_request` rows and `team` labels: members may
 * read approval requests only for collections they hold a read grant on, and team rows
 * (labels for approver lanes) unconditionally.
 */
async function workflowMetadataReadFallback(
	collectionName: string
): Promise<{ reducedCondition?: Record<string, unknown> } | null> {
	const workspace = getWorkspace({ provision: true });
	const requestorId = workspace.baseScope.requestor.norbital_id;
	if (collectionName === 'team') return {};
	if (collectionName === 'notification') {
		return { reducedCondition: { recipient_user_id: requestorId } };
	}
	if (collectionName === 'document_asset' || collectionName === 'agent_run_step') {
		return { reducedCondition: { owner_user_id: requestorId } };
	}
	if (collectionName === 'automation_run') {
		return { reducedCondition: { requested_by_user_id: requestorId } };
	}
	if (collectionName !== 'approval_request') return null;
	const teamIds = workspace.baseScope.requestor.team_members.map((team) => team.norbital_id);
	if (teamIds.length === 0) return null;
	const { teams, policies } = await loadPoliciesForTeams(teamIds);
	const policyById = new Map(policies.map((policy) => [policy.norbital_id, policy]));
	const readableCollections = new Set<string>();
	for (const team of teams) {
		const policy = policyById.get(team.policy_id);
		if (!policy?.is_active || !Array.isArray(policy.grants)) continue;
		for (const grant of policy.grants) {
			if (grant.action === 'read') readableCollections.add(grant.collection_name);
		}
	}
	if (readableCollections.size === 0) return null;
	return { reducedCondition: { collection_name: { in: [...readableCollections] } } };
}

export async function resolveCollectionReadPermission<
	TScope extends TCollectionReadPermissionScopeBase
>(scope: TScope): Promise<TScope & TCollectionReadPermissionResolvedFields> {
	const policyGrants = await resolvePolicyGrants(scope, 'read');
	if (policyGrants.length === 0) {
		const workspace = getWorkspace({ provision: true });
		if (!scope.approvalServiceBypassKey && workspace.baseScope.requestor.role !== 'admin') {
			const fallback = await workflowMetadataReadFallback(scope.collectionMetadata.collection_name);
			if (!fallback) {
				throw error(403, 'Unauthorized: No policy grants this operation');
			}
			return Object.assign({}, scope, {
				policyGrants: [],
				reducedCondition: fallback.reducedCondition
			}) as TScope & TCollectionReadPermissionResolvedFields;
		}
		return Object.assign({}, scope, {
			policyGrants: []
		}) as TScope & TCollectionReadPermissionResolvedFields;
	}

	const evaluationResult = await evaluatePolicyGrants({
		policyGrants,
		context: scope.context,
		collectionMetadata: scope.collectionMetadata
	});
	const finalScope = Object.assign({}, scope, {
		policyGrants,
		reducedCondition: evaluationResult.reducedCondition ?? undefined
	}) as TScope & TCollectionReadPermissionResolvedFields;

	if (evaluationResult.hasDirectAccess || evaluationResult.reducedCondition) {
		return finalScope;
	}

	throw error(403, 'Unauthorized: No policy grants this operation');
}

/**
 * Resolves the write decision for a mutation. Matching ungated conditions grant direct access;
 * a matching `approvalConfig` applies the write-then-lock flow. Throws 403 when no path grants access.
 * It never throws 408 — there is no intent/menu round-trip in the write-then-lock model.
 */
export async function resolveCollectionMutationPermission(params: {
	scope: TCollectionPermissionScopeInput;
	actionType: Exclude<PolicyActionKey, 'read'>;
}): Promise<TCollectionPermissionScopeOutput> {
	const { scope, actionType } = params;
	const policyGrants = await resolvePolicyGrants(scope, actionType);
	if (policyGrants.length === 0) {
		if (scope.approvalServiceBypassKey) {
			return Object.assign({}, scope, {
				policyGrants: [],
				approvalConfig: null
			}) as TCollectionPermissionScopeOutput;
		}
		const workspace = getWorkspace({ provision: true });
		if (workspace.baseScope.requestor.role !== 'admin') {
			throw error(403, 'Unauthorized: No policy grants this operation');
		}
		return Object.assign({}, scope, {
			policyGrants: [],
			approvalConfig: null
		}) as TCollectionPermissionScopeOutput;
	}

	const evaluationResult = await evaluatePolicyGrants({
		policyGrants,
		context: scope.context,
		collectionMetadata: scope.collectionMetadata
	});

	const finalScope = Object.assign({}, scope, {
		policyGrants,
		reducedCondition: evaluationResult.reducedCondition ?? undefined
	}) as TCollectionPermissionScopeOutput;

	if (evaluationResult.approvalConfig) {
		finalScope.approvalConfig = evaluationResult.approvalConfig;
		return finalScope;
	}

	if (evaluationResult.hasDirectAccess || evaluationResult.reducedCondition) {
		finalScope.approvalConfig = null;
		return finalScope;
	}

	throw error(403, 'Unauthorized: No policy grants this operation');
}
