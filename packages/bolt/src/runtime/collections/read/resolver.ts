import { Effect } from 'effect';
import type { AnyDBQueryConfig, SQL } from 'drizzle-orm';
import type { RelationalBuilder } from '#lib/runtime/persistence.js';
import type { QueryError } from '#lib/runtime/collections/collections.contract.js';
import {
	planRelations,
	projectRootRow,
	readRelationalRows,
	type MaskRow,
	type PlanContext
} from './relation-plan.js';
import { WhereCompileError, orderingExpressions, type OrderTerm } from './where.js';

type RelationalReadConfig = Readonly<{
	readonly where: SQL;
	readonly ordering: ReadonlyArray<OrderTerm>;
	readonly searchOrdering?: SQL | undefined;
	readonly limit: number;
	readonly with: unknown;
	readonly columns?: Readonly<Record<string, boolean>> | undefined;
}>;

type RelationalReadPorts = Readonly<{
	readonly builders: Readonly<Record<string, RelationalBuilder | undefined>>;
	readonly planContext: PlanContext;
	readonly mask: MaskRow;
	readonly execute: (
		statement: ReturnType<RelationalBuilder['findMany']>
	) => Effect.Effect<ReadonlyArray<unknown>, QueryError>;
}>;

/**
 * One relational statement plus the per-level mask. The caller supplies the subject's
 * plan context and mask; this owns statement construction and the resolver wiring.
 */
export const readRelational = Effect.fn('Collections.readRelational')(function* (
	ports: RelationalReadPorts,
	collection: string,
	config: RelationalReadConfig
) {
	const builder = ports.builders[collection];
	if (builder === undefined) {
		return yield* new WhereCompileError({
			collection,
			field: 'collection',
			message: `'${collection}' has no relational descriptor in this workspace.`
		});
	}
	const planned = yield* planRelations(ports.planContext, collection, config.with, config.columns);
	// The same load-bearing cast `read/relation-plan.ts` explains at length: Drizzle's declared
	// `RelationsFilter` does not model the `RAW` key that `relationsFilterToSQL` reads before
	// every other, so a bound predicate cannot be handed to a typed filter. The root read
	// carries the subject's row predicate through exactly that key.
	const query = builder.findMany({
		where: { RAW: config.where },
		orderBy: (table: unknown) => [
			...(config.searchOrdering === undefined ? [] : [config.searchOrdering]),
			...orderingExpressions(table, config.ordering)
		],
		limit: config.limit,
		...(planned.with === undefined ? {} : { with: planned.with })
	} as unknown as AnyDBQueryConfig);
	const rawRows = yield* ports.execute(query);
	// Grouping consumes the ordered, unmasked page while callers receive only the policy-masked
	// projection. Keeping both arrays here avoids a second public resolver abstraction.
	const source = rawRows.map((row) => row as Readonly<Record<string, unknown>>);
	const rows = rawRows
		.map(
			(row) =>
			readRelationalRows(
				[row as Readonly<Record<string, unknown>>],
				planned.level,
				ports.mask
			)[0] ?? {}
		)
		.map((row) =>
			projectRootRow(row, planned.plan.rootProjection, planned.plan.root.attached)
		);
	return { rows, source };
});
