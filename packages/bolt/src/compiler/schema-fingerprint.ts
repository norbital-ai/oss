import { createHash } from 'node:crypto';
import { Schema } from 'effect';
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

/** The five fields a mutation-visible snapshot column must declare; excess fields are ignored. */
const SnapshotColumnShape = Schema.Struct({
	entityType: Schema.Literal('columns'),
	table: Schema.String,
	name: Schema.String,
	type: Schema.String,
	notNull: Schema.Boolean
});
const isSnapshotColumnShape = Schema.is(SnapshotColumnShape);

const isSnapshotColumn = (value: unknown): value is SnapshotColumn => isSnapshotColumnShape(value);

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
