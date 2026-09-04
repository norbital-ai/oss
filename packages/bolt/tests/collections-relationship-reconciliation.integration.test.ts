import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { approveBy } from '../src/authoring/approval-flow.js';
import { describePolicy } from '../src/authoring/policy-introspection.js';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { AuthoredRefusal } from '../src/authoring/refusal.js';
import { authoredHooks } from '../src/authoring/contracts-schema.js';
import * as Approvals from '../src/runtime/approvals/approvals.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import { SyncCommit } from '../src/runtime/facilities/services.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { unwrapMutationPhase } from './support/mutation-phase.js';

/** Exercises the authored admin-team policy, not the administrator bypass under separate test. */
const policySubject = { ...adminSubject, admin: false };

const WRITERS_TEAM = 'writers';

/**
 * Whether the caller is the restricted writer rather than the administrator.
 *
 * Both roles reach the same coordinates and a coordinate may have exactly one grant, so the two
 * answers this fixture needs live inside one grant's `authorize` instead of in a second policy. The
 * decision api carries the requestor, which is the only thing that can tell them apart.
 */
const isWriter = (api: unknown): boolean => {
	const requestor =
		typeof api === 'object' && api !== null ? Reflect.get(api, 'requestor') : undefined;
	const team =
		typeof requestor === 'object' && requestor !== null
			? Reflect.get(requestor, 'team')
			: undefined;
	return team === WRITERS_TEAM;
};

/**
 * A three-level graph using the relationship metadata the compiler emits for authored workspaces.
 *
 * The parent-side `many` edge names the property exposed to callers. The inverse `one` edge owns
 * the endpoints and therefore the foreign key. Reconciliation must resolve that inverse rather
 * than relying on endpoints being repeated on the `many` declaration.
 */
const relationshipWorkspace = (reviewBudgets = false, reviewCostEstimates = false) => {
	const review = { flow: () => approveBy('reviewers'), superceded_by: [] };
	const write = (reviewed: boolean) => (reviewed ? { approval: review } : {});
	const graphData = describePolicy('graph-data', {
		description:
			'The one owner of every graph coordinate, with review attached to the selected writes.',
		grants: {
			budgets: {
				read: {},
				mutate: {
					new: write(reviewBudgets),
					existing: {
						...write(reviewBudgets),
						authorize: (context: unknown, api: unknown) => {
							if (!isWriter(api)) return true;
							const previous =
								typeof context === 'object' && context !== null
									? Reflect.get(context, 'previous')
									: undefined;
							return (
								typeof previous === 'object' &&
								previous !== null &&
								Reflect.get(previous, 'name') === 'Writer-owned'
							);
						}
					}
				},
				delete: {
					...write(reviewBudgets),
					authorize: (_context: unknown, api: unknown) => !isWriter(api)
				}
			},
			cost_estimates: {
				mutate: {
					new: {
						...write(reviewCostEstimates),
						authorize: (_context: unknown, api: unknown) => !isWriter(api)
					},
					existing: write(reviewCostEstimates)
				},
				read: {},
				delete: write(reviewCostEstimates)
			},
			cost_estimate_lines: { mutate: { new: {}, existing: {} }, read: {}, delete: {} },
			mutation_audit: { mutate: { new: {} }, read: {} }
		}
	});
	return workspace({
		name: 'relationship-reconciliation',
		version: '1.0.0',
		collections: [
			collection({
				name: 'budgets',
				fields: { name: field.string({ required: true }) }
			}),
			collection({
				name: 'cost_estimates',
				fields: {
					budget_id: field.uuid({ required: true }),
					label: field.string({ required: true }),
					amount: field.number({ required: true })
				}
			}),
			collection({
				name: 'cost_estimate_lines',
				fields: {
					cost_estimate_id: field.uuid({ required: true }),
					code: field.string({ required: true }),
					quantity: field.number({ required: true })
				}
			}),
			collection({
				name: 'mutation_audit',
				fields: { body: field.string({ required: true }) }
			})
		],
		relations: [
			{
				name: 'budget_cost_estimates',
				source: 'budgets',
				target: 'cost_estimates',
				cardinality: 'many'
			},
			{
				name: 'cost_estimate_budget',
				source: 'cost_estimates',
				target: 'budgets',
				cardinality: 'one',
				from: { collection: 'cost_estimates', column: 'budget_id' },
				to: { collection: 'budgets', column: 'id' }
			},
			{
				name: 'estimate_lines',
				source: 'cost_estimates',
				target: 'cost_estimate_lines',
				cardinality: 'many'
			},
			{
				name: 'line_estimate',
				source: 'cost_estimate_lines',
				target: 'cost_estimates',
				cardinality: 'one',
				from: { collection: 'cost_estimate_lines', column: 'cost_estimate_id' },
				to: { collection: 'cost_estimates', column: 'id' }
			}
		],
		apps: [
			app({ name: 'budgets', label: 'Budgets' }),
			app({ name: 'approvals', label: 'Approvals' })
		],
		teams: {
			admin: ['graph-data', 'admin-approval'],
			reviewers: ['admin-approval'],
			writers: ['graph-data']
		},
		automations: [],
		integrations: [],
		prompt: 'You are the test workspace agent.',
		tools: [],
		skills: [],
		envoys: [],
		requiredFacilities: [],
		policies: [
			graphData,
			policy({
				name: 'admin-approval',
				effect: 'allow',
				actions: ['approve'],
				capabilities: { apps: ['approvals'] }
			})
		]
	});
};

const definition = relationshipWorkspace();
const withCascadeRelations = (
	base: ReturnType<typeof relationshipWorkspace>,
	names: ReadonlySet<string>
) => ({
	...base,
	relations: base.relations.map((relation) =>
		names.has(relation.name) ? { ...relation, cascade: true } : relation
	)
});
const rootCascadeRelations = new Set(['cost_estimate_budget']);
const rootCascadeDefinition = withCascadeRelations(definition, rootCascadeRelations);
const approvalDefinition = withCascadeRelations(relationshipWorkspace(true), rootCascadeRelations);
const childApprovalDefinition = withCascadeRelations(
	relationshipWorkspace(false, true),
	rootCascadeRelations
);
const inverseCascadeDefinition = withCascadeRelations(
	definition,
	new Set(['cost_estimate_budget', 'line_estimate'])
);
const directManyInverseCascadeDefinition = {
	...rootCascadeDefinition,
	relations: rootCascadeDefinition.relations.map((relation) => {
		if (relation.name === 'budget_cost_estimates')
			return {
				...relation,
				from: { collection: 'cost_estimates', column: 'budget_id' },
				to: { collection: 'budgets', column: 'id' }
			};
		if (relation.name === 'cost_estimate_budget') return { ...relation, cascade: true };
		return relation;
	})
};
const writerSubject = {
	userId: 'writer-1',
	tenantId: 'test-tenant',
	teamPath: ['writers'],
	policies: []
};
const reviewerSubject = {
	userId: '00000000-0000-4000-8000-000000000777',
	tenantId: 'test-tenant',
	teamPath: ['reviewers'],
	policies: []
};

/**
 * The fixture tables as a schema, so the hooks are typed the way a compiled workspace's are.
 *
 * The reconciliation hooks read `input` and `existing` off the schema and never hand a subset back
 * through a variable, so relations stay empty — a nested create graph is only ever written by the
 * caller, not by a hook here.
 */
interface ReconciliationSchema {
	readonly tables: {
		readonly budgets: {
			readonly $inferSelect: { readonly id: string; readonly name: string };
			readonly $inferInsert: { readonly id?: string; readonly name: string };
		};
		readonly cost_estimates: {
			readonly $inferSelect: {
				readonly id: string;
				readonly budget_id: string;
				readonly label: string;
				readonly amount: number;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly budget_id: string;
				readonly label: string;
				readonly amount: number;
			};
		};
		readonly cost_estimate_lines: {
			readonly $inferSelect: {
				readonly id: string;
				readonly cost_estimate_id: string;
				readonly code: string;
				readonly quantity: number;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly cost_estimate_id: string;
				readonly code: string;
				readonly quantity: number;
			};
		};
		readonly mutation_audit: {
			readonly $inferSelect: { readonly id: string; readonly body: string };
			readonly $inferInsert: { readonly id?: string; readonly body: string };
		};
	};
	readonly relations: Record<string, never>;
}

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const mutateBudget = (
	runtime: BoltTestRuntime,
	effectId: string,
	values: Readonly<Record<string, unknown>>
) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			return yield* collections.mutate(EffectId.make(effectId), policySubject, 'budgets', [values]);
		})
	);

const drainChanges = (runtime: BoltTestRuntime) =>
	runtime.runtime.runPromise(Effect.flatMap(SyncCommit.Service, (sync) => sync.drainChanges));

const requiredId = (row: Readonly<Record<string, unknown>> | undefined, label: string): string => {
	const id = row?.['id'];
	if (typeof id !== 'string') throw new Error(`${label} has no id`);
	return id;
};

const approveRequest = (runtime: BoltTestRuntime, effectId: string, requestId: string) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			const approvals = yield* Approvals.Service;
			const requested = yield* approvals.status(EffectId.make(`${effectId}:status`), requestId);
			if (requested === undefined) throw new Error(`approval request ${requestId} is missing`);
			const decided = yield* approvals.decide(
				EffectId.make(`${effectId}:decide`),
				reviewerSubject,
				requested,
				'approve'
			);
			expect(decided._tag).toBe('Approved');
		})
	);

const resumeRequest = (runtime: BoltTestRuntime, effectId: string, requestId: string) =>
	runtime.runtime.runPromise(
		Effect.gen(function* () {
			yield* (yield* Collections.Service).resume(EffectId.make(effectId), requestId);
		})
	);

const deletionHooks = (calls: Array<string>) => ({
	...emptyAuthoredRuntime,
	hooks: {
		cost_estimates: authoredHooks<ReconciliationSchema, 'cost_estimates'>({
			delete: {
				perRecord: {
					before: {
						description: 'Records estimate delete preparation.',
						handler: () => {
							calls.push('estimate.before');
						}
					},
					after: {
						description: 'Records estimate delete settlement.',
						handler: () => {
							calls.push('estimate.after');
						}
					}
				}
			}
		}),
		cost_estimate_lines: authoredHooks<ReconciliationSchema, 'cost_estimate_lines'>({
			delete: {
				perRecord: {
					before: {
						description: 'Records line delete preparation.',
						handler: () => {
							calls.push('line.before');
						}
					},
					after: {
						description: 'Records line delete settlement.',
						handler: () => {
							calls.push('line.after');
						}
					}
				}
			}
		})
	}
});

const budgetUpdateHooks = (calls: Array<string>) => ({
	...emptyAuthoredRuntime,
	hooks: {
		budgets: authoredHooks<ReconciliationSchema, 'budgets'>({
			mutate: {
				perRecord: {
					before: {
						description: 'Records approved root preparation.',
						handler: (context) => {
							if (context.existing === undefined) return context.input;
							calls.push('budget.before');
							return context.input;
						}
					}
				}
			}
		})
	}
});

const seedApprovedBudget = async (runtime: BoltTestRuntime, effectId: string) => {
	const pending = await runtime.runtime.runPromise(
		Effect.flip(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).mutate(
					EffectId.make(`${effectId}:mutate`),
					policySubject,
					'budgets',
					[
						{
							name: 'Reviewed root',
							budget_cost_estimates: [{ label: 'Reviewed child', amount: 10 }]
						}
					]
				);
			})
		)
	);
	if (!(pending instanceof Collections.PendingApproval))
		throw new Error('seed mutation did not request approval');
	await approveRequest(runtime, `${effectId}:approve`, pending.requestId);
	await resumeRequest(runtime, `${effectId}:resume`, pending.requestId);
	return {
		budgetId: requiredId((await runtime.database.query('select id from budgets'))[0], 'budget'),
		childId: requiredId(
			(await runtime.database.query('select id from cost_estimates'))[0],
			'estimate'
		)
	};
};

describe('declarative relationship reconciliation', () => {
	it('resolves direct many endpoints while inheriting cascade from the inverse one edge', () => {
		expect(
			Collections.resolveWritableManyRelation(
				directManyInverseCascadeDefinition,
				'budgets',
				'budget_cost_estimates'
			)
		).toEqual({
			name: 'budget_cost_estimates',
			parentCollection: 'budgets',
			parentColumn: 'id',
			childCollection: 'cost_estimates',
			childColumn: 'budget_id',
			cascade: true
		});
	});

	it('rolls back an allowed root when a child create predicate rejects one graph node', async () => {
		harness = await makeBoltTestRuntime(definition);
		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					return yield* (yield* Collections.Service).mutate(
						EffectId.make('denied-child-create'),
						writerSubject,
						'budgets',
						[
							{
								name: 'Writer-owned',
								budget_cost_estimates: [{ label: 'Denied child', amount: 10 }]
							}
						]
					);
				})
			)
		);
		expect(outcome._tag).toBe('Failure');
		if (outcome._tag === 'Failure')
			expect(unwrapMutationPhase(outcome.failure)).toMatchObject({
				action: 'create',
				resource: 'cost_estimates',
				reason: expect.stringContaining('refused the prepared record')
			});
		expect(await harness.database.query('select id from budgets')).toEqual([]);
		expect(await harness.database.query('select id from cost_estimates')).toEqual([]);
		expect(await drainChanges(harness)).toEqual([]);
	}, 60_000);

	it('rolls back child reconciliation when the root update predicate rejects the row', async () => {
		harness = await makeBoltTestRuntime(definition);
		await mutateBudget(harness, 'denied-root-seed', {
			name: 'Not writer-owned',
			budget_cost_estimates: [{ label: 'Must remain', amount: 10 }]
		});
		const budgetId = requiredId(
			(await harness.database.query('select id from budgets'))[0],
			'budget'
		);
		await drainChanges(harness);

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					return yield* (yield* Collections.Service).mutate(
						EffectId.make('denied-root-update'),
						writerSubject,
						'budgets',
						[{ id: budgetId, budget_cost_estimates: [] }]
					);
				})
			)
		);
		expect(outcome._tag).toBe('Failure');
		expect(await harness.database.query('select name from budgets')).toEqual([
			{ name: 'Not writer-owned' }
		]);
		expect(await harness.database.query('select label from cost_estimates')).toEqual([
			{ label: 'Must remain' }
		]);
		expect(await drainChanges(harness)).toEqual([]);
	}, 60_000);

	it('strips a nested owner key and retains an id-only child without false update side effects', async () => {
		harness = await makeBoltTestRuntime(definition);
		await mutateBudget(harness, 'owner-seed-one', {
			name: 'One',
			budget_cost_estimates: [{ label: 'Retained', amount: 10 }]
		});
		await mutateBudget(harness, 'owner-seed-two', { name: 'Two', budget_cost_estimates: [] });
		const budgets = await harness.database.query('select id, name from budgets order by name');
		const firstId = requiredId(budgets[0], 'first budget');
		const secondId = requiredId(budgets[1], 'second budget');
		const child = (
			await harness.database.query(
				'select id, budget_id, row_version, updated_at from cost_estimates'
			)
		)[0];
		const childId = requiredId(child, 'retained child');
		await drainChanges(harness);

		await mutateBudget(harness, 'owner-retain', {
			id: firstId,
			budget_cost_estimates: [{ id: childId, budget_id: secondId }]
		});

		expect(
			await harness.database.query(
				'select id, budget_id, row_version, updated_at from cost_estimates'
			)
		).toEqual([child]);
		expect(
			(await drainChanges(harness)).filter((change) => change.collection === 'cost_estimates')
		).toEqual([]);
	}, 60_000);

	it('routes the hook-prepared graph and revalidates the same preparation on resume', async () => {
		const calls: Array<string> = [];
		harness = await makeBoltTestRuntime(approvalDefinition, {
			authored: {
				...emptyAuthoredRuntime,
				hooks: {
					budgets: authoredHooks<ReconciliationSchema, 'budgets'>({
						mutate: {
							prepare: () => {
								calls.push('prepare');
								return undefined;
							},
							perRecord: {
								before: {
									description: 'Records the only authored preparation pass.',
									handler: (context) => {
										calls.push('before');
										return context.input;
									}
								}
							}
						}
					})
				}
			}
		});

		const pending = await harness.runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).mutate(
						EffectId.make('approval-hook-probe'),
						policySubject,
						'budgets',
						[
							{
								name: 'Hook once',
								budget_cost_estimates: [{ label: 'Reviewed child', amount: 10 }]
							}
						]
					);
				})
			)
		);
		expect(pending).toBeInstanceOf(Collections.PendingApproval);
		expect(calls).toEqual(['prepare', 'before']);
		if (!(pending instanceof Collections.PendingApproval)) return;

		await approveRequest(harness, 'approval-hook-probe', pending.requestId);
		expect(calls).toEqual(['prepare', 'before']);
		await resumeRequest(harness, 'approval-hook-resume', pending.requestId);

		expect(calls).toEqual(['prepare', 'before', 'prepare', 'before']);
		expect(await harness.database.query('select name from budgets')).toEqual([
			{ name: 'Hook once' }
		]);
		expect(await harness.database.query('select label from cost_estimates')).toEqual([
			{ label: 'Reviewed child' }
		]);
	}, 60_000);

	it('keeps before-hook writes staged when later hook preparation fails', async () => {
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...emptyAuthoredRuntime,
				hooks: {
					budgets: authoredHooks<ReconciliationSchema, 'budgets'>({
						mutate: {
							perRecord: {
								before: {
									description: 'Stages an audit and then refuses the parent.',
									handler: ({ input, api }) =>
										Effect.gen(function* () {
											yield* api.db.mutation_audit.mutate([{ body: 'must roll back' }]);
											return yield* Effect.fail(
												new AuthoredRefusal({ message: 'parent preparation failed' })
											);
										})
								}
							}
						}
					})
				}
			}
		});

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).mutate(
						EffectId.make('failing-before-hook'),
						policySubject,
						'budgets',
						[{ name: 'Rejected by hook' }],
						false,
						0,
						{}
					);
				})
			)
		);

		expect(outcome._tag).toBe('Failure');
		expect(await harness.database.query('select id from budgets')).toEqual([]);
		expect(await harness.database.query('select id from mutation_audit')).toEqual([]);
	}, 60_000);

	it('stores one approval for the root graph and reconciles it atomically after approval', async () => {
		harness = await makeBoltTestRuntime(approvalDefinition);
		const failure = await harness.runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					return yield* (yield* Collections.Service).mutate(
						EffectId.make('approval-graph'),
						policySubject,
						'budgets',
						[
							{
								name: 'Approved whole',
								budget_cost_estimates: [{ label: 'One child', amount: 25 }]
							}
						]
					);
				})
			)
		);
		expect(failure).toBeInstanceOf(Collections.PendingApproval);
		if (!(failure instanceof Collections.PendingApproval)) return;

		// No provisional fragment is visible: the root and explicitly included relationship settle
		// together only after the single stored root operation reaches its final approval.
		expect(await harness.database.query('select id from budgets')).toEqual([]);
		expect(await harness.database.query('select id from cost_estimates')).toEqual([]);
		const state = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).status(
					EffectId.make('approval-graph-status'),
					failure.requestId
				);
			})
		);
		expect(state?._tag).toBe('Pending');
		if (state === undefined) return;

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const approvals = yield* Approvals.Service;
				const collections = yield* Collections.Service;
				const decided = yield* approvals.decide(
					EffectId.make('approval-graph-decide'),
					reviewerSubject,
					state,
					'approve'
				);
				expect(decided._tag).toBe('Approved');
				yield* collections.resume(EffectId.make('approval-graph-resume'), failure.requestId);
			})
		);

		const budgets = await harness.database.query('select id, name from budgets');
		const budgetId = requiredId(budgets[0], 'approved budget');
		expect(budgets).toEqual([{ id: budgetId, name: 'Approved whole' }]);
		expect(
			await harness.database.query('select budget_id, label, amount from cost_estimates')
		).toEqual([{ budget_id: budgetId, label: 'One child', amount: 25 }]);

		const updateFailure = await harness.runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					return yield* (yield* Collections.Service).mutate(
						EffectId.make('approval-graph-update'),
						policySubject,
						'budgets',
						[
							{
								id: budgetId,
								name: 'Approved replacement',
								budget_cost_estimates: [{ label: 'Replacement', amount: 40 }]
							}
						]
					);
				})
			)
		);
		expect(updateFailure).toBeInstanceOf(Collections.PendingApproval);
		if (!(updateFailure instanceof Collections.PendingApproval)) return;
		// Pending replacement has only locked the root. Its scalar patch, inserted child and omitted
		// child deletion are all still absent until the same resumed transaction can apply them.
		expect(await harness.database.query('select name from budgets')).toEqual([
			{ name: 'Approved whole' }
		]);
		expect(await harness.database.query('select label, amount from cost_estimates')).toEqual([
			{ label: 'One child', amount: 25 }
		]);

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const approvals = yield* Approvals.Service;
				const collections = yield* Collections.Service;
				const requested = yield* approvals.status(
					EffectId.make('approval-graph-update-status'),
					updateFailure.requestId
				);
				if (requested === undefined) throw new Error('update approval request is missing');
				const decided = yield* approvals.decide(
					EffectId.make('approval-graph-update-decide'),
					reviewerSubject,
					requested,
					'approve'
				);
				expect(decided._tag).toBe('Approved');
				yield* collections.resume(
					EffectId.make('approval-graph-update-resume'),
					updateFailure.requestId
				);
			})
		);
		expect(await harness.database.query('select name, approval_id from budgets')).toEqual([
			{ name: 'Approved replacement', approval_id: null }
		]);
		expect(await harness.database.query('select label, amount from cost_estimates')).toEqual([
			{ label: 'Replacement', amount: 40 }
		]);
	}, 60_000);

	it('exposes the proposed graph to a generic approver and lets that approver decide it', async () => {
		harness = await makeBoltTestRuntime(approvalDefinition);
		const reviewerTeamId = '00000000-0000-4000-8000-000000000778';
		await harness.database.query('insert into team (id, name) values ($1, $2)', [
			reviewerTeamId,
			'reviewers'
		]);
		await harness.database.query(
			'insert into "user" (id, name, "emailVerified", status, "tenantId", team_id) values ($1, $2, false, $3, $4, $5)',
			[reviewerSubject.userId, 'Reviewer', 'normal', reviewerSubject.tenantId, reviewerTeamId]
		);

		const pending = await harness.runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).mutate(
						EffectId.make('generic-approval-inbox'),
						policySubject,
						'budgets',
						[
							{
								name: 'Visible proposal',
								budget_cost_estimates: [{ label: 'Visible child', amount: 12 }]
							}
						]
					);
				})
			)
		);
		expect(pending).toBeInstanceOf(Collections.PendingApproval);
		if (!(pending instanceof Collections.PendingApproval)) return;

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const approvals = yield* Approvals.Service;
				const request = yield* collections.findFirst(
					EffectId.make('generic-approval-inbox-read'),
					reviewerSubject,
					{
						collection: 'approval_request',
						where: { id: { eq: pending.requestId } }
					}
				);
				expect(request).toMatchObject({
					id: pending.requestId,
					status: 'ONGOING',
					proposed_values: {
						name: 'Visible proposal',
						budget_cost_estimates: [{ label: 'Visible child', amount: 12 }]
					}
				});
				const state = yield* approvals.status(
					EffectId.make('generic-approval-inbox-status'),
					pending.requestId
				);
				if (state === undefined) throw new Error('generic approval request is missing');
				const decided = yield* approvals.decide(
					EffectId.make('generic-approval-inbox-decide'),
					reviewerSubject,
					state,
					'approve'
				);
				expect(decided._tag).toBe('Approved');
			})
		);
	}, 60_000);

	it('rejects pending child row drift before hooks and releases the reviewed root lock', async () => {
		const calls: Array<string> = [];
		harness = await makeBoltTestRuntime(approvalDefinition, {
			authored: budgetUpdateHooks(calls)
		});
		const { budgetId, childId } = await seedApprovedBudget(harness, 'approval-row-drift-seed');

		const pending = await harness.runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).mutate(
						EffectId.make('approval-row-drift'),
						policySubject,
						'budgets',
						[
							{
								id: budgetId,
								name: 'Approved root edit',
								budget_cost_estimates: [{ id: childId, label: 'Approved child edit', amount: 20 }]
							}
						]
					);
				})
			)
		);
		expect(pending).toBeInstanceOf(Collections.PendingApproval);
		expect(calls).toEqual(['budget.before']);
		if (!(pending instanceof Collections.PendingApproval)) return;
		expect(
			await harness.database.query('select approval_id from budgets where id = $1', [budgetId])
		).toEqual([{ approval_id: pending.requestId }]);

		await harness.database.query('update cost_estimates set amount = $1 where id = $2', [
			11,
			childId
		]);
		await approveRequest(harness, 'approval-row-drift', pending.requestId);
		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).resume(
						EffectId.make('approval-row-drift-resume'),
						pending.requestId
					);
				})
			)
		);

		expect(outcome._tag).toBe('Failure');
		expect(calls).toEqual(['budget.before', 'budget.before']);
		const conflicted = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).status(
					EffectId.make('approval-row-drift-conflicted'),
					pending.requestId
				);
			})
		);
		expect(conflicted).toMatchObject({
			_tag: 'Conflicted',
			reason: 'the reviewed mutation graph changed while approval was pending'
		});
		expect(
			await harness.database.query('select status from approval_request where id = $1', [
				pending.requestId
			])
		).toEqual([{ status: 'CONFLICTED' }]);
		expect(await harness.database.query('select name, approval_id from budgets')).toEqual([
			{ name: 'Reviewed root', approval_id: null }
		]);
		expect(await harness.database.query('select label, amount from cost_estimates')).toEqual([
			{ label: 'Reviewed child', amount: 11 }
		]);
	}, 60_000);

	it('rejects pending relationship edge drift before hooks and releases the reviewed root lock', async () => {
		const calls: Array<string> = [];
		harness = await makeBoltTestRuntime(approvalDefinition, {
			authored: budgetUpdateHooks(calls)
		});
		const { budgetId, childId } = await seedApprovedBudget(harness, 'approval-edge-drift-seed');

		const pending = await harness.runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).mutate(
						EffectId.make('approval-edge-drift'),
						policySubject,
						'budgets',
						[
							{
								id: budgetId,
								name: 'Approved root edit',
								budget_cost_estimates: [{ id: childId, label: 'Approved child edit', amount: 20 }]
							}
						]
					);
				})
			)
		);
		expect(pending).toBeInstanceOf(Collections.PendingApproval);
		expect(calls).toEqual(['budget.before']);
		if (!(pending instanceof Collections.PendingApproval)) return;

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).mutate(
					EffectId.make('approval-edge-drift-child'),
					policySubject,
					'cost_estimates',
					[
						{
							id: '00000000-0000-4000-8000-000000000099',
							budget_id: budgetId,
							label: 'Late child',
							amount: 99
						}
					],
					false,
					0,
					{
						roots: [{ id: '00000000-0000-4000-8000-000000000099', action: 'create' }]
					}
				);
			})
		);
		await approveRequest(harness, 'approval-edge-drift', pending.requestId);
		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).resume(
						EffectId.make('approval-edge-drift-resume'),
						pending.requestId
					);
				})
			)
		);

		expect(outcome._tag).toBe('Failure');
		expect(calls).toEqual(['budget.before', 'budget.before']);
		expect(await harness.database.query('select name, approval_id from budgets')).toEqual([
			{ name: 'Reviewed root', approval_id: null }
		]);
		expect(
			await harness.database.query('select label, amount from cost_estimates order by label')
		).toEqual([
			{ label: 'Late child', amount: 99 },
			{ label: 'Reviewed child', amount: 10 }
		]);
	}, 60_000);

	it('refuses a graph whose child is still locked by a decided approval that has not resumed', async () => {
		harness = await makeBoltTestRuntime(childApprovalDefinition);
		const initial = await harness.runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					return yield* (yield* Collections.Service).mutate(
						EffectId.make('locked-child-seed'),
						policySubject,
						'budgets',
						[
							{
								name: 'Locked child',
								budget_cost_estimates: [{ label: 'Original', amount: 10 }]
							}
						]
					);
				})
			)
		);
		expect(initial).toBeInstanceOf(Collections.PendingApproval);
		if (!(initial instanceof Collections.PendingApproval)) return;
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const approvals = yield* Approvals.Service;
				const requested = yield* approvals.status(
					EffectId.make('locked-child-seed-status'),
					initial.requestId
				);
				if (requested === undefined) throw new Error('seed approval missing');
				yield* approvals.decide(
					EffectId.make('locked-child-seed-decide'),
					reviewerSubject,
					requested,
					'approve'
				);
				yield* (yield* Collections.Service).resume(
					EffectId.make('locked-child-seed-resume'),
					initial.requestId
				);
			})
		);
		const budgetId = requiredId(
			(await harness.database.query('select id from budgets'))[0],
			'budget'
		);
		const childId = requiredId(
			(await harness.database.query('select id from cost_estimates'))[0],
			'child'
		);

		const childPending = await harness.runtime.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).mutate(
						EffectId.make('locked-child-update'),
						policySubject,
						'cost_estimates',
						[{ id: childId, amount: 11 }],
						false,
						0,
						{ roots: [{ id: childId, action: 'update' }] }
					);
				})
			)
		);
		expect(childPending).toBeInstanceOf(Collections.PendingApproval);
		if (!(childPending instanceof Collections.PendingApproval)) return;
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const approvals = yield* Approvals.Service;
				const requested = yield* approvals.status(
					EffectId.make('locked-child-update-status'),
					childPending.requestId
				);
				if (requested === undefined) throw new Error('child approval missing');
				yield* approvals.decide(
					EffectId.make('locked-child-update-decide'),
					reviewerSubject,
					requested,
					'approve'
				);
			})
		);

		const graph = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					return yield* (yield* Collections.Service).mutate(
						EffectId.make('locked-child-graph'),
						policySubject,
						'budgets',
						[
							{
								id: budgetId,
								budget_cost_estimates: [{ id: childId, amount: 12 }]
							}
						]
					);
				})
			)
		);
		expect(graph._tag).toBe('Failure');
		expect(await harness.database.query('select amount from cost_estimates')).toEqual([
			{ amount: 10 }
		]);
	}, 60_000);

	it('creates a root and children, then updates, inserts, and deletes to match the desired state', async () => {
		harness = await makeBoltTestRuntime(rootCascadeDefinition);

		await mutateBudget(harness, 'reconcile-create', {
			name: 'FY27 operating budget',
			budget_cost_estimates: [
				{ label: 'Hardware', amount: 200 },
				{ label: 'Labour', amount: 100 }
			]
		});

		const budgets = await harness.database.query('select id, name from budgets');
		const created = await harness.database.query(
			'select id, budget_id, label, amount from cost_estimates order by label'
		);
		const budgetId = requiredId(budgets[0], 'budget');
		const hardwareId = requiredId(created[0], 'hardware estimate');
		const labourId = requiredId(created[1], 'labour estimate');
		expect(created.map((row) => row['budget_id'])).toEqual([budgetId, budgetId]);

		await mutateBudget(harness, 'reconcile-replace', {
			id: budgetId,
			name: 'FY27 approved budget',
			budget_cost_estimates: [
				{ id: labourId, label: 'Labour revised', amount: 125 },
				{ label: 'Travel', amount: 75 }
			]
		});

		const storedBudget = await harness.database.query('select id, name from budgets');
		const storedEstimates = await harness.database.query(
			'select id, budget_id, label, amount from cost_estimates order by label'
		);
		expect(storedBudget).toEqual([{ id: budgetId, name: 'FY27 approved budget' }]);
		expect(storedEstimates).toHaveLength(2);
		expect(storedEstimates).toEqual([
			{ id: labourId, budget_id: budgetId, label: 'Labour revised', amount: 125 },
			{
				id: expect.any(String),
				budget_id: budgetId,
				label: 'Travel',
				amount: 75
			}
		]);
		expect(storedEstimates.some((row) => row['id'] === hardwareId)).toBe(false);
	}, 60_000);

	/**
	 * Reconciling a non-owned edge is all of it or none of it.
	 *
	 * Omission-delete belongs to an owned edge alone, so a `many` the parent does not own cannot
	 * read absence as "delete these" — and it does not read it as "keep these" either. A payload
	 * that names the edge and leaves stored members out is refused, because the two readings are
	 * indistinguishable from the caller's side and silently choosing one loses whichever the caller
	 * meant. Omitting the *key* is a different statement and still says nothing about the children.
	 */
	it('refuses an omission on a non-owned edge and reconciles the full set', async () => {
		harness = await makeBoltTestRuntime(definition);
		await mutateBudget(harness, 'omission-create', {
			name: 'Draft',
			budget_cost_estimates: [
				{ label: 'A', amount: 10 },
				{ label: 'B', amount: 20 }
			]
		});
		const budgetId = requiredId(
			(await harness.database.query('select id from budgets'))[0],
			'budget'
		);
		const before = await harness.database.query(
			'select id, budget_id, label, amount from cost_estimates order by label'
		);
		const firstId = requiredId(before[0], 'first estimate');
		const secondId = requiredId(before[1], 'second estimate');

		await mutateBudget(harness, 'omission-update', { id: budgetId, name: 'Still populated' });
		expect(
			await harness.database.query(
				'select id, budget_id, label, amount from cost_estimates order by label'
			)
		).toEqual(before);

		const partial = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).mutate(
						EffectId.make('non-owned-omission'),
						policySubject,
						'budgets',
						[
							{
								id: budgetId,
								budget_cost_estimates: [{ id: firstId, label: 'A revised', amount: 11 }]
							}
						]
					);
				})
			)
		);
		expect(partial._tag).toBe('Failure');
		if (partial._tag === 'Failure')
			expect(unwrapMutationPhase(partial.failure)).toMatchObject({
				collection: 'cost_estimates',
				action: 'update',
				message: expect.stringContaining('not cascade-owned')
			});
		expect(
			await harness.database.query(
				'select id, budget_id, label, amount from cost_estimates order by label'
			)
		).toEqual(before);

		// The same write, stated in full: every stored member named, one edited and one added.
		await mutateBudget(harness, 'non-owned-reconcile', {
			id: budgetId,
			budget_cost_estimates: [
				{ id: firstId, label: 'A revised', amount: 11 },
				{ id: secondId, label: 'B', amount: 20 },
				{ label: 'C', amount: 30 }
			]
		});
		expect(
			await harness.database.query(
				'select id, budget_id, label, amount from cost_estimates order by label'
			)
		).toEqual([
			{ id: firstId, budget_id: budgetId, label: 'A revised', amount: 11 },
			before[1],
			{ id: expect.any(String), budget_id: budgetId, label: 'C', amount: 30 }
		]);
	}, 60_000);

	it('does not plan descendant deletion across a non-cascade edge', async () => {
		const calls: Array<string> = [];
		harness = await makeBoltTestRuntime(rootCascadeDefinition, {
			authored: deletionHooks(calls)
		});
		await mutateBudget(harness, 'noncascade-seed', {
			name: 'Protected descendants',
			budget_cost_estimates: [
				{
					label: 'Protected estimate',
					amount: 10,
					estimate_lines: [{ code: 'LOCKED', quantity: 1 }]
				}
			]
		});
		const budgetId = requiredId(
			(await harness.database.query('select id from budgets'))[0],
			'budget'
		);
		const estimateId = requiredId(
			(await harness.database.query('select id from cost_estimates'))[0],
			'estimate'
		);
		const lineId = requiredId(
			(await harness.database.query('select id from cost_estimate_lines'))[0],
			'line'
		);

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					yield* (yield* Collections.Service).mutate(
						EffectId.make('noncascade-omit-estimate'),
						policySubject,
						'budgets',
						[{ id: budgetId, budget_cost_estimates: [] }]
					);
				})
			)
		);

		expect(outcome._tag).toBe('Failure');
		// The omitted estimate is planned, but its non-cascade descendant is left to the foreign-key
		// restriction. In particular, the engine must not invent a line delete or run its hooks.
		expect(calls).toEqual(['estimate.before']);
		expect(await harness.database.query('select id from cost_estimates')).toEqual([
			{ id: estimateId }
		]);
		expect(await harness.database.query('select id from cost_estimate_lines')).toEqual([
			{ id: lineId }
		]);
	}, 60_000);

	it('uses inverse-one cascade metadata to delete descendants through canonical hooks', async () => {
		const calls: Array<string> = [];
		harness = await makeBoltTestRuntime(inverseCascadeDefinition, {
			authored: deletionHooks(calls)
		});
		await mutateBudget(harness, 'inverse-cascade-seed', {
			name: 'Cascade descendants',
			budget_cost_estimates: [
				{
					label: 'Cascade estimate',
					amount: 10,
					estimate_lines: [{ code: 'DELETE', quantity: 1 }]
				}
			]
		});
		const budgetId = requiredId(
			(await harness.database.query('select id from budgets'))[0],
			'budget'
		);

		await mutateBudget(harness, 'inverse-cascade-omit-estimate', {
			id: budgetId,
			budget_cost_estimates: []
		});

		expect(calls).toEqual(['estimate.before', 'line.before', 'line.after', 'estimate.after']);
		expect(await harness.database.query('select id from cost_estimates')).toEqual([]);
		expect(await harness.database.query('select id from cost_estimate_lines')).toEqual([]);
	}, 60_000);

	it('synchronizes an explicitly included grandchild relation while an omitted sibling relation is untouched', async () => {
		harness = await makeBoltTestRuntime(inverseCascadeDefinition);
		await mutateBudget(harness, 'recursive-create', {
			name: 'Recursive',
			budget_cost_estimates: [
				{
					label: 'A',
					amount: 10,
					estimate_lines: [
						{ code: 'A-1', quantity: 1 },
						{ code: 'A-2', quantity: 2 }
					]
				},
				{
					label: 'B',
					amount: 20,
					estimate_lines: [
						{ code: 'B-1', quantity: 3 },
						{ code: 'B-2', quantity: 4 }
					]
				}
			]
		});

		const budgetId = requiredId(
			(await harness.database.query('select id from budgets'))[0],
			'budget'
		);
		const estimates = await harness.database.query(
			'select id, label from cost_estimates order by label'
		);
		const estimateAId = requiredId(estimates[0], 'estimate A');
		const estimateBId = requiredId(estimates[1], 'estimate B');
		const linesA = await harness.database.query(
			'select id, cost_estimate_id, code, quantity from cost_estimate_lines where cost_estimate_id = $1 order by code',
			[estimateAId]
		);
		const lineA1Id = requiredId(linesA[0], 'line A-1');
		const lineA2Id = requiredId(linesA[1], 'line A-2');
		const linesBBefore = await harness.database.query(
			'select id, cost_estimate_id, code, quantity from cost_estimate_lines where cost_estimate_id = $1 order by code',
			[estimateBId]
		);

		await mutateBudget(harness, 'recursive-replace', {
			id: budgetId,
			budget_cost_estimates: [
				{
					id: estimateAId,
					estimate_lines: [
						{ id: lineA1Id, code: 'A-1 revised', quantity: 5 },
						{ code: 'A-3', quantity: 6 }
					]
				},
				{ id: estimateBId }
			]
		});

		const linesAAfter = await harness.database.query(
			'select id, cost_estimate_id, code, quantity from cost_estimate_lines where cost_estimate_id = $1 order by code',
			[estimateAId]
		);
		expect(linesAAfter).toEqual([
			{
				id: lineA1Id,
				cost_estimate_id: estimateAId,
				code: 'A-1 revised',
				quantity: 5
			},
			{
				id: expect.any(String),
				cost_estimate_id: estimateAId,
				code: 'A-3',
				quantity: 6
			}
		]);
		expect(linesAAfter.some((row) => row['id'] === lineA2Id)).toBe(false);
		expect(
			await harness.database.query(
				'select id, cost_estimate_id, code, quantity from cost_estimate_lines where cost_estimate_id = $1 order by code',
				[estimateBId]
			)
		).toEqual(linesBBefore);
	}, 60_000);

	it('loads every submitted relationship frontier in one planning statement', async () => {
		harness = await makeBoltTestRuntime(inverseCascadeDefinition);
		await mutateBudget(harness, 'planning-wave-seed', {
			name: 'One relationship wave',
			budget_cost_estimates: Array.from({ length: 8 }, (_, index) => ({
				label: `Estimate ${index}`,
				amount: index + 1,
				estimate_lines: [{ code: `LINE-${index}`, quantity: index + 1 }]
			}))
		});
		const budgetId = requiredId(
			(await harness.database.query('select id from budgets'))[0],
			'budget'
		);
		const estimates = await harness.database.query(
			'select id, label, amount from cost_estimates order by label'
		);
		const lines = await harness.database.query(
			'select id, cost_estimate_id, code, quantity from cost_estimate_lines order by code'
		);
		const lineByEstimate = new Map(lines.map((line) => [line['cost_estimate_id'], line]));

		harness.database.forget();
		await mutateBudget(harness, 'planning-wave-update', {
			id: budgetId,
			budget_cost_estimates: estimates.map((estimate) => {
				const estimateId = requiredId(estimate, 'estimate');
				const line = lineByEstimate.get(estimateId);
				return {
					id: estimateId,
					label: estimate['label'],
					amount: estimate['amount'],
					estimate_lines: [
						{
							id: requiredId(line, 'line'),
							code: line?.['code'],
							quantity: line?.['quantity']
						}
					]
				};
			})
		});

		const wavePlanning = harness.database.statements.filter((statement) =>
			statement.includes('__bolt_write_wave_kind')
		);
		// The engine's own wave read answers the root alone; the declarative graph's shared wave read
		// answers every submitted pre-image and relationship membership in one statement — one VALUES
		// list per collection or relation edge, not one UNION ALL branch per id. Eight estimates and
		// eight lines share two row branches; the budget's estimates and each estimate's lines share
		// two relation branches. Four branches, three `union all`s. No recursive prepareNode fallback
		// may open another row or relation statement.
		expect(wavePlanning).toHaveLength(2);
		expect(wavePlanning[1]?.match(/ union all /g)).toHaveLength(3);
		expect(
			harness.database.statements.some(
				(statement) =>
					statement.includes('__bolt_graph_row_ordinal') ||
					statement.includes('__bolt_relation_ordinal')
			)
		).toBe(false);
	}, 60_000);

	it('rolls back the entire graph when a new child omits a required field', async () => {
		harness = await makeBoltTestRuntime(definition);
		await mutateBudget(harness, 'rollback-create', {
			name: 'Before',
			budget_cost_estimates: [{ label: 'Existing', amount: 10 }]
		});
		const budgetId = requiredId(
			(await harness.database.query('select id from budgets'))[0],
			'budget'
		);
		const estimateId = requiredId(
			(await harness.database.query('select id from cost_estimates'))[0],
			'estimate'
		);

		const outcome = await harness.runtime.runPromise(
			Effect.result(
				Effect.gen(function* () {
					const collections = yield* Collections.Service;
					return yield* collections.mutate(
						EffectId.make('rollback-invalid'),
						policySubject,
						'budgets',
						[
							{
								id: budgetId,
								name: 'Must roll back',
								budget_cost_estimates: [
									{ id: estimateId, label: 'Also rolled back', amount: 99 },
									{ amount: 30 }
								]
							}
						]
					);
				})
			)
		);

		expect(outcome._tag).toBe('Failure');
		expect(await harness.database.query('select id, name from budgets')).toEqual([
			{ id: budgetId, name: 'Before' }
		]);
		expect(
			await harness.database.query('select id, budget_id, label, amount from cost_estimates')
		).toEqual([
			{
				id: estimateId,
				budget_id: budgetId,
				label: 'Existing',
				amount: 10
			}
		]);
	}, 60_000);
});
