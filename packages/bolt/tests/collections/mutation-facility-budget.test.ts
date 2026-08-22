import { describe, expect, it, afterEach } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * Both per-row costs are declared, or the measurement is of a path that never ran.
 *
 * `create.after` is what used to force a second read of a row that had just been read back, and a
 * change trigger is what used to force a third read plus an enqueue. A collection with neither
 * exercises none of it — `emitChangeEvents` returns immediately when no automation watches the
 * collection — so a fixture without them would pass this test no matter what the pipeline does.
 */
const authored = {
	...emptyAuthoredRuntime,
	hooks: {
		notes: {
			create: {
				perRecord: {
					after: { description: 'observe the written row', handler: () => undefined }
				}
			}
		}
	},
	automations: {
		on_note: {
			name: 'on_note',
			trigger: { _tag: 'Change' as const, collection: 'notes', event: 'created' as const },
			handler: () => undefined
		}
	}
};

/**
 * That a batched write costs the same number of round trips whatever N is.
 *
 * Every facility call is an RPC out of the guest isolate before it is a query, and the batch path
 * used to make three per row *after* the transaction had already committed in one: a read-back per
 * row, a second read of the same row for its `after` hook, and a read-plus-enqueue per row for its
 * change event. Measured on a real payroll run that was 89 rows and 18.1 seconds, of which the
 * write itself was milliseconds.
 *
 * A count, not a duration, because a duration is a machine's opinion and this is a shape. The two
 * sizes are compared against each other rather than against a fixed number, so the test says the
 * only thing worth saying — that cost does not scale with N — and does not have to be edited every
 * time the pipeline legitimately gains or loses a step.
 */
const definition = workspace({
	name: 'budget',
	version: '1.0.0',
	collections: [collection({ name: 'notes', fields: { body: field.string({ required: true }) } })],
	apps: [app({ name: 'budget', label: 'Budget' })],
	// A team name maps to the policy names its members hold; `teamPath` on the subject names teams.
	teams: { admin: ['admin-data'] },
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	requiredFacilities: [],
	policies: [
		policy({
			name: 'admin-data',
			effect: 'allow',
			grants: [
				{ collection: 'notes', action: 'create' },
				{ collection: 'notes', action: 'read' },
				{ collection: 'notes', action: 'update' },
				{ collection: 'notes', action: 'delete' }
			]
		})
	]
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const callsToWrite = async (rows: number): Promise<number> => {
	harness = await makeBoltTestRuntime(definition, { authored });
	harness.database.forget();
	await harness.runtime.runPromise(
		Effect.gen(function* () {
			const collections = yield* Collections.Service;
			yield* collections.mutate(
				EffectId.make(`budget-${rows}`),
				adminSubject,
				'notes',
				Array.from({ length: rows }, (_, index) => ({ body: `note ${index}` }))
			);
		})
	);
	const count = harness.database.calls.length;
	await harness.dispose();
	harness = undefined;
	return count;
};

describe('the facility-call budget of a batched write', () => {
	it('costs the same number of round trips for 50 rows as for 1', async () => {
		const one = await callsToWrite(1);
		const fifty = await callsToWrite(50);

		// Equal, not merely sub-linear. A single extra per-row call would make this 49 apart.
		expect(fifty).toBe(one);
		// And the constant is small enough that the assertion above is not passing on a shared floor
		// of setup traffic that swamps the difference.
		expect(one).toBeLessThan(10);
	}, 60_000);
});
