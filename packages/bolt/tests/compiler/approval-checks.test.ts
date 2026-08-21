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
		expect(approvalDiagnostics(definition)[0]?.message).toContain('silently holds less');
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

	/**
	 * An approver that `+teams.ts` does not declare, which used to be allowed and is not any more.
	 *
	 * The old rule read as obvious and was defensible: `reconcileApproverTeams` mints a `bolt_team`
	 * row for every approver name a release declares, and `Approvals.decide` matches on team *name*
	 * rather than on held policies — so a team holding nothing could still decide, and refusing it
	 * would have made the reconciler's purpose unreachable.
	 *
	 * `approvers` is `TeamName` now, generated from `+teams.ts`'s own keys, so a misspelling is a
	 * compile error instead of an approval nobody can ever decide. The shape that rule protected is
	 * still expressible and is now *visible*: declare the team holding nothing.
	 */
	it('refuses an approver team +teams.ts never declares', () => {
		const definition = workspace([guarded(['Payroll Approvers'])], {
			'Payroll Officer': ['field_ops_contractor']
		});
		expect(rules(definition)).toEqual(['unresolvable-approver']);
		expect(approvalDiagnostics(definition)[0]?.message).toContain('": []');
	});

	it('accepts a review-only approver team, declared as holding nothing', () => {
		const definition = workspace([guarded(['Payroll Approvers'])], {
			'Payroll Approvers': [],
			Contractor: ['field_ops_contractor']
		});
		expect(approvalDiagnostics(definition)).toEqual([]);
	});

	/**
	 * **The check that makes an array of policies safe**, and the reason envoys and automations may
	 * name arrays at all.
	 *
	 * `rowPredicate` unions the `where` of every matching grant, so an unconditional grant beside a
	 * narrowed one on the same `(collection, action)` collapses the predicate to `true`. The holder
	 * does not get "their own rows plus dispatch" — they get everything, with nothing to say so.
	 * `Contractor (Controller)` in field-operations was exactly that shape, with two seeded people in
	 * it.
	 */
	it('refuses a team whose two policies widen a narrowed grant', () => {
		const narrowed = {
			name: 'contractor',
			grants: [
				{
					collection: 'variation_requests',
					action: 'update',
					where: { assignee_user_id: { eq: '${requestor.norbital_id}' } }
				}
			]
		} as unknown as WorkspaceDefinition['policies'][number];
		const unconditional = {
			name: 'controller',
			grants: [{ collection: 'variation_requests', action: 'update' }]
		} as unknown as WorkspaceDefinition['policies'][number];
		const definition = workspace([narrowed, unconditional], {
			'Contractor (Controller)': ['contractor', 'controller']
		});
		expect(rules(definition)).toEqual(['composition-widens-grant']);
		const [diagnostic] = approvalDiagnostics(definition);
		expect(diagnostic?.message).toContain('"contractor"');
		expect(diagnostic?.message).toContain('"controller"');
		expect(diagnostic?.message).toContain('update on variation_requests');
	});

	/** Holding the two separately is fine — it is the *union* that widens, not either policy. */
	it('accepts the same two policies held by two different teams', () => {
		const narrowed = {
			name: 'contractor',
			grants: [
				{
					collection: 'variation_requests',
					action: 'update',
					where: { assignee_user_id: { eq: '${requestor.norbital_id}' } }
				}
			]
		} as unknown as WorkspaceDefinition['policies'][number];
		const unconditional = {
			name: 'controller',
			grants: [{ collection: 'variation_requests', action: 'update' }]
		} as unknown as WorkspaceDefinition['policies'][number];
		expect(
			approvalDiagnostics(
				workspace([narrowed, unconditional], {
					Contractor: ['contractor'],
					Controllers: ['controller']
				})
			)
		).toEqual([]);
	});

	/**
	 * An envoy is a holder too, and the one where this matters most.
	 *
	 * Without the check running over envoys, shipping arrays would take the hazard from teams — where
	 * the widened holder is an employee — to a public surface, where it is a stranger with a phone.
	 */
	it('refuses an envoy whose two policies widen a narrowed grant', () => {
		const narrowed = {
			name: 'contractor',
			grants: [
				{
					collection: 'jobs',
					action: 'read',
					where: { assignee_user_id: { eq: '${requestor.norbital_id}' } }
				}
			]
		} as unknown as WorkspaceDefinition['policies'][number];
		const unconditional = {
			name: 'controller',
			grants: [{ collection: 'jobs', action: 'read' }]
		} as unknown as WorkspaceDefinition['policies'][number];
		const definition = {
			name: 'test',
			version: '0',
			collections: [],
			relations: [],
			policies: [narrowed, unconditional],
			teams: {},
			automations: [],
			envoys: [{ name: 'sales_desk', policies: ['contractor', 'controller'] }],
			apps: []
		} as unknown as WorkspaceDefinition;
		expect(rules(definition)).toEqual(['composition-widens-grant']);
		expect(approvalDiagnostics(definition)[0]?.message).toContain('envoy "sales_desk"');
	});

	/** One policy carrying both is the author's own composition, and it is refused by name. */
	it('refuses one policy that grants the same thing twice, narrowed and not', () => {
		const both = {
			name: 'contractor',
			grants: [
				{
					collection: 'jobs',
					action: 'read',
					where: { assignee_user_id: { eq: '${requestor.norbital_id}' } }
				},
				{ collection: 'jobs', action: 'read' }
			]
		} as unknown as WorkspaceDefinition['policies'][number];
		const other = { name: 'controller', grants: [] } as unknown as
			WorkspaceDefinition['policies'][number];
		const definition = workspace([both, other], { Contractor: ['contractor', 'controller'] });
		expect(rules(definition)).toEqual(['composition-widens-grant']);
		expect(approvalDiagnostics(definition)[0]?.message).toContain('Policy "contractor"');
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
		// Four bindings, four lines, one build.
		expect(approvalRefusal(definition)).toContain('4 authority bindings');
	});
});
