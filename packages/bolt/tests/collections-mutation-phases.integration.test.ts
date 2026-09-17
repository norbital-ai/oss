import { afterEach, describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../src/authoring/workspace-schema.js';
import { approveBy } from '../src/authoring/approval-flow.js';
import {
	describePolicy,
	policyRuntimeFunctionsFor
} from '../src/authoring/policy-introspection.js';
import { refuse, AuthoredRefusal } from '../src/authoring/refusal.js';
import * as Collections from '../src/runtime/collections/collections.js';
import { MAX_ORDINARY_MUTATION_CHANGED_ROWS } from '../src/runtime/collections/write/plan.js';
import { SyncCommit } from '../src/runtime/facilities/services.js';
import { emptyAuthoredRuntime, type AuthoredRuntime } from '../src/runtime/collections/authored.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { unwrapMutationPhase } from './support/mutation-phase.js';

/**
 * Which of a batch's phases failed, which is a different question from why.
 *
 * A refusal ahead of the transaction and a database failure inside it mean different things to
 * whoever is handling the failure: "nothing was written, retry the batch" against "the batch is
 * already committed, do not retry it". The second is the one that costs money: retrying a settled
 * payroll run pays it twice.
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

const notesModule: AuthoredRuntime['collections']['notes'] = {
	create: { input: { columns: { body: true } } }
};

const authoredWith = (
	transform?: (inputs: ReadonlyArray<Readonly<Record<string, unknown>>>) => unknown
): AuthoredRuntime => ({
	...emptyAuthoredRuntime,
	collections: { notes: { ...notesModule, ...(transform === undefined ? {} : { transform }) } }
});

const pendingDefinition = workspace({
	name: 'pending-phases',
	version: '1.0.0',
	collections: [collection({ name: 'notes', fields: { body: field.string({ required: true }) } })],
	apps: [],
	teams: { writers: ['writer'], reviewers: [] },
	automations: [],
	envoys: [],
	integrations: [],
	prompt: 'You are the pending capture test workspace agent.',
	tools: [],
	skills: [],
	requiredFacilities: [],
	policies: [
		describePolicy('writer', {
			description: 'Writers submit notes through review.',
			grants: {
				notes: {
					read: {},
					mutate: {
						new: { approval: { flow: () => approveBy('reviewers'), superceded_by: [] } }
					}
				}
			}
		})
	]
});
const pendingFunctions = policyRuntimeFunctionsFor(pendingDefinition.policies);
const pendingAuthored: AuthoredRuntime = {
	...authoredWith(),
	policyAuthorizations: pendingFunctions.authorizations,
	approvalFlows: pendingFunctions.approvalFlows
};
const pendingSubject = {
	...adminSubject,
	admin: false,
	teamPath: ['writers']
};

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const create = (
	effectId: string,
	inputs: ReadonlyArray<Readonly<Record<string, unknown>>>,
	subject = adminSubject
) =>
	Effect.gen(function* () {
		const collections = yield* Collections.Service;
		return yield* collections.write(EffectId.make(effectId), subject, [
			{ collection: 'notes', action: 'create', inputs }
		]);
	});

const writeTwo = () => create('phases-1', [{ body: 'first' }, { body: 'second' }]);

/** The failure a write raised. */
const phaseFailureOf = async (runtime: BoltTestRuntime) => {
	const outcome = await runtime.runtime.runPromise(Effect.result(writeTwo()));
	if (outcome._tag !== 'Failure')
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
	return outcome.failure;
};

describe('a batched write that fails', () => {
	it('reports a transform refusal ahead of the transaction, with nothing committed', async () => {
		harness = await makeBoltTestRuntime(definition, {
			authored: authoredWith(() => {
				refuse('A note must name a subject.');
			})
		});

		const failure = await phaseFailureOf(harness);

		// Nothing was written, checked against the database rather than taken on trust.
		expect(await harness.database.query('select id from notes')).toHaveLength(0);
		// And the sentence the author wrote is the failure, stamped with the site it came from.
		const cause = unwrapMutationPhase(failure);
		expect(cause).toBeInstanceOf(AuthoredRefusal);
		expect((cause as AuthoredRefusal).message).toBe('A note must name a subject.');
		expect((cause as AuthoredRefusal).action).toBe('transform');
	}, 60_000);

	it('leaves a successful batch untouched', async () => {
		harness = await makeBoltTestRuntime(definition, { authored: authoredWith() });

		const written = await harness.runtime.runPromise(writeTwo());

		expect(written.records).toHaveLength(2);
		expect(written.records.map((row) => row['body'])).toEqual(['first', 'second']);
	}, 60_000);

	it('emits no batch when the database transaction fails', async () => {
		// The transform hands the database a null it will not take: the failure is the commit's.
		harness = await makeBoltTestRuntime(definition, {
			authored: authoredWith((inputs) => inputs.map((input) => ({ ...input, body: null })))
		});
		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const syncCommit = yield* SyncCommit.Service;
				const outcome = yield* Effect.result(create('phases-commit-failure', [{ body: 'x' }]));
				return { outcome, changes: yield* syncCommit.drainChanges };
			})
		);

		expect(result.outcome._tag).toBe('Failure');
		if (result.outcome._tag === 'Failure')
			expect(result.outcome.failure).toMatchObject({ phase: 'commit', committed: [] });
		expect(result.changes).toEqual([]);
		expect(await harness.database.query('select id from notes')).toEqual([]);
	}, 60_000);

	it('commits a reviewed write provisionally under the hold and publishes the request beside it', async () => {
		harness = await makeBoltTestRuntime(pendingDefinition, { authored: pendingAuthored });
		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const syncCommit = yield* SyncCommit.Service;
				const commit = yield* create(
					'phases-pending-approval',
					[{ body: 'Held for review' }],
					pendingSubject
				);
				return { commit, changes: yield* syncCommit.drainChanges };
			})
		);

		// RFC §4.8: the row is real, stamped with the request, and the request rides the same batch.
		const requestId = result.commit.pendingApproval?.requestId;
		expect(requestId).toBeDefined();
		expect(result.changes.map((change) => change.collection).toSorted()).toEqual([
			'approval_request',
			'notes',
			'requestor'
		]);
		expect(result.changes).toContainEqual(
			expect.objectContaining({
				collection: 'approval_request',
				operation: 'insert',
				after: expect.objectContaining({
					collection_name: 'notes',
					status: 'ONGOING',
					applied_at: null
				})
			})
		);
		expect(await harness.database.query('select body, approval_id from notes')).toEqual([
			{ body: 'Held for review', approval_id: requestId }
		]);
		// The restore point: a hold revision recording the row's absence before the proposal.
		expect(
			await harness.database.query(
				`select snapshot from bolt_collection_history where collection_name = 'notes' and operation = 'hold' and approval_id = $1`,
				[requestId]
			)
		).toEqual([{ snapshot: null }]);
	}, 60_000);

	it('admits the changed-row limit and refuses one more before commit', async () => {
		harness = await makeBoltTestRuntime(definition, { authored: authoredWith() });
		const result = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const syncCommit = yield* SyncCommit.Service;
				const admitted = yield* create(
					'phases-boundary-admitted',
					Array.from({ length: MAX_ORDINARY_MUTATION_CHANGED_ROWS }, (_, index) => ({
						body: `admitted-${index}`
					}))
				);
				const admittedChanges = yield* syncCommit.drainChanges;
				const refused = yield* Effect.result(
					create(
						'phases-boundary-refused',
						Array.from({ length: MAX_ORDINARY_MUTATION_CHANGED_ROWS + 1 }, (_, index) => ({
							body: `refused-${index}`
						}))
					)
				);
				const refusedChanges = yield* syncCommit.drainChanges;
				return { admitted, admittedChanges, refused, refusedChanges };
			})
		);

		expect(result.admitted.records).toHaveLength(MAX_ORDINARY_MUTATION_CHANGED_ROWS);
		expect(result.admittedChanges).toHaveLength(MAX_ORDINARY_MUTATION_CHANGED_ROWS);
		expect(result.refused._tag).toBe('Failure');
		expect(JSON.stringify(result.refused)).toContain(
			`may change at most ${MAX_ORDINARY_MUTATION_CHANGED_ROWS} rows`
		);
		expect(result.refusedChanges).toEqual([]);
		expect(await harness.database.query('select id from notes')).toHaveLength(
			MAX_ORDINARY_MUTATION_CHANGED_ROWS
		);
	}, 120_000);
});

describe('unwrapMutationPhase', () => {
	it('returns a value that is not a phase failure unchanged', () => {
		const refusal = new AuthoredRefusal({ message: 'unrelated' });
		expect(unwrapMutationPhase(refusal)).toBe(refusal);
	});

	it('keeps the innermost phase when one batch fails inside another', () => {
		// The inner batch is the one that knows what was committed, so wrapping it again would
		// replace a true answer with a vaguer one.
		const inner = new Collections.MutationPhaseFailure({
			phase: 'settle',
			collection: 'payslips',
			committed: ['a'],
			cause: new AuthoredRefusal({ message: 'inner' })
		});
		expect(Collections.mutationPhaseFailure('prepare', 'payroll_runs', [], inner)).toBe(inner);
	});
});
