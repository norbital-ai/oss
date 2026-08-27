import { Effect, type Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import type {
	RelationDefinition,
	WorkspaceDefinition
} from '../../src/authoring/workspace-schema.js';
import type { QueryRow } from '../../src/runtime/collections/collections.contract.js';
import { attachRelations, requestedRelations } from '../../src/runtime/collections/prefetch.js';

/**
 * `with` was dropped by the query path, so a table that asked for a relation received only the
 * foreign key and rendered a raw uuid — or the dash its label function falls back to.
 */

const relations: ReadonlyArray<RelationDefinition> = [
	{
		name: 'entry_pay_component',
		source: 'component_entries',
		target: 'pay_components',
		cardinality: 'one',
		from: { collection: 'component_entries', column: 'pay_component_id' },
		to: { collection: 'pay_components', column: 'id' }
	},
	{
		// Declared with the endpoints in the opposite order, which authors do and the resolver must
		// tolerate — orientation is read against the collection being queried, never assumed.
		name: 'component_entries',
		source: 'pay_components',
		target: 'component_entries',
		cardinality: 'many',
		from: { collection: 'component_entries', column: 'pay_component_id' },
		to: { collection: 'pay_components', column: 'id' }
	},
	{
		name: 'component_payslip_line',
		source: 'pay_components',
		target: 'payslip_lines',
		cardinality: 'one',
		from: { collection: 'pay_components', column: 'payslip_line_id' },
		to: { collection: 'payslip_lines', column: 'id' }
	},
	{
		name: 'endpointless',
		source: 'component_entries',
		target: 'pay_components',
		cardinality: 'one'
	}
];

const definition = { relations } as unknown as WorkspaceDefinition;
const referenceDefinition = {
	...definition,
	collections: [
		{
			name: 'payslip_sources',
			fields: {
				source: {
					type: 'reference',
					required: true,
					indexed: true,
					unique: true,
					reference: {
						onDelete: 'restrict',
						targets: [
							{
								tag: 'TIME_ENTRY',
								collection: 'time_entries',
								storageColumn: 'source__time_entry_id'
							},
							{
								tag: 'LEAVE_REQUEST',
								collection: 'leave_requests',
								storageColumn: 'source__leave_request_id'
							}
						]
					}
				}
			}
		}
	]
} as unknown as WorkspaceDefinition;

const tables: Readonly<Record<string, ReadonlyArray<Record<string, Schema.Json>>>> = {
	pay_components: [
		{
			id: 'pc-1',
			code: 'LOAN',
			name: 'Loan recovery',
			secret: 'hidden',
			payslip_line_id: 'pl-1'
		},
		{ id: 'pc-2', code: 'CLAIM', name: 'Claim', secret: 'hidden', payslip_line_id: null }
	],
	payslip_lines: [{ id: 'pl-1', period: '2026-06' }],
	component_entries: [
		{ id: 'ce-1', pay_component_id: 'pc-1' },
		{ id: 'ce-2', pay_component_id: 'pc-1' }
	],
	time_entries: [{ id: 'te-1', work_date: '2026-08-01' }],
	leave_requests: [{ id: 'lr-1', from_date: '2026-08-02' }]
};

/** Stands in for the caller's authorized read, recording every batch it is asked for. */
const reader = (visible: (collection: string) => boolean = () => true) => {
	const calls: Array<{ collection: string; column: string; values: ReadonlyArray<Schema.Json> }> =
		[];
	const read = (collection: string, column: string, values: ReadonlyArray<Schema.Json>) => {
		calls.push({ collection, column, values });
		if (!visible(collection)) return Effect.succeed([]);
		const rows = (tables[collection] ?? []).filter((row) => values.includes(row[column] ?? null));
		return Effect.succeed(rows);
	};
	return { calls, read };
};

const run = (
	collection: string,
	rows: ReadonlyArray<QueryRow>,
	spec: unknown,
	read: ReturnType<typeof reader>['read']
) => Effect.runSync(attachRelations(definition, collection, rows, spec, read));

describe('relation prefetch', () => {
	it('hydrates each polymorphic target under the same discriminated reference property', () => {
		const { read, calls } = reader();
		const result = Effect.runSync(
			attachRelations(
				referenceDefinition,
				'payslip_sources',
				[
					{ id: 'ps-1', source: { kind: 'TIME_ENTRY', id: 'te-1' } },
					{ id: 'ps-2', source: { kind: 'LEAVE_REQUEST', id: 'lr-1' } }
				],
				{ source: true },
				read
			)
		);
		expect(result).toMatchObject([
			{ source: { kind: 'TIME_ENTRY', id: 'te-1', record: { work_date: '2026-08-01' } } },
			{ source: { kind: 'LEAVE_REQUEST', id: 'lr-1', record: { from_date: '2026-08-02' } } }
		]);
		expect(calls.map(({ collection }) => collection).sort()).toEqual([
			'leave_requests',
			'time_entries'
		]);
	});

	it('projects each hydrated reference arm exactly as authored', () => {
		const { read } = reader();
		const [row] = Effect.runSync(
			attachRelations(
				referenceDefinition,
				'payslip_sources',
				[{ id: 'ps-1', source: { kind: 'TIME_ENTRY', id: 'te-1' } }],
				{ source: { TIME_ENTRY: { columns: { work_date: true } } } },
				read
			)
		);
		expect(row).toEqual({
			id: 'ps-1',
			source: {
				kind: 'TIME_ENTRY',
				id: 'te-1',
				record: { work_date: '2026-08-01' }
			}
		});
	});
	it('attaches a one-relation as the record itself', () => {
		const { read } = reader();
		const [row] = run(
			'component_entries',
			[{ id: 'ce-1', pay_component_id: 'pc-1' }],
			{ entry_pay_component: true },
			read
		);
		expect(row).toMatchObject({ entry_pay_component: { code: 'LOAN', name: 'Loan recovery' } });
	});

	it('attaches a many-relation as an array, and an empty one as an empty array', () => {
		const { read } = reader();
		const rows = run(
			'pay_components',
			[{ id: 'pc-1' }, { id: 'pc-2' }],
			{ component_entries: true },
			read
		);
		expect(rows[0]).toMatchObject({
			component_entries: [{ id: 'ce-1' }, { id: 'ce-2' }]
		});
		expect(rows[1]).toMatchObject({ component_entries: [] });
	});

	it('reports an unmatched one-relation as null, not an empty record', () => {
		const { read } = reader();
		const [row] = run(
			'component_entries',
			[{ id: 'ce-9', pay_component_id: 'missing' }],
			{ entry_pay_component: true },
			read
		);
		// `{}` would read as a record that exists and has lost its fields; a surface tests for absence.
		expect(row).toMatchObject({ entry_pay_component: null });
	});

	it('reads one batch per relation rather than one per row', () => {
		const { calls, read } = reader();
		run(
			'component_entries',
			[
				{ id: 'ce-1', pay_component_id: 'pc-1' },
				{ id: 'ce-2', pay_component_id: 'pc-1' },
				{ id: 'ce-3', pay_component_id: 'pc-2' }
			],
			{ entry_pay_component: true },
			read
		);
		expect(calls).toHaveLength(1);
		// Deduplicated: three rows, two distinct keys.
		expect(calls[0]).toMatchObject({
			collection: 'pay_components',
			column: 'id',
			values: ['pc-1', 'pc-2']
		});
	});

	it('narrows to exactly the requested columns', () => {
		const { read } = reader();
		const [row] = run(
			'component_entries',
			[{ id: 'ce-1', pay_component_id: 'pc-1' }],
			{ entry_pay_component: { columns: { code: true, name: true } } },
			read
		);
		const related = (row as Record<string, Record<string, unknown>>)['entry_pay_component'];
		expect(Object.keys(related ?? {}).sort()).toEqual(['code', 'name']);
		expect(related?.['secret']).toBeUndefined();
	});

	it('supports exclusion projections without turning them into select-all', () => {
		const { read } = reader();
		const [row] = run(
			'component_entries',
			[{ id: 'ce-1', pay_component_id: 'pc-1' }],
			{ entry_pay_component: { columns: { secret: false } } },
			read
		);
		const related = (row as Record<string, Record<string, unknown>>)['entry_pay_component'];
		expect(related).toMatchObject({ id: 'pc-1', code: 'LOAN', name: 'Loan recovery' });
		expect(related?.['secret']).toBeUndefined();
	});

	it('recurses into a nested with', () => {
		const { read } = reader();
		const [row] = run(
			'component_entries',
			[{ id: 'ce-1', pay_component_id: 'pc-1' }],
			{ entry_pay_component: { with: { component_payslip_line: { columns: { period: true } } } } },
			read
		);
		expect(row).toMatchObject({
			entry_pay_component: { component_payslip_line: { period: '2026-06' } }
		});
	});

	// The security property: prefetch has no SQL of its own, so a related record a subject cannot
	// read simply does not come back. `with` can never widen what a subject can see.
	it("attaches nothing the caller's own read refuses to return", () => {
		const { read } = reader((collection) => collection !== 'pay_components');
		const [row] = run(
			'component_entries',
			[{ id: 'ce-1', pay_component_id: 'pc-1' }],
			{ entry_pay_component: true },
			read
		);
		expect(row).toMatchObject({ entry_pay_component: null });
	});

	it('leaves a relation it cannot resolve off the row rather than guessing', () => {
		const { calls, read } = reader();
		const [row] = run(
			'component_entries',
			[{ id: 'ce-1', pay_component_id: 'pc-1' }],
			{ unknown_relation: true, endpointless: true },
			read
		);
		expect(row).not.toHaveProperty('unknown_relation');
		expect(row).not.toHaveProperty('endpointless');
		expect(calls).toHaveLength(0);
	});

	it('reads a spec into the relations it names, ignoring ones switched off', () => {
		expect(requestedRelations({ a: true, b: { columns: {} }, c: false, d: undefined })).toEqual([
			'a',
			'b'
		]);
		expect(requestedRelations(undefined)).toEqual([]);
	});

	it('returns the rows untouched when nothing is requested', () => {
		const { calls, read } = reader();
		const rows = [{ id: 'ce-1', pay_component_id: 'pc-1' }];
		expect(run('component_entries', rows, undefined, read)).toEqual(rows);
		expect(calls).toHaveLength(0);
	});
});
