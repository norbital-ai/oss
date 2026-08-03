import type { CollectionField } from '@norbital-ai/platform-utils/collection';
import type {
	CollectionColumnMap,
	ManifestContext
} from '@norbital-ai/platform-utils/manifest/context';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';

type CollectionMetadata = NonNullable<ReturnType<ManifestContext['findCollection']>>;

function inferredField(name: string, value: unknown): CollectionField {
	return {
		name,
		kind:
			typeof value === 'boolean'
				? 'boolean'
				: typeof value === 'number'
					? 'number'
					: value != null && typeof value === 'object'
						? 'json'
						: 'string',
		nullable: true,
		...(Array.isArray(value) ? { array: true } : {})
	};
}

export function resolveRecordDetailFields(
	manifest: NorbitalManifest,
	metadata: CollectionMetadata,
	columns: CollectionColumnMap,
	record: Record<string, unknown>
): readonly CollectionField[] {
	const declaredFields = metadata.fields?.length
		? metadata.fields
		: Object.entries(columns)
				.filter(([name]) => !name.startsWith('norbital_'))
				.map(([name, column]): CollectionField => ({
					name,
					kind: column.dataType,
					nullable: !column.notNull,
					...(column.array ? { array: true } : {}),
					...(column.values ? { values: column.values } : {}),
					...(column.options ? { options: column.options } : {}),
					...(column.currencies ? { currencies: column.currencies } : {}),
					...(column.mimeTypes ? { mimeTypes: column.mimeTypes } : {}),
					...(column.variant ? { variant: column.variant } : {})
				}));
	const fields = declaredFields.length
		? declaredFields
		: Object.entries(record)
				.filter(([name]) => !name.startsWith('norbital_'))
				.map(([name, value]) => inferredField(name, value));

	return fields.map((field) => {
		if (field.relation) return field;
		const relationship = Object.values(manifest.relationships).find(
			(candidate) =>
				candidate.from === metadata.collection_name && candidate.from_fields?.includes(field.name)
		);
		if (!relationship) return field;
		return {
			...field,
			relation: {
				name: relationship.name,
				target: relationship.to,
				recordLabel: manifest.collections[relationship.to]?.record_label ?? null
			}
		};
	});
}
