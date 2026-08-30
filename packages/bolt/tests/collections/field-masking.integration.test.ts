import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Exit, Option } from 'effect';
import { describePolicy } from '../../src/authoring/policy-introspection.js';
import { collection, field, workspace } from '../../src/authoring/workspace-schema.js';
import { authoredHooks, type CollectionHooks } from '../../src/authoring/contracts-schema.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import type * as Identity from '../../src/runtime/identity/identity.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';
import { unwrapMutationPhase } from '../support/mutation-phase.js';

const definition = workspace({
	name: 'field-masking',
	version: '1',
	collections: [
		collection({
			name: 'assignments',
			fields: {
				title: field.string({ required: true }),
				controller_note: field.string(),
				source: field.string()
			}
		})
	],
	apps: [],
	/**
	 * One policy owns every `assignments` coordinate, because a coordinate may have exactly one
	 * owner. The unmasked half of this fixture is the administrator bypass rather than a second
	 * grant: `adminSubject` carries `admin: true`, which reaches an authored collection whole and is
	 * how a real workspace expresses "sees everything" beside a field-masked role.
	 */
	policies: [
		describePolicy('field-worker', {
			description: 'May work only with the public assignment fields.',
			grants: {
				assignments: {
					read: { fields: ['id', 'title'] },
					mutate: { new: { fields: ['title'] }, existing: { fields: ['title'] } }
				}
			}
		})
	],
	teams: { 'field-worker': ['field-worker'] },
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'Test workspace.',
	tools: [],
	skills: [],
	requiredFacilities: []
});

const fieldWorker: Identity.Subject = {
	userId: 'worker-1',
	tenantId: 'test-tenant',
	teamPath: ['field-worker'],
	policies: []
};

/** The fixture as a schema, so the hooks are typed the way a compiled workspace's are. */
interface MaskingSchema {
	readonly tables: {
		readonly assignments: {
			readonly $inferSelect: {
				readonly id: string;
				readonly title: string;
				readonly controller_note: string;
				readonly source: string;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly title: string;
				readonly controller_note?: string;
				readonly source?: string;
			};
		};
	};
	readonly relations: Record<string, never>;
}

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('authored policy field masks', () => {
	it('omits forbidden fields from collection reads', async () => {
		harness = await makeBoltTestRuntime(definition);
		const id = recordId('masked-assignment');
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.mutate(
					harness!.effectId('create'),
					adminSubject,
					'assignments',
					[{ id, title: 'Inspect site', controller_note: 'Do not disclose' }],
					false,
					0,
					{ root: { id, action: 'create' } }
				);
			})
		);

		const rows = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).findMany(
					harness!.effectId('read'),
					fieldWorker,
					{ collection: 'assignments' }
				);
			})
		);

		expect(rows).toEqual([{ id, row_version: 1, title: 'Inspect site' }]);
		expect(JSON.stringify(rows)).not.toContain('controller_note');
		expect(JSON.stringify(rows)).not.toContain('Do not disclose');
	});

	it('checks caller fields before update hooks and permits server-derived fields', async () => {
		const assignmentHooks: CollectionHooks<MaskingSchema, 'assignments'> = {
			mutate: {
				perRecord: {
					before: {
						description: 'Attempts to add a controller-only note.',
						handler: (context) =>
							context.existing === undefined
								? context.input
								: { ...context.input, controller_note: 'injected by hook' }
					}
				}
			}
		};
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...emptyAuthoredRuntime,
				hooks: { assignments: authoredHooks(assignmentHooks) }
			}
		});
		const id = recordId('hooked-assignment');
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).mutate(
					harness!.effectId('create'),
					adminSubject,
					'assignments',
					[{ id, title: 'Original', controller_note: 'Private' }],
					false,
					0,
					{ root: { id, action: 'create' } }
				);
			})
		);

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).mutate(
					harness!.effectId('restricted-update'),
					fieldWorker,
					'assignments',
					[{ id, title: 'Changed' }],
					false,
					0,
					{ root: { id, action: 'update' } }
				);
			})
		);
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).mutate(
					harness!.effectId('restricted-declarative-update'),
					fieldWorker,
					'assignments',
					[{ id, title: 'Changed through graph' }],
					false,
					0,
					{ root: { id, action: 'update' } }
				);
			})
		);

		const [record] = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).findMany(
					harness!.effectId('verify'),
					adminSubject,
					{ collection: 'assignments' }
				);
			})
		);
		expect(record).toMatchObject({
			title: 'Changed through graph',
			controller_note: 'injected by hook'
		});
	});

	it('rejects forged create fields before hooks while allowing server-computed fields', async () => {
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...emptyAuthoredRuntime,
				hooks: {
					assignments: authoredHooks<MaskingSchema, 'assignments'>({
						mutate: {
							perRecord: {
								before: {
									description: 'Owns the controller-only provenance field.',
									handler: (context) =>
										context.existing === undefined
											? { title: String(context.input.title), source: 'server-computed' }
											: context.input
								}
							}
						}
					})
				}
			}
		});

		const forgedId = recordId('forged-create');
		const forged = await harness.runtime.runPromiseExit(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).mutate(
					harness!.effectId('forged-create'),
					fieldWorker,
					'assignments',
					[{ id: forgedId, title: 'Forged', source: 'caller-forged' }],
					false,
					0,
					{ root: { id: forgedId, action: 'create' } }
				);
			})
		);
		const refusal = Option.getOrUndefined(Exit.findErrorOption(forged));
		// The field grant is a PREPARE refusal, so the batch reports it under its prepare phase; the
		// grant sentence itself is the unwrapped failure underneath.
		expect(refusal).toBeInstanceOf(Collections.MutationPhaseFailure);
		expect(refusal).toMatchObject({ phase: 'prepare' });
		expect(unwrapMutationPhase(refusal)).toMatchObject({
			action: 'create',
			resource: 'assignments',
			reason: 'create includes fields outside the matching policy grant'
		});

		const allowedId = recordId('allowed-create');
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).mutate(
					harness!.effectId('allowed-create'),
					fieldWorker,
					'assignments',
					[{ id: allowedId, title: 'Allowed' }],
					false,
					0,
					{ root: { id: allowedId, action: 'create' } }
				);
			})
		);
		const rows = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).findMany(
					harness!.effectId('verify-create'),
					adminSubject,
					{ collection: 'assignments' }
				);
			})
		);
		expect(rows).toEqual([
			expect.objectContaining({
				id: allowedId,
				title: 'Allowed',
				source: 'server-computed'
			})
		]);
	});
});
