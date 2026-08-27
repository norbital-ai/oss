import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { refuse, AuthoredRefusal } from '../../src/authoring/refusal.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

/**
 * Which of a batch's three phases failed, which is a different question from why.
 *
 * The three mean three different things to whoever is handling the failure, and until the phase was
 * tagged they were indistinguishable — a refusal from a `before` hook and a refusal from an `after`
 * hook arrived as the same `AuthoredRefusal`, and the caller had no way to tell "nothing was
 * written, retry the batch" from "the batch is already committed, do not retry it". The second is
 * the one that costs money: retrying a settled payroll run pays it twice.
 *
 * So each case asserts the phase **and** that the original failure survived the wrapper. Either
 * alone is satisfied by a wrong implementation: a wrapper that reported the phase and swallowed the
 * cause would turn every business rule in the workspace back into an unrecognised 500, which is the
 * regression `AuthoredRefusal` exists to prevent.
 */
const definition = workspace({
	name: 'phases',
	version: '1.0.0',
	collections: [collection({ name: 'notes', fields: { body: field.string({ required: true }) } })],
	apps: [app({ name: 'phases', label: 'Phases' })],
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
				{ collection: 'notes', action: 'read' }
			]
		})
	]
});

const hooksRefusingIn = (site: 'before' | 'after') => ({
	...emptyAuthoredRuntime,
	hooks: {
		notes: {
			create: {
				perRecord: {
					[site]: {
						description: `refuses in ${site}`,
						handler: (context: unknown) => {
							refuse('A note must name a subject.');
							return context;
						}
					}
				}
			}
		}
	}
});

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const writeTwo = () =>
	Effect.gen(function* () {
		const collections = yield* Collections.Service;
		return yield* collections.mutate(EffectId.make('phases-1'), adminSubject, 'notes', [
			{ body: 'first' },
			{ body: 'second' }
		]);
	});

/** The failure a mutate raised, as the phase wrapper it now is. */
const phaseFailureOf = async (runtime: BoltTestRuntime) => {
	const outcome = await runtime.runtime.runPromise(Effect.result(writeTwo()));
	if (outcome._tag !== 'Failure')
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
	return outcome.failure;
};

describe('a batched write that fails', () => {
	it('reports a before-hook refusal as prepare, with nothing committed', async () => {
		harness = await makeBoltTestRuntime(definition, { authored: hooksRefusingIn('before') });

		const failure = await phaseFailureOf(harness);

		expect(failure).toBeInstanceOf(Collections.MutationPhaseFailure);
		expect(failure).toMatchObject({ phase: 'prepare', collection: 'notes', committed: [] });
		// The claim `committed: []` makes, checked against the database rather than taken on trust.
		expect(await harness.database.query('select id from notes')).toHaveLength(0);
		// And the sentence the author wrote is still the failure underneath, not a casualty of it.
		const cause = Collections.unwrapMutationPhase(failure);
		expect(cause).toBeInstanceOf(AuthoredRefusal);
		expect((cause as AuthoredRefusal).message).toBe('A note must name a subject.');
		expect((cause as AuthoredRefusal).action).toBe('create.before');
	}, 60_000);

	it('reports an after-hook refusal as settle, naming the rows that are already facts', async () => {
		harness = await makeBoltTestRuntime(definition, { authored: hooksRefusingIn('after') });

		const failure = await phaseFailureOf(harness);

		expect(failure).toBeInstanceOf(Collections.MutationPhaseFailure);
		expect(failure).toMatchObject({ phase: 'settle', collection: 'notes' });
		// The transaction committed before the `after` hook ran, so the rows exist. This is exactly
		// the case a caller must not retry, and `committed` is what lets it tell.
		const stored = await harness.database.query('select id from notes');
		expect(stored).toHaveLength(2);
		const committed = (failure as Collections.MutationPhaseFailure).committed;
		expect([...committed].toSorted()).toEqual(stored.map((row) => String(row['id'])).toSorted());
		const cause = Collections.unwrapMutationPhase(failure);
		expect(cause).toBeInstanceOf(AuthoredRefusal);
		expect((cause as AuthoredRefusal).action).toBe('create.after');
	}, 60_000);

	it('leaves a successful batch untouched', async () => {
		harness = await makeBoltTestRuntime(definition, { authored: emptyAuthoredRuntime });

		const written = await harness.runtime.runPromise(writeTwo());

		expect(written).toHaveLength(2);
		expect(written.map((row) => row['body'])).toEqual(['first', 'second']);
	}, 60_000);
});

describe('unwrapMutationPhase', () => {
	it('returns a value that is not a phase failure unchanged', () => {
		const refusal = new AuthoredRefusal({ message: 'unrelated' });
		expect(Collections.unwrapMutationPhase(refusal)).toBe(refusal);
	});

	it('keeps the innermost phase when one batch fails inside another', () => {
		// A hook may write, and its write is a batch of its own. The inner batch is the one that knows
		// what was committed, so wrapping it again would replace a true answer with a vaguer one.
		const inner = new Collections.MutationPhaseFailure({
			phase: 'settle',
			collection: 'payslips',
			committed: ['a'],
			cause: new AuthoredRefusal({ message: 'inner' })
		});
		expect(Collections.mutationPhaseFailure('prepare', 'payroll_runs', [], inner)).toBe(inner);
	});
});
