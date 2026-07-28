import type { StandardSchemaIssue } from '@norbital-ai/std/schema';

export type FieldAndFormErrors = {
	fieldErrors: Record<string, string[]>;
	formErrors: string[];
};

export function fieldAndFormErrorsFromStandardIssues(
	issues: readonly StandardSchemaIssue[]
): FieldAndFormErrors {
	const fieldErrors: Record<string, string[]> = {};
	const formErrors: string[] = [];

	for (const issue of issues) {
		const message = issue.message;
		const path = issue.path?.length ? issue.path.join('.') : '';

		if (!path) {
			formErrors.push(message);
		} else {
			(fieldErrors[path] ??= []).push(message);
		}
	}

	return { fieldErrors, formErrors };
}
