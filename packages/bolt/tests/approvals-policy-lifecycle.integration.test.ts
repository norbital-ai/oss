import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveBy } from '../src/authoring/approval-flow.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../src/authoring/policy-introspection.js';
import { collection, field, workspace } from '../src/authoring/workspace-schema.js';
import * as Approvals from '../src/runtime/approvals/approvals.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import { Subject } from '../src/runtime/identity/identity.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { unwrapMutationPhase } from './support/mutation-phase.js';

/** Exercises authored lifecycle policy; administrator status bypasses its approval gates. */
const policySubject = { ...adminSubject, admin: false };

const events: Array<string> = [];
const decisionContexts: Array<unknown> = [];
const objectAt = (context: unknown, key: string): Readonly<Record<string, unknown>> => {
	if (typeof context !== 'object' || context === null) return {};
	const value = Reflect.get(context, key);
	return typeof value === 'object' && value !== null
		? (value as Readonly<Record<string, unknown>>)
		: {};
};

const lifecyclePolicy = describePolicy('writer', {
	description: 'Every write is authorized and then routed over its prepared record.',
	grants: {
		records: {
			read: {},
			mutate: {
				new: {
					fields: ['title'],
					authorize: (context: unknown) => {
						decisionContexts.push(context);
						events.push(`create.authorize:${String(objectAt(context, 'record')['status'])}`);
						return true;
					},
					approval: {
						flow: (context: unknown) => {
							decisionContexts.push(context);
							events.push(`create.flow:${String(objectAt(context, 'record')['status'])}`);
							return approveBy('Reviewers');
						},
						superceded_by: []
					}
				},
				existing: {
					fields: ['title'],
					authorize: (context: unknown) => {
						decisionContexts.push(context);
						events.push(`update.authorize:${String(objectAt(context, 'record')['status'])}`);
						return true;
					},
					approval: {
						flow: (context: unknown) => {
							decisionContexts.push(context);
							events.push(`update.flow:${String(objectAt(context, 'record')['status'])}`);
							return approveBy('Reviewers');
						},
						superceded_by: []
					}
				}
			},
			delete: {
				authorize: (context: unknown) => {
					decisionContexts.push(context);
					events.push(`delete.authorize:${String(objectAt(context, 'record')['status'])}`);
					return true;
				},
				approval: {
					flow: (context: unknown) => {
						decisionContexts.push(context);
						events.push(`delete.flow:${String(objectAt(context, 'record')['status'])}`);
						return approveBy('Reviewers');
					},
					superceded_by: []
				}
			}
		}
	}
});

const definition = workspace({
	name: 'policy-lifecycle',
	version: '1.0.0',
	collections: [
		collection({
			name: 'records',
			fields: {
				title: field.string({ required: true }),
				status: field.string({ required: true })
			}
		})
	],
	apps: [],
	policies: [lifecyclePolicy],
	teams: { admin: ['writer'], Writers: ['writer'], Reviewers: [] },
	automations: [],
	integrations: [],
	prompt: 'Exercise the policy lifecycle.',
	tools: [],
	skills: [],
	channels: [],
	envoys: [],
	requiredFacilities: []
});

const functions = policyRuntimeFunctionsFor([lifecyclePolicy]);
const writerSubject = Subject.make({
	userId: 'writer-1',
	tenantId: 'test-tenant',
	teamPath: ['Writers'],
	policies: []
});

/** The transform derives the server-owned status; policy decisions are asked of its payload. */
const authored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	policyAuthorizations: functions.authorizations,
	approvalFlows: functions.approvalFlows,
	collections: {
		records: {
			create: { input: { columns: { title: true } } },
			update: { input: { columns: { title: true, status: true } } },
			delete: {},
			transform: (
				inputs: ReadonlyArray<Readonly<Record<string, unknown>>>,
				context: Readonly<{
					existing: ReadonlyArray<Readonly<Record<string, unknown>> | undefined>;
				}>
			) =>
				Effect.succeed(
					inputs.map((input, index) => {
						const stored = context.existing[index];
						events.push(
							`${stored === undefined ? 'create' : 'update'}.transform:${String(input['title'])}`
						);
						return {
							...input,
							status: stored === undefined ? 'created-prepared' : 'updated-prepared'
						};
					})
				)
		}
	}
};

let harness: BoltTestRuntime | undefined;
beforeEach(() => {
	events.length = 0;
	decisionContexts.length = 0;
});
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const write = (
	runtime: BoltTestRuntime,
	effectId: string,
	subject: Subject,
	action: 'create' | 'update' | 'delete',
	input: Readonly<Record<string, unknown>>
) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Collections.Service).write(runtime.effectId(effectId), subject, [
				{ collection: 'records', action, inputs: [input] }
			]);
		})
	);

const approveAndResume = async (runtime: BoltTestRuntime, requestId: string): Promise<void> => {
	await runtime.runtime.runPromise(
		Effect.gen(function* () {
			const approvals = yield* Approvals.Service;
			const pending = yield* approvals.status(runtime.effectId('status'), requestId);
			if (pending?._tag !== 'Pending')
				throw new Error(`expected Pending, received ${String(pending?._tag)}`);
			yield* approvals.decide(
				runtime.effectId('approve'),
				{ ...adminSubject, admin: false, teamPath: ['Reviewers'] },
				pending,
				'approve'
			);
			yield* (yield* Collections.Service).resume(runtime.effectId('resume'), requestId);
		})
	);
};

describe('policy and transform lifecycle', () => {
	it('asks authorization and routing of one transformed payload, holds, then seals on approval', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });

		const created = await write(harness, 'create', policySubject, 'create', { title: 'Draft' });
		const id = String(created.records[0]?.['id']);
		const createRequest = created.pendingApproval?.requestId ?? '';
		expect(createRequest).not.toBe('');
		expect(events).toEqual([
			'create.transform:Draft',
			'create.authorize:created-prepared',
			'create.flow:created-prepared'
		]);
		expect(decisionContexts[0]).toBe(decisionContexts[1]);
		// Committed provisionally under the hold; the seal lifts the stamp and re-applies nothing.
		expect(
			await harness.database.query('select title, status, approval_id from records where id = $1', [
				id
			])
		).toEqual([{ title: 'Draft', status: 'created-prepared', approval_id: createRequest }]);
		await approveAndResume(harness, createRequest);
		expect(
			await harness.database.query('select title, status, approval_id from records where id = $1', [
				id
			])
		).toEqual([{ title: 'Draft', status: 'created-prepared', approval_id: null }]);

		events.length = 0;
		decisionContexts.length = 0;
		const updated = await write(harness, 'update', policySubject, 'update', { id, title: 'Final' });
		const updateRequest = updated.pendingApproval?.requestId ?? '';
		expect(updateRequest).not.toBe('');
		expect(events).toEqual([
			'update.transform:Final',
			'update.authorize:updated-prepared',
			'update.flow:updated-prepared'
		]);
		expect(decisionContexts[0]).toBe(decisionContexts[1]);
		expect(
			await harness.database.query('select title, status, approval_id from records where id = $1', [
				id
			])
		).toEqual([{ title: 'Final', status: 'updated-prepared', approval_id: updateRequest }]);
		await approveAndResume(harness, updateRequest);
		expect(
			await harness.database.query('select title, status, approval_id from records where id = $1', [
				id
			])
		).toEqual([{ title: 'Final', status: 'updated-prepared', approval_id: null }]);

		events.length = 0;
		decisionContexts.length = 0;
		const deleted = await write(harness, 'delete', policySubject, 'delete', { id });
		const deleteRequest = deleted.pendingApproval?.requestId ?? '';
		expect(deleteRequest).not.toBe('');
		expect(events).toEqual(['delete.authorize:updated-prepared', 'delete.flow:updated-prepared']);
		expect(decisionContexts[0]).toBe(decisionContexts[1]);
		// A held delete is applied provisionally too; its hold revision carries the row for a restore.
		expect(await harness.database.query('select id from records where id = $1', [id])).toEqual([]);
		expect(
			await harness.database.query(
				"select snapshot->>'title' as title from bolt_collection_history where record_id = $1 and operation = 'hold' and approval_id = $2",
				[id, deleteRequest]
			)
		).toEqual([{ title: 'Final' }]);
		await approveAndResume(harness, deleteRequest);
		expect(await harness.database.query('select id from records where id = $1', [id])).toEqual([]);
	});

	it('rejects forbidden submitted fields before the transform can observe them', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		const id = recordId('masked-record');
		await harness.database.query('insert into records (id, title, status) values ($1, $2, $3)', [
			id,
			'Existing',
			'existing'
		]);

		const failure = await write(harness, 'masked-update', writerSubject, 'update', {
			id,
			status: 'forged'
		}).then(
			() => undefined,
			(cause: unknown) => unwrapMutationPhase(cause)
		);
		expect(failure).toMatchObject({ _tag: 'Bolt.AccessControl.AccessDenied' });
		expect(events).toEqual([]);
	});

	it('reviews a successor and the version it closes as one concrete flow', async () => {
		const transitionPolicy = describePolicy('version_writer', {
			description: 'A successor and the version it closes share one review route.',
			grants: {
				versions: {
					read: {},
					mutate: {
						new: {
							fields: ['label', 'supersedes_id'],
							approval: { flow: () => approveBy('Reviewers'), superceded_by: [] }
						},
						existing: {
							fields: ['closed_by'],
							approval: { flow: () => approveBy('Reviewers'), superceded_by: [] }
						}
					}
				}
			}
		});
		const transitionDefinition = workspace({
			name: 'policy-transition-lifecycle',
			version: '1.0.0',
			collections: [
				collection({
					name: 'versions',
					fields: {
						label: field.string({ required: true }),
						supersedes_id: field.string(),
						closed_by: field.string()
					}
				})
			],
			apps: [],
			policies: [transitionPolicy],
			teams: { Reviewers: [] },
			automations: [],
			integrations: [],
			prompt: 'Exercise an atomic reviewed transition.',
			tools: [],
			skills: [],
			channels: [],
			envoys: [],
			requiredFacilities: []
		});
		const transitionFunctions = policyRuntimeFunctionsFor([transitionPolicy]);
		const transitionSubject = Subject.make({
			userId: 'automation:version-transition',
			tenantId: 'test-tenant',
			teamPath: [],
			policies: ['version_writer']
		});
		const predecessorId = recordId('predecessor');
		const successorId = recordId('successor');
		harness = await makeBoltTestRuntime(transitionDefinition, {
			authored: {
				...emptyAuthoredRuntime,
				policyAuthorizations: transitionFunctions.authorizations,
				approvalFlows: transitionFunctions.approvalFlows,
				collections: {
					versions: {
						create: { input: { columns: { label: true, supersedes_id: true } } },
						update: { input: { columns: { closed_by: true } } }
					}
				}
			}
		});
		const transitionHarness = harness;
		await transitionHarness.database.query('insert into versions (id, label) values ($1, $2)', [
			predecessorId,
			'Previous'
		]);

		// One batch: the successor's create and the predecessor's close route to the same
		// concrete flow, so they are held under one request and sealed together.
		const commit = await transitionHarness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).write(
					transitionHarness.effectId('authored-transition'),
					transitionSubject,
					[
						{
							collection: 'versions',
							action: 'create',
							inputs: [{ id: successorId, label: 'Successor', supersedes_id: predecessorId }]
						},
						{
							collection: 'versions',
							action: 'update',
							inputs: [{ id: predecessorId, closed_by: successorId }]
						}
					]
				);
			})
		);
		const requestId = commit.pendingApproval?.requestId ?? '';
		expect(requestId).not.toBe('');
		expect(
			await transitionHarness.database.query(
				'select id, label, supersedes_id, closed_by, approval_id from versions order by label'
			)
		).toEqual([
			{
				id: predecessorId,
				label: 'Previous',
				supersedes_id: null,
				closed_by: successorId,
				approval_id: requestId
			},
			{
				id: successorId,
				label: 'Successor',
				supersedes_id: predecessorId,
				closed_by: null,
				approval_id: requestId
			}
		]);
		expect(
			await transitionHarness.database.query('select count(*)::int as total from approval_request')
		).toEqual([{ total: 1 }]);

		await approveAndResume(transitionHarness, requestId);
		expect(
			await transitionHarness.database.query(
				'select id, label, supersedes_id, closed_by, approval_id from versions order by label'
			)
		).toEqual([
			{
				id: predecessorId,
				label: 'Previous',
				supersedes_id: null,
				closed_by: successorId,
				approval_id: null
			},
			{
				id: successorId,
				label: 'Successor',
				supersedes_id: predecessorId,
				closed_by: null,
				approval_id: null
			}
		]);
	});
});
