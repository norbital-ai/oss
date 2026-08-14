import type { TApprovalConfig } from '@norbital-ai/platform-utils/system/types';
import type { ManifestCollectionEntry } from '$lib/manifest/index.js';
import type { TBaseScope } from '$lib/shared/scope.js';
import type { TNorbitalDBRecord } from '$lib/server/collection/collection_ops.server.js';
import type { ResolvedPolicyGrant } from './permission/permission_record_resolution.server.js';

export type TCollectionMutationPayload = Record<string, unknown>;

/**
 * Typed action context for a collection write. Carries the base scope plus the incoming/original
 * record so policy and approval-flow conditions can be evaluated against the mutation.
 */
export type TCollectionActionContext =
	| { type: 'list'; scope: TBaseScope & { records: null } }
	| { type: 'view'; scope: TBaseScope & { records: null } }
	| {
			type: 'create';
			payload: TCollectionMutationPayload;
			scope: TBaseScope & { incoming_record: TCollectionMutationPayload };
	  }
	| {
			type: 'update';
			payload: TCollectionMutationPayload;
			scope: TBaseScope & {
				incoming_record: TCollectionMutationPayload;
				original_record: TNorbitalDBRecord;
			};
	  }
	| {
			type: 'delete';
			scope: TBaseScope & { original_record: TNorbitalDBRecord };
	  };

/**
 * A server-resolved approval flow config for a single collection. Produced by policy
 * evaluation when a write is GATED, and consumed by the write-then-lock mutation path to
 * create the approval request. There is no client-facing menu of signed options.
 */
export type TResolvedApprovalConfig = TApprovalConfig & {
	collection_name: string;
};

export type PermissionEvaluationResult = {
	hasDirectAccess: boolean;
	reducedCondition: ResolvedPolicyGrant['conditions'] | null;
	approvalConfig: TResolvedApprovalConfig | null;
};

export type TCollectionPermissionScopeInput = {
	approvalServiceBypassKey?: string;
	collectionMetadata: ManifestCollectionEntry;
	context: TCollectionActionContext;
};

export type TCollectionPermissionScopeOutput = TCollectionPermissionScopeInput & {
	policyGrants: ResolvedPolicyGrant[];
	approvalConfig?: TResolvedApprovalConfig | null;
	reducedCondition?: ResolvedPolicyGrant['conditions'];
};
