export function assertExactlyOnePhotoParent(
	jobAssignmentId: string | null | undefined,
	variationRequestId: string | null | undefined
): void {
	const hasJobAssignment = jobAssignmentId != null && jobAssignmentId !== '';
	const hasVariation = variationRequestId != null && variationRequestId !== '';
	if (hasJobAssignment === hasVariation) {
		throw new Error(
			'Photo evidence must reference exactly one job assignment or variation request.'
		);
	}
}
