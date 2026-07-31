import {
	isSearchableCollectionField,
	type CollectionField
} from '@norbital-ai/platform-utils/collection';
import { literalIlikeContainsPattern } from '@norbital-ai/std/string';
import { getColumns, type AnyRelationsFilter } from 'drizzle-orm';
import { portableCollectionField } from '$lib/authoring/schema/table.js';
import { toRelationsFilter } from '$lib/authoring/workspace/relations-filter.js';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import { requireTable } from './direct/collection_direct.js';

function searchableCollectionFields(
	ctx: ProvisionedContext,
	collectionName: string
): CollectionField[] {
	return Object.entries(getColumns(requireTable(ctx, collectionName)))
		.map(([name, column]) => portableCollectionField(name, column))
		.filter(isSearchableCollectionField);
}

function collectionTextSearchWhere(
	ctx: ProvisionedContext,
	collectionName: string,
	pattern: string
): AnyRelationsFilter | undefined {
	const fields = searchableCollectionFields(ctx, collectionName);
	if (fields.length === 0) return undefined;
	return toRelationsFilter({
		OR: fields.map((field) => ({ [field.name]: { ilike: pattern } }))
	});
}

/** Search scalar text plus every text value exposed through a direct relationship field. */
export function collectionSearchWhere(
	ctx: ProvisionedContext,
	collectionName: string,
	search: string | undefined
): AnyRelationsFilter | undefined {
	const pattern = literalIlikeContainsPattern(search ?? '');
	if (!pattern) return undefined;
	const ownSearch = collectionTextSearchWhere(ctx, collectionName, pattern);
	const relationshipSearches = ctx.manifestCtx
		.getRelationshipsForCollection(collectionName)
		.flatMap(({ name, rel }) => {
			if (rel.from !== collectionName || rel.to_is_array || !rel.from_fields?.length) return [];
			const targetSearch = collectionTextSearchWhere(ctx, rel.to, pattern);
			return targetSearch ? [toRelationsFilter({ [name]: targetSearch })] : [];
		});
	const clauses = [...(ownSearch ? [ownSearch] : []), ...relationshipSearches];
	if (clauses.length === 0) return undefined;
	return clauses.length === 1 ? clauses[0] : toRelationsFilter({ OR: clauses });
}
