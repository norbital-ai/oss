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
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as AccessControl from '../../src/runtime/access/access-control.js';
import * as Identity from '../../src/runtime/identity/identity.js';
import { ADMIN_STATUS } from '../../src/runtime/identity/identity.js';
import { DispatchError, dispatchInvocation } from '../../src/runtime/dispatch.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import { fixtureUserId, seedSession, seedTeam } from '../support/fixture-identity.js';

/**
 * The `teams.*` commands, driven through the boundary a browser actually reaches.
 *
 * Three claims are under test and they are deliberately different kinds of claim:
 *
 *   1. **Who may run them.** Administration is a status on the person, so the suite seeds one
 *      administrator and one ordinary member of a real team and asserts both directions. Every
 *      refusal case here has the admission case beside it — a refusal suite on its own is satisfied
 *      by a handler that refuses everybody, which is indistinguishable from one that crashes.
 *   2. **What they cannot do.** No `teams.*` command may change what a team *may do*: the policies a
 *      team holds are compiled into the release. So the payloads below carry hostile extra fields —
 *      a `status`, a `userId` — and the assertions read the columns back.
 *   3. **What they actually change.** Every refusal asserts the state as well as the failure, because
 *      a refusal that returned an error while still writing the row would pass a status-only check;
 *      and the assignment case reads the moved person back out of `authenticate`, because moving
 *      somebody between teams is only meaningful if the subject they sign in as moves too.
 *
 * The workspace declares one narrow policy on purpose. The default test workspace declares an
 * `admin` policy granting `*` on `*`, which *does* confer `manage` on `identity` — so a member of
 * that team would pass the gate and the refusal cases would be testing nothing. `Employee` grants
 * `read` on one app, which is what an ordinary member of a real workspace holds.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('local')
};

const peopleWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [collection({ name: 'people', fields: { name: field.string({ required: true }) } })],
	apps: [],
	policies: [
		policy({
			name: 'Employee',
			effect: 'allow',
			actions: ['read'],
			capabilities: { apps: ['people'] }
		})
	],
	teams: { Employee: ['Employee'] },
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	requiredFacilities: []
});

let sequence = 0;
const command = (name: string, credential: string, input: Record<string, unknown> = {}) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${name}-${credential}-${(sequence += 1)}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		headers: { authorization: [`Bearer ${credential}`] }
	});

const dispatch = (runtime: BoltTestRuntime, invocation: Invocation) =>
	runtime.runtime.runPromise(dispatchInvocation(invocation));

/** The failure a refusal produced, or a thrown error naming what came back instead. */
const refusalOf = async (runtime: BoltTestRuntime, invocation: Invocation) => {
	const outcome = await runtime.runtime.runPromise(
		dispatchInvocation(invocation).pipe(Effect.result)
	);
	if (outcome._tag !== 'Failure')
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
	return outcome.failure;
};

const read = (value: unknown, key: string): unknown =>
	value === null || typeof value !== 'object' ? undefined : Reflect.get(value, key);

/** The team an answer carries, as the plain object the wire shape is. */
const teamOf = (response: { readonly value?: unknown }): Record<string, unknown> =>
	Object(read(response.value, 'team')) as Record<string, unknown>;

const teamRows = (runtime: BoltTestRuntime) =>
	runtime.database.query(
		'select "id"::text as "id", "name", "parent_id"::text as "parentId" from "team" order by "name"'
	);

const memberRow = (runtime: BoltTestRuntime, user: string) =>
	runtime.database
		.query('select "team_id"::text as "teamId", "status" from "user" where "id" = $1::uuid', [
			fixtureUserId(user)
		])
		.then((rows) => rows[0]);

const access = (runtime: BoltTestRuntime) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Identity.Service).workspaceAccess(
				EffectId.make(`access-${(sequence += 1)}`),
				'test-tenant'
			);
		})
	);

/**
 * An administrator by status and an ordinary member of a declared team.
 *
 * The administrator belongs to no team at all, deliberately: with no team they hold no policy, so
 * the only thing that admits them to any command below is `user.status`, which is what
 * this suite is about.
 */
const seedPeople = async (runtime: BoltTestRuntime) => {
	await seedTeam(runtime, 'Employee');
	await seedSession(runtime, { token: 'admin-token', user: 'ada', status: ADMIN_STATUS });
	await seedSession(runtime, { token: 'member-token', user: 'grace', team: 'Employee' });
};

const createTeam = (runtime: BoltTestRuntime, input: Record<string, unknown>) =>
	dispatch(runtime, command('teams.create', 'admin-token', input));

describe('teams.create', () => {
	it('creates the team an administrator asks for, and lists it afterwards as an empty team', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);

		const created = await createTeam(harness, {
			name: 'Approvers',
			description: 'Decides payroll runs'
		});
		expect(teamOf(created)).toMatchObject({
			name: 'Approvers',
			description: 'Decides payroll runs',
			parentId: null
		});

		// The row, and the projection the settings surface reads. An empty team has to appear in both:
		// it is what a freshly declared `approvers` name reconciles into, and an operator who cannot
		// see it cannot put anybody in it.
		const listed = await access(harness);
		expect(listed.teams.map(({ name }) => name)).toEqual(['Approvers', 'Employee']);
		expect(listed.teams.find(({ name }) => name === 'Approvers')?.description).toBe(
			'Decides payroll runs'
		);
		// The write is in the ledger the same surface reads back as `events`.
		expect(listed.events.map(({ action, subject }) => [action, subject])).toContainEqual([
			'team_created',
			'Approvers'
		]);
	});

	it('refuses an ordinary member of a real team, and writes no row', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);

		const failure = await refusalOf(
			harness,
			command('teams.create', 'member-token', { name: 'Approvers' })
		);
		expect(failure).toBeInstanceOf(AccessControl.AccessDenied);
		// The gate that refused, named. A bare "something failed" would also be satisfied by a decode
		// error or a crash, which is how a refusal suite comes to pass against a handler with no gate.
		expect(failure).toMatchObject({ action: 'manage', resource: 'identity' });
		// The assertion that fails if the gate is removed: without it the insert lands and the refusal
		// above would be satisfied by an answer that had already written the team.
		expect((await teamRows(harness)).map((row) => row['name'])).toEqual(['Employee']);
	});

	it('refuses a second team whose name differs only in case', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);
		await createTeam(harness, { name: 'HR Manager' });

		const failure = await refusalOf(
			harness,
			command('teams.create', 'admin-token', { name: 'hr manager' })
		);
		expect(failure).toBeInstanceOf(DispatchError);
		expect(failure).toMatchObject({ code: 'invalid_input' });
		// One team, not two. Names are compared folded everywhere else in the runtime — an approval
		// step naming `HR Manager` must not become ambiguous because somebody typed it in lower case.
		expect((await teamRows(harness)).map((row) => row['name'])).toEqual(['Employee', 'HR Manager']);
	});
});

describe('teams.update', () => {
	it('renames a team and moves it under another', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);
		const parent = teamOf(await createTeam(harness, { name: 'Payroll' }));
		const child = teamOf(await createTeam(harness, { name: 'Approvers' }));

		const updated = await dispatch(
			harness,
			command('teams.update', 'admin-token', {
				teamId: child['id'],
				name: 'Payroll Approvers',
				parentId: parent['id']
			})
		);
		expect(teamOf(updated)).toMatchObject({
			name: 'Payroll Approvers',
			parentId: parent['id']
		});
		expect((await teamRows(harness)).map((row) => row['name'])).toEqual([
			'Employee',
			'Payroll',
			'Payroll Approvers'
		]);
	});

	it('refuses an ordinary member, and the team keeps its name', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);
		const team = teamOf(await createTeam(harness, { name: 'Approvers' }));

		const failure = await refusalOf(
			harness,
			command('teams.update', 'member-token', { teamId: team['id'], name: 'Everybody' })
		);
		expect(failure).toBeInstanceOf(AccessControl.AccessDenied);
		// The gate that refused, named. A bare "something failed" would also be satisfied by a decode
		// error or a crash, which is how a refusal suite comes to pass against a handler with no gate.
		expect(failure).toMatchObject({ action: 'manage', resource: 'identity' });
		expect((await teamRows(harness)).map((row) => row['name'])).toEqual(['Approvers', 'Employee']);
	});

	it('refuses a move that would nest a team inside its own subtree', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);
		const top = teamOf(await createTeam(harness, { name: 'Payroll' }));
		const under = teamOf(await createTeam(harness, { name: 'Approvers', parentId: top['id'] }));

		const failure = await refusalOf(
			harness,
			command('teams.update', 'admin-token', { teamId: top['id'], parentId: under['id'] })
		);
		expect(failure).toBeInstanceOf(DispatchError);
		expect(failure).toMatchObject({ code: 'invalid_input' });
		// A cycle is survivable — every walk over `parent_id` is depth-bounded — but it is never what
		// anybody meant, and the tree it produces has no root for the chart or the path walk to start
		// from. The refusal has to leave the tree as it was.
		const rows = await teamRows(harness);
		expect(rows.find((row) => row['name'] === 'Payroll')?.['parentId']).toBeNull();
		expect(rows.find((row) => row['name'] === 'Approvers')?.['parentId']).toBe(top['id']);
	});
});

describe('teams.assign', () => {
	it('moves a person, and the subject they authenticate as moves with them', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);
		const team = teamOf(await createTeam(harness, { name: 'Approvers' }));

		const assigned = await dispatch(
			harness,
			command('teams.assign', 'admin-token', {
				memberId: fixtureUserId('grace'),
				teamId: team['id']
			})
		);
		expect(read(assigned.value, 'memberId')).toBe(fixtureUserId('grace'));

		// The point of the command, asserted where it matters: the credential resolves to a subject
		// belonging to the new team, which is what decides both the policies they hold and the
		// approvals they are eligible to decide.
		const subject = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Identity.Service).authenticate(
					EffectId.make('assign-authenticate'),
					'member-token'
				);
			})
		);
		expect(subject.teamPath[0]).toBe('Approvers');
		expect(subject.teamPath).toEqual(['Approvers']);
		expect(
			(await access(harness)).members.find(({ id }) => id === fixtureUserId('grace'))?.team
		).toBe('Approvers');
	});

	it('takes somebody out of every team when the team is null', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);

		const assigned = await dispatch(
			harness,
			command('teams.assign', 'admin-token', { memberId: fixtureUserId('grace'), teamId: null })
		);
		expect(read(assigned.value, 'team')).toBeNull();
		expect((await memberRow(harness, 'grace'))?.['teamId']).toBeNull();
	});

	it('refuses an ordinary member, and nobody moves', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);
		const team = teamOf(await createTeam(harness, { name: 'Approvers' }));

		const failure = await refusalOf(
			harness,
			command('teams.assign', 'member-token', {
				memberId: fixtureUserId('grace'),
				teamId: team['id']
			})
		);
		expect(failure).toBeInstanceOf(AccessControl.AccessDenied);
		// The gate that refused, named. A bare "something failed" would also be satisfied by a decode
		// error or a crash, which is how a refusal suite comes to pass against a handler with no gate.
		expect(failure).toMatchObject({ action: 'manage', resource: 'identity' });
		// Placing *yourself* in a team is the escalation this gate exists to stop: a team's policies
		// are declared, so choosing your own team is choosing your own authority.
		expect((await memberRow(harness, 'grace'))?.['teamId']).toBe(
			(await teamRows(harness)).find((row) => row['name'] === 'Employee')?.['id']
		);
	});

	it('cannot promote anybody: a payload naming a status and a user id moves the named member and nothing else', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);
		const team = teamOf(await createTeam(harness, { name: 'Approvers' }));

		await dispatch(
			harness,
			command('teams.assign', 'admin-token', {
				memberId: fixtureUserId('grace'),
				teamId: team['id'],
				// Neither of these is a field of the command. `status` is the column that decides
				// administration and nothing here may write it; `userId` is minted from the credential on
				// every command, which is exactly why the target is named `memberId` — spelling it
				// `userId` would move the operator instead, silently, every time.
				status: 'admin',
				userId: fixtureUserId('ada')
			})
		);

		expect(await memberRow(harness, 'grace')).toMatchObject({
			teamId: team['id'],
			status: 'normal'
		});
		expect((await memberRow(harness, 'ada'))?.['teamId']).toBeNull();
	});
});

describe('teams.delete', () => {
	it('refuses while anybody still belongs to the team, and the members keep it', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);
		const employee = (await teamRows(harness)).find((row) => row['name'] === 'Employee');

		const failure = await refusalOf(
			harness,
			command('teams.delete', 'admin-token', { teamId: employee?.['id'] })
		);
		expect(failure).toBeInstanceOf(DispatchError);
		expect(failure).toMatchObject({ code: 'invalid_input' });
		// The whole reason this refuses rather than nulling `team_id`: a person's team is the whole of
		// their authority, so the alternative silently strips every policy from every member at once,
		// with no row left anywhere saying who used to be where.
		expect((await teamRows(harness)).map((row) => row['name'])).toEqual(['Employee']);
		expect((await memberRow(harness, 'grace'))?.['teamId']).toBe(employee?.['id']);
	});

	it('deletes an empty team and re-roots its children', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);
		const parent = teamOf(await createTeam(harness, { name: 'Payroll' }));
		await createTeam(harness, { name: 'Approvers', parentId: parent['id'] });

		const deleted = await dispatch(
			harness,
			command('teams.delete', 'admin-token', { teamId: parent['id'] })
		);
		expect(teamOf(deleted)).toMatchObject({ name: 'Payroll' });

		const rows = await teamRows(harness);
		expect(rows.map((row) => row['name'])).toEqual(['Approvers', 'Employee']);
		// `parent_id` is documented as `set null` on delete, and it is a plain uuid column with no
		// foreign key — so nothing performs that but the command. A child left pointing at a deleted
		// parent is a team the hierarchy walk can never reach from any root.
		expect(rows.find((row) => row['name'] === 'Approvers')?.['parentId']).toBeNull();
	});

	it('refuses an ordinary member, and the team survives', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);
		const team = teamOf(await createTeam(harness, { name: 'Approvers' }));

		const failure = await refusalOf(
			harness,
			command('teams.delete', 'member-token', { teamId: team['id'] })
		);
		expect(failure).toBeInstanceOf(AccessControl.AccessDenied);
		// The gate that refused, named. A bare "something failed" would also be satisfied by a decode
		// error or a crash, which is how a refusal suite comes to pass against a handler with no gate.
		expect(failure).toMatchObject({ action: 'manage', resource: 'identity' });
		expect((await teamRows(harness)).map((row) => row['name'])).toEqual(['Approvers', 'Employee']);
	});

	it('refuses a team that does not exist rather than reporting a database fault', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedPeople(harness);

		// Not a uuid at all. This has to read as "there is no such team" — the honest answer from
		// where the caller stands — and not as a Postgres cast error surfacing as a 500.
		const failure = await refusalOf(
			harness,
			command('teams.delete', 'admin-token', { teamId: 'not-a-team' })
		);
		expect(failure).toBeInstanceOf(DispatchError);
		expect(failure).toMatchObject({ code: 'invalid_input' });
	});
});
