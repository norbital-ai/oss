import type { CollectionMutationGraph, StoredRecord } from '@norbital-ai/bolt-protocol';
import { describe, expect, it } from 'vitest';
import { project } from '../src/client/live-query/project.js';

const write = (graph: CollectionMutationGraph) => ({ graph });

describe('project', () => {
	it('patches an existing id, appends a pending create, and skips other collections and unknown deletes', () => {
		const held: StoredRecord = { id: 'run-1', status: 'draft' };
		const result = project(
			[held],
			[
				write({
					action: 'mutate',
					collection: 'payroll_runs',
					rows: [{ action: 'update', values: { id: 'run-1', status: 'posted' } }]
				}),
				write({
					action: 'mutate',
					collection: 'payroll_runs',
					rows: [{ action: 'create', values: { id: 'run-2', status: 'draft' } }]
				}),
				write({
					action: 'mutate',
					collection: 'payroll_runs',
					rows: [{ action: 'update', values: { id: 'run-3', status: 'draft' } }]
				}),
				write({
					action: 'mutate',
					collection: 'payslips',
					rows: [{ action: 'create', values: { id: 'slip-1', status: 'draft' } }]
				}),
				write({
					action: 'delete',
					collection: 'payroll_runs',
					ids: ['never-held']
				}),
				write({
					action: 'mutate',
					collection: 'payroll_runs',
					rows: [{ action: 'create', values: { status: 'no-id' } }]
				})
			],
			'payroll_runs'
		);

		expect(result).toEqual([
			{ id: 'run-1', status: 'posted' },
			{ id: 'run-2', status: 'draft' },
			{ id: 'run-3', status: 'draft' }
		]);
		expect(result[0]).not.toBe(held);
	});

	it('drops every id in a delete batch from the projected collection', () => {
		const result = project(
			[
				{ id: 'run-1', status: 'draft' },
				{ id: 'run-2', status: 'draft' },
				{ id: 'run-3', status: 'posted' }
			],
			[
				write({
					action: 'delete',
					collection: 'payroll_runs',
					ids: ['run-1', 'run-2']
				})
			],
			'payroll_runs'
		);

		expect(result).toEqual([{ id: 'run-3', status: 'posted' }]);
	});
});
