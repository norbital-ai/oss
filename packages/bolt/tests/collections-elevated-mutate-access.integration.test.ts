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
import { authoredHooks, type CollectionHooks } from '../src/authoring/contracts-schema.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../src/runtime/collections/authored.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from './support/bolt-test-layer.js';

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

/**
 * The fixture tables as a schema, so the hook is typed the way a compiled workspace's are: the
 * `record` an after hook receives types the run id down, and `api.db.outputs.mutate` carries the
 * collection's own write shape instead of a reflected `Record`.
 */
interface ElevatedAccessSchema {
	readonly tables: {
		readonly runs: {
			readonly $inferSelect: { readonly id: string; readonly label: string };
			readonly $inferInsert: { readonly id?: string; readonly label: string };
		};
		readonly outputs: {
			readonly $inferSelect: {
				readonly id: string;
				readonly run_id: string;
				readonly amount: number;
			};
			readonly $inferInsert: {
				readonly id?: string;
				readonly run_id: string;
				readonly amount: number;
			};
		};
	};
	readonly relations: Record<string, never>;
}

const runHooks: CollectionHooks<ElevatedAccessSchema, 'runs'> = {
	mutate: {
		perRecord: {
			after: {
				description: 'Builds the derived output owned by the completed run.',
				handler: ({ previous, record, api }) =>
					Effect.gen(function* () {
						if (previous !== undefined) return;
						yield* api.db.outputs.mutate([{ run_id: record.id, amount: 10 }]);
						yield* api.db.outputs.mutate([{ run_id: record.id, amount: 20 }]);
					})
			}
		}
	}
};

const authored = {
	...emptyAuthoredRuntime,
	hooks: { runs: authoredHooks(runHooks) }
};

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

		// The whole write — commit and the settle aftermath it triggers, which is where the derived
		// outputs are written — must complete. Asserted through the outcome so a post-commit settle
		// failure surfaces as `MutationPhaseFailure phase: 'settle'` right here, not as a bare throw.
		const outcome = await harness.runtime.runPromise(
			collections
				.mutate(EffectId.make('authorized-root'), operator, 'runs', [{ label: 'August payroll' }])
				.pipe(Effect.result)
		);
		expect(outcome._tag, 'the settled mutation must succeed').toBe('Success');

		expect(await harness.database.query('select amount from outputs order by amount')).toEqual([
			{ amount: 10 },
			{ amount: 20 }
		]);
	}, 60_000);
});
