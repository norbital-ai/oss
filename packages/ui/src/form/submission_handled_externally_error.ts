/**
 * Thrown when submit failure was handled outside FormState (e.g. approval dialog).
 * FormState suppresses the default error toast and returns to idle without rethrowing.
 */
export class SubmissionHandledExternallyError extends Error {
	override readonly name = 'SubmissionHandledExternallyError';

	constructor(message = 'Submission handled externally') {
		super(message);
		Object.setPrototypeOf(this, new.target.prototype);
	}
}
