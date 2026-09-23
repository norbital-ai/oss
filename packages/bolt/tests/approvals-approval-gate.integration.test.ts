import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { approveBy } from '../src/authoring/approval-flow.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../src/authoring/policy-introspection.js';
import { collection, field, workspace } from '../src/authoring/workspace-schema.js';
import * as Approvals from '../src/runtime/approvals/approvals.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import type { AuthoredCollectionModule } from '../src/authoring/collection-schema.js';
import type * as Identity from '../src/runtime/identity/identity.js';
import { SyncCommit } from '../src/runtime/facilities/services.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';

/**
 * The approval gate over real SQL.
 *
 * Approval was the one core system whose only evidence was a live probe. What a probe cannot show is
 * the part that matters most here — that a policy-routed hold is durable and visible.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

/** Requests approval through the authored `admin` team policy; administrator status bypasses it. */
const policySubject = { ...adminSubject, admin: false };

const gatedWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [
		collection({
			name: 'people',
			fields: { name: field.string({ required: true }) }
		})
	],
	apps: [],
	policies: [
		describePolicy('admin', {
			description: 'Creates people through one concrete review flow.',
			grants: {
				people: {
					// The requester can read its own proposal back without masking; the inbox
					// projection masks with the requesting subject's own read grant.
					read: { fields: ['name'] },
					mutate: {
						new: { approval: { flow: () => approveBy('approvers'), superceded_by: [] } }
					}
				}
			}
		})
	],
	teams: {
		admin: ['admin'],
		approvers: []
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	channels: [],
	envoys: [],
	requiredFacilities: []
});

const gatedFunctions = policyRuntimeFunctionsFor(gatedWorkspace.policies);
const peopleModule: AuthoredCollectionModule = { create: { input: { columns: { name: true } } } };
const gatedAuthored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	policyAuthorizations: gatedFunctions.authorizations,
	approvalFlows: gatedFunctions.approvalFlows,
	collections: { people: peopleModule }
};

const rowCount = async (runtime: BoltTestRuntime, name: string): Promise<number> => {
	const rows = await runtime.database.query(`select count(*)::int as total from ${name}`);
	const [row] = rows;
	return typeof row?.['total'] === 'number' ? row['total'] : -1;
};

const createPerson = (
	runtime: BoltTestRuntime,
	effectId: string,
	name: string,
	subject: Identity.Subject = policySubject
) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Collections.Service).write(runtime.effectId(effectId), subject, [
				{ collection: 'people', action: 'create', inputs: [{ name }] }
			]);
		})
	);

describe('approval gate over SQL', () => {
	it('writes the row a gated create requested, and holds it under the approval', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace, { authored: gatedAuthored });
		const commit = await createPerson(harness, 'create-held', 'Ada');
		const requestId = commit.pendingApproval?.requestId;
		expect(requestId).toBeTypeOf('string');
		// The graph is committed provisionally under the request (RFC §4.8).
		expect(await harness.database.query('select name, approval_id from people')).toEqual([
			{ name: 'Ada', approval_id: requestId }
		]);
	});

	it('records the held request so a reviewer can find and read it', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace, { authored: gatedAuthored });
		const { runtime, effectId } = harness;
		const commit = await createPerson(harness, 'create-held', 'Grace');
		const requestId = commit.pendingApproval?.requestId ?? '';
		expect(requestId).not.toBe('');

		const state = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).status(effectId('status'), requestId);
			})
		);
		expect(state?._tag).toBe('Pending');

		// The operation is kept whole. A reviewer approves the write that was actually requested, not
		// a reconstruction of it.
		const rows = await harness.database.query(
			'select collection_name, record_id, action, status from approval_request'
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			collection_name: 'people',
			record_id: commit.records[0]?.['id'],
			action: 'create',
			status: 'ONGOING'
		});
	});

	it('commits a decision, its projections, audit and follow-up atomically', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace, { authored: gatedAuthored });
		const { runtime, effectId } = harness;
		const commit = await createPerson(harness, 'create-decided', 'Margaret');
		const requestId = commit.pendingApproval?.requestId ?? '';
		const pending = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).status(effectId('status-decided'), requestId);
			})
		);
		expect(pending?._tag).toBe('Pending');
		if (pending?._tag !== 'Pending') return;
		const reviewer = {
			...adminSubject,
			userId: 'reviewer-1',
			teamPath: ['approvers'],
			admin: false
		};
		const decided = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).decide(
					effectId('approve-decided'),
					reviewer,
					pending,
					'approve'
				);
			})
		);
		expect(decided._tag).toBe('Approved');
		expect(await harness.database.query('select status, steps from approval_request')).toEqual([
			expect.objectContaining({ status: 'APPROVED', steps: [] })
		]);
		expect(
			await harness.database.query(
				"select kind, subject_id from bolt_audit where kind = 'approval_decided'"
			)
		).toEqual([{ kind: 'approval_decided', subject_id: 'reviewer-1' }]);
		expect(await harness.database.query('select command, input from bolt_task')).toEqual([
			{ command: 'collections.resume', input: { requestId } }
		]);
	});

	it('lets every workspace administrator supersede without an authored superseding team', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace, { authored: gatedAuthored });
		const { runtime, effectId } = harness;
		const commit = await createPerson(harness, 'create-admin-superseded', 'Katherine');
		const requestId = commit.pendingApproval?.requestId ?? '';
		const pending = await runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).status(
					effectId('status-admin-superseded'),
					requestId
				);
			})
		);
		expect(pending?._tag).toBe('Pending');
		if (pending?._tag !== 'Pending') return;

		const approvals = await runtime.runPromise(
			Effect.gen(function* () {
				const service = yield* Approvals.Service;
				const capabilities = yield* service.capabilities(
					effectId('capabilities-admin-superseded'),
					adminSubject,
					requestId
				);
				const decided = yield* service.decide(
					effectId('decide-admin-superseded'),
					adminSubject,
					pending,
					'supersede',
					'Workspace administrator emergency override'
				);
				return { capabilities, decided };
			})
		);
		expect(approvals.capabilities.canSupersede).toBe(true);
		expect(approvals.decided).toMatchObject({
			_tag: 'Approved',
			superseded: true,
			reason: 'Workspace administrator emergency override'
		});
	});

	it('leaves an ungated collection alone', async () => {
		harness = await makeBoltTestRuntime(undefined, {
			authored: { ...emptyAuthoredRuntime, collections: { people: peopleModule } }
		});
		const commit = await createPerson(harness, 'create-direct', 'Ada', adminSubject);
		expect(commit.pendingApproval).toBeUndefined();
		expect(await rowCount(harness, 'people')).toBe(1);
		expect(await harness.database.query('select 1 from approval_request')).toHaveLength(0);
	});

	it('holds each write under its own request rather than letting one decision cover both', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace, { authored: gatedAuthored });
		const first = await createPerson(harness, 'create-many:0', 'Ada');
		const second = await createPerson(harness, 'create-many:1', 'Grace');
		expect(first.pendingApproval?.requestId).not.toBe(second.pendingApproval?.requestId);
		expect(
			await harness.database.query('select name, approval_id from people order by name')
		).toEqual([
			{ name: 'Ada', approval_id: first.pendingApproval?.requestId },
			{ name: 'Grace', approval_id: second.pendingApproval?.requestId }
		]);
		expect(await rowCount(harness, 'approval_request')).toBe(2);
	});

	it('replicates the provisional row with its stamp beside the request projection', async () => {
		harness = await makeBoltTestRuntime(gatedWorkspace, { authored: gatedAuthored });
		const { runtime } = harness;
		const commit = await createPerson(harness, 'create-held', 'Ada');
		const changes = await runtime.runPromise(
			Effect.flatMap(SyncCommit.Service, (sync) => sync.drainChanges)
		);
		expect(changes.map((change) => change.collection).toSorted()).toEqual([
			'approval_request',
			'people',
			'requestor'
		]);
		// The change carries routing values only; the stamp is read from the row itself.
		expect(changes.find((change) => change.collection === 'people')).toMatchObject({
			operation: 'insert',
			id: commit.records[0]?.['id']
		});
	});
});
