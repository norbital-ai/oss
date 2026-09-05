import { isSystemCollectionField, type CollectionField } from '@norbital-ai/std/collection';

/** The exact catalog-backed field set a collection form must declare. */
export function collectionFormMutationFieldNames(fields: readonly CollectionField[]): string[] {
	return fields
		.filter((field) => !isSystemCollectionField(field.name) && !field.readOnly)
		.map((field) => field.name);
}

/** Authored values visible to a form, including generated read-only facts but never system fields. */
function collectionFormValueFieldNames(fields: readonly CollectionField[]): string[] {
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
	expectedKeys: readonly string[],
	registrations: ReadonlyMap<string, number>
): void {
	const expectedSet = new Set(expectedKeys);
	const missing = [...expectedSet].filter((name) => (registrations.get(name) ?? 0) === 0);
	const duplicate = [...registrations].flatMap(([name, count]) => (count > 1 ? [name] : [])).sort();
	const unknown = [...registrations.keys()].filter((name) => !expectedSet.has(name)).sort();
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
 * metadata. The mutation boundary is deliberately narrower: the caller names the writable
 * columns — the collection's declared `input` when it has one, the catalog's mutable fields
 * otherwise — so a hook-derived column and an undeclared key alike can never become an
 * accidental graph mutation. Declared `many` relationships ride along when custom composition
 * set them (a matrix stating a schedule's complete desired set).
 */
export function pickWritableFormValues(
	writableColumns: readonly string[],
	values: Readonly<Record<string, unknown>>,
	relationships: ReadonlyArray<{ readonly name: string }> = []
): Record<string, unknown> {
	const names = [
		...writableColumns,
		...relationships.map(({ name }) => name).filter((name) => Reflect.get(values, name) !== undefined)
	];
	return Object.fromEntries(names.map((name) => [name, Reflect.get(values, name)]));
}
