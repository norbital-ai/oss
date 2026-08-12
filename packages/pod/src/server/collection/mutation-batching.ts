/** Keep headroom below PostgreSQL's 65,535 bind-parameter ceiling. */
export const MUTATION_PARAMETER_BUDGET = 60_000;

export function rowsPerMutationStatement(columnsPerRow: number, rowCap = Infinity): number {
	if (!Number.isInteger(columnsPerRow) || columnsPerRow < 1) {
		throw new Error('Mutation statement column count must be a positive integer.');
	}
	return Math.max(1, Math.min(rowCap, Math.floor(MUTATION_PARAMETER_BUDGET / columnsPerRow)));
}
