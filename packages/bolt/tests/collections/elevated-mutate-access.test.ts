import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import {
	app,
	collection,
	field,
	policy,
	workspace,
	type WorkspaceDefinition
} from '../../src/authoring/workspace-schema.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

/** A non-administrator who may create a run, but may only read its engine-owned output. */
const operator = {
	userId: 'operator-1',
	tenantId: 'test-tenant',
	policies: [],
	teamPath: ['operators']
};

const definition: WorkspaceDefinition = workspace({
	name: 'elevated-mutate-access',
	version: '1.0.0',
	collections: [
		collection({ name: 'runs', fields: { label: field.string({ required: true }) } }),
		collection({
			name: 'outputs',
			fields: {
				run_id: field.uuid({ required: true }),
				amount: field.number({ required: true })
			}
		})
	],
	apps: [app({ name: 'operator', label: 'Operator' })],
	teams: { operators: ['operator'] },
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'operator',
			effect: 'allow',
			grants: [
				{ collection: 'runs', action: 'create' },
				{ collection: 'runs', action: 'read' },
				{ collection: 'outputs', action: 'read' }
			]
		})
	]
});

const authored = {
	...emptyAuthoredRuntime,
	hooks: {
		runs: {
			create: {
				perRecord: {
					after: {
						description: 'Builds the derived output owned by the completed run.',
						handler: (context: unknown, api: unknown) =>
							Effect.gen(function* () {
								const runId = String(
									(context as { readonly record: Readonly<Record<string, unknown>> }).record.id
								);
								const outputs = (
									api as {
										readonly db: Readonly<
											Record<
												string,
												{
													readonly mutate: (
														values: Readonly<Record<string, unknown>>
													) => Effect.Effect<void>;
												}
											>
										>;
									}
								).db['outputs'];
								if (outputs === undefined) return yield* Effect.die('outputs api missing');
								yield* outputs.mutate({ run_id: runId, amount: 10 });
								yield* outputs.mutate({ run_id: runId, amount: 20 });
							})
					}
				}
			}
		}
	}
} as unknown as typeof emptyAuthoredRuntime;

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe('an elevated after-hook mutation', () => {
	it('writes derived rows under the authorized root without granting direct child creation', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		const collections = await harness.runtime.runPromise(Collections.Service);

		const direct = await harness.runtime.runPromise(
			collections
				.mutate(EffectId.make('direct-output'), operator, 'outputs', [
					{ run_id: '00000000-0000-4000-8000-000000000001', amount: 99 }
				])
				.pipe(Effect.result)
		);
		expect(direct._tag).toBe('Failure');

		await harness.runtime.runPromise(
			collections.mutate(EffectId.make('authorized-root'), operator, 'runs', [
				{ label: 'August payroll' }
			])
		);

		expect(await harness.database.query('select amount from outputs order by amount')).toEqual([
			{ amount: 10 },
			{ amount: 20 }
		]);
	}, 60_000);
});
