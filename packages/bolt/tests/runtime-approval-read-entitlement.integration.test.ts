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
import { subject } from '../src/authoring/contracts-schema.js';
import { approveBy } from '../src/authoring/approval-flow.js';
import { describePolicy } from '../src/authoring/policy-introspection.js';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import * as Approvals from '../src/runtime/approvals/approvals.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { SyncCommit } from '../src/runtime/facilities/services.js';
import { resolveInitialPrefix, advanceActivePrefix } from '../src/runtime/sync/delta-engine.js';
import { dispatchInvocation } from '../src/runtime/dispatch.js';
import type * as Identity from '../src/runtime/identity/identity.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';
import { fixtureUserId, seedSession, seedTeam } from './support/fixture-identity.js';

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
		command: name,
		input: input as never,
		headers: { authorization: [`Bearer ${credential}`] }
	});

const REVIEWERS = 'Reviewers';
const APPROVAL_EFFECT_ID = EffectId.make('approval-read-entitlement');
/** The job under review and the request holding it; both set by `raise`. */
let JOB_ID = '';
let REQUEST_ID = '';

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
		// The approval the raiser's grant routes to. `approvers` and `team.name` are the same string.
		describePolicy('raiser', {
			description: 'Raises jobs for the reviewers to decide.',
			capabilities: { apps: ['work'] },
			grants: {
				jobs: {
					mutate: { new: { approval: { flow: () => approveBy(REVIEWERS), superceded_by: [] } } }
				}
			}
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

const place = async (runtime: BoltTestRuntime) => {
	await seedTeam(runtime, 'Raisers');
	await seedTeam(runtime, REVIEWERS);
	await seedTeam(runtime, 'Bystanders');
	await seedSession(runtime, { token: 'raiser-token', user: 'raiser', team: 'Raisers' });
	await seedSession(runtime, { token: 'reviewer-token', user: 'reviewer', team: REVIEWERS });
	await seedSession(runtime, { token: 'bystander-token', user: 'bystander', team: 'Bystanders' });
};

/**
 * The job under review, raised through the write path — the only owner of the state the predicate
 * reads. Owned by the raiser unless told otherwise, and therefore outside every reviewer's own scope.
 */
const raise = async (
	runtime: BoltTestRuntime,
	ownerId = fixtureUserId('raiser'),
	title = 'Extra scaffolding'
) => {
	const commit = await runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Collections.Service).write(APPROVAL_EFFECT_ID, raiserSubject, [
				{ collection: 'jobs', action: 'create', inputs: [{ title, owner_id: ownerId }] }
			]);
		})
	);
	if (commit.pendingApproval === undefined) throw new Error('the job create was not held');
	JOB_ID = String(commit.records[0]?.['id']);
	REQUEST_ID = commit.pendingApproval.requestId;
};

const authored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	collections: { jobs: { create: { input: { columns: { title: true, owner_id: true } } } } }
};

describe('an approver may read what they were asked to approve', () => {
	it('publishes the held row beside its request, and its removal beside the withdrawal', async () => {
		harness = await makeBoltTestRuntime(reviewWorkspace, { authored });
		await place(harness);
		const drain = () =>
			harness!.runtime.runPromise(Effect.flatMap(SyncCommit.Service, (sync) => sync.drainChanges));
		const input = { kind: 'findMany' as const, collection: 'jobs', limit: 100 };
		const initial = await harness.runtime.runPromise(
			resolveInitialPrefix(APPROVAL_EFFECT_ID, raiserSubject, input)
		);
		expect(initial.rows).toEqual([]);
		const subscription = {
			subId: 'pending-jobs',
			input,
			planKey: initial.plan.effectivePlan.fingerprint,
			version: 0,
			prefixKeys: initial.keys,
			prefixBytes: initial.retainedBytes,
			viewerPrefixes: [100],
			credential: 'raiser-token',
			authorityFingerprint: initial.plan.effectivePlan.authority.fingerprint
		};
		await raise(harness);
		const created = await drain();
		expect(created).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ collection: 'jobs', id: JOB_ID, operation: 'insert' }),
				expect.objectContaining({
					collection: 'approval_request',
					id: REQUEST_ID,
					operation: 'insert',
					after: expect.objectContaining({
						collection_name: 'jobs',
						record_id: JOB_ID,
						status: 'ONGOING',
						applied_at: null
					})
				}),
				expect.objectContaining({
					collection: 'requestor',
					operation: 'insert',
					after: expect.objectContaining({
						approval_request_id: REQUEST_ID,
						user_id: raiserSubject.userId
					})
				})
			])
		);
		const held = await harness.runtime.runPromise(
			advanceActivePrefix(APPROVAL_EFFECT_ID, raiserSubject, subscription, { changes: created })
		);
		expect(held?.deltas[0]?.delta.put).toEqual([
			expect.objectContaining({
				id: JOB_ID,
				row: expect.objectContaining({ approval_id: REQUEST_ID, title: 'Extra scaffolding' })
			})
		]);
		if (held === undefined) throw new Error('Held approval did not update its live query');
		await harness.runtime.runPromise(
			Effect.flatMap(Approvals.Service, (approvals) =>
				approvals.withdraw(EffectId.make('withdraw-live-approval'), raiserSubject, {
					requestId: REQUEST_ID
				})
			)
		);
		expect(await drain()).toEqual([
			expect.objectContaining({
				collection: 'approval_request',
				id: REQUEST_ID,
				operation: 'update',
				before: expect.objectContaining({ status: 'ONGOING', row_version: 1 }),
				after: expect.objectContaining({ status: 'WITHDRAWN', row_version: 2 })
			})
		]);
		// The restore the withdrawal queued, run as the task runner would.
		await harness.runtime.runPromise(
			Effect.flatMap(Collections.Service, (collections) =>
				collections.discard(EffectId.make('discard-live-approval'), REQUEST_ID)
			)
		);
		const changes = await drain();
		expect(changes).toEqual([
			expect.objectContaining({ collection: 'jobs', id: JOB_ID, operation: 'delete' })
		]);
		const removed = await harness.runtime.runPromise(
			advanceActivePrefix(
				APPROVAL_EFFECT_ID,
				raiserSubject,
				{
					...subscription,
					version: held.toVersion,
					prefixKeys: held.prefixKeys,
					prefixBytes: held.prefixBytes
				},
				{ changes }
			)
		);
		expect(removed?.deltas[0]?.delta).toEqual({ removeIds: [JOB_ID], put: [] });
	});
	it('exposes the held row to its owner without granting approval inbox access', async () => {
		harness = await makeBoltTestRuntime(reviewWorkspace, { authored });
		await place(harness);
		await raise(harness, fixtureUserId('bystander'), 'Reserved on behalf of the owner');
		const owner: Identity.Subject = {
			...raiserSubject,
			userId: fixtureUserId('bystander'),
			teamPath: ['Bystanders']
		};
		const read = (who: Identity.Subject, collection = 'jobs') =>
			harness!.runtime.runPromise(
				Effect.flatMap(Collections.Service, (collections) =>
					collections.findMany(EffectId.make(`held:${who.userId}:${collection}`), who, {
						collection
					})
				)
			);
		// The provisional row is a real row: the owner's own-rows grant reaches it, stamped.
		expect(await read(owner)).toEqual([
			expect.objectContaining({
				id: JOB_ID,
				approval_id: REQUEST_ID,
				owner_id: owner.userId,
				title: 'Reserved on behalf of the owner'
			})
		]);
		expect(await read(owner, 'approval_request')).toEqual([]);
		expect(await read({ ...owner, userId: fixtureUserId('unrelated') })).toEqual([]);
	});
	it('projects only the actions each visible principal may actually take', async () => {
		harness = await makeBoltTestRuntime(reviewWorkspace, { authored });
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
		harness = await makeBoltTestRuntime(reviewWorkspace, { authored });
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
		harness = await makeBoltTestRuntime(reviewWorkspace, { authored });
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
