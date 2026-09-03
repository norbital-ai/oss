import { describe, expect, it } from 'vitest';
import { approvalRefusal } from '../src/authoring/approval-validation.js';
import { grantScopeProblems } from '../src/runtime/access/access-control.js';
import type { WorkspaceDefinition } from '../src/authoring/workspace-schema.js';

/**
 * A grant's row scope has to name a column its collection actually has.
 *
 * It always had to, and until a `with` clause became one statement the database said so for free:
 * a compiled scope is a bare `"column" = $1`, the collection was its own `from` clause, and an
 * unknown name raised "column does not exist" the moment the query ran. A relational read puts the
 * related collection inside a lateral join where the parent row is also in scope, and PostgreSQL
 * resolves an unqualified name innermost first — so an unknown name stops failing and starts
 * binding *outward*, filtering the parent row instead of the related one. A grant quietly
 * evaluating against the wrong record is the one failure a policy must not have, so the loud
 * failure is restored at the release boundary instead.
 */

const workspace = (grants: ReadonlyArray<Readonly<Record<string, unknown>>>): WorkspaceDefinition =>
	({
		collections: [
			{
				name: 'time_entries',
				fields: {
					work_date: { type: 'date', required: false },
					source: {
						type: 'reference',
						required: true,
						reference: {
							onDelete: 'restrict',
							targets: [
								{
									tag: 'EMPLOYMENT',
									collection: 'employments',
									storageColumn: 'source__employment_id'
								}
							]
						}
					}
				}
			},
			{ name: 'employments', fields: { code: { type: 'string', required: false } } }
		],
		policies: [{ name: 'employee', grants }],
		teams: {},
		envoys: [],
		automations: [],
		integrations: []
	}) as unknown as WorkspaceDefinition;

describe('an authored grant’s row scope', () => {
	it('refuses a column the collection does not have, naming the policy and the column', () => {
		const problems = grantScopeProblems(
			workspace([{ collection: 'time_entries', action: 'read', where: { employee_id: 'x' } }])
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatchObject({
			policy: 'employee',
			collection: 'time_entries',
			action: 'read',
			column: 'policy.employee.time_entries.read.employee_id'
		});
	});

	it('refuses the release rather than only reporting it', () => {
		const refusal = approvalRefusal(
			workspace([{ collection: 'time_entries', action: 'read', where: { employee_id: 'x' } }])
		);
		expect(refusal).toContain('employee_id');
		expect(refusal).toContain('time_entries');
	});

	it('accepts declared fields, system columns, and a structured logical reference', () => {
		expect(
			grantScopeProblems(
				workspace([
					{
						collection: 'time_entries',
						action: 'read',
						where: { work_date: { gte: '2026-01-01' } }
					},
					{ collection: 'time_entries', action: 'update', where: { id: { in: ['a'] } } },
					{
						collection: 'time_entries',
						action: 'delete',
						where: { source: { kind: { eq: 'EMPLOYMENT' } } }
					}
				])
			)
		).toEqual([]);
	});

	it('refuses generated reference storage columns at the authored policy boundary', () => {
		const problems = grantScopeProblems(
			workspace([
				{ collection: 'time_entries', action: 'read', where: { source__employment_id: 'e1' } }
			])
		);
		expect(problems.map(({ column }) => column)).toEqual([
			'policy.employee.time_entries.read.source__employment_id'
		]);
	});

	it('reads through AND, OR and NOT to the columns underneath them', () => {
		const problems = grantScopeProblems(
			workspace([
				{
					collection: 'time_entries',
					action: 'read',
					where: {
						AND: [
							{ work_date: { gte: 'x' } },
							{ OR: [{ id: 'a' }, { NOT: { missing_column: 'b' } }] }
						]
					}
				}
			])
		);
		expect(problems.map(({ column }) => column)).toEqual([
			'policy.employee.time_entries.read.AND[1].OR[1].NOT.missing_column'
		]);
	});

	it('rejects every serialized SQL token key and structured unknown fields', () => {
		const problems = grantScopeProblems(
			workspace([
				{
					collection: 'time_entries',
					action: 'read',
					where: { kind: 'policy-sql', statement: '"id" is not null' }
				},
				{
					collection: 'time_entries',
					action: 'read',
					where: { statement: '"id" is not null', kind: 'policy-sql' }
				},
				{
					collection: 'time_entries',
					action: 'read',
					where: { nonexistent: 1 }
				}
			])
		);
		expect(problems.map(({ column }) => column)).toEqual([
			'policy.employee.time_entries.read.kind',
			'policy.employee.time_entries.read.statement',
			'policy.employee.time_entries.read.nonexistent'
		]);
	});

	it('fails closed for a grant on a collection this workspace does not declare', () => {
		const problems = grantScopeProblems(
			workspace([{ collection: 'invented', action: 'read', where: { anything: 1 } }])
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatchObject({
			policy: 'employee',
			collection: 'invented',
			action: 'read',
			column: 'policy.employee.invented.read'
		});
	});

	it('accepts a grant with no row scope at all', () => {
		expect(grantScopeProblems(workspace([{ collection: 'time_entries', action: 'read' }]))).toEqual(
			[]
		);
	});
});
