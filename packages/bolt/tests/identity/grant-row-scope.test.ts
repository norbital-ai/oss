import { describe, expect, it } from 'vitest';
import { policySql } from '../../src/authoring/policy-sql.js';
import { approvalRefusal } from '../../src/compiler/approval-checks.js';
import { grantScopeProblems } from '../../src/runtime/access/access-control.js';
import type { WorkspaceDefinition } from '../../src/authoring/workspace-schema.js';

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
			column: 'employee_id'
		});
	});

	it('refuses the release rather than only reporting it', () => {
		const refusal = approvalRefusal(
			workspace([{ collection: 'time_entries', action: 'read', where: { employee_id: 'x' } }])
		);
		expect(refusal).toContain('employee_id');
		expect(refusal).toContain('time_entries');
	});

	it('accepts a declared column, a system column, and a reference’s storage column', () => {
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
						where: { source__employment_id: 'e1' }
					}
				])
			)
		).toEqual([]);
	});

	/**
	 * A polymorphic reference has no single persisted column, so naming the *field* would compile to
	 * an identifier the table does not carry — precisely the case that used to fail loudly.
	 */
	it('refuses a polymorphic reference named by its field instead of its storage column', () => {
		const problems = grantScopeProblems(
			workspace([{ collection: 'time_entries', action: 'read', where: { source: 'e1' } }])
		);
		expect(problems.map(({ column }) => column)).toEqual(['source']);
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
		expect(problems.map(({ column }) => column)).toEqual(['missing_column']);
	});

	/**
	 * A `policySql` predicate brings its own tables and aliases — `"team" t`, `me."id"` — so nothing here
	 * can tell one of its identifiers from a column of the collection. Checking it would refuse
	 * correct policies; qualifying it would rewrite SQL the author wrote. It is the author's, and
	 * the check says so by leaving it alone.
	 */
	it('leaves a policySql predicate alone, and still checks structured predicates', () => {
		const problems = grantScopeProblems(
			workspace([
				{
					collection: 'time_entries',
					action: 'read',
					where: policySql(
						'"id" in (select u."id" from "user" u where u."team_id" = ${requestor.id})'
					)
				},
				{
					collection: 'time_entries',
					action: 'read',
					where: { nonexistent: 1 }
				}
			])
		);
		expect(problems.map(({ column }) => column)).toEqual(['nonexistent']);
	});

	it('says nothing about a grant on a collection this workspace does not declare', () => {
		expect(
			grantScopeProblems(
				workspace([{ collection: 'invented', action: 'read', where: { anything: 1 } }])
			)
		).toEqual([]);
	});

	it('accepts a grant with no row scope at all', () => {
		expect(grantScopeProblems(workspace([{ collection: 'time_entries', action: 'read' }]))).toEqual(
			[]
		);
	});
});
