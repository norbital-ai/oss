import type { CollectionFilter } from '@norbital-ai/platform-utils/collection';
import { type AnyRelationsFilter, type Operators, type SQL } from 'drizzle-orm';
import { getColumns } from 'drizzle-orm';
import { z } from 'zod';
import {
	isTemporalOperand,
	isUtcIsoInstant,
	temporalKindForFieldKind,
	type TemporalKind
} from '@norbital-ai/std/date';
import {
	andRelationsFilters,
	toRelationsFilter
} from '$lib/authoring/workspace/relations-filter.js';
import { portableCollectionField } from '$lib/authoring/schema/table.js';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import { requireTable } from './collection_direct.js';
import { error } from './http_error.js';

const utcInstantSchema = z.string().refine(isUtcIsoInstant);
const dateRangeSchema = z.object({ start: utcInstantSchema, end: utcInstantSchema });

interface FilterTarget {
	readonly relation?: string;
	readonly field: string;
	readonly temporalKind?: TemporalKind;
}

function filterTarget(
	ctx: ProvisionedContext,
	collection: string,
	path: readonly string[]
): FilterTarget {
	const [first, second] = path;
	if (!first) throw error(400, 'Collection filter path is empty.');
	let targetCollection = collection;
	let relation: string | undefined;
	let field = first;
	if (second) {
		const relationship = ctx.manifestCtx.findRelationship(first);
		if (!relationship || (relationship.from !== collection && relationship.to !== collection)) {
			throw error(400, `Collection '${collection}' has no relation '${first}'.`);
		}
		relation = first;
		targetCollection = relationship.from === collection ? relationship.to : relationship.from;
		field = second;
	}
	const column = getColumns(requireTable(ctx, targetCollection))[field];
	if (!column) {
		throw error(400, `Collection '${targetCollection}' has no field '${field}'.`);
	}
	const temporalKind = temporalKindForFieldKind(portableCollectionField(field, column).kind);
	return { relation, field, temporalKind };
}

function validateTemporalOperand(target: FilterTarget, filter: CollectionFilter): void {
	if (!target.temporalKind || filter.operator === 'isNull' || filter.operator === 'isNotNull') {
		return;
	}
	if (!isTemporalOperand(target.temporalKind, filter.operand)) {
		const expected =
			target.temporalKind === 'instant'
				? 'a UTC ISO instant'
				: target.temporalKind === 'clock-time'
					? 'a local clock time (HH:mm)'
					: 'a calendar date (YYYY-MM-DD)';
		throw error(400, `Filter '${target.field}' requires ${expected}.`);
	}
}

function dateRangePredicate(field: string, filter: CollectionFilter): AnyRelationsFilter {
	return {
		RAW: (table: unknown, operators: Operators): SQL => {
			const column = Reflect.get(table as object, field);
			if (!column) throw error(400, `Collection filter field '${field}' is unavailable.`);
			if (filter.operator === 'contains_date') {
				if (typeof filter.operand !== 'string' || !isUtcIsoInstant(filter.operand)) {
					throw error(400, 'Date-range containment requires a UTC ISO instant.');
				}
				return operators.sql`(${column}->>'start')::timestamptz <= ${filter.operand}::timestamptz
					and (${column}->>'end')::timestamptz >= ${filter.operand}::timestamptz`;
			}
			const parsedRange = dateRangeSchema.safeParse(filter.operand);
			if (!parsedRange.success) {
				throw error(400, 'Date-range overlap requires UTC ISO start and end instants.');
			}
			const range = parsedRange.data;
			return operators.sql`(${column}->>'start')::timestamptz <= ${range.end}::timestamptz
				and ${range.start}::timestamptz <= (${column}->>'end')::timestamptz`;
		}
	} as AnyRelationsFilter; // stupidity: boundary-cast — Drizzle's schema-erased RAW callback supplies the related table alias at runtime.
}

function collectionFilterWhere(
	ctx: ProvisionedContext,
	collection: string,
	filter: CollectionFilter
): AnyRelationsFilter {
	const target = filterTarget(ctx, collection, filter.path);
	validateTemporalOperand(target, filter);
	const predicate =
		filter.operator === 'contains_date' || filter.operator === 'overlaps'
			? dateRangePredicate(target.field, filter)
			: toRelationsFilter({
					[target.field]: {
						[filter.operator]:
							filter.operator === 'isNull' || filter.operator === 'isNotNull'
								? true
								: filter.operand
					}
				});
	return target.relation ? toRelationsFilter({ [target.relation]: predicate }) : predicate;
}

/** Turns CollectionTable's explicit filter controls into a Drizzle relations filter. */
export function collectionFiltersWhere(
	ctx: ProvisionedContext,
	collection: string,
	filters: readonly CollectionFilter[] | undefined
): AnyRelationsFilter | undefined {
	if (!filters?.length) return undefined;
	const clauses = filters.map((filter) => collectionFilterWhere(ctx, collection, filter));
	return clauses.length === 1 ? clauses[0] : andRelationsFilters(...clauses);
}
