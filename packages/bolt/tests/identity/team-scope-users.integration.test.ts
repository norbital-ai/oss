import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EffectId,
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import {
	fixtureTeamId,
	fixtureUserId,
	seedSession,
	seedTeam
} from '../support/fixture-identity.js';

/**
 * "A salesperson sees their own; their manager sees everyone under them", written once.
 *
 * The whole point of `${requestor.team_scope_users}` is that the *same* grant answers differently at
 * each level, so an organisation does not author one policy per rank. That property is only visible
 * with three subjects against one rule — a suite that checked a single level would pass just as well
 * against a predicate matching only the subject's own team, and would prove nothing about the walk.
 *
 * It also exists because `team` descent alone does not produce this. Descent hands a manager
 * every *policy* their reports hold, but a grant scoped `${requestor.id}` re-evaluates
 * against whoever is asking — so inheriting a self-scoped policy shows the manager their own records
 * and nobody else's. The hierarchy has to be in the predicate, which is what this token puts there.
 *
 * Run against real Postgres, because what is under test is a recursive CTE.
 */
let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make('development'),
	releaseId: ReleaseId.make('local')
};

const command = (name: string, credential: string, input: unknown = null) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${name}-${credential}-${JSON.stringify(input)}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		headers: { authorization: [`Bearer ${credential}`] }
	});

/** One rule, held identically by all three ranks. The subtree is the whole of the difference. */
const scopedWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [
		collection({
			name: 'deals',
			fields: { label: field.string({ required: true }), owner_id: field.string() }
		})
	],
	apps: [app({ name: 'sales', label: 'Sales' })],
	policies: [
		policy({
			name: 'own_or_below',
			effect: 'allow',
			capabilities: { apps: ['sales'] },
			grants: [
				{
					collection: 'deals',
					action: 'read',
					where: { $sql: '"owner_id"::text IN ${requestor.team_scope_users}' }
				}
			]
		})
	],
	teams: {
		Director: ['own_or_below'],
		Manager: ['own_or_below'],
		Salesperson: ['own_or_below'],
		Support: ['own_or_below']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: [],
	relations: []
});

/** Director → Manager → Salesperson, one person in each, each owning one deal. */
const place = async (runtime: BoltTestRuntime) => {
	await seedTeam(runtime, 'Director');
	await seedTeam(runtime, 'Manager', { parent: 'Director' });
	await seedTeam(runtime, 'Salesperson', { parent: 'Manager' });
	for (const [person, team] of [
		['director', 'Director'],
		['manager', 'Manager'],
		['seller', 'Salesperson']
	] as const) {
		await seedSession(runtime, { token: `${person}-token`, user: person, team });
		await runtime.database.query(
			`insert into deals ("id", "label", "owner_id") values (gen_random_uuid(), $1, $2)`,
			[`${person}'s deal`, fixtureUserId(person)]
		);
	}
	// Referenced so a rename of the helper cannot leave the hierarchy silently unbuilt.
	void fixtureTeamId;
};

const dealsVisibleTo = async (runtime: BoltTestRuntime, credential: string) => {
	const outcome = await runtime.runtime.runPromise(
		dispatchInvocation(
			command('collections.findMany', credential, { collection: 'deals', limit: 50 })
		).pipe(Effect.result)
	);
	if (outcome._tag !== 'Success') throw new Error(`refused: ${JSON.stringify(outcome)}`);
	const rows = Reflect.get(outcome.success.value as object, 'rows');
	if (!Array.isArray(rows)) throw new Error('expected rows');
	return (rows as ReadonlyArray<Record<string, unknown>>).map((row) => row['label']).sort();
};

describe('team_scope_users', () => {
	it('answers one rule differently at each level of the hierarchy', async () => {
		harness = await makeBoltTestRuntime(scopedWorkspace);
		await place(harness);

		// A leaf reaches only its own team — there is nothing beneath it.
		expect(await dealsVisibleTo(harness, 'seller-token')).toEqual(["seller's deal"]);
		// Their manager reaches theirs and the seller's, from the identical grant.
		expect(await dealsVisibleTo(harness, 'manager-token')).toEqual([
			"manager's deal",
			"seller's deal"
		]);
		// And the director reaches the whole branch.
		expect(await dealsVisibleTo(harness, 'director-token')).toEqual([
			"director's deal",
			"manager's deal",
			"seller's deal"
		]);
	});

	it('does not leak sideways into a sibling branch', async () => {
		// The direction a subtree walk gets wrong. `Support` hangs off Director beside Manager, so a
		// walk that ascended even one level — or that matched on anything looser than descent — would
		// hand this person the seller's deal. Reaching only their own is what proves the walk goes one
		// way.
		harness = await makeBoltTestRuntime(scopedWorkspace);
		await place(harness);
		await seedTeam(harness, 'Support', { parent: 'Director' });
		await seedSession(harness, { token: 'support-token', user: 'support', team: 'Support' });
		await harness.database.query(
			`insert into deals ("id", "label", "owner_id") values (gen_random_uuid(), $1, $2)`,
			["support's deal", fixtureUserId('support')]
		);
		expect(await dealsVisibleTo(harness, 'support-token')).toEqual(["support's deal"]);
	});
});
