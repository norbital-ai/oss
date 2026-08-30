import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveBy } from '../../src/authoring/approval-flow.js';
import { authoredHooks, type CollectionHooks } from '../../src/authoring/contracts-schema.js';
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
import { unwrapMutationPhase } from '../support/mutation-phase.js';

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

/**
 * The two fixture collections as a schema, so the hooks below are typed the way a compiled
 * workspace's are: `CollectionHooks` reads handler contexts off `tables`, making `input`,
 * `existing`, `previous`, `record` and `api.db.<collection>` inferred rather than reflected.
 *
 * `status` and the `versions` columns are optional in the insert because a hook may derive them —
 * the honest statement of what a create must carry.
 */
interface LifecycleSchema {
	readonly tables: {
		readonly records: {
			readonly $inferSelect: {
				readonly id: string;
				readonly title: string;
				readonly status: string;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly title: string;
				readonly status?: string;
			};
		};
		readonly versions: {
			readonly $inferSelect: {
				readonly id: string;
				readonly label: string;
				readonly supersedes_id: string | null;
				readonly closed_by: string | null;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly label: string;
				readonly supersedes_id?: string | null;
				readonly closed_by?: string | null;
			};
		};
	};
	readonly relations: Record<string, never>;
}

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
const recordHooks: CollectionHooks<LifecycleSchema, 'records'> = {
	mutate: {
		perRecord: {
			before: {
				description: 'Derive the server-owned status before policy decisions.',
				handler: (context) => {
					if (context.existing === undefined) {
						events.push(`create.before:${context.input.title}`);
						return { ...context.input, status: 'created-prepared' };
					}
					events.push(`update.before:${context.input.title}`);
					return { ...context.input, status: 'updated-prepared' };
				}
			},
			after: {
				description: 'Observe only a settled stored mutation.',
				handler: ({ record, previous, changes }) => {
					if (previous === undefined) {
						events.push(`create.after:${record.status}`);
						return;
					}
					events.push(`update.after:${record.status}:${previous.status}:${changes.status}`);
				}
			}
		}
	},
	delete: {
		perRecord: {
			before: {
				description: 'Observe the stored row before routing its delete.',
				handler: ({ existing }) => {
					events.push(`delete.before:${existing.status}`);
				}
			},
			after: {
				description: 'Observe the deleted row only after settlement.',
				handler: ({ record }) => {
					events.push(`delete.after:${record.status}`);
				}
			}
		}
	}
};

const authored = {
	...emptyAuthoredRuntime,
	policyAuthorizations: functions.authorizations,
	approvalFlows: functions.approvalFlows,
	hooks: { records: authoredHooks(recordHooks) }
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
			service.mutate(
				harness.effectId('create'),
				policySubject,
				'records',
				[{ id, title: 'Draft' }],
				false,
				0,
				{ root: { id, action: 'create' } }
			)
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
			service.mutate(
				harness.effectId('update'),
				policySubject,
				'records',
				[{ id, title: 'Final' }],
				false,
				0,
				{ root: { id, action: 'update' } }
			)
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
				service.mutate(
					harness.effectId('masked-update'),
					writerSubject,
					'records',
					[{ id, status: 'forged' }],
					false,
					0,
					{ root: { id, action: 'update' } }
				)
			)
		);
		// A batch reports its refusal under the phase that raised it and keeps the refusal itself
		// underneath, so the grant denial is read through the wrapper rather than instead of it.
		expect(failure).toBeInstanceOf(Collections.MutationPhaseFailure);
		expect(unwrapMutationPhase(failure)).toBeInstanceOf(AccessControl.AccessDenied);
		expect(events).toEqual([]);
	});

	it('reviews a before-hook sibling write and its root as one concrete flow', async () => {
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
		const versionHooks: CollectionHooks<LifecycleSchema, 'versions'> = {
			mutate: {
				perRecord: {
					before: {
						description: 'Closes the predecessor inside the successor graph.',
						handler: (context) =>
							Effect.gen(function* () {
								if (context.existing !== undefined) return context.input;
								const predecessor = String(context.input.supersedes_id);
								transitionEvents.push(`prepare:${predecessor}`);
								yield* context.api.db.versions.mutate({ id: predecessor, closed_by: successorId });
								return context.input;
							})
					}
				}
			}
		};
		harness = await makeBoltTestRuntime(transitionDefinition, {
			authored: {
				...emptyAuthoredRuntime,
				policyAuthorizations: transitionFunctions.authorizations,
				approvalFlows: transitionFunctions.approvalFlows,
				hooks: { versions: authoredHooks(versionHooks) }
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
							root: { id: successorId, action: 'create' }
						}
					)
				);
			})
		);
		const pending = unwrapMutationPhase(raised);
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
