import { describe, expect, it } from 'vitest';
import { filterToWhere } from '../src/client/workspace-api.js';

/**
 * A table filter whose path walks a relationship must come out quantified: the predicate grammar
 * (`bolt-protocol` `predicateProblem`) reads a bare relation object's keys as operators and refuses
 * the query, which left the People "Employee profile" table and any table with a relation-path
 * initial filter on their skeletons.
 */
describe('filterToWhere', () => {
	it('quantifies every relationship segment of the path with some', () => {
		expect(
			filterToWhere({
				path: ['employment_employee', 'effective_range'],
				operator: 'contains_date',
				operand: '2026-09-07T00:00:00.000Z'
			})
		).toEqual({
			employment_employee: {
				some: { effective_range: { contains_date: '2026-09-07T00:00:00.000Z' } }
			}
		});
		expect(filterToWhere({ path: ['a', 'b', 'c'], operator: 'eq', operand: 1 })).toEqual({
			a: { some: { b: { some: { c: { eq: 1 } } } } }
		});
	});

	it('leaves a direct column alone and spells an operand-less operator as true', () => {
		expect(filterToWhere({ path: ['name'], operator: 'ilike', operand: '%x%' })).toEqual({
			name: { ilike: '%x%' }
		});
		expect(
			filterToWhere({ path: ['approval_id'], operator: 'isNull', operand: undefined })
		).toEqual({ approval_id: { isNull: true } });
	});
});
