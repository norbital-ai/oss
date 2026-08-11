import { describe, expect, it } from 'vitest';
import { CollectionQueryState } from '@norbital-ai/ui/collection-query';

type RosterRow = { readonly employment_id: string; readonly work_date: string };

describe('CollectionQueryState', () => {
	it('drops back to the first page when a narrowing changes the result set', () => {
		const query = new CollectionQueryState<RosterRow>({ pageSize: 50 });
		query.setPageIndex(3);
		expect(query.pageIndex).toBe(3);

		query.setSearch('abu');
		expect(query.pageIndex).toBe(0);

		query.setPageIndex(2);
		query.setFilters([{ path: ['work_date'], operator: 'gte', operand: '2025-09-01' }]);
		expect(query.pageIndex).toBe(0);
	});

	it('keeps the page when the search is retyped to the value already applied', () => {
		const query = new CollectionQueryState<RosterRow>();
		query.setSearch('abu');
		query.setPageIndex(2);

		// A debounced input re-commits the same string; that is not a new result set.
		query.setSearch('  abu  ');
		expect(query.pageIndex).toBe(2);
		expect(query.search).toBe('abu');
	});

	it('resets the page when the page size changes, because the boundaries moved', () => {
		const query = new CollectionQueryState<RosterRow>({ pageSize: 25 });
		query.setPageIndex(4);
		query.setPageSize(100);
		expect(query.pageSize).toBe(100);
		expect(query.pageIndex).toBe(0);
	});

	it('clamps a page size the server would reject', () => {
		const query = new CollectionQueryState<RosterRow>();
		query.setPageSize(10_000);
		expect(query.pageSize).toBe(500);
		query.setPageSize(0);
		expect(query.pageSize).toBe(1);
		query.setPageSize(Number.NaN);
		expect(query.pageSize).toBe(50);
	});

	it('reports whether the set is narrowed and hands the client the wire shape', () => {
		const query = new CollectionQueryState<RosterRow>();
		expect(query.narrowed).toBe(false);
		expect(query.queryOptions).toEqual({ filters: [] });

		query.setFilters([{ path: ['employment_id'], operator: 'eq', operand: 'e1' }]);
		expect(query.narrowed).toBe(true);
		expect(query.queryOptions).toEqual({
			filters: [{ path: ['employment_id'], operator: 'eq', operand: 'e1' }]
		});

		query.clear();
		expect(query.narrowed).toBe(false);
		expect(query.pageIndex).toBe(0);
	});
});
