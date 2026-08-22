import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	InvocationId,
	Invocation,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { defineEnvironment } from '../../src/authoring/environment-schema.js';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as AccessControl from '../../src/runtime/access/access-control.js';
import * as Approvals from '../../src/runtime/approvals/approvals.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { PendingApproval } from '../../src/runtime/collections/collections.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { seedSession } from '../support/fixture-identity.js';

/**
 * Who a command runs as, and where that answer is allowed to come from.
 *
 * A `Command` reaches the switch carrying a subject this boundary authenticated from a credential
 * and then wrote over the payload's own. A `Task` carries no credential, and a non-data-browser
 * `Plugin` is an unauthenticated `POST /_bolt/plugin/<anything>/<command>` — both hand their input
 * to the switch untouched. So on those two tags `subject` is a claim, and a claim that says
 * `teamPath: ['admin'], policies: []` used to pass `authorize(subject, 'manage', 'secrets')` and open the vault.
 *
 * The refusal is one gate where identity is minted rather than a check per case, so these tests
 * hold the whole list of exposed commands against it instead of the two the issue named.
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

/** The strongest form of the claim: a subject that names itself an admin of the invocation tenant. */
const forgedSubject = {
	userId: 'user-forged',
	tenantId: 'test-tenant',
	teamPath: ['admin'],
	policies: []
};

const command = (name: string, credential: string, input: unknown = null) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${name}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		headers: { authorization: [`Bearer ${credential}`] }
	});

const task = (name: string, input: unknown) =>
	Invocation.cases.Task.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`task-${name}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		attempt: 0
	});

/** Any plugin but `data-browser`, which is the one the boundary resolves a subject for itself. */
const plugin = (name: string, input: unknown) =>
	Invocation.cases.Plugin.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`plugin-${name}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		plugin: 'operator-console',
		command: name,
		input: input as never,
		headers: {},
		trustedContext: {}
	});

const failureOf = async (runtime: BoltTestRuntime, invocation: Invocation) => {
	const outcome = await runtime.runtime.runPromise(
		dispatchInvocation(invocation).pipe(Effect.result)
	);
	if (outcome._tag !== 'Failure')
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
	return outcome.failure;
};

/**
 * Every command that decodes a `Subject` out of its own input.
 *
 * Written out rather than sampled: the two the issue reported are the two somebody happened to
 * look at, and the same decode appears in twenty-nine more. `invoke.*` is a prefix, so one name
 * stands for every authored remote a workspace declares.
 */
const SUBJECT_COMMANDS: ReadonlyArray<string> = [
	'invoke.anything',
	'secrets.status',
	'secrets.write',
	'apps.visible',
	'access.impersonate',
	'access.resolveScope',
	'access.authorize',
	'access.predicate',
	'access.explain',
	'access.mask',
	'approvals.request',
	'approvals.decide',
	'approvals.withdraw',
	'sync.diff',
	'sync.shape',
	'sync.mutate',
	'agents.turn',
	'agents.start',
	'agents.listConversations',
	'agents.history',
	'workspace.manifest',
	'collections.findMany',
	'collections.findFirst',
	'collections.count',
	'collections.history',
	'collections.create',
	'collections.createMany',
	'collections.update',
	'collections.delete',
	'collections.import',
	'collections.export'
];

/**
 * The same hole one field down.
 *
 * These take no `Subject`, but a `Command` mints their `userId`, `tenantId` and `invitedBy` from
 * the authenticated one all the same — so on a credential-free tag `identity.startSession` would
 * have issued a live session credential for any user id the payload named.
 */
const IDENTITY_FIELD_COMMANDS: ReadonlyArray<string> = [
	'identity.invite',
	'identity.acceptInvitation',
	'identity.startSession',
	'identity.workspaceAccess',
	'identity.workspaceSettings'
];

const vaultWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [collection({ name: 'people', fields: { name: field.string({ required: true }) } })],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } }),
		policy({
			name: 'employee',
			effect: 'allow',
			grants: [{ collection: 'people', action: 'read' }]
		})
	],
	teams: {
		admin: ['admin', 'employee'],
		employee: ['employee']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: [],
	environment: defineEnvironment({ GEOCODING_API_KEY: { label: 'Geocoding key' } })
});

/** The approval-resume task path: a held write, resumed with no subject in the payload at all. */
const gatedWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [
		collection({
			name: 'people',
			fields: { name: field.string({ required: true }) },
			approvalLock: true
		})
	],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
	],
	teams: {
		admin: ['admin']
	},
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	automations: [],
	envoys: [],
	requiredFacilities: []
});

describe('payload-supplied identity', () => {
	it('refuses every command that reads an identity out of its own input, on a task', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		for (const name of SUBJECT_COMMANDS) {
			const failure = await failureOf(harness, task(name, { subject: forgedSubject }));
			expect(failure, name).toBeInstanceOf(AccessControl.AccessDenied);
			expect((failure as AccessControl.AccessDenied).reason).toContain('no credential');
		}
		for (const name of IDENTITY_FIELD_COMMANDS) {
			const failure = await failureOf(
				harness,
				task(name, { userId: 'user-forged', tenantId: 'test-tenant', invitedBy: 'user-forged' })
			);
			expect(failure, name).toBeInstanceOf(AccessControl.AccessDenied);
			expect((failure as AccessControl.AccessDenied).reason).toContain('no credential');
		}
	});

	// `/_bolt/plugin/<anything>/<command>` is an unauthenticated POST that reaches the same switch, so
	// the claim is refused on that tag too and not only on the one the issue named.
	it('refuses the same claim arriving on a plugin that is not the data browser', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		for (const name of ['secrets.write', 'secrets.status', 'collections.create']) {
			const failure = await failureOf(
				harness,
				plugin(name, { subject: forgedSubject, name: 'GEOCODING_API_KEY', value: 'stolen' })
			);
			expect(failure, name).toBeInstanceOf(AccessControl.AccessDenied);
			expect((failure as AccessControl.AccessDenied).reason).toContain('no credential');
		}
	});

	// The refusal is worth nothing on its own: what makes it a fix is that the vault is still empty
	// afterwards, read back through the command that reports what is set.
	it('leaves the vault unwritten after a refused task, and writes it for an authorized command', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		// `admin` is the vault workspace's team holding the policy that grants `*` — the authorized
		// half of this test needs a session that really can write a workspace secret.
		await seedSession(harness, { token: 'admin-token', user: 'user-admin-token', team: 'admin' });

		await failureOf(
			harness,
			task('secrets.write', { subject: forgedSubject, name: 'GEOCODING_API_KEY', value: 'stolen' })
		);
		const beforeResponse = await harness.runtime.runPromise(
			dispatchInvocation(command('secrets.status', 'admin-token'))
		);
		const before = beforeResponse.value as ReadonlyArray<{
			readonly name: string;
			readonly configured: boolean;
		}>;
		expect(before.find(({ name }) => name === 'GEOCODING_API_KEY')?.configured).toBe(false);

		const written = await harness.runtime.runPromise(
			dispatchInvocation(
				command('secrets.write', 'admin-token', { name: 'GEOCODING_API_KEY', value: 'kept' })
			)
		);
		expect(written.value).toMatchObject({ saved: true, name: 'GEOCODING_API_KEY' });

		const afterResponse = await harness.runtime.runPromise(
			dispatchInvocation(command('secrets.status', 'admin-token'))
		);
		const after = afterResponse.value as ReadonlyArray<{
			readonly name: string;
			readonly configured: boolean;
		}>;
		expect(after.find(({ name }) => name === 'GEOCODING_API_KEY')?.configured).toBe(true);
	});

	// The gate refuses a claim; it does not replace the authorization that follows one.
	it('still refuses an authenticated command whose subject lacks the authority', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		// `employee` grants a read of `people` and nothing about secrets, which is what makes the
		// refusal below an authorization refusal rather than an authentication one.
		await seedSession(harness, {
			token: 'employee-token',
			user: 'user-employee-token',
			team: 'employee'
		});
		const failure = await failureOf(
			harness,
			command('secrets.write', 'employee-token', { name: 'GEOCODING_API_KEY', value: 'stolen' })
		);
		expect(failure).toBeInstanceOf(AccessControl.AccessDenied);
		expect((failure as AccessControl.AccessDenied).resource).toBe('secrets');
	});

	/**
	 * The task path the runtime actually enqueues, still working.
	 *
	 * `Approvals` enqueues `collections.resume` with `{ requestId }` and nothing else. Its authority
	 * is the stored approval itself — `authorizeResume` requires the request to be `Approved`, and the
	 * write is replayed under the subject recorded when the original create was authenticated — so it
	 * never had a payload subject to lose.
	 */
	it('still runs the approval-resume task, whose authority is the stored approval', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace);
		const { runtime, effectId } = harness;
		const id = recordId('person-1');

		const held = await runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).create(effectId('create-held'), adminSubject, {
						collection: 'people',
						id,
						values: { name: 'Ada' }
					});
				})
			)
		);
		expect(held).toBeInstanceOf(PendingApproval);
		const requestId = held instanceof PendingApproval ? held.requestId : '';

		const pending = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).status(effectId('status'), requestId);
			})
		);
		if (pending?._tag !== 'Pending')
			throw new Error(`expected a pending approval, got ${String(pending?._tag)}`);
		await harness.database.query('update bolt_approvals set state = $2 where request_id = $1', [
			requestId,
			{ _tag: 'Approved', requestId, decidedBy: adminSubject.userId, operation: pending.operation }
		]);

		const resumed = await runtime.runPromise(
			dispatchInvocation(task('collections.resume', { requestId }))
		);
		expect(resumed.value).toMatchObject({ resumed: true, requestId });
		expect(await harness.database.query('select name from people')).toEqual([{ name: 'Ada' }]);
	});
});
