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
import { AccessControl } from '../../src/runtime/access/access-control.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

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

const session = async (runtime: BoltTestRuntime, token: string, roles: ReadonlyArray<string>) => {
	await runtime.database.query(
		`with person as (insert into bolt_auth_user ("norbital_id", "name", "email", "tenantId", "roles", "teams") values (md5($2::text)::uuid, $2, $5, $3, $4::jsonb, '[]'::jsonb) on conflict ("norbital_id") do update set "roles" = excluded."roles", "teams" = excluded."teams", "email" = excluded."email", "tenantId" = excluded."tenantId" returning "norbital_id" as id) insert into bolt_auth_session ("norbital_id", "token", "userId", "expiresAt") select gen_random_uuid(), $1, person.id, now() + interval '1 hour' from person`,
		[token, `user-${token}`, 'test-tenant', JSON.stringify([...roles]), `${token}@example.test`]
	);
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
 * `admin` is the founder's policy and is the only one carrying `impersonator` — the role
 * `identity.admitFounder` adds on top of what the policies declare, because no policy declares it.
 */
const hrWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [
		collection({ name: 'notices', fields: { title: field.string({ required: true }) } }),
		collection({ name: 'payslips', fields: { amount: field.string({ required: true }) } })
	],
	apps: [
		app({ name: 'hr_employee', label: 'Employee Self-Service' }),
		app({ name: 'hr_controller', label: 'HR Controller' }),
		app({ name: 'hr_controller/payroll', label: 'Payroll' })
	],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], roles: ['admin'], apps: ['*'] }),
		policy({
			name: 'Employee',
			effect: 'allow',
			roles: ['employee'],
			apps: ['hr_employee'],
			grants: [{ collection: 'notices', action: 'read' }]
		}),
		policy({
			name: 'HR',
			effect: 'allow',
			roles: ['hr'],
			apps: ['hr_controller'],
			grants: [
				{ collection: 'notices', action: 'read' },
				{ collection: 'payslips', action: 'read' }
			]
		})
	],
	agents: [],
	automations: [],
	channels: [],
	integrations: [],
	requiredFacilities: []
});

describe('team impersonation', () => {
	/**
	 * The acceptance example, both halves.
	 *
	 * An administrator who can see every app is asked to look as an `Employee`: the controller group
	 * and the app under it leave the sidebar, and `payslips` — the collection those apps are built on
	 * — stops answering. The second assertion is the one that matters; the first alone would be
	 * satisfied by a filtered list in front of a runtime that still served the rows.
	 */
	it('drops hr_controller from a previewed employee view and refuses the read behind it', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await session(harness, 'admin-token', ['admin', AccessControl.IMPERSONATOR_ROLE]);

		expect(await visibleApps(harness, 'admin-token')).toEqual(
			expect.arrayContaining(['hr_employee', 'hr_controller', 'hr_controller/payroll'])
		);

		const previewed = await visibleApps(harness, 'admin-token', 'Employee');
		expect(previewed).toEqual(['hr_employee']);
		expect(previewed).not.toContain('hr_controller');
		expect(previewed).not.toContain('hr_controller/payroll');

		const refused = await failureOf(
			harness,
			command('collections.findMany', 'admin-token', { collection: 'payslips' }, 'Employee')
		);
		expect(refused).toBeInstanceOf(AccessControl.AccessDenied);
		expect(refused).toMatchObject({ action: 'read', resource: 'payslips' });
	});

	/**
	 * A preview is a member's view, not a blackout.
	 *
	 * Written because the cheap way to pass the test above is to hand the subject no roles at all —
	 * which refuses everything, including what an employee is plainly entitled to, and would make
	 * "an employee cannot see the HR app" true for the wrong reason. It is also why the picker lists
	 * the workspace's policies rather than the approver teams its grants name: a subject carrying
	 * `roles: ['L1 Manager']` matches no policy, so this read would fail too.
	 */
	it('still serves what the previewed team is granted', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await session(harness, 'admin-token', ['admin', AccessControl.IMPERSONATOR_ROLE]);

		const response = await harness.runtime.runPromise(
			dispatchInvocation(
				command('collections.findMany', 'admin-token', { collection: 'notices' }, 'Employee')
			)
		);
		expect(response.status).toBe(200);
	});

	/** Nothing lingers: with the header gone the very next command is the real subject again. */
	it('restores the real subject when the preview stops', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await session(harness, 'admin-token', ['admin', AccessControl.IMPERSONATOR_ROLE]);

		expect(await visibleApps(harness, 'admin-token', 'Employee')).toEqual(['hr_employee']);
		expect(await visibleApps(harness, 'admin-token')).toEqual(
			expect.arrayContaining(['hr_controller', 'hr_controller/payroll'])
		);

		const served = await harness.runtime.runPromise(
			dispatchInvocation(command('collections.findMany', 'admin-token', { collection: 'payslips' }))
		);
		expect(served.status).toBe(200);
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
		await session(harness, 'employee-token', ['employee']);

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
			command('collections.findMany', 'employee-token', { collection: 'payslips' }, 'HR')
		);
		expect(widened).toBeInstanceOf(AccessControl.AccessDenied);
	});

	/** A team the workspace never declared is refused too, rather than silently ignored. */
	it('refuses a team no policy declares', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await session(harness, 'admin-token', ['admin', AccessControl.IMPERSONATOR_ROLE]);

		const refused = await failureOf(
			harness,
			command('apps.visible', 'admin-token', null, 'L1 Manager')
		);
		expect(refused).toMatchObject({ action: 'impersonate', reason: 'no policy of that name' });
	});

	/**
	 * What the sidebar renders, answered from the actor rather than from the previewed subject.
	 *
	 * Once a preview is running the subject holds `Employee`'s roles, and an answer derived from it
	 * would report `isAdmin: false` — taking the picker off the surface and leaving no way back.
	 */
	it('reports the picker state from the real actor, mid-preview', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await session(harness, 'admin-token', ['admin', AccessControl.IMPERSONATOR_ROLE]);
		await session(harness, 'employee-token', ['employee']);

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
		await session(harness, 'admin-token', ['admin', AccessControl.IMPERSONATOR_ROLE]);

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
		expect(audit[0]).toMatchObject({ payload: { team: 'Employee', roles: ['employee'] } });
	});

	/**
	 * The founder holds the role the picker requires.
	 *
	 * `identity.admitFounder` derives roles from the workspace's policies, and no policy declares
	 * `impersonator` — so before this the first administrator of every workspace held every role
	 * except the one impersonation needs, and the menu could never render for anybody.
	 */
	it('admits a founder holding the impersonator role', async () => {
		harness = await makeBoltTestRuntime(hrWorkspace);
		await session(harness, 'admin-token', ['admin', AccessControl.IMPERSONATOR_ROLE]);

		const admitted = await harness.runtime.runPromise(
			dispatchInvocation(
				command('identity.admitFounder', 'admin-token', { email: 'founder@example.test' })
			)
		);
		const roles =
			admitted.value === null || typeof admitted.value !== 'object'
				? undefined
				: Reflect.get(admitted.value, 'roles');
		expect(roles).toContain(AccessControl.IMPERSONATOR_ROLE);
	});
});
