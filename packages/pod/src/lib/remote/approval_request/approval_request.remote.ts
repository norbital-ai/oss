import { Guard, requireAuthMiddleware } from '$lib/remote/guard.server.js';
import {
	runProcessApprovalRequestAction,
	runWithdrawApprovalRequest
} from './approval_request.runtime.server.js';
import {
	ProcessApprovalRequestActionInputSchema,
	WithdrawApprovalRequestInputSchema
} from './schema.js';

const authenticated = Guard.init().use(requireAuthMiddleware());

export const processApprovalRequestAction = authenticated.command(
	ProcessApprovalRequestActionInputSchema,
	runProcessApprovalRequestAction
);

export const withdrawApprovalRequest = authenticated.command(
	WithdrawApprovalRequestInputSchema,
	runWithdrawApprovalRequest
);
