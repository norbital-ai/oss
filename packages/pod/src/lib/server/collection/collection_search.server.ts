import {
	isSearchableCollectionField,
	type CollectionField
} from '@norbital-ai/platform-utils/collection';
import { literalIlikeContainsPattern, normalizeSearchTerm } from '@norbital-ai/std/string';
import { getColumns, type AnyRelationsFilter, type Operators, type SQL } from 'drizzle-orm';
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

function trigramTypoWhere(fieldNames: readonly string[], term: string): AnyRelationsFilter {
	return {
		RAW: (table: unknown, operators: Operators): SQL => {
			const predicates = fieldNames.flatMap((fieldName) => {
				const column = Reflect.get(table as object, fieldName);
				if (!column) return [];
				return [
					operators.sql`similarity(${column}::text, ${term}) >= 0.3`,
					operators.sql`word_similarity(${term}, ${column}::text) >= 0.45`
				];
			});
			if (predicates.length === 0) return operators.sql`false`;
			return operators.sql.join(predicates, operators.sql` or `);
		}
	} as AnyRelationsFilter; // stupidity:boundary-cast -- Drizzle supplies the active table alias to the server-only RAW predicate.
}

function collectionTextSearchWhere(
	ctx: ProvisionedContext,
	collectionName: string,
	term: string,
	pattern: string
): AnyRelationsFilter | undefined {
	const fields = searchableCollectionFields(ctx, collectionName);
	if (fields.length === 0) return undefined;
	// Numbers identify business records precisely. Trigram matching broadens identifiers such as
	// NHPMY0072 to hundreds of sibling records with the same prefix, which can hide the exact row
	// behind a query limit. Keep typo tolerance for human text and literal matching for identifiers.
	const fuzzyPredicates = /\p{N}/u.test(term)
		? []
		: [
				trigramTypoWhere(
					fields.map((field) => field.name),
					term
				)
			];
	return toRelationsFilter({
		OR: [...fields.map((field) => ({ [field.name]: { ilike: pattern } })), ...fuzzyPredicates]
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
	const term = normalizeSearchTerm(search ?? '');
	const ownSearch = collectionTextSearchWhere(ctx, collectionName, term, pattern);
	const relationshipSearches = ctx.manifestCtx
		.getRelationshipsForCollection(collectionName)
		.flatMap(({ name, rel }) => {
			if (rel.from !== collectionName || rel.to_is_array || !rel.from_fields?.length) return [];
			const targetSearch = collectionTextSearchWhere(ctx, rel.to, term, pattern);
			return targetSearch ? [toRelationsFilter({ [name]: targetSearch })] : [];
		});
	const clauses = [...(ownSearch ? [ownSearch] : []), ...relationshipSearches];
	if (clauses.length === 0) return undefined;
	return clauses.length === 1 ? clauses[0] : toRelationsFilter({ OR: clauses });
}
