import { describe, expect, it } from 'vitest';
import { pendingGraphs, type CollectionCatalog } from '../src/client/workspace-api.js';
import type { ClientState } from '../src/client/sync/machine.js';

const stateWith = (graphs: ReadonlyArray<unknown>): ClientState =>
	({
		writes: new Map(
			graphs.map(
				(graph, index) =>
					[`w${index}`, { request: { idempotencyKey: `w${index}`, graph } }] as const
			)
		)
	}) as unknown as ClientState;

const catalog: CollectionCatalog = {
	payroll_runs: {
		name: 'payroll_runs',
		fields: [
			{ name: 'id', kind: 'uuid', nullable: false },
			{ name: 'company_id', kind: 'uuid', nullable: false },
			{ name: 'period', kind: 'text', nullable: false },
			{ name: 'status', kind: 'enum', nullable: false },
			{ name: 'total', kind: 'numeric', nullable: false, readOnly: true }
		],
		write: { create: { columns: { company_id: true, period: true } }, update: { columns: {} } }
	},
	notes: {
		name: 'notes',
		fields: [
			{ name: 'id', kind: 'uuid', nullable: false },
			{ name: 'body', kind: 'text', nullable: false },
			{ name: 'tone', kind: 'text', nullable: true }
		],
		relationships: [{ name: 'tags', target: 'tags', cardinality: 'many' }],
		write: { create: { columns: { body: true } }, update: { columns: { body: true } } }
	},
	drafts: { name: 'drafts', fields: [{ name: 'body', kind: 'text', nullable: false }] }
};

/**
 * A pending create is painted only where the row the browser sent is the row the server writes:
 * the collection declares a create and the input carries every required column. An input that
 * leaves a required column to the transform is engine-authored — painting it as a row put an empty
 * payroll run on the list twenty seconds before its payslips existed.
 */
describe('pendingGraphs', () => {
	it('paints a complete create under the write key as its id', () => {
		const graph = { action: 'create', collection: 'notes', inputs: [{ body: 'x' }] };
		expect(pendingGraphs(stateWith([graph]), catalog)).toEqual([
			{ graph: { ...graph, inputs: [{ body: 'x', id: 'w0:0' }] } }
		]);
	});

	it('withholds a create whose required columns the server still derives', () => {
		const graph = {
			action: 'create',
			collection: 'payroll_runs',
			inputs: [{ company_id: 'c', period: '2026-01' }]
		};
		expect(pendingGraphs(stateWith([graph]), catalog)).toEqual([]);
	});

	it('withholds a create of a collection that declares none', () => {
		const graph = { action: 'create', collection: 'drafts', inputs: [{ body: 'x' }] };
		expect(pendingGraphs(stateWith([graph]), catalog)).toEqual([]);
		expect(pendingGraphs(stateWith([graph]))).toEqual([]);
	});

	it('paints an update without its relation actions and a delete as it is', () => {
		const update = {
			action: 'update',
			collection: 'notes',
			inputs: [{ id: 'n1', body: 'y', tags: { create: [{ label: 't' }] } }]
		};
		const remove = { action: 'delete', collection: 'notes', inputs: [{ id: 'n2' }] };
		expect(pendingGraphs(stateWith([update, remove]), catalog)).toEqual([
			{ graph: { ...update, inputs: [{ id: 'n1', body: 'y' }] } },
			{ graph: remove }
		]);
	});
});
