import { describe, expect, it } from 'vitest';
import { approvalDiagnostics, approvalRefusal } from '../../src/compiler/approval-checks.js';
import type { WorkspaceDefinition } from '../../src/authoring/workspace-schema.js';

const policy = (
	name: string,
	grants: ReadonlyArray<
		Readonly<{ collection: string; action: 'read' | 'create' | 'update' | 'delete' }>
	>
) => ({ name, grants }) as WorkspaceDefinition['policies'][number];

const workspace = (
	policies: WorkspaceDefinition['policies'],
	teams: WorkspaceDefinition['teams'],
	overrides: Partial<WorkspaceDefinition> = {}
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
		apps: [],
		...overrides
	}) as WorkspaceDefinition;

const rules = (definition: WorkspaceDefinition): ReadonlyArray<string> =>
	approvalDiagnostics(definition).map(({ rule }) => rule);

describe('authority bindings', () => {
	it('accepts disjoint coordinates composed by one holder', () => {
		const definition = workspace(
			[
				policy('reader', [{ collection: 'jobs', action: 'read' }]),
				policy('writer', [{ collection: 'jobs', action: 'update' }])
			],
			{ Operators: ['reader', 'writer'] }
		);
		expect(approvalDiagnostics(definition)).toEqual([]);
		expect(approvalRefusal(definition)).toBeUndefined();
	});

	it('refuses a holder naming an undeclared policy', () => {
		const definition = workspace([policy('reader', [])], {
			Operators: ['reader', 'renamed_policy']
		});
		expect(rules(definition)).toEqual(['undeclared-team-policy']);
		expect(approvalDiagnostics(definition)[0]?.message).toContain('silently holds less');
	});

	it('matches policy names case-insensitively', () => {
		const definition = workspace([policy('Job_Reader', [])], { Operators: ['job_reader'] });
		expect(approvalDiagnostics(definition)).toEqual([]);
	});

	it('refuses any duplicate coordinate even when both grants are narrowed', () => {
		const definition = workspace(
			[
				policy('own_jobs', [{ collection: 'jobs', action: 'read' }]),
				policy('regional_jobs', [{ collection: 'jobs', action: 'read' }])
			],
			{ Operators: ['own_jobs', 'regional_jobs'] }
		);
		expect(rules(definition)).toEqual(['overlapping-policy-grant']);
		const message = approvalDiagnostics(definition)[0]?.message;
		expect(message).toContain('team "Operators" composes policies');
		expect(message).toContain('read on jobs');
		expect(message).toContain('exactly one owner per holder');
	});

	it('accepts alternative holders with different grants for the same coordinate', () => {
		const definition = workspace(
			[
				policy('own_jobs', [{ collection: 'jobs', action: 'read' }]),
				policy('regional_jobs', [{ collection: 'jobs', action: 'read' }])
			],
			{ Operators: ['own_jobs'], Managers: ['regional_jobs'] }
		);
		expect(approvalDiagnostics(definition)).toEqual([]);
		expect(approvalRefusal(definition)).toBeUndefined();
	});

	it('checks authored policies against runtime-owned policies after merge', () => {
		const definition = workspace(
			[policy('approval_reader', [{ collection: 'approval_request', action: 'read' }])],
			{ Operators: ['approval_reader'] }
		);
		expect(rules(definition)).toContain('overlapping-policy-grant');
		expect(approvalDiagnostics(definition)[0]?.message).toContain(
			'team "Operators" composes policies "approval_reader", "bolt.system-collections"'
		);
	});

	it('refuses duplicate coordinates in an envoy composition', () => {
		const policies = [
			policy('reader_a', [{ collection: 'jobs', action: 'read' }]),
			policy('reader_b', [{ collection: 'jobs', action: 'read' }])
		];
		const definition = workspace(
			policies,
			{},
			{
				envoys: [{ name: 'desk', policies: ['reader_a', 'reader_b'] }] as never
			}
		);
		expect(rules(definition)).toEqual(['overlapping-policy-grant']);
		expect(approvalDiagnostics(definition)[0]?.message).toContain('envoy "desk" composes policies');
	});

	it('refuses duplicate coordinates in an automation composition', () => {
		const policies = [
			policy('reader_a', [{ collection: 'jobs', action: 'read' }]),
			policy('reader_b', [{ collection: 'jobs', action: 'read' }])
		];
		const definition = workspace(
			policies,
			{},
			{
				automations: [{ name: 'review', policies: ['reader_a', 'reader_b'] }] as never
			}
		);
		expect(rules(definition)).toEqual(['overlapping-policy-grant']);
		expect(approvalDiagnostics(definition)[0]?.message).toContain(
			'automation "review" composes policies'
		);
	});

	it('refuses an undeclared policy named by an integration', () => {
		const definition = workspace(
			[policy('reader', [])],
			{},
			{
				integrations: [
					{
						name: 'jobs.dispatch',
						collection: 'jobs',
						policies: ['missing'],
						receive: [],
						webhooks: [],
						send: []
					}
				] as never
			}
		);
		expect(rules(definition)).toEqual(['undeclared-team-policy']);
		expect(approvalDiagnostics(definition)[0]?.message).toContain(
			'integration "jobs.dispatch" names the policy "missing"'
		);
	});

	it('refuses a malformed runtime declaration that repeats one coordinate inside a policy', () => {
		const duplicate = policy('reader', [
			{ collection: 'jobs', action: 'read' },
			{ collection: 'jobs', action: 'read' }
		]);
		const definition = workspace([duplicate], { Operators: ['reader'] });
		expect(rules(definition)).toEqual(['overlapping-policy-grant']);
		expect(approvalDiagnostics(definition)[0]?.message).toContain(
			'team "Operators" composes policy "reader" declares it more than once'
		);
	});

	it('reports all unresolved bindings in one refusal', () => {
		const definition = workspace(
			[
				policy('a', [{ collection: 'jobs', action: 'read' }]),
				policy('b', [{ collection: 'jobs', action: 'read' }])
			],
			{ Operators: ['a', 'b', 'missing'] }
		);
		expect(rules(definition)).toEqual(['undeclared-team-policy', 'overlapping-policy-grant']);
		expect(approvalRefusal(definition)).toContain('2 authority bindings');
	});
});

/**
 * A gate that cannot roll back is refused where it is written, not discovered on a rejection.
 *
 * Rejecting an update restores the version from before the request. A collection declaring
 * `history: false` keeps no such version, so the only honest reversal left is deleting the record -
 * destroying data whose only offence was being edited by somebody without authority.
 */
describe('approval gates without their durable review ledger', () => {
	const gated = (collection: string, action: 'create' | 'update' | 'delete') =>
		({
			name: 'payroll',
			grants: [{ collection, action, approval: { flow: () => undefined, superceded_by: [] } }]
		}) as unknown as WorkspaceDefinition['policies'][number];

	const withCollections = (
		policies: WorkspaceDefinition['policies'],
		collections: WorkspaceDefinition['collections']
	) => workspace(policies, {}, { collections });

	it('refuses a gated update on a collection that keeps no history', () => {
		const diagnostics = approvalDiagnostics(
			withCollections([gated('audit_notes', 'update')], [
				{ name: 'audit_notes', fields: {}, history: false }
			] as WorkspaceDefinition['collections'])
		);
		expect(diagnostics.map(({ rule }) => rule)).toContain('approval-without-history');
		expect(
			approvalRefusal(
				withCollections([gated('audit_notes', 'update')], [
					{ name: 'audit_notes', fields: {}, history: false }
				] as WorkspaceDefinition['collections'])
			)
		).toContain('history: false');
	});

	it('refuses a gated create because review membership is stored in history', () => {
		const diagnostics = approvalDiagnostics(
			withCollections([gated('audit_notes', 'create')], [
				{ name: 'audit_notes', fields: {}, history: false }
			] as WorkspaceDefinition['collections'])
		);
		expect(diagnostics.map(({ rule }) => rule)).toContain('approval-without-history');
	});

	it('refuses a gated delete because reviewers need its durable masked snapshot', () => {
		const diagnostics = approvalDiagnostics(
			withCollections([gated('audit_notes', 'delete')], [
				{ name: 'audit_notes', fields: {}, history: false }
			] as WorkspaceDefinition['collections'])
		);
		expect(diagnostics.map(({ rule }) => rule)).toContain('approval-without-history');
	});

	it('allows a gated update where the collection keeps history', () => {
		const diagnostics = approvalDiagnostics(
			withCollections([gated('payroll_runs', 'update')], [
				{ name: 'payroll_runs', fields: {}, history: true }
			] as WorkspaceDefinition['collections'])
		);
		expect(diagnostics.map(({ rule }) => rule)).not.toContain('approval-without-history');
	});
});
