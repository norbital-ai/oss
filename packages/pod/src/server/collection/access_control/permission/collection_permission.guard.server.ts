import type { ManifestCollectionEntry } from '$lib/manifest/index.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { error } from '$lib/server/http.js';
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
	if (collectionName === 'document_asset') {
		return { reducedCondition: { owner_user_id: requestorId } };
	}
	if (collectionName === 'chat_session') {
		// Fixed visibility contract for non-admin members:
		// - their own personal sessions and authenticated DMs (both carry their user_id), and
		// - authenticated groups whose profile policy is held by one of their active teams.
		// Public channel transcripts never enter this fallback, so they remain admin-only.
		return {
			reducedCondition: {
				$sql:
					'("user_id" = ${requestor.norbital_id} OR "norbital_id" IN (' +
					'SELECT cc.chat_id FROM channel_conversation cc ' +
					'JOIN policy p ON p.key = cc.policy_key AND p.is_active = true ' +
					'JOIN team t ON t.policy_id = p.norbital_id AND t.is_active = true ' +
					'JOIN team_members tm ON tm.team_id = t.norbital_id ' +
					"WHERE cc.conversation_kind = 'group' AND cc.audience = 'authenticated' " +
					'AND tm.user_id = ${requestor.norbital_id}))'
			}
		};
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

/**
 * The one write a member may make without any policy granting it: dismissing their own notification.
 *
 * A notification is addressed to a person, and marking it read is that person saying "seen" — there
 * is no workspace decision in it for a policy to express, and no tenant author would think to write
 * a grant for it. Without this the bell renders an unread count that can never go down for exactly
 * the users who are not admins.
 *
 * Deliberately narrow on all three axes, because the mutation path does NOT apply a
 * `reducedCondition` to its WHERE (only reads do) — a residual filter here would look like a scope
 * and enforce nothing. So the decision is made against the row already loaded: this collection,
 * this recipient, and a payload that touches nothing but `read_at`. Rewriting the subject of a
 * notification you received is not a thing you get to do.
 */
/**
 * System collections carrying a self-service write, checked by `collection_ops` before the
 * mutation pipeline starts.
 *
 * A tenant author declares which of *their* collections may be written; nobody declares a system
 * one, so `allowsMutation` refuses every write to `notification` before this guard is consulted.
 * This names the exception; `selfServiceWriteAllowed` below decides whether a given write is it.
 * The two must be read together — this set opens the door, that function is the whole of the lock.
 */
export const SELF_SERVICE_WRITE_COLLECTIONS: ReadonlySet<string> = new Set(['notification']);

export function selfServiceWriteAllowed(
	collectionName: string,
	actionType: Exclude<PolicyActionKey, 'read'>,
	context: TCollectionActionContext
): boolean {
	if (collectionName !== 'notification' || actionType !== 'update') return false;
	if (context.type !== 'update') return false;
	const requestorId = getWorkspace({ provision: true }).baseScope.requestor.norbital_id;
	if (context.scope.original_record?.recipient_user_id !== requestorId) return false;
	return Object.keys(context.payload).every(
		(field) => field === 'read_at' || field.startsWith('norbital_')
	);
}

/**
 * Collections no client may read or write, at any role.
 *
 * These hold credential material and host-facing plumbing: `invitation` carries single-use token
 * hashes, `host_event_outbox` carries keyed subject digests and seat counts destined for the billing
 * host. Every other deny in this file is policy-driven and an `admin` short-circuits it, so a plain
 * grant check is not enough — an admin session would otherwise replicate both tables into a browser.
 * Pod reaches them through elevated server paths that never consult this guard.
 */
/**
 * Collections no client may reach, whatever its role.
 *
 * Exported because reachability is not only a permission question: the replica DDL and the sync
 * stream are separate paths to the same rows, and a set duplicated across three files drifts. Anything
 * added here must be denied by all of them.
 */
export const CLIENT_OPAQUE_COLLECTIONS: ReadonlySet<string> = new Set([
	'invitation',
	'host_event_outbox',
	'sync_outbox',
	'_norbital_automation_job',
	'_norbital_sync_compaction',
	'_norbital_automation_cursor',
	'_norbital_sync_epoch',
	'_approval_lock'
]);

function assertClientReachable(collectionName: string): void {
	if (CLIENT_OPAQUE_COLLECTIONS.has(collectionName)) {
		throw error(403, `Unauthorized: ${collectionName} is not client-readable`);
	}
}

export async function resolveCollectionReadPermission<
	TScope extends TCollectionReadPermissionScopeBase
>(scope: TScope): Promise<TScope & TCollectionReadPermissionResolvedFields> {
	assertClientReachable(scope.collectionMetadata.collection_name);
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
	const collectionName = scope.collectionMetadata.collection_name;
	assertClientReachable(collectionName);
	const policyGrants = await resolvePolicyGrants(scope, actionType);
	if (policyGrants.length === 0) {
		if (scope.approvalServiceBypassKey) {
			return Object.assign({}, scope, {
				policyGrants: [],
				approvalConfig: null
			}) as TCollectionPermissionScopeOutput;
		}
		const workspace = getWorkspace({ provision: true });
		if (
			workspace.baseScope.requestor.role !== 'admin' &&
			!selfServiceWriteAllowed(collectionName, actionType, scope.context)
		) {
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
