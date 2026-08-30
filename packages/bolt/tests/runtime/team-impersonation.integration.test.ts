import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as AccessControl from '../../src/runtime/access/access-control.js';
import { ADMIN_STATUS } from '../../src/runtime/identity/identity.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import { seedSession, seedTeam } from '../support/fixture-identity.js';

/**
 * Viewing the workspace as one of its teams, through the boundary a browser actually reaches.
 *
 * The claim under test is not "an app disappears from a list". Hiding navigation is not authority —
 * the row predicate is — so every assertion here is paired: the app is gone from `apps.visible`
 * *and* the read it fronts is refused, from the same substituted subject, over the same dispatch.
 * A version of this feature that filtered `visibleApps` alone would pass half of these and ship a
 * sidebar that lies about what the runtime will serve.
 *
 * The workspace is shaped like `hr-payroll`, because that is where the acceptance example comes
 * from: policies named for the teams that hold them (`Employee`, `HR`), an employee app and an
 * `hr_controller` group with a child under it, and a collection only HR is granted.
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

/**
 * A command as it arrives from Colony, optionally carrying a team preview.
 *
 * The header is the channel: `/api/bolt/command` copies the request's headers onto the invocation,
 * and stamps this one from the trusted route it resolved. Nothing about the header is trusted here,
 * which is the whole of what the refusal tests below prove.
 */
const command = (name: string, credential: string, input: unknown = null, team?: string) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${name}-${credential}-${team ?? 'self'}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		headers: {
			authorization: [`Bearer ${credential}`],
			...(team === undefined ? {} : { 'x-colony-impersonated-team': [team] })
		}
	});

/**
 * The teams the picker offers and a preview resolves against.
 *
 * They are rows now, not policy names — `impersonationTeams` reads `team` and `subjectAsTeam`
 * looks a name up in it — so a workspace that declares `Employee` in `+teams.ts` and has no row for
 * it offers nothing and can preview nothing. Seeded flat and non-inheriting, because what these
 * tests are about is which policies one named team holds, not how a hierarchy composes them; the
 * names match `hrWorkspace.teams` exactly, which is what makes a preview mean the policies below.
 */
const hrTeams = async (runtime: BoltTestRuntime) => {
	for (const name of ['admin', 'Employee', 'HR']) await seedTeam(runtime, name);
};

/**
 * The administrator these tests preview from, belonging to *no* team at all.
 *
 * Deliberately placeless rather than in `admin`. The status itself grants the complete workspace;
 * keeping the person out of a team proves that this authority is not accidentally inherited from
 * the authored policy ladder. A preview clears the status and substitutes one real team's policy.
 */
const administrator = async (runtime: BoltTestRuntime, token = 'admin-token') => {
	await hrTeams(runtime);
	await seedSession(runtime, { token, user: `user-${token}`, status: ADMIN_STATUS });
};

const failureOf = async (runtime: BoltTestRuntime, invocation: Invocation) => {
	const outcome = await runtime.runtime.runPromise(
		dispatchInvocation(invocation).pipe(Effect.result)
	);
	if (outcome._tag !== 'Failure')
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
	return outcome.failure;
};

const visibleApps = async (runtime: BoltTestRuntime, credential: string, team?: string) => {
	const response = await runtime.runtime.runPromise(
		dispatchInvocation(command('apps.visible', credential, null, team))
	);
	const apps =
		response.value === null || typeof response.value !== 'object'
			? undefined
			: Reflect.get(response.value, 'apps');
	return Array.isArray(apps) ? (apps as ReadonlyArray<string>) : [];
};

/**
 * `Employee` sees one app and its own notices; `HR` sees the controller group and payslips.
 *
 * The `admin` policy is kept, and kept unused. It is an ordinary authored policy — no workspace has
 * to declare one and nothing in the runtime looks for the name. Administration itself is the
 * trusted `user.status`, which bypasses authored policy until an explicit team preview clears it.
 */
const hrWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [
		collection({
			name: 'notices',
			fields: {
				title: field.string({ required: true }),
				owner_id: field.uuid({ required: true })
			}
		}),
		collection({ name: 'payslips', fields: { amount: field.string({ required: true }) } })
	],
	apps: [
		app({ name: 'hr_employee', label: 'Employee Self-Service' }),
		app({ name: 'hr_controller', label: 'HR Controller' }),
		app({ name: 'hr_controller/payroll', label: 'Payroll' })
	],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } }),
		policy({
			name: 'Employee',
			effect: 'allow',
			capabilities: { apps: ['hr_employee'] },
			grants: [
				{
					collection: 'notices',
					action: 'read',
					where: { owner_id: { eq: '${requestor.id}' } }
				}
			]
		}),
		policy({
			name: 'HR',
			effect: 'allow',
			capabilities: { apps: ['hr_controller'] },
			// `notices read` belongs to `Employee` and to nothing else: a coordinate has exactly one
			// owner, and the `admin` team below composes both policies rather than restating either.
			grants: [{ collection: 'payslips', action: 'read' }]
		})
	],
	teams: {
		admin: ['admin', 'Employee', 'HR'],
		Employee: ['Employee'],
		HR: ['HR']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: []
});

describe('team impersonation', () => {
	/**
	 * The acceptance example, both halves.
	 *
	 * An administrator sees every app by default, then asks to look as an `Employee`: only the
	 * employee app remains, while `payslips` — which Employee is not granted — becomes unavailable.
	 * The second assertion is the one that matters; the first alone would be
	 * satisfied by a filtered list in front of a runtime that still served the rows.
	 */
	it('drops hr_controller from a previewed employee view and refuses the read behind it', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await administrator(harness);

		expect(await visibleApps(harness, 'admin-token')).toEqual([
			'hr_employee',
			'hr_controller',
			'hr_controller/payroll'
		]);

		const previewed = await visibleApps(harness, 'admin-token', 'Employee');
		expect(previewed).toEqual(['hr_employee']);
		expect(previewed).not.toContain('hr_controller');
		expect(previewed).not.toContain('hr_controller/payroll');

		const refused = await failureOf(
			harness,
			command('collections.export', 'admin-token', { collection: 'payslips' }, 'Employee')
		);
		expect(refused).toBeInstanceOf(AccessControl.AccessDenied);
		// The read is refused by the policy decision itself. There is no partition admission in front
		// of a page any more, so the refusal names the collection the previewed subject may not read
		// and the reason no grant matched — which is the same answer an ordinary Employee gets.
		expect(refused).toMatchObject({
			action: 'read',
			resource: 'payslips',
			reason: 'no matching allow policy'
		});
	});

	/**
	 * A preview is a member's view, not a blackout.
	 *
	 * Written because the cheap way to pass the test above is to hand the subject no roles at all —
	 * which refuses everything, including what an employee is plainly entitled to, and would make
	 * "an employee cannot see the HR app" true for the wrong reason. It is also why the picker lists
	 * the workspace's policies rather than the approver teams its grants name: a subject carrying
	 * `teamPath: ['L1 Manager'], policies: []` matches no policy, so this read would fail too.
	 */
	it('serves a nested identity equality for what the previewed team is granted', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await administrator(harness);

		const response = await harness.runtime.runPromise(
			dispatchInvocation(
				command('collections.export', 'admin-token', { collection: 'notices' }, 'Employee')
			)
		);
		expect(response.status).toBe(200);
	});

	/** Nothing lingers: with the header gone the next command restores the administrator bypass. */
	it('restores the real subject when the preview stops', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await administrator(harness);

		expect(await visibleApps(harness, 'admin-token', 'Employee')).toEqual(['hr_employee']);
		expect(await visibleApps(harness, 'admin-token')).toEqual([
			'hr_employee',
			'hr_controller',
			'hr_controller/payroll'
		]);

		const restored = await harness.runtime.runPromise(
			dispatchInvocation(command('collections.export', 'admin-token', { collection: 'payslips' }))
		);
		expect(restored.status).toBe(200);
	});

	/**
	 * The gate, on both the header and the command.
	 *
	 * A non-admin asserting the header is refused rather than quietly ignored: a request to run as
	 * somebody else is a claim, and reporting it as anything but a refusal would hide an attempt.
	 * The refusal lands on every command, not only on the ones that read data — the substitution
	 * happens where identity is minted, so there is no case that can be reached past it.
	 */
	it('refuses a non-admin the preview entirely', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await hrTeams(harness);
		await seedSession(harness, {
			token: 'employee-token',
			user: 'user-employee-token',
			team: 'Employee'
		});

		const claimed = await failureOf(harness, command('apps.visible', 'employee-token', null, 'HR'));
		expect(claimed).toBeInstanceOf(AccessControl.AccessDenied);
		expect(claimed).toMatchObject({ action: 'impersonate', reason: 'impersonation not permitted' });

		const asked = await failureOf(
			harness,
			command('access.impersonateTeam', 'employee-token', { teamId: 'HR' })
		);
		expect(asked).toBeInstanceOf(AccessControl.AccessDenied);
		expect(asked).toMatchObject({ action: 'impersonate', reason: 'impersonation not permitted' });

		// And the escalation the header would otherwise be: an employee cannot reach HR's collection
		// by naming HR, which is the direction a widening bug would take.
		const widened = await failureOf(
			harness,
			command('collections.export', 'employee-token', { collection: 'payslips' }, 'HR')
		);
		expect(widened).toBeInstanceOf(AccessControl.AccessDenied);
	});

	/** A team the workspace never declared is refused too, rather than silently ignored. */
	it('refuses a team no policy declares', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await administrator(harness);

		const refused = await failureOf(
			harness,
			command('apps.visible', 'admin-token', null, 'L1 Manager')
		);
		// "No team", not "no policy": a preview names a `team` row now, so an undeclared name is
		// refused by the lookup rather than by the policy ladder.
		expect(refused).toMatchObject({ action: 'impersonate', reason: 'no team of that name' });
	});

	/**
	 * What the sidebar renders, answered from the actor rather than from the previewed subject.
	 *
	 * Once a preview is running the subject holds `Employee`'s roles, and an answer derived from it
	 * would report `isAdmin: false` — taking the picker off the surface and leaving no way back.
	 */
	it('reports the picker state from the real actor, mid-preview', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await administrator(harness);
		await hrTeams(harness);
		await seedSession(harness, {
			token: 'employee-token',
			user: 'user-employee-token',
			team: 'Employee'
		});

		const idle = await harness.runtime.runPromise(
			dispatchInvocation(command('access.impersonation', 'admin-token'))
		);
		expect(idle.value).toMatchObject({ isAdmin: true, isActive: false, activeTeamIds: [] });
		// Asserted as the set of ids rather than the whole array: every policy the workspace declares
		// is offered, so pinning the exact list here would fail whenever the fixture gains one, for a
		// reason that has nothing to do with what this test is about.
		const offered = (idle.value as { teams: ReadonlyArray<{ id: string }> }).teams.map(
			({ id }) => id
		);
		expect(offered).toEqual(expect.arrayContaining(['admin', 'Employee', 'HR']));

		const active = await harness.runtime.runPromise(
			dispatchInvocation(command('access.impersonation', 'admin-token', null, 'Employee'))
		);
		expect(active.value).toMatchObject({
			isAdmin: true,
			isActive: true,
			activeTeamIds: ['Employee']
		});

		const member = await harness.runtime.runPromise(
			dispatchInvocation(command('access.impersonation', 'employee-token'))
		);
		expect(member.value).toMatchObject({ isAdmin: false });
	});

	/**
	 * The trace, written once.
	 *
	 * `impersonateTeam` is the audited entry point the host calls before it stores the choice; the
	 * per-invocation seam re-checks the same authority and deliberately records nothing. Both halves
	 * are asserted, because an audit row per request would bury the entry that says a preview began
	 * just as effectively as writing none at all.
	 */
	it('records the start of a preview and nothing per request', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await administrator(harness);

		const started = await harness.runtime.runPromise(
			dispatchInvocation(command('access.impersonateTeam', 'admin-token', { teamId: 'Employee' }))
		);
		expect(started.value).toMatchObject({ apps: ['hr_employee'] });

		await visibleApps(harness, 'admin-token', 'Employee');
		await visibleApps(harness, 'admin-token', 'Employee');

		const audit = await harness.database.query(
			`select "kind", "payload" from bolt_audit where "kind" = 'impersonation_started'`,
			[]
		);
		expect(audit).toHaveLength(1);
		// The path is the team row's own name, not a policy's — `Employee` seeded above does not
		// inherit, so it resolves to itself and the recorded path is exactly one name long.
		expect(audit[0]).toMatchObject({ payload: { team: 'Employee', teamPath: ['Employee'] } });
	});

	/**
	 * The founder is admitted as an administrator, not as a holder of every role at once.
	 *
	 * This used to assert the opposite half of the same problem: `admitFounder` derived roles from
	 * every policy the workspace declares and bolted a synthetic `impersonator` onto the array,
	 * because no policy declares one and none should. That made the first administrator
	 * simultaneously an employee and an HR controller, made their authority a function of the policy
	 * ladder, and put a magic string in the role namespace that `mayImpersonate` had to agree on.
	 *
	 * Administrative status is explicit on their own row, so it is `admin` that has to come back
	 * true — and the founder has to be placed in no team at all. That status grants the complete
	 * workspace directly; an explicit preview temporarily narrows it to one team's policy. The response carries no array to
	 * assert on any more, so the placement is read off the row itself: `team_id` null is the same
	 * claim the empty array used to make, and filling it again would restore exactly the conflation
	 * this replaced with nothing else failing.
	 */
	it('admits a founder as an administrator rather than as a holder of every role', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await administrator(harness);

		const admitted = await harness.runtime.runPromise(
			dispatchInvocation(
				command('identity.admitFounder', 'admin-token', { email: 'founder@example.test' })
			)
		);
		expect(admitted.value).toMatchObject({ admitted: true, admin: true });
		expect(
			await harness.database.query(
				`select "team_id" from "user" where "email" = 'founder@example.test'`,
				[]
			),
			'the founder was placed in a team rather than left for an operator to place'
		).toEqual([{ team_id: null }]);
	});
});
