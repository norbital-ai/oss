import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	InvocationId,
	PROTOCOL_VERSION,
	Invocation,
	EnvironmentName,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { field, policy } from '../../src/authoring/workspace-schema.js';
import * as AccessControl from '../../src/runtime/access/access-control.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import {
	makeBoltTestRuntime,
	testWorkspace,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { seedSession } from '../support/fixture-identity.js';

/**
 * Who may read the schema plan, and who may apply it.
 *
 * Every `schema.*` command used to run for any authenticated subject in the tenant, and — through a
 * `Task` invocation, which carries no credential at all — for nobody in particular. `schema.migrate`
 * opens a DDL transaction, so the worst case was an employee's session token, or an unauthenticated
 * task payload, rewriting the tenant's tables.
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

const command = (name: string, credential: string) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`schema-${name}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		// Every `schema.*` contract declares `EmptyInput` (`Schema.Struct({})`), so the empty payload
		// is `{}`. `null` fails the contract decode, which happens before authority is consulted, and
		// would turn every refusal below into an `invalid_input` that proves nothing about access.
		input: {},
		headers: { authorization: [`Bearer ${credential}`] }
	});

/** The credential-free path: whatever `subject` the payload claims is the only one on offer. */
const task = (name: string, input: unknown) =>
	Invocation.cases.Task.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`schema-task-${name}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		attempt: 0
	});

/**
 * A session in one of the three teams the fixture declares.
 *
 * The team is the whole variable these tests turn on: `employee` holds no schema authority at all,
 * `inspector` holds `read` over the `schema` app, and `admin` holds `*`. Each name is a key of the
 * workspace's `teams` map below, because it is the declaration — not the row — that says what the
 * name holds.
 */
const seedMember = (runtime: BoltTestRuntime, token: string, team: string) =>
	seedSession(runtime, { token, user: `user-${token}`, team });

const failureOf = async (runtime: BoltTestRuntime, invocation: Invocation) => {
	const outcome = await runtime.runtime.runPromise(
		dispatchInvocation(invocation).pipe(Effect.result)
	);
	if (outcome._tag !== 'Failure')
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
	return outcome.failure;
};

/**
 * `inspector` is the whole point of splitting `read` from `manage`: an operator who may look at the
 * DDL a release would apply, and may not apply it.
 */
const schemaWorkspace = () =>
	testWorkspace({
		collections: [{ name: 'people', fields: { name: field.string({ required: true }) } }],
		policies: [
			policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } }),
			policy({
				name: 'inspector',
				effect: 'allow',
				actions: ['read'],
				capabilities: { apps: ['schema'] }
			}),
			policy({
				name: 'employee',
				effect: 'allow',
				grants: [{ collection: 'people', action: 'read' }]
			})
		],
		teams: {
			admin: ['admin', 'inspector', 'employee'],
			inspector: ['inspector'],
			employee: ['employee']
		}
	});

describe('schema.* access control', () => {
	it('refuses every schema command to an authenticated subject with no schema authority', async () => {
		harness = await makeBoltTestRuntime(schemaWorkspace());
		await seedMember(harness, 'employee-token', 'employee');
		for (const name of [
			'schema.plan',
			'schema.fingerprint',
			'schema.validate',
			'schema.verify',
			'schema.migrate'
		]) {
			const failure = await failureOf(harness, command(name, 'employee-token'));
			expect(failure).toBeInstanceOf(AccessControl.AccessDenied);
			expect((failure as AccessControl.AccessDenied).resource).toBe('schema');
		}
	});

	it('lets a subject holding read see the plan and still refuses the migration', async () => {
		harness = await makeBoltTestRuntime(schemaWorkspace());
		await seedMember(harness, 'inspector-token', 'inspector');

		const plan = await harness.runtime.runPromise(
			dispatchInvocation(command('schema.plan', 'inspector-token'))
		);
		expect(Array.isArray((plan.value as { steps?: unknown }).steps)).toBe(true);

		const failure = await failureOf(harness, command('schema.migrate', 'inspector-token'));
		expect(failure).toBeInstanceOf(AccessControl.AccessDenied);
		expect((failure as AccessControl.AccessDenied).action).toBe('manage');
	});

	it('lets a subject holding manage apply the migration', async () => {
		harness = await makeBoltTestRuntime(schemaWorkspace());
		await seedMember(harness, 'admin-token', 'admin');
		const response = await harness.runtime.runPromise(
			dispatchInvocation(command('schema.migrate', 'admin-token'))
		);
		expect((response.value as { migrated?: boolean }).migrated).toBe(true);
	});

	// The hole with no credential check at all: a task payload can claim any subject it likes, so the
	// claim is refused rather than read. A forged admin subject is the strongest form of the claim.
	it('refuses a schema command arriving as a task, however the payload names its subject', async () => {
		harness = await makeBoltTestRuntime(schemaWorkspace());
		const forged = {
			subject: { userId: 'user-forged', tenantId: 'test-tenant', policies: [], teamPath: ['admin'] }
		};
		// Both payloads are refused, by the two gates a `Task` meets in order. An empty one never gets
		// past provenance — `schema.migrate` declares no `Task` origin — while one naming a subject is
		// stopped a step earlier, at the claim itself. Asserting a single reason for both would have to
		// pick one gate and would pass while the other was gone.
		for (const { input, reason } of [
			{ input: {}, reason: 'Task provenance does not authorize this route' },
			{ input: forged, reason: 'no credential' }
		]) {
			const failure = await failureOf(harness, task('schema.migrate', input));
			expect(failure, reason).toBeInstanceOf(AccessControl.AccessDenied);
			expect((failure as AccessControl.AccessDenied).reason).toContain(reason);
		}
	});
});
