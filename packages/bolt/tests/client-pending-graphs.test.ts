import { describe, expect, it } from 'vitest';
import { pendingGraphs, type CollectionCatalog } from '../src/client/workspace-api.js';
import type { ClientState } from '../src/client/sync/machine.js';

const stateWith = (graphs: ReadonlyArray<unknown>): ClientState =>
	({
		writes: new Map(graphs.map((graph, index) => [`w${index}`, { request: { graph } }] as const))
	}) as unknown as ClientState;

const catalog: CollectionCatalog = {
	payroll_runs: {
		name: 'payroll_runs',
		fields: [],
		inputColumns: ['company_id', 'period']
	},
	notes: { name: 'notes', fields: [] }
};

/**
 * A pending create is painted only where the row the browser sent is the row the server writes.
 * A collection with a declared `input` is engine-authored: painting its input as a row put an
 * empty payroll run on the list twenty seconds before its payslips existed.
 */
describe('pendingGraphs', () => {
	it('paints a create of a collection with no declared input', () => {
		const graph = {
			action: 'mutate',
			collection: 'notes',
			rows: [{ action: 'create', values: { id: 'n1', body: 'x' } }]
		};
		expect(pendingGraphs(stateWith([graph]), catalog)).toEqual([{ graph }]);
	});

	it('withholds a create of an engine-authored collection until the server answers', () => {
		const graph = {
			action: 'mutate',
			collection: 'payroll_runs',
			rows: [{ action: 'create', values: { id: 'r1', company_id: 'c', period: '2026-01' } }]
		};
		expect(pendingGraphs(stateWith([graph]), catalog)).toEqual([]);
	});

	it('still paints an update of an engine-authored collection', () => {
		const graph = {
			action: 'mutate',
			collection: 'payroll_runs',
			rows: [
				{ action: 'create', values: { id: 'r1', company_id: 'c', period: '2026-01' } },
				{ action: 'update', values: { id: 'r0', period: '2025-12' } }
			]
		};
		expect(pendingGraphs(stateWith([graph]), catalog)).toEqual([
			{ graph: { ...graph, rows: [graph.rows[1]] } }
		]);
	});

	it('paints everything when no catalog is known', () => {
		const graph = {
			action: 'mutate',
			collection: 'payroll_runs',
			rows: [{ action: 'create', values: { id: 'r1' } }]
		};
		expect(pendingGraphs(stateWith([graph]))).toEqual([{ graph }]);
	});
});
