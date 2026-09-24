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

	it("puts a related filter's conditions on one related row, quantified or counted", () => {
		const open = { path: ['status'], operator: 'eq' as const, operand: 'open' };
		const invoice = { path: ['kind'], operator: 'eq' as const, operand: 'invoice' };
		// "Customers with at least 1 open invoice message".
		expect(
			filterToWhere({
				path: ['messages'],
				operator: 'related',
				related: { count: 'gte', value: 1 },
				where: [open, invoice]
			})
		).toEqual({
			messages: {
				count: { where: { AND: [{ status: { eq: 'open' } }, { kind: { eq: 'invoice' } }] }, gte: 1 }
			}
		});
		expect(
			filterToWhere({
				path: ['messages'],
				operator: 'related',
				related: { quantifier: 'none' },
				where: [open]
			})
		).toEqual({ messages: { none: { status: { eq: 'open' } } } });
		// Through a one relation first: the outer segment is quantified as always.
		expect(
			filterToWhere({
				path: ['account', 'invoices'],
				operator: 'related',
				related: { count: 'eq', value: 0 }
			})
		).toEqual({ account: { some: { invoices: { count: { eq: 0 } } } } });
	});
});
