import type { ManifestRelationship } from '@norbital-ai/platform-utils/manifest/types';
import type { TablesRelationalConfig } from 'drizzle-orm';

export const RELATIONSHIP_ON_DELETE = Symbol.for('@norbital-ai/pod/relationship/on-delete');

type RelationEntry = {
	readonly targetTableName?: string;
	readonly relationType?: 'one' | 'many';
	readonly isReversed?: boolean;
	readonly throughTable?: unknown;
	readonly sourceColumns?: readonly { readonly name: string }[];
	readonly targetColumns?: readonly { readonly name: string }[];
	readonly [RELATIONSHIP_ON_DELETE]?: 'cascade';
};

/**
 * Derive manifest relationship entries from a Drizzle RQB v2 relations config
 * (the processed tables config: `{ [table]: { table, name, relations } }`).
 *
 * Manifest orientation convention: `from` is the many side
 * (`from_is_array: true`), `to` is the one side — so a relation defined on
 * either side of a one-to-many edge derives the same entry. Through-relations
 * (M2M) are arrays on both sides.
 */
export function deriveManifestRelationships(
	relations: TablesRelationalConfig
): Readonly<Record<string, ManifestRelationship>> {
	const out: Record<string, ManifestRelationship> = {};

	for (const [tableName, tableConfig] of Object.entries(relations)) {
		const tableRelations =
			tableConfig && typeof tableConfig === 'object'
				? (tableConfig as { relations?: Record<string, unknown> }).relations
				: undefined;
		if (!tableRelations || typeof tableRelations !== 'object') continue;
		for (const [name, relation] of Object.entries(tableRelations)) {
			if (!relation || typeof relation !== 'object') continue;
			const rel = relation as RelationEntry;
			// RQB materializes the column mapping onto an unconfigured inverse
			// `one()` relation and marks it as reversed. It describes the same
			// database edge from the opposite side, so only the configured edge
			// should determine manifest and foreign-key orientation.
			if (rel.isReversed === true) continue;
			const target = rel.targetTableName;
			if (!target) continue;
			if (rel.throughTable != null) {
				out[name] = {
					name,
					from: tableName,
					to: target,
					from_is_array: true,
					to_is_array: true,
					from_fields: [],
					to_fields: []
				};
				continue;
			}
			const isMany = rel.relationType === 'many';
			out[name] = {
				name,
				from: isMany ? target : tableName,
				to: isMany ? tableName : target,
				from_is_array: true,
				to_is_array: false,
				...(rel[RELATIONSHIP_ON_DELETE] ? { on_delete: rel[RELATIONSHIP_ON_DELETE] } : {}),
				from_fields: (isMany ? rel.targetColumns : rel.sourceColumns)?.map((column) => column.name),
				to_fields: (isMany ? rel.sourceColumns : rel.targetColumns)?.map((column) => column.name)
			};
		}
	}

	return out;
}
