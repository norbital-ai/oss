import { isSystemCollectionField, type CollectionField } from '@norbital-ai/std/collection';

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
		fields
			.filter((field) => !isSystemCollectionField(field.name) && !field.readOnly)
			.map((field) => [field.name, Reflect.get(values, field.name)])
	);
}
