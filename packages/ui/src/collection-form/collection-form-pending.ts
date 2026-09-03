/**
 * Create/update stay pending while FormState is submitting even when `operations.pending`
 * has already dropped (enqueueMutation returns a settlement promise synchronously).
 */
export function collectionFormSubmissionPending(input: {
	readonly isSubmitting: boolean;
	readonly operationsPending: number;
}): boolean {
	return input.isSubmitting || input.operationsPending > 0;
}
