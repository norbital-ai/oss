import {
	isSystemCollectionField,
	type CollectionField,
	type CollectionWriteContract,
	type CollectionWriteSelection
} from '@norbital-ai/std/collection';

/**
 * The selection a form writes through: `update` when it edits an existing record, `create` for a
 * draft. Absent, the collection declares no such operation and the form is read-only.
 */
export function collectionFormWriteSelection(
	write: CollectionWriteContract | undefined,
	editing: boolean
): CollectionWriteSelection | undefined {
	return editing ? write?.update : write?.create;
}

/** The exact catalog-backed field set a collection form must declare: the selection's columns. */
export function collectionFormWriteColumns(selection: CollectionWriteSelection): string[] {
	return Object.keys(selection.columns ?? {});
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
 * Keeps only values the collection form is allowed to send back to a write.
 *
 * An edit form starts from a complete hydrated row so it can render field values and framework
 * metadata. The write boundary is deliberately narrower: the declared selection's columns, so an
 * undeclared key can never reach the graph. The selection's `with` relations ride along when
 * custom composition set them (a matrix stating a schedule's complete desired set).
 */
export function pickWritableFormValues(
	writableColumns: readonly string[],
	values: Readonly<Record<string, unknown>>,
	relations: readonly string[] = []
): Record<string, unknown> {
	const names = [
		...writableColumns,
		...relations.filter((name) => Reflect.get(values, name) !== undefined)
	];
	return Object.fromEntries(names.map((name) => [name, Reflect.get(values, name)]));
}
