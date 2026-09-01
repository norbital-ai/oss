import { createHash } from 'node:crypto';
import type { RelationDefinition } from '../authoring/workspace-schema.js';

type SnapshotColumn = Readonly<{
	readonly entityType: 'columns';
	readonly table: string;
	readonly name: string;
	readonly type: string;
	readonly typeSchema?: string | null;
	readonly dimensions?: number;
	readonly notNull: boolean;
	readonly default?: string | null;
	readonly generated?: Readonly<{ readonly as: string }> | null;
}>;

type SnapshotLike = Readonly<{ readonly ddl: ReadonlyArray<unknown> }>;

const isSnapshotColumn = (value: unknown): value is SnapshotColumn => {
	if (value === null || typeof value !== 'object') return false;
	return (
		Reflect.get(value, 'entityType') === 'columns' &&
		typeof Reflect.get(value, 'table') === 'string' &&
		typeof Reflect.get(value, 'name') === 'string' &&
		typeof Reflect.get(value, 'type') === 'string' &&
		typeof Reflect.get(value, 'notNull') === 'boolean'
	);
};

/** Identifies the mutation-visible part of one committed workspace schema. */
export const workspaceSchemaFingerprint = (
	snapshot: SnapshotLike,
	relations: ReadonlyArray<RelationDefinition>
): string => {
	const collections: Record<string, { fields: Record<string, unknown> }> = {};
	for (const entry of snapshot.ddl) {
		if (!isSnapshotColumn(entry)) continue;
		const collection = collections[entry.table] ?? { fields: {} };
		collection.fields[entry.name] = {
			type: entry.type,
			typeSchema: entry.typeSchema ?? null,
			dimensions: entry.dimensions ?? 0,
			notNull: entry.notNull,
			default: entry.default ?? null,
			generated: entry.generated?.as ?? null
		};
		collections[entry.table] = collection;
	}
	const schema = {
		collections: Object.fromEntries(
			Object.entries(collections)
				.toSorted(([left], [right]) => left.localeCompare(right))
				.map(([collection, definition]) => [
					collection,
					{
						fields: Object.fromEntries(
							Object.entries(definition.fields).toSorted(([left], [right]) =>
								left.localeCompare(right)
							)
						)
					}
				])
		),
		relations: relations
			.map(({ name, source, target, cardinality }) => ({
				name,
				source,
				target,
				cardinality
			}))
			.toSorted((left, right) =>
				[left.source, left.name, left.target, left.cardinality]
					.join('\u0000')
					.localeCompare(
						[right.source, right.name, right.target, right.cardinality].join('\u0000')
					)
			)
	};
	return `sha256:${createHash('sha256')
		.update(JSON.stringify({ actions: ['mutate', 'delete'], schema }))
		.digest('hex')}`;
};
