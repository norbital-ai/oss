import { Schema } from 'effect';

/**
 * One issue in a standard-schema validation failure, derived from effect's own adapter.
 *
 * `Schema.toStandardSchemaV1` is effect's implementation of the standard schema interface, so its
 * failure result is the authoritative shape of an issue here — derived through `ReturnType` rather
 * than restated from the spec, which keeps the two in step by construction.
 */
export type StandardSchemaIssue = Extract<
	Awaited<
		ReturnType<
			ReturnType<
				typeof Schema.toStandardSchemaV1<Schema.Codec<unknown, unknown>>
			>['~standard']['validate']
		>
	>,
	{ readonly issues: readonly unknown[] }
>['issues'][number];

/** Any schema the realm's forms accept: an Effect schema, standard-adapted or raw. */
export type StandardSchemaOf<S extends Schema.Codec<unknown, unknown>> = ReturnType<
	typeof Schema.toStandardSchemaV1<S>
>;

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
