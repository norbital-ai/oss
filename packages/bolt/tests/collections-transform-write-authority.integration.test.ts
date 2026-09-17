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
} from '../src/authoring/workspace-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';

/** A non-administrator who may create a run, but may only read the output the workspace derives. */
const operator = {
	userId: 'operator-1',
	tenantId: 'test-tenant',
	policies: [],
	teamPath: ['operators']
};

const definition: WorkspaceDefinition = workspace({
	name: 'transform-write-authority',
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
	relations: [
		{
			name: 'outputs',
			source: 'runs',
			target: 'outputs',
			cardinality: 'many',
			from: { collection: 'runs', column: 'id' },
			to: { collection: 'outputs', column: 'run_id' },
			cascade: true
		}
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

/**
 * The transform derives the run's outputs (RFC §4.4): rows the caller never submitted and could
 * not have, since the operator holds no `outputs` create. They are the workspace's own work.
 */
const authored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	collections: {
		runs: {
			create: { input: { columns: { label: true } } },
			transform: (inputs: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
				Effect.succeed(
					inputs.map((input) => ({
						...input,
						outputs: { create: [{ amount: 10 }, { amount: 20 }] }
					}))
				)
		},
		outputs: { create: { input: { columns: { run_id: true, amount: true } } } }
	}
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

describe("a transform's derived rows, as the workspace", () => {
	it('writes derived rows under the authorized root without granting direct child creation', async () => {
		harness = await makeBoltTestRuntime(definition, { authored });
		const collections = await harness.runtime.runPromise(Collections.Service);

		const direct = await harness.runtime.runPromise(
			collections
				.write(EffectId.make('direct-output'), operator, [
					{
						collection: 'outputs',
						action: 'create',
						inputs: [{ run_id: '00000000-0000-4000-8000-000000000001', amount: 99 }]
					}
				])
				.pipe(Effect.result)
		);
		expect(direct._tag).toBe('Failure');

		const outcome = await harness.runtime.runPromise(
			collections
				.write(EffectId.make('authorized-root'), operator, [
					{ collection: 'runs', action: 'create', inputs: [{ label: 'August payroll' }] }
				])
				.pipe(Effect.result)
		);
		expect(outcome._tag, 'the transform-derived graph must commit').toBe('Success');

		const [run] = await harness.database.query('select id from runs');
		expect(
			await harness.database.query('select run_id, amount from outputs order by amount')
		).toEqual([
			{ run_id: run?.['id'], amount: 10 },
			{ run_id: run?.['id'], amount: 20 }
		]);
	}, 60_000);
});
