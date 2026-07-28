import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import type { TApprovalRequest } from '@norbital-ai/platform-utils/system/types';
import { approvalRequestFromRow } from '$lib/shared/approval.js';
import { error } from '$lib/runtime/http.js';

type TApprovalLifecycleHookType =
	'onApprovalRequestApproved' | 'onApprovalRequestRejected' | 'onApprovalRequestChangeRequested';
type ProcessApprovalRequestActionInput = {
	approval_request_id: string;
	action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE';
	comments: string | null;
	isSupercede: boolean;
};
type WithdrawApprovalRequestInput = {
	approval_request_id: string;
};
type TCollectionHookEventData = {
	type: string;
	data?: unknown;
};

function approvalRequestOrThrow(value: unknown): TApprovalRequest {
	try {
		return approvalRequestFromRow(value);
	} catch {
		throw error(500, 'Approval operation did not return an approval request.');
	}
}

async function runApprovalLifecycleHook(params: {
	collectionName: string;
	hookType: TApprovalLifecycleHookType;
	approvalRequest: TApprovalRequest;
	event: TCollectionHookEventData;
}): Promise<void> {
	const { getWorkspace } = await import('$lib/server/bootstrap/workspace_store.js');
	const { runCollectionHook } = await import('$lib/server/run/tenant_run.js');
	const workspace = getWorkspace({ provision: true });
	const hook = workspace.manifestCtx.getCollection(params.collectionName).hooks?.[params.hookType];
	if (!hook) return;
	const context = {
		type: 'view',
		scope: {
			requestor: { ...workspace.baseScope.requestor },
			organization: { ...workspace.baseScope.organization },
			record: { [SYSTEM_COLUMN_NAMES.PKEY]: params.approvalRequest.norbital_id },
			requestor_subordinates: []
		},
		collection: { id: params.collectionName, name: params.collectionName },
		approval_request: params.approvalRequest,
		event: params.event
	} satisfies Parameters<typeof runCollectionHook>[0]['context'];
	await runCollectionHook({
		collectionName: params.collectionName,
		hookKey: params.hookType,
		context
	});
}

function approvalActionHookSpec(
	action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE',
	approvalRequest: TApprovalRequest,
	actionedBy: string,
	comments?: string
): { hookType: TApprovalLifecycleHookType; event: TCollectionHookEventData } {
	const data = {
		approval_request: approvalRequest,
		actioned_by: actionedBy,
		comments
	};
	switch (action) {
		case 'APPROVED':
			return { hookType: 'onApprovalRequestApproved', event: { type: 'ON_AR_APPROVED', data } };
		case 'REJECTED':
			return { hookType: 'onApprovalRequestRejected', event: { type: 'ON_AR_REJECTED', data } };
		case 'REQUEST_FOR_CHANGE':
			return {
				hookType: 'onApprovalRequestChangeRequested',
				event: { type: 'ON_AR_CHANGE_REQUESTED', data }
			};
	}
}

export async function runProcessApprovalRequestAction({
	approval_request_id,
	action,
	comments,
	isSupercede
}: ProcessApprovalRequestActionInput): Promise<{ message: string }> {
	const { getWorkspace } = await import('$lib/server/bootstrap/workspace_store.js');
	const { loadApprovalRequestRow } =
		await import('$lib/server/collection/access_control/approval_service.server.js');
	const { getPermissionBypassKey } =
		await import('$lib/server/collection/access_control/permission/permission_bypass_key.server.js');
	const { executeApprovalOperation } =
		await import('$lib/server/collection/access_control/approval_operation.server.js');
	const workspace = getWorkspace({ provision: true });
	const existingApprovalRequestData = await loadApprovalRequestRow(approval_request_id);
	if (!existingApprovalRequestData) throw error(404, 'Approval request not found');

	const updatedRequest = approvalRequestOrThrow(
		await executeApprovalOperation({
			operation: 'approval',
			action: 'process_action',
			approval_action: action,
			approval_request: existingApprovalRequestData,
			is_supercede: isSupercede,
			comments: comments ?? undefined
		})
	);

	const collectionName = updatedRequest.collection_name;
	const actionHook = approvalActionHookSpec(
		action,
		updatedRequest,
		workspace.baseScope.requestor!.norbital_id,
		comments ?? undefined
	);
	await runApprovalLifecycleHook({
		collectionName,
		hookType: actionHook.hookType,
		approvalRequest: updatedRequest,
		event: actionHook.event
	});

	return { message: 'Action processed successfully' };
}

export async function runWithdrawApprovalRequest({
	approval_request_id
}: WithdrawApprovalRequestInput): Promise<{ message: string }> {
	const { getWorkspace } = await import('$lib/server/bootstrap/workspace_store.js');
	const { withdrawApprovalRequest } =
		await import('$lib/server/collection/access_control/approval_service.server.js');
	approvalRequestOrThrow(
		await withdrawApprovalRequest(
			approval_request_id,
			getWorkspace({ provision: true }).baseScope.requestor
		)
	);
	return { message: 'Approval request withdrawn successfully' };
}
