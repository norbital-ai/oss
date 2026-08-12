import { describe, expect, it } from 'vitest';
import {
	MUTATION_PARAMETER_BUDGET,
	rowsPerMutationStatement
} from '$lib/server/collection/mutation-batching.js';

describe('collection mutation statement batching', () => {
	it('keeps every statement below the PostgreSQL parameter ceiling', () => {
		for (const columns of [1, 4, 6, 8, 12, 37, 500]) {
			const rows = rowsPerMutationStatement(columns);
			expect(rows * columns).toBeLessThanOrEqual(MUTATION_PARAMETER_BUDGET);
			expect((rows + 1) * columns).toBeGreaterThan(MUTATION_PARAMETER_BUDGET);
		}
	});

	it('honours a memory-bound caller cap without violating the parameter budget', () => {
		expect(rowsPerMutationStatement(8, 5_000)).toBe(5_000);
		expect(rowsPerMutationStatement(20, 5_000)).toBe(3_000);
	});

	it('rejects an invalid column count', () => {
		expect(() => rowsPerMutationStatement(0)).toThrow(/positive integer/);
	});
});
