import { describe, expect, it, vi } from 'vitest';
import { reconcileDeclaredPolicies } from '../../src/server/bootstrap/policy_reconcile.server.js';

/**
 * An approval names its approvers by `team.name`; the stored grant holds `team.norbital_id`.
 *
 * The resolution between them is the only thing standing between a declaration and a permission
 * change nobody reviewed, so all three outcomes are driven here: bound, refused, and deferred. The
 * one that matters most is the refusal — a name that resolves to nothing must never be allowed to
 * land as `approval_config: null`, because the guard reads that as a direct write.
 */

type Row = Record<string, unknown>;

function clientWith(teams: readonly { id: string; name: string }[]) {
	const stored: Row[] = [];
	return {
		stored,
		query: async (text: string, values: readonly unknown[]) => {
			if (text.includes('FROM team')) {
				return { rows: teams.map((team) => ({ id: team.id, name: team.name })) };
			}
			stored.push(JSON.parse(String(values[4])));
			return { rows: [{ inserted: true }] };
		}
	};
}

function manifestWith(approval: unknown, action = 'create') {
	return {
		policies: {
			field_agent: {
				key: 'field_agent',
				name: 'Field agent',
				description: 'Lets a field agent raise quotes for review.',
				grants: [{ collection: 'quotes', action, approval }]
			}
		}
	} as never;
}

const oneStep = {
	id: 'config-1',
	name: 'Variation approval',
	steps: [{ id: 'step-1', name: 'Controller review', approvers: ['Field Operations Controllers'] }]
};

describe('an approval names its approvers by team name', () => {
	it('stores the id of the team holding that name', async () => {
		const client = clientWith([{ id: 'team-uuid-1', name: 'Field Operations Controllers' }]);
		const result = await reconcileDeclaredPolicies(client, manifestWith(oneStep));

		expect(result.unresolvedApproverTeams).toEqual([]);
		expect(client.stored[0]?.[0]).toMatchObject({
			approval_config: {
				norbital_id: 'config-1',
				approval_name: 'Variation approval',
				approval_step_nodes: [
					{ id: 'step-1', teams_that_can_approve: ['team-uuid-1'], nextSteps: [] }
				]
			}
		});
	});

	it('resolves a nested step, not only the first', async () => {
		const client = clientWith([
			{ id: 'first-uuid', name: 'L1 Manager' },
			{ id: 'second-uuid', name: 'HR Manager' }
		]);
		await reconcileDeclaredPolicies(
			client,
			manifestWith({
				id: 'config-1',
				name: 'Two stage',
				supercededBy: ['HR Manager'],
				steps: [
					{
						id: 'step-1',
						name: 'Line manager',
						approvers: ['L1 Manager'],
						steps: [{ id: 'step-2', name: 'HR', approvers: ['HR Manager'] }]
					}
				]
			})
		);

		const config = (client.stored[0]?.[0] as Row).approval_config as Row;
		expect(config.supercede_teams).toEqual(['second-uuid']);
		const first = (config.approval_step_nodes as Row[])[0];
		expect(first?.teams_that_can_approve).toEqual(['first-uuid']);
		expect((first?.nextSteps as Row[])[0]?.teams_that_can_approve).toEqual(['second-uuid']);
	});

	it('refuses a name no team holds, naming the policy, the grant and the team', async () => {
		const client = clientWith([
			{ id: 'team-uuid-1', name: 'Field Operations Controllers Renamed' }
		]);
		await expect(reconcileDeclaredPolicies(client, manifestWith(oneStep))).rejects.toThrow(
			/policy "field_agent", create on "quotes" → team "Field Operations Controllers"/
		);
		expect(client.stored).toEqual([]);
	});

	it('refuses a name two teams share rather than picking one by row order', async () => {
		const client = clientWith([
			{ id: 'team-uuid-1', name: 'Field Operations Controllers' },
			{ id: 'team-uuid-2', name: 'Field Operations Controllers' }
		]);
		await expect(reconcileDeclaredPolicies(client, manifestWith(oneStep))).rejects.toThrow(
			/not unique.*team "Field Operations Controllers"/s
		);
	});

	it('defers on a tenant with no teams, keeping the gate and saying so', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const client = clientWith([]);
		const result = await reconcileDeclaredPolicies(client, manifestWith(oneStep));

		expect(result.unresolvedApproverTeams).toEqual([
			{
				policy: 'field_agent',
				collection: 'quotes',
				action: 'create',
				team: 'Field Operations Controllers'
			}
		]);
		expect(warn.mock.calls[0]?.[0]).toMatch(/team "Field Operations Controllers"/);
		warn.mockRestore();

		// The gate is still there. Losing it would turn a reviewed write into a direct one, which is
		// exactly the downgrade this mechanism exists to prevent; losing only the approvers blocks.
		const config = (client.stored[0]?.[0] as Row).approval_config as Row;
		expect(config.norbital_id).toBe('config-1');
		expect((config.approval_step_nodes as Row[])[0]?.teams_that_can_approve).toEqual([]);
	});

	it('refuses to gate a read instead of silently dropping the gate', async () => {
		const client = clientWith([{ id: 'team-uuid-1', name: 'Field Operations Controllers' }]);
		await expect(reconcileDeclaredPolicies(client, manifestWith(oneStep, 'read'))).rejects.toThrow(
			/gates a read on "quotes"/
		);
	});
});
