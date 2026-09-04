import { Effect, Option, Redacted } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { ADMIN_STATUS, NORMAL_STATUS } from '../src/runtime/identity/identity.js';
import {
	GATEWAY_SECRET_VARIABLE,
	HostConfig
} from '../src/runtime/access/system-principal.js';
import { dispatchInvocation } from '../src/runtime/dispatch.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';
import { fixtureTeamId, fixtureUserId, seedSession, seedTeam } from './support/fixture-identity.js';

/**
 * People writes: `identity.assignTeam` and `identity.setMemberAdmin`.
 *
 * The operator form calls these two commands. Administration used to be unreachable from that
 * sheet because nothing wrote `user.team_id` or `user.status`. An administrator must be able to
 * place someone and promote them without holding `manage`/`identity`; an ordinary member must not.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const HOST_SECRET = 'a-test-gateway-secret';

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
	teams: { Employee: ['Employee'], Payroll: ['Employee'] },
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	requiredFacilities: []
});

let sequence = 0;

const asPerson = (command: string, credential: string, input: Record<string, unknown>) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${command}-${(sequence += 1)}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command,
		input: input as never,
		headers: { authorization: [`Bearer ${credential}`] }
	});

const withHostSecret = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.provideService(HostConfig, {
			read: (key: string) =>
				Effect.succeed(
					key === GATEWAY_SECRET_VARIABLE
						? Option.some(Redacted.make(HOST_SECRET))
						: Option.none<Redacted.Redacted<string>>()
				)
		})
	);

const dispatch = (runtime: BoltTestRuntime, invocation: Invocation) =>
	runtime.runtime.runPromise(withHostSecret(dispatchInvocation(invocation)));

const refusalOf = async (runtime: BoltTestRuntime, invocation: Invocation) => {
	const outcome = await runtime.runtime.runPromise(
		withHostSecret(dispatchInvocation(invocation)).pipe(Effect.result)
	);
	if (outcome._tag !== 'Failure')
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
	return outcome.failure;
};

const read = (value: unknown, key: string): unknown =>
	value === null || typeof value !== 'object' ? undefined : Reflect.get(value, key);

const memberRow = (runtime: BoltTestRuntime, user: string) =>
	runtime.database
		.query(
			`select "status", "team_id"::text as "team_id", "tenantId" from "user" where "id" = $1::uuid`,
			[fixtureUserId(user)]
		)
		.then((rows) => rows[0]);

describe('identity.assignTeam and identity.setMemberAdmin', () => {
	it('lets an administrator move a member between teams without changing status', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedTeam(harness, 'Employee');
		await seedTeam(harness, 'Payroll');
		await seedSession(harness, { token: 'admin-token', user: 'ada', status: ADMIN_STATUS });
		await seedSession(harness, { token: 'member-token', user: 'grace', team: 'Employee' });

		const response = await dispatch(
			harness,
			asPerson('identity.assignTeam', 'admin-token', {
				memberId: fixtureUserId('grace'),
				teamId: fixtureTeamId('Payroll')
			})
		);
		expect(response.status).toBe(200);
		expect(read(response.value, 'assigned')).toBe(true);
		const row = await memberRow(harness, 'grace');
		expect(read(row, 'team_id')).toBe(fixtureTeamId('Payroll'));
		expect(read(row, 'status')).toBe(NORMAL_STATUS);
		expect(read(row, 'tenantId')).toBe('test-tenant');
	});

	it('lets an administrator promote a member without moving their team', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedTeam(harness, 'Employee');
		await seedSession(harness, { token: 'admin-token', user: 'ada', status: ADMIN_STATUS });
		await seedSession(harness, { token: 'member-token', user: 'grace', team: 'Employee' });

		const response = await dispatch(
			harness,
			asPerson('identity.setMemberAdmin', 'admin-token', {
				memberId: fixtureUserId('grace'),
				admin: true
			})
		);
		expect(response.status).toBe(200);
		expect(read(response.value, 'updated')).toBe(true);
		const row = await memberRow(harness, 'grace');
		expect(read(row, 'status')).toBe(ADMIN_STATUS);
		expect(read(row, 'team_id')).toBe(fixtureTeamId('Employee'));
	});

	it('refuses an ordinary member who does not hold manage identity', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedTeam(harness, 'Employee');
		await seedSession(harness, { token: 'admin-token', user: 'ada', status: ADMIN_STATUS });
		await seedSession(harness, { token: 'member-token', user: 'grace', team: 'Employee' });

		const teamFailure = await refusalOf(
			harness,
			asPerson('identity.assignTeam', 'member-token', {
				memberId: fixtureUserId('ada'),
				teamId: fixtureTeamId('Employee')
			})
		);
		expect(String(read(teamFailure, '_tag'))).toContain('AccessDenied');

		const adminFailure = await refusalOf(
			harness,
			asPerson('identity.setMemberAdmin', 'member-token', {
				memberId: fixtureUserId('grace'),
				admin: true
			})
		);
		expect(String(read(adminFailure, '_tag'))).toContain('AccessDenied');
		expect(read(await memberRow(harness, 'grace'), 'status')).toBe(NORMAL_STATUS);
	});

	it('clears the only team and refuses demoting the last administrator', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedTeam(harness, 'Employee');
		await seedSession(harness, { token: 'admin-token', user: 'ada', status: ADMIN_STATUS });
		await seedSession(harness, { token: 'member-token', user: 'grace', team: 'Employee' });

		const cleared = await dispatch(
			harness,
			asPerson('identity.assignTeam', 'admin-token', {
				memberId: fixtureUserId('grace'),
				teamId: null
			})
		);
		expect(cleared.status).toBe(200);
		expect(read(await memberRow(harness, 'grace'), 'team_id')).toBeNull();

		const lastAdmin = await refusalOf(
			harness,
			asPerson('identity.setMemberAdmin', 'admin-token', {
				memberId: fixtureUserId('ada'),
				admin: false
			})
		);
		expect(String(read(lastAdmin, '_tag'))).toContain('AccessDenied');
		expect(read(await memberRow(harness, 'ada'), 'status')).toBe(ADMIN_STATUS);
	});
});
