import { Cause, Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { authoredHooks, type CollectionHooks } from '../src/authoring/contracts-schema.js';
import { approveBy } from '../src/authoring/approval-flow.js';
import { fixtureUserId, seedSession } from './support/fixture-identity.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../src/authoring/policy-introspection.js';
import { refuse } from '../src/authoring/refusal.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import * as Collections from '../src/runtime/collections/collections.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	testWorkspace
} from './support/bolt-test-layer.js';

interface PeopleSchema {
	readonly tables: {
		readonly people: {
			readonly $inferSelect: {
				readonly id: string;
				readonly name: string;
				readonly team: string | null;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly name: string;
				readonly team?: string | null;
			};
		};
	};
	readonly relations: Record<string, never>;
}

describe('hook read consistency at commit and approval reservation', () => {
	for (const gated of [false, true]) {
		for (const shared of [false, true]) {
			for (const counted of [false, true]) {
				it(`${gated ? 'approval' : 'direct'} ${counted ? 'count' : 'rows'} read ${shared ? 'refuses competing phantom' : 'allows unrelated reservations'}`, async () => {
					let readers = 0;
					const barrier = Promise.withResolvers<void>();
					const hooks: CollectionHooks<PeopleSchema, 'people'> = {
						mutate: {
							perRecord: {
								before: {
									description: 'One settled or reserved place per team.',
									handler: ({ input, api }) =>
										Effect.gen(function* () {
											const query = { where: { team: { eq: input.team ?? '' } } };
											const count = counted
												? yield* api.db.people.count(query)
												: (yield* api.db.people.findMany(query)).length;
											const pending = yield* api.db.people.findPending({
												where: { team: { eq: input.team ?? '' } }
											});
											if (count + pending.length > 0)
												refuse('This team already has its place reserved.');
											if (++readers === 2) barrier.resolve();
											yield* Effect.promise(() => barrier.promise);
											return input;
										})
								}
							}
						}
					};
					const declaration = {
						description: 'One place with optional review.',
						grants: {
							people: {
								read: {},
								mutate: {
									new: gated
										? { approval: { flow: () => approveBy('admin'), superceded_by: [] } }
										: {}
								}
							}
						}
					};
					const definition = testWorkspace({ policies: [describePolicy('admin', declaration)] });

					const harness = await makeBoltTestRuntime(definition, {
						authored: {
							...emptyAuthoredRuntime,
							approvalFlows: policyRuntimeFunctionsFor(definition.policies).approvalFlows,
							policyAuthorizations: policyRuntimeFunctionsFor(definition.policies).authorizations,
							hooks: { people: authoredHooks(hooks) }
						}
					});
					try {
						await seedSession(harness, {
							token: 'requestor-session',
							user: 'requestor',
							team: 'admin'
						});
						const results = await Promise.all(
							['first', 'second'].map((name) =>
								harness.runtime.runPromiseExit(
									Effect.gen(function* () {
										const collections = yield* Collections.Service;
										const id = recordId(`last-place-${name}`);
										return yield* collections.mutate(
											harness.effectId(name),
											{ ...adminSubject, userId: fixtureUserId('requestor'), admin: false },
											'people',
											[{ id, name, team: shared ? 'last-place' : name }],
											false,
											0,
											{ roots: [{ id, action: 'create' }] }
										);
									})
								)
							)
						);
						expect(readers).toBe(2);
						if (!gated) expect(results.filter(Exit.isSuccess)).toHaveLength(shared ? 1 : 2);
						if (shared)
							expect(
								results.some(
									(result) =>
										Exit.isFailure(result) &&
										(Cause.pretty(result.cause) + JSON.stringify(result)).includes(
											'Refresh and retry'
										)
								)
							).toBe(true);
						const collection = gated ? 'approval_request' : 'people';
						const rows = await harness.database.query(`select id from ${collection}`);
						expect(
							rows,
							results
								.map((result) => (Exit.isFailure(result) ? Cause.pretty(result.cause) : 'success'))
								.join('\n')
						).toHaveLength(shared ? 1 : 2);
					} finally {
						barrier.resolve();
						await harness.dispose();
					}
				}, 30_000);
			}
		}
	}
});
