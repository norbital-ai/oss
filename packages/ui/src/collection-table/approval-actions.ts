import type { CollectionApprovalRequest } from '@norbital-ai/std/collection';

/** What the current principal may do with a request, given its live state. */
type ApprovalActions = Readonly<{
	readonly decide: boolean;
	readonly supersede: boolean;
	readonly withdraw: boolean;
}>;

/** Actions the server offered for the current principal, bounded by the request's live state. */
export const approvalActionsFor = (
	request: CollectionApprovalRequest | undefined
): ApprovalActions => ({
	decide: request?.status === 'ONGOING' && request.canDecide === true,
	supersede: request?.status === 'ONGOING' && request.canSupersede === true,
	withdraw: request?.status === 'ONGOING' && request.canWithdraw === true
});
