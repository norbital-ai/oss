import { ApprovalRequestResolvedSchema } from '$lib/shared/approval.js';
import type { TApprovalRequest } from '@norbital-ai/platform-utils/system/types';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { error } from '../http_error.js';
import { hydrateCollectionRecord } from '../scope/scope_hydration.server.js';
import {
	findApprovalConfigInWorkspace,
	processAction,
	withdrawApprovalRequest
} from './approval_service.server.js';

type ApprovalAction = 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE';

type ApprovalOperation =
	| {
			operation: 'approval';
			action: 'process_action';
			approval_action: ApprovalAction;
			approval_request: TApprovalRequest;
			is_supercede: boolean;
			comments?: string;
	  }
	| {
			operation: 'approval';
			action: 'withdraw_request';
			approval_request_id: string;
	  }
	| {
			operation: 'approval';
			action: 'resolve_for_ui';
			approval_request_id: string;
	  };

/**
 * Approval workflow operations in the write-then-lock model. There is no `create_context_scope`
 * or `upsert_request` (signed/intent submit) — gated writes auto-create the request inside the
 * normal mutation path. Only post-write workflow transitions are handled here.
 */
export async function executeApprovalOperation(input: ApprovalOperation): Promise<unknown> {
	switch (input.action) {
		case 'process_action': {
			const runtime = getWorkspace({ provision: true });
			const approvalRequest = input.approval_request as TApprovalRequest;
			const resolved = await findApprovalConfigInWorkspace(
				runtime.manifestCtx,
				approvalRequest.approval_config_id
			);
			if (!resolved) throw error(404, 'Approval config not found for this request.');
			return processAction(
				input.approval_action,
				approvalRequest,
				resolved.approvalConfigPermission,
				runtime.baseScope.requestor,
				input.is_supercede,
				input.comments
			);
		}
		case 'withdraw_request': {
			const runtime = getWorkspace({ provision: true });
			return withdrawApprovalRequest(input.approval_request_id, runtime.baseScope.requestor);
		}
		case 'resolve_for_ui': {
			// Approval-request row with config/team enrichment for UI surfaces.
			const hydrated = await hydrateCollectionRecord({
				collection_name: 'approval_request',
				record_id: input.approval_request_id,
				node_id: 'approval_request'
			});
			const record = hydrated.record;
			return ApprovalRequestResolvedSchema.parse(record);
		}
		default: {
			const _exhaustive: never = input;
			throw new Error(`Unknown approval operation action: ${String(_exhaustive)}`);
		}
	}
}
