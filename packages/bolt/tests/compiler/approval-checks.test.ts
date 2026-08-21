import { describe, expect, it } from 'vitest';
import { approvalDiagnostics, approvalRefusal } from '../../src/compiler/approval-checks.js';
import type { WorkspaceDefinition } from '../../src/authoring/workspace-schema.js';

/**
 * The three name bindings an approval depends on, and what happens when one does not resolve.
 *
 * Each rule guards a failure that is *silent* rather than loud: an approval routed to a team nobody
 * holds waits forever, and "waiting" is a legitimate state that looks identical from every surface.
 * So each case below asserts on the rule that fired, and at least one asserts the message says what
 * to do — a diagnostic naming a problem it does not explain is how the `console.warn` this replaces
 * came to be ignored for as long as it was.
 */
const workspace = (
	policies: WorkspaceDefinition['policies'],
	teams: WorkspaceDefinition['teams']
): WorkspaceDefinition =>
	({
		name: 'test',
		version: '0',
		collections: [],
		relations: [],
		policies,
		teams,
		automations: [],
		envoys: [],
		apps: []
	}) as unknown as WorkspaceDefinition;

const guarded = (approvers: ReadonlyArray<string>, name = 'field_ops_contractor') =>
	({
		name,
		grants: [
			{
				collection: 'variation_requests',
				action: 'update',
				approval: { steps: [{ approvers }] }
			}
		]
	}) as unknown as WorkspaceDefinition['policies'][number];

const rules = (definition: WorkspaceDefinition): ReadonlyArray<string> =>
	approvalDiagnostics(definition).map(({ rule }) => rule);

describe('approval bindings', () => {
	it('accepts a release whose every name resolves', () => {
		const definition = workspace(
			[guarded(['Field Operations Controllers']), { name: 'field_ops_controller' } as never],
			{
				'Field Operations Controllers': ['field_ops_controller'],
				Contractor: ['field_ops_contractor']
			}
		);
		expect(approvalDiagnostics(definition)).toEqual([]);
		expect(approvalRefusal(definition)).toBeUndefined();
	});

	it('refuses a step that names no approvers, which no spelling check would catch', () => {
		// There is no typo here and no team to create: `decide` evaluates `some(...)` to false for
		// every subject alive, so the record stays locked for the life of the release.
		const definition = workspace([guarded([])], { Contractor: [] });
		expect(rules(definition)).toEqual(['empty-approvers']);
	});

	it('treats a whitespace-only approver as no approver at all', () => {
		expect(rules(workspace([guarded(['  '])], { Contractor: [] }))).toEqual(['empty-approvers']);
	});

	it('refuses a team holding a policy that no file declares', () => {
		const definition = workspace(
			[guarded(['Approvers']), { name: 'field_ops_controller' } as never],
			{ Approvers: ['field_ops_controller', 'a_policy_that_was_renamed'] }
		);
		expect(rules(definition)).toEqual(['undeclared-team-policy']);
		expect(approvalDiagnostics(definition)[0]?.message).toContain('silently hold less');
	});

	it('matches team and policy names case-insensitively, as every other comparison does', () => {
		// `bolt_team.name` resolves with `lower(name) = lower($1)` and `policiesHeldByTeam` folds both
		// sides, so a build that refused on case would refuse a release the runtime routes correctly.
		const definition = workspace(
			[guarded(['field operations CONTROLLERS']), { name: 'Field_Ops_Controller' } as never],
			{ 'Field Operations Controllers': ['field_ops_controller'] }
		);
		expect(approvalDiagnostics(definition)).toEqual([]);
	});

	it('allows an approver team +teams.ts never declares, because activation creates it', () => {
		// The rule that reads as obvious and is wrong. `reconcileApproverTeams` mints a `bolt_team` row
		// for every approver name a release declares, and `Approvals.decide` matches on team *name*,
		// never on held policies — so a team holding nothing can still decide. Refusing this would make
		// the reconciler's entire purpose unreachable, which its own tests demonstrate.
		const definition = workspace([guarded(['Payroll Approvers'])], {
			'Payroll Officer': ['field_ops_contractor']
		});
		expect(approvalDiagnostics(definition)).toEqual([]);
	});

	it('reports every unresolved binding at once rather than the first', () => {
		// A build that surfaced one name per run would take three builds to fix three typos.
		const definition = workspace([guarded([]), guarded([], 'second_policy')], {
			Other: ['not_a_policy', 'nor_this_one']
		});
		expect(rules(definition)).toEqual([
			'empty-approvers',
			'empty-approvers',
			'undeclared-team-policy',
			'undeclared-team-policy'
		]);
		expect(approvalRefusal(definition)).toContain('4 approval bindings');
	});
});
