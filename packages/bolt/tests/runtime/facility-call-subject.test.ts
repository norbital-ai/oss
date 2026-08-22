import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	InvocationId,
	Invocation,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId,
	type FacilityCall
} from '@norbital-ai/bolt-protocol';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as Approvals from '../../src/runtime/approvals/approvals.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { PendingApproval } from '../../src/runtime/collections/collections.js';
import { ADMIN_STATUS } from '../../src/runtime/identity/identity.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { fixtureUserId, seedExternalSubject, seedSession } from '../support/fixture-identity.js';

/**
 * Which person a facility call is made for.
 *
 * A facility used to see a tenant and an environment and nothing finer, so anything it stored per
 * caller — a personal credential, a browser session somebody signed in themselves — had only one
 * key for the whole workspace to share. `FacilityCall.subject` is that missing key, and these tests
 * are about where its value is allowed to come from and where it must be absent.
 *
 * The value is provided by `dispatchInvocation` from the subject `authenticate` returned, so the
 * assertions below are on the envelope the binding actually received rather than on the field
 * existing in a type. A seam that is declared and never provided answers `None` forever and reads,
 * from inside a facility, exactly like a workspace where nobody is signed in.
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

const command = (name: string, credential: string, input: unknown) =>
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

const dataBrowserQuery = (credential: string, trustedContext: unknown) =>
	Invocation.cases.Plugin.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make('plugin-query-impersonated'),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		plugin: 'data-browser',
		command: 'query',
		input: { collection: 'people', input: { limit: 20 } },
		headers: { authorization: [`Bearer ${credential}`] },
		trustedContext: trustedContext as never
	});

const subjectsOf = (calls: ReadonlyArray<FacilityCall>) => calls.map(({ subject }) => subject);

const peopleWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [collection({ name: 'people', fields: { name: field.string({ required: true }) } })],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
	],
	teams: {
		admin: ['admin']
	},
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	requiredFacilities: []
});

/** The same workspace with the write held, which is the only way to reach an enqueued `Task`. */
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

describe('the subject a facility call carries', () => {
	/**
	 * The read itself, not just some call in the invocation.
	 *
	 * The session lookup that authenticates the credential is asserted to carry *no* subject, because
	 * it is the call that establishes one — if it carried a subject, the value would have come from
	 * somewhere other than authentication, which is the whole thing being ruled out.
	 */
	it('stamps the authenticated user on every facility call a command makes after authentication', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await harness.database.query('insert into people (id, name) values ($1, $2)', [
			recordId('person-1'),
			'Ada'
		]);
		await seedSession(harness, { token: 'admin-token', user: 'user-admin-token', team: 'admin' });
		harness.database.forget();

		const response = await harness.runtime.runPromise(
			dispatchInvocation(command('collections.findMany', 'admin-token', { collection: 'people' }))
		);
		expect(response.value).toMatchObject({ rows: [{ name: 'Ada' }] });

		const calls = [...harness.database.calls];
		expect(calls.length).toBeGreaterThan(1);
		expect(
			calls[0]?.subject,
			'the credential lookup ran before there was a subject'
		).toBeUndefined();
		expect(
			subjectsOf(calls.slice(1)),
			'a facility call made under an authenticated command carried no subject'
		).toEqual(
			// A `CallSubject` is the user and their one team, and nothing else — a facility binding has no
			// use for a list of policy names it cannot interpret.
			calls.slice(1).map(() => ({ userId: fixtureUserId('user-admin-token'), team: 'admin' }))
		);
	});

	/**
	 * The claim a payload makes is not the answer, restated at the facility boundary.
	 *
	 * `MINTED_IDENTITY` already overwrites `subject` before any case reads it, so this asserts the
	 * consequence one hop further out: naming another user in the body does not change who the host
	 * is told the call is for. If the subject were ever read from the input, this is where it shows.
	 */
	it('ignores a subject the request body names and uses the credential holder', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedSession(harness, { token: 'admin-token', user: 'user-admin-token', team: 'admin' });
		harness.database.forget();

		await harness.runtime.runPromise(
			dispatchInvocation(
				command('collections.findMany', 'admin-token', {
					collection: 'people',
					subject: {
						userId: 'user-victim',
						tenantId: 'test-tenant',
						policies: [],
						teamPath: ['admin']
					}
				})
			)
		);

		const named = subjectsOf(harness.database.calls).map((subject) => subject?.userId);
		expect(named, 'a payload-named user reached a facility call').not.toContain('user-victim');
		expect(named).toContain(fixtureUserId('user-admin-token'));
	});

	/**
	 * Work with nobody behind it says so.
	 *
	 * A durable task carries no credential by construction, so there is no subject to provide and
	 * none is invented. A facility that needs one has to refuse this call; a placeholder would take
	 * that decision away from it and quietly file the task's writes under a user who never ran it.
	 */
	it('provides no subject at all for an enqueued task', async () => {
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
		harness.database.forget();

		const resumed = await runtime.runPromise(
			dispatchInvocation(task('collections.resume', { requestId }))
		);
		expect(resumed.value).toMatchObject({ resumed: true, requestId });

		const calls = [...harness.database.calls];
		// Asserted non-empty first: zero recorded calls would satisfy "none carried a subject" while
		// proving nothing, and a resume that ran no SQL did not replay the write.
		expect(calls.length, 'the resumed task made no facility call to inspect').toBeGreaterThan(0);
		expect(subjectsOf(calls), 'a task with no credential fabricated a subject').toEqual(
			calls.map(() => undefined)
		);
	});

	// The health probe answers before it reaches a service, so there is nothing to attribute and
	// nothing is attributed — the case that would most easily acquire a stand-in subject.
	it('provides no subject for the health probe, which touches no facility', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		harness.database.forget();

		const response = await harness.runtime.runPromise(
			dispatchInvocation(
				Invocation.cases.Request.make({
					protocolVersion: PROTOCOL_VERSION,
					id: InvocationId.make('request-health'),
					scope,
					deadlineEpochMs: Date.now() + 30_000,
					method: 'GET',
					url: '/health',
					headers: {}
				})
			)
		);
		expect(response.value).toMatchObject({ status: 'ok' });
		expect(harness.database.calls).toEqual([]);
	});

	/**
	 * Impersonation exposes the target, because that is what impersonation is.
	 *
	 * An operator opening a member's rows is acting for that member, so the per-user state a facility
	 * reaches has to be the member's — showing the operator their own would defeat the feature and
	 * would also be the more dangerous default, since it would write the member's session and secrets
	 * under the operator's key. The actor is not lost: `impersonate` authorized them, wrote the audit
	 * row, and stamped `impersonatedBy` on the subject it returned.
	 */
	it('exposes the impersonated target rather than the actor on the data browser path', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await harness.database.query('insert into people (id, name) values ($1, $2)', [
			recordId('person-1'),
			'Ada'
		]);
		// An administrator by status, belonging to no team. `impersonator` was a role here until it was
		// recognised as the admin flag in disguise; a team grants nothing of the kind now, and the
		// operator holding none is what makes the target's team below distinguishable from the actor's.
		await seedSession(harness, {
			token: 'operator-token',
			user: 'user-operator-token',
			status: ADMIN_STATUS
		});
		await seedExternalSubject(harness, {
			externalId: 'member-external',
			userId: 'user-member',
			team: 'admin'
		});
		harness.database.forget();

		const outcome = await harness.runtime.runPromise(
			dispatchInvocation(
				dataBrowserQuery('operator-token', { impersonatedSubject: 'member-external' })
			).pipe(Effect.result)
		);
		expect(outcome._tag === 'Failure' ? outcome.failure : undefined).toBeUndefined();
		expect(outcome._tag === 'Success' ? outcome.success.value : undefined).toMatchObject([
			{ name: 'Ada' }
		]);

		const stamped = subjectsOf(harness.database.calls).filter((subject) => subject !== undefined);
		expect(stamped.length, 'the impersonated read carried no subject').toBeGreaterThan(0);
		expect(
			stamped.map(({ userId }) => userId),
			'the actor was stamped on a call made on the target’s behalf'
		).toEqual(stamped.map(() => 'user-member'));
		// The team travels with the target too, not the operator's — a facility keying per-user state
		// off it would otherwise partition that state by whoever happened to open the browser. The
		// operator is in no team at all, so `admin` here can only have come from the member's row.
		expect(stamped[stamped.length - 1]?.team).toBe('admin');
	});
});
