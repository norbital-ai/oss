/** Pure COMMIT ordering over operations that PREPARE has already authorized and normalized. */
import type { GraphPreparedOperation } from './engine.js';

export type PredicateAssertionExpectation = Readonly<{
	readonly operation: GraphPreparedOperation;
	readonly timing: 'before-write' | 'after-insert';
}>;

export type WriteStatementPlan = Readonly<{
	readonly collections: ReadonlyArray<string>;
	/** The sole authoritative COMMIT and SETTLE operation order. */
	readonly operations: ReadonlyArray<GraphPreparedOperation>;
	readonly before: ReadonlyArray<PredicateAssertionExpectation>;
	readonly after: ReadonlyArray<PredicateAssertionExpectation>;
	readonly claimLedger: boolean;
}>;

/** Deletes deepest-first; updates and inserts shallowest-first, stable within each collection. */
export const statementPlanFor = (
	prepared: ReadonlyArray<GraphPreparedOperation>,
	options: Readonly<{ readonly ledgerClaim?: unknown }> = {}
): WriteStatementPlan => {
	const groups = Map.groupBy(prepared, (operation) => `${operation.depth}\u0000${operation.collection}`);
	const orderedGroups = [...groups.values()].toSorted(
		([left], [right]) => (left?.depth ?? 0) - (right?.depth ?? 0)
	);
	const operationsFor = (action: GraphPreparedOperation['action'], reverse = false) =>
		(reverse ? [...orderedGroups].reverse() : orderedGroups).flatMap((group) =>
			group.filter((operation) => operation.action === action)
		);
	const operations = [
		...operationsFor('delete', true),
		...operationsFor('update'),
		...operationsFor('create')
	];
	return {
		collections: [...new Set(prepared.map((operation) => operation.collection))].toSorted(),
		operations,
		before: operations
			.filter((operation) => operation.action !== 'create')
			.map((operation) => ({ operation, timing: 'before-write' })),
		after: operationsFor('create').map((operation) => ({ operation, timing: 'after-insert' })),
		claimLedger: Object.hasOwn(options, 'ledgerClaim')
	};
};
