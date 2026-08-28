import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveBy } from '../../src/authoring/approval-flow.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../../src/authoring/policy-introspection.js';
import { collection, field, workspace } from '../../src/authoring/workspace-schema.js';
import * as AccessControl from '../../src/runtime/access/access-control.js';
import * as Approvals from '../../src/runtime/approvals/approvals.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { PendingApproval } from '../../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import { Subject } from '../../src/runtime/identity/identity.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

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
			create: {
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
			update: {
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
const authored = {
	...emptyAuthoredRuntime,
	policyAuthorizations: functions.authorizations,
	approvalFlows: functions.approvalFlows,
	hooks: {
		records: {
			mutate: {
				perRecord: {
					before: {
						description: 'Derive the server-owned status before policy decisions.',
						handler: (context: unknown) => {
							const input = objectAt(context, 'input');
							const existing = Reflect.get(context as object, 'existing');
							if (existing === undefined) {
								events.push(`create.before:${String(input['title'])}`);
								return { ...input, status: 'created-prepared' };
							}
							events.push(`update.before:${String(input['title'])}`);
							return { ...input, status: 'updated-prepared' };
						}
					},
					after: {
						description: 'Observe only a settled stored mutation.',
						handler: (context: unknown) => {
							const record = objectAt(context, 'record');
							const previousValue = Reflect.get(context as object, 'previous');
							if (previousValue === undefined) {
								events.push(`create.after:${String(record['status'])}`);
								return;
							}
							const previous = objectAt(context, 'previous');
							const changes = objectAt(context, 'changes');
							events.push(
								`update.after:${String(record['status'])}:${String(previous['status'])}:${String(changes['status'])}`
							);
						}
					}
				}
			},
			delete: {
				perRecord: {
					before: {
						description: 'Observe the stored row before routing its delete.',
						handler: (context: unknown) => {
							const existing = objectAt(context, 'existing');
							events.push(`delete.before:${String(existing['status'])}`);
						}
					},
					after: {
						description: 'Observe the deleted row only after settlement.',
						handler: (context: unknown) => {
							const record = objectAt(context, 'record');
							events.push(`delete.after:${String(record['status'])}`);
						}
					}
				}
			}
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

const pendingRequest = async <E>(effect: Effect.Effect<unknown, E>): Promise<PendingApproval> => {
	if (harness === undefined) throw new Error('test runtime is not initialized');
	const failure = await harness.runtime.runPromise(Effect.flip(effect));
	expect(
		failure,
		failure instanceof Approvals.ApprovalConflict
			? failure.reason
			: 'write did not request approval'
	).toBeInstanceOf(PendingApproval);
	if (!(failure instanceof PendingApproval)) throw new Error('write did not request approval');
	return failure;
};

describe('policy and hook lifecycle', () => {
	it('uses one prepared context for authorization and routing, then runs after only on settlement', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		const service = await harness.runtime.runPromise(Collections.Service);
		const id = recordId('lifecycle-record');

		const created = await pendingRequest(
			service.create(harness.effectId('create'), policySubject, {
				collection: 'records',
				id,
				values: { title: 'Draft' }
			})
		);
		expect(events).toEqual([
			'create.before:Draft',
			'create.authorize:created-prepared',
			'create.flow:created-prepared'
		]);
		expect(decisionContexts[0]).toBe(decisionContexts[1]);
		await approveAndResume(harness, created.requestId);
		expect(events.at(-1)).toBe('create.after:created-prepared');

		events.length = 0;
		decisionContexts.length = 0;
		const updated = await pendingRequest(
			service.update(harness.effectId('update'), policySubject, {
				collection: 'records',
				id,
				values: { title: 'Final' }
			})
		);
		expect(events).toEqual([
			'update.before:Final',
			'update.authorize:updated-prepared',
			'update.flow:updated-prepared'
		]);
		expect(decisionContexts[0]).toBe(decisionContexts[1]);
		expect(
			await harness.database.query('select title, status from records where id = $1', [id])
		).toEqual([{ title: 'Draft', status: 'created-prepared' }]);
		await approveAndResume(harness, updated.requestId);
		expect(events.at(-1)).toBe('update.after:updated-prepared:created-prepared:updated-prepared');

		events.length = 0;
		decisionContexts.length = 0;
		const deleted = await pendingRequest(
			service.delete(harness.effectId('delete'), policySubject, 'records', id)
		);
		expect(events).toEqual([
			'delete.before:updated-prepared',
			'delete.authorize:updated-prepared',
			'delete.flow:updated-prepared'
		]);
		expect(decisionContexts[0]).toBe(decisionContexts[1]);
		await approveAndResume(harness, deleted.requestId);
		expect(events.at(-1)).toBe('delete.after:updated-prepared');
		expect(await harness.database.query('select id from records where id = $1', [id])).toEqual([]);
	});

	it('rejects forbidden submitted fields before an update hook can observe them', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		const service = await harness.runtime.runPromise(Collections.Service);
		const id = recordId('masked-record');
		await harness.database.query('insert into records (id, title, status) values ($1, $2, $3)', [
			id,
			'Existing',
			'existing'
		]);

		const failure = await harness.runtime.runPromise(
			Effect.flip(
				service.update(harness.effectId('masked-update'), writerSubject, {
					collection: 'records',
					id,
					values: { status: 'forged' }
				})
			)
		);
		expect(failure).toBeInstanceOf(AccessControl.AccessDenied);
		expect(events).toEqual([]);
	});

	it('reviews a before-hook sibling write and its root as one concrete flow', async () => {
		const transitionPolicy = describePolicy('version_writer', {
			description: 'A successor and the version it closes share one review route.',
			grants: {
				versions: {
					read: {},
					create: {
						fields: ['label', 'supersedes_id'],
						approval: { flow: () => approveBy('Reviewers'), superceded_by: [] }
					},
					update: {
						fields: ['closed_by'],
						approval: { flow: () => approveBy('Reviewers'), superceded_by: [] }
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
		const transitionEvents: Array<string> = [];
		harness = await makeBoltTestRuntime(transitionDefinition, {
			authored: {
				...emptyAuthoredRuntime,
				policyAuthorizations: transitionFunctions.authorizations,
				approvalFlows: transitionFunctions.approvalFlows,
				hooks: {
					versions: {
						mutate: {
							perRecord: {
								before: {
									description: 'Closes the predecessor inside the successor graph.',
									handler: (context: unknown, api: unknown) =>
										Effect.gen(function* () {
											const input = objectAt(context, 'input');
											if (Reflect.get(context as object, 'existing') !== undefined) return input;
											const predecessor = String(input['supersedes_id']);
											transitionEvents.push(`prepare:${predecessor}`);
											const database = objectAt(api, 'db');
											const versions = objectAt(database, 'versions');
											const mutate = Reflect.get(versions, 'mutate');
											if (typeof mutate !== 'function') throw new Error('mutate is unavailable');
											yield* mutate({ id: predecessor, closed_by: successorId });
											return input;
										})
								}
							}
						}
					}
				}
			}
		});
		const transitionHarness = harness;
		await transitionHarness.database.query('insert into versions (id, label) values ($1, $2)', [
			predecessorId,
			'Previous'
		]);

		const raised = await transitionHarness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* Effect.flip(
					collections.mutate(
						transitionHarness.effectId('authored-transition'),
						transitionSubject,
						'versions',
						[{ label: 'Successor', supersedes_id: predecessorId }],
						false,
						0,
						{
							declarative: true,
							root: { id: successorId, action: 'create' }
						}
					)
				);
			})
		);
		const pending = Collections.unwrapMutationPhase(raised);
		if (!(pending instanceof PendingApproval)) {
			throw new Error(`transition was not held: ${JSON.stringify(pending)}`);
		}
		expect(transitionEvents).toEqual([`prepare:${predecessorId}`]);
		expect(
			await transitionHarness.database.query('select id, closed_by from versions order by label')
		).toEqual([{ id: predecessorId, closed_by: null }]);

		await approveAndResume(transitionHarness, pending.requestId);
		expect(transitionEvents).toEqual([`prepare:${predecessorId}`, `prepare:${predecessorId}`]);
		expect(
			await transitionHarness.database.query(
				'select id, label, supersedes_id, closed_by from versions order by label'
			)
		).toEqual([
			{ id: predecessorId, label: 'Previous', supersedes_id: null, closed_by: successorId },
			{ id: successorId, label: 'Successor', supersedes_id: predecessorId, closed_by: null }
		]);
	});
});
