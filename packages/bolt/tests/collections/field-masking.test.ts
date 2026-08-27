import { afterEach, describe, expect, it } from 'vitest';
import { Effect, Exit, Option } from 'effect';
import { describePolicy } from '../../src/authoring/policy-introspection.js';
import { collection, field, workspace } from '../../src/authoring/workspace-schema.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import type * as Identity from '../../src/runtime/identity/identity.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

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
	policies: [
		describePolicy('admin', {
			description: 'May manage assignments.',
			grants: {
				assignments: { create: {}, read: {}, update: {}, delete: {} }
			}
		}),
		describePolicy('field-worker', {
			description: 'May work only with the public assignment fields.',
			grants: {
				assignments: {
					read: { fields: ['id', 'title'] },
					create: { fields: ['title'] },
					update: { fields: ['title'] }
				}
			}
		})
	],
	teams: { admin: ['admin'], 'field-worker': ['field-worker'] },
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
				yield* collections.create(harness!.effectId('create'), adminSubject, {
					collection: 'assignments',
					id,
					values: { title: 'Inspect site', controller_note: 'Do not disclose' }
				});
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
		harness = await makeBoltTestRuntime(definition, {
			authored: {
				...emptyAuthoredRuntime,
				hooks: {
					assignments: {
						update: {
							perRecord: {
								before: {
									description: 'Attempts to add a controller-only note.',
									handler: (context: unknown) => ({
										...(context as { readonly input: Record<string, unknown> }).input,
										controller_note: 'injected by hook'
									})
								}
							}
						}
					}
				}
			}
		});
		const id = recordId('hooked-assignment');
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).create(harness!.effectId('create'), adminSubject, {
					collection: 'assignments',
					id,
					values: { title: 'Original', controller_note: 'Private' }
				});
			})
		);

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).update(
					harness!.effectId('restricted-update'),
					fieldWorker,
					{ collection: 'assignments', id, values: { title: 'Changed' } }
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
					{ declarative: true, root: { id, action: 'update' } }
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
					assignments: {
						create: {
							perRecord: {
								before: {
									description: 'Owns the controller-only provenance field.',
									handler: (context: unknown) => ({
										title: String(
											(context as { readonly input: Record<string, unknown> }).input['title']
										),
										source: 'server-computed'
									})
								}
							}
						}
					}
				}
			}
		});

		const forgedId = recordId('forged-create');
		const forged = await harness.runtime.runPromiseExit(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).create(
					harness!.effectId('forged-create'),
					fieldWorker,
					{
						collection: 'assignments',
						id: forgedId,
						values: { title: 'Forged', source: 'caller-forged' }
					}
				);
			})
		);
		expect(Option.getOrUndefined(Exit.findErrorOption(forged))).toMatchObject({
			action: 'create',
			resource: 'assignments',
			reason: 'create includes fields outside the matching policy grant'
		});

		const allowedId = recordId('allowed-create');
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Collections.Service).create(
					harness!.effectId('allowed-create'),
					fieldWorker,
					{
						collection: 'assignments',
						id: allowedId,
						values: { title: 'Allowed' }
					}
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
