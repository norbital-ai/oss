import { isSystemCollectionField, type CollectionField } from '@norbital-ai/std/collection';

/** The exact catalog-backed field set a collection form must declare. */
export function collectionFormMutationFieldNames(fields: readonly CollectionField[]): string[] {
	return fields
		.filter((field) => !isSystemCollectionField(field.name) && !field.readOnly)
		.map((field) => field.name);
}

/** Authored values visible to a form, including generated read-only facts but never system fields. */
export function collectionFormValueFieldNames(fields: readonly CollectionField[]): string[] {
	return fields.filter((field) => !isSystemCollectionField(field.name)).map((field) => field.name);
}

/**
 * Enforce explicit, complete form composition.
 *
 * System identity remains in the record baseline for update routing, but it is framework-hidden:
 * authors neither declare it nor satisfy completeness with it. A `hidden` Field still registers,
 * so it satisfies this contract without mounting a control.
 */
export function assertCollectionFormFieldRegistration(
	collection: string,
	fields: readonly CollectionField[],
	registrations: ReadonlyMap<string, number>
): void {
	const expected = collectionFormMutationFieldNames(fields);
	const knownSet = new Set(collectionFormValueFieldNames(fields));
	const missing = expected.filter((name) => (registrations.get(name) ?? 0) === 0);
	const duplicate = [...registrations]
		.filter(([, count]) => count > 1)
		.map(([name]) => name)
		.sort();
	const unknown = [...registrations.keys()].filter((name) => !knownSet.has(name)).sort();
	if (missing.length === 0 && duplicate.length === 0 && unknown.length === 0) return;

	const details = [
		missing.length > 0 ? `missing: ${missing.join(', ')}` : null,
		duplicate.length > 0 ? `duplicated: ${duplicate.join(', ')}` : null,
		unknown.length > 0 ? `not mutable: ${unknown.join(', ')}` : null
	].filter((detail): detail is string => detail !== null);
	throw new Error(
		`CollectionForm "${collection}" must declare every mutable field exactly once (${details.join('; ')}). ` +
			'Use <Field hidden> when a mutable value must not be shown; framework fields such as id are hidden automatically.'
	);
}

/** Build the form baseline without exposing framework identity to authored field composition. */
export function pickCollectionFormValues(
	fields: readonly CollectionField[],
	values: Readonly<Record<string, unknown>>
): Record<string, unknown> {
	return Object.fromEntries(
		collectionFormValueFieldNames(fields).map((name) => [name, Reflect.get(values, name)])
	);
}

/**
 * Keeps only values the collection form is allowed to send back to a mutation.
 *
 * An edit form starts from a complete hydrated row so it can render field values and framework
 * metadata. The mutation boundary is deliberately narrower: Bolt-managed columns and generated
 * authored columns are read context, never write input. Picking through the catalog here also keeps
 * an undeclared key from a custom form composition from becoming an accidental graph mutation.
 */
export function pickWritableFormValues(
	fields: readonly CollectionField[],
	values: Readonly<Record<string, unknown>>
): Record<string, unknown> {
	return Object.fromEntries(
		collectionFormMutationFieldNames(fields).map((name) => [name, Reflect.get(values, name)])
	);
}
