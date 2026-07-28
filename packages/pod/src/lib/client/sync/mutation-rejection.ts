import type { MutationResult } from './types.js';

export type RejectedMutation = Extract<MutationResult, { status: 'rejected' }>;

/**
 * The sentence to show a person when a write is refused.
 *
 * `detail` is the message the server wrote for exactly this moment ("Cannot revise record until an
 * approver requests changes."); `reason` is the machine-readable code the same rejection carries
 * for callers that branch on it. Prefer the sentence, fall back to the code — a rejection with no
 * authored message (an offline queue, a missing id, an unexpected server failure) still has to say
 * *something*, and the code is the honest remainder.
 *
 * The code is never discarded: it stays on the thrown error as `code`, so reconciliation logic
 * keeps switching on `CONFLICT`/`PERMISSION_DENIED` while the human reads prose.
 */
export function mutationRejectionMessage(rejection: RejectedMutation | undefined): string {
	const detail = rejection?.detail?.trim();
	if (detail) return detail;
	return rejection?.reason ?? 'MUTATE_FAILED';
}
