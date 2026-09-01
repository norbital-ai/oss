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
import { subject } from '../../src/authoring/contracts-schema.js';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as Approvals from '../../src/runtime/approvals/approvals.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import type * as Identity from '../../src/runtime/identity/identity.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import { fixtureUserId, seedSession, seedTeam } from '../support/fixture-identity.js';

/**
 * Being asked to approve a record is what entitles somebody to read it.
 *
 * The reviewer below holds a grant narrowed to their *own* rows, which is the ordinary shape — and
 * the record under review is by definition one somebody else raised, so that narrowing excludes
 * exactly the thing they were asked to judge. Before this branch existed a workspace could route an
 * approval to a team and leave them unable to see what they were deciding, with nothing in either
 * declaration saying so.
 *
 * Two assertions carry the suite, and neither is "the approver can read":
 *
 *   - a **bystander** on the same team-less footing, with the same narrowed grant and no approval
 *     naming them, still sees nothing. Without that, a predicate that quietly degraded to `true`
 *     would pass every other case here.
 *   - the entitlement **ends when the approval closes**. It is scoped to the reason for it, not
 *     granted permanently to whoever was once asked.
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

const REVIEWERS = 'Reviewers';
const JOB_ID = '019f6f10-0008-7000-8000-000000000001';
const APPROVAL_EFFECT_ID = EffectId.make('approval-read-entitlement');
const APPROVAL_ROOT = { collection: 'jobs', id: JOB_ID, action: 'create' } as const;
const REQUEST_ID = Approvals.approvalRequestId(APPROVAL_ROOT, APPROVAL_EFFECT_ID);

/** The approval the raiser's grant carries. `approvers` and `team.name` are the same string. */
const jobApproval = {
	id: '019f6f10-0007-7000-8000-000000000009',
	steps: [
		{
			id: '019f6f10-0007-7000-8000-000000000109',
			approvers: [REVIEWERS]
		}
	],
	superceded_by: []
};

/** Both parties read only their own rows — the narrowing an approver's ordinary grant would have. */
const ownRowsOnly = { owner_id: { eq: subject.id } } as const;

const reviewWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [
		collection({
			name: 'jobs',
			fields: { title: field.string({ required: true }), owner_id: field.string() }
		})
	],
	apps: [app({ name: 'work', label: 'Work' })],
	policies: [
		// `jobs read` has one owner and every team composes it, which is how all three principals end
		// up with the identical narrowing the suite depends on.
		policy({
			name: 'own-jobs',
			effect: 'allow',
			capabilities: { apps: ['work'] },
			grants: [{ collection: 'jobs', action: 'read', where: ownRowsOnly }]
		}),
		policy({
			name: 'raiser',
			effect: 'allow',
			capabilities: { apps: ['work'] },
			grants: [{ collection: 'jobs', action: 'create', approval: jobApproval }]
		})
	],
	teams: {
		Raisers: ['own-jobs', 'raiser'],
		[REVIEWERS]: ['own-jobs'],
		Bystanders: ['own-jobs']
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

const raiserSubject: Identity.Subject = {
	userId: fixtureUserId('raiser'),
	tenantId: 'test-tenant',
	teamPath: ['Raisers'],
	policies: []
};

const titlesVisibleTo = async (runtime: BoltTestRuntime, credential: string) => {
	const outcome = await runtime.runtime.runPromise(
		dispatchInvocation(
			command('collections.export', credential, { collection: 'jobs', limit: 50 })
		).pipe(Effect.result)
	);
	if (outcome._tag !== 'Success') throw new Error(`refused: ${JSON.stringify(outcome)}`);
	const rows = outcome.success.value;
	if (!Array.isArray(rows)) throw new Error('expected rows');
	return (rows as ReadonlyArray<Record<string, unknown>>).map((row) => row['title']).sort();
};

const approvalCapabilitiesFor = async (runtime: BoltTestRuntime, credential: string) => {
	const outcome = await runtime.runtime.runPromise(
		dispatchInvocation(
			command('approvals.capabilities', credential, { requestId: REQUEST_ID })
		).pipe(Effect.result)
	);
	if (outcome._tag !== 'Success') throw new Error(`refused: ${JSON.stringify(outcome)}`);
	return outcome.success.value;
};

/** The job under review, owned by the raiser and therefore outside every reviewer's own scope. */
const place = async (runtime: BoltTestRuntime) => {
	await seedTeam(runtime, 'Raisers');
	await seedTeam(runtime, REVIEWERS);
	await seedTeam(runtime, 'Bystanders');
	await seedSession(runtime, { token: 'raiser-token', user: 'raiser', team: 'Raisers' });
	await seedSession(runtime, { token: 'reviewer-token', user: 'reviewer', team: REVIEWERS });
	await seedSession(runtime, { token: 'bystander-token', user: 'bystander', team: 'Bystanders' });
	await runtime.database.query(
		`insert into jobs ("id", "title", "owner_id") values ($1::uuid, $2, $3)`,
		[JOB_ID, 'Extra scaffolding', fixtureUserId('raiser')]
	);
};

/** Raised through the public approval gate, the only owner of the state the predicate reads. */
const raise = (runtime: BoltTestRuntime) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Approvals.Service).gate({
				effectId: APPROVAL_EFFECT_ID,
				subject: raiserSubject,
				root: APPROVAL_ROOT,
				storedGraph: { version: 1, collection: 'jobs', id: JOB_ID, action: 'create' },
				proposedValues: { title: 'Extra scaffolding' },
				approval: jobApproval,
				review: undefined
			});
		})
	);

describe('an approver may read what they were asked to approve', () => {
	it('projects only the actions each visible principal may actually take', async () => {
		harness = await makeBoltTestRuntime(reviewWorkspace);
		await place(harness);
		await raise(harness);

		expect(await approvalCapabilitiesFor(harness, 'raiser-token')).toEqual([
			{
				id: REQUEST_ID,
				status: 'ONGOING',
				canDecide: false,
				canSupersede: false,
				canWithdraw: true
			}
		]);
		expect(await approvalCapabilitiesFor(harness, 'reviewer-token')).toEqual([
			{
				id: REQUEST_ID,
				status: 'ONGOING',
				canDecide: true,
				canSupersede: false,
				canWithdraw: false
			}
		]);
		// A request outside the principal's approval visibility returns no capability record at all.
		expect(await approvalCapabilitiesFor(harness, 'bystander-token')).toEqual([]);
	});

	it('reaches a record its own grant excludes, while the approval is open', async () => {
		harness = await makeBoltTestRuntime(reviewWorkspace);
		await place(harness);

		// Before anything is raised, the narrowing is the whole answer: nobody sees the raiser's job.
		expect(await titlesVisibleTo(harness, 'reviewer-token')).toEqual([]);

		await raise(harness);

		// Named on the open step, so the record is reachable despite the grant that excludes it.
		expect(await titlesVisibleTo(harness, 'reviewer-token')).toEqual(['Extra scaffolding']);
		// And the case that makes the one above mean something: identical policy, identical narrowing,
		// not named as an approver. A predicate that had degraded to `true` would show it this row.
		expect(await titlesVisibleTo(harness, 'bystander-token')).toEqual([]);
	});

	it('stops reaching it once the approval closes', async () => {
		harness = await makeBoltTestRuntime(reviewWorkspace);
		await place(harness);
		await raise(harness);
		expect(await titlesVisibleTo(harness, 'reviewer-token')).toEqual(['Extra scaffolding']);

		// Closing the request is what ends the entitlement — it lasts exactly as long as its reason.
		await harness.database.query(
			`update approval_request set "closed_at" = now() where "record_id" = $1`,
			[JOB_ID]
		);
		expect(await titlesVisibleTo(harness, 'reviewer-token')).toEqual([]);
	});
});
