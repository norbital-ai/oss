import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Effect, Exit, Option, Result } from 'effect';
import { refuse, AuthoredRefusal } from '../src/authoring/refusal.js';
import {
	emptyAuthoredRuntime,
	runAuthoredHandler,
	type AuthoredRuntime
} from '../src/runtime/collections/authored.js';
import * as Collections from '../src/runtime/collections/collections.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from './support/bolt-test-layer.js';
import { unwrapMutationPhase } from './support/mutation-phase.js';

/** The `people` write contract, with the one transform a rule can come from (RFC §4.4). */
const authored: AuthoredRuntime = {
	...emptyAuthoredRuntime,
	collections: {
		people: {
			create: { input: { columns: { name: true, team: true } } },
			transform: (inputs: ReadonlyArray<Readonly<Record<string, unknown>>>) => {
				for (const input of inputs)
					if (input['team'] == null) refuse('A person must belong to a team.');
				return inputs;
			}
		}
	}
};

/**
 * A refusal is a business rule, and the whole point of this suite is that it stops being reported as
 * a broken runtime.
 *
 * Both halves are asserted every time, because either alone is satisfied by a wrong implementation.
 * "It failed" is satisfied by the old behaviour — `refuse` threw, `orDie` made it a defect, and the
 * operation failed exactly as loudly. "It carries the sentence" is satisfied by a defect too. What
 * distinguishes the target is *which channel* it arrives in: a typed failure the caller can match on
 * rather than a defect that bypasses every mapping and reports 500. So each case asserts the
 * failure is typed **and** that no defect was raised.
 */
const outcomeOf = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromiseExit(effect);

describe('refuse, as a typed refusal rather than a defect', () => {
	it('is a typed failure when a plain synchronous handler throws it', async () => {
		const exit = await outcomeOf(
			runAuthoredHandler(() => {
				refuse('A payslip cannot be deleted without its payroll run.');
				return 'unreachable';
			})
		);
		expect(Exit.isFailure(exit)).toBe(true);
		// The synchronous case is the sharpest one: the handler runs inside the thunk, so a throw
		// lands in the refusal channel instead of escaping before the function is entered. It is
		// also the majority spelling in every template.
		expect(refusalFrom(exit)).toMatchObject({
			_tag: 'Bolt.Authored.Refusal',
			message: 'A payslip cannot be deleted without its payroll run.'
		});
		expect(defectFrom(exit)).toBeUndefined();
	});

	it('is a typed failure when an async handler rejects with it', async () => {
		const exit = await outcomeOf(
			runAuthoredHandler(async () => {
				refuse('Unpaid break must be shorter than the recorded worked time.');
				return 'unreachable';
			})
		);
		expect(Exit.isFailure(exit)).toBe(true);
		expect(refusalFrom(exit)).toMatchObject({
			message: 'Unpaid break must be shorter than the recorded worked time.'
		});
		expect(defectFrom(exit)).toBeUndefined();
	});

	it('is a typed failure when an Effect.gen handler throws it mid-generator', async () => {
		const exit = await outcomeOf(
			runAuthoredHandler(() =>
				Effect.gen(function* () {
					yield* Effect.void;
					refuse('Worked intervals must be in time order and cannot overlap.');
					return 'unreachable';
				})
			)
		);
		// Effect converts a throw inside a generator into a defect before anyone else sees it, so this
		// is the path that needs `catchDefect` rather than a `try`.
		expect(refusalFrom(exit)).toMatchObject({
			message: 'Worked intervals must be in time order and cannot overlap.'
		});
		expect(defectFrom(exit)).toBeUndefined();
	});

	it('leaves a handler that genuinely broke as a defect', async () => {
		const synchronousExit = await outcomeOf(
			runAuthoredHandler(() => {
				throw new TypeError('cannot read properties of undefined');
			})
		);
		const asynchronousExit = await outcomeOf(
			runAuthoredHandler(async () => {
				throw new TypeError('could not finish async work');
			})
		);
		// The contract this change does *not* alter. A refusal is a rule; a `TypeError` is a fault, and
		// reporting it as a business rule would be the same conflation in the opposite direction.
		expect(refusalFrom(synchronousExit)).toBeUndefined();
		expect(String(defectFrom(synchronousExit))).toContain('cannot read properties of undefined');
		expect(refusalFrom(asynchronousExit)).toBeUndefined();
		expect(String(defectFrom(asynchronousExit))).toContain('could not finish async work');
	});

	it('passes a value and a resolved promise through untouched', async () => {
		await expect(Effect.runPromise(runAuthoredHandler(() => 41 + 1))).resolves.toBe(42);
		await expect(Effect.runPromise(runAuthoredHandler(async () => 'settled'))).resolves.toBe(
			'settled'
		);
	});

	it('substitutes a sentence rather than losing the refusal when one is empty', async () => {
		// `message` is a `NonEmptyString`, so an empty sentence would make the error constructor itself
		// throw and replace the author's refusal with a schema complaint. The refusal has to survive.
		const exit = await outcomeOf(runAuthoredHandler(() => refuse('   ')));
		const refusal = refusalFrom(exit);
		expect(refusal).toBeDefined();
		expect(refusal?.message.length ?? 0).toBeGreaterThan(0);
	});
});

describe('a refusal raised from a real transform', () => {
	let harness: BoltTestRuntime;

	beforeAll(async () => {
		harness = await makeBoltTestRuntime(undefined, { authored });
	}, 30_000);

	afterAll(async () => {
		await harness.dispose();
	});

	it('refuses the write, writes no row, and names the collection and the site', async () => {
		const id = recordId('refused-person');
		const exit = await harness.runtime.runPromiseExit(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.write(harness.effectId('refusal-1'), adminSubject, [
					{ collection: 'people', action: 'create', inputs: [{ id, name: 'Ada' }] }
				]);
			})
		);
		// The refusal is stamped with the site it came from — the transform, which runs ahead of the
		// transaction. Unwrapping restores the typed refusal, which is what a business rule is.
		const failure = Option.getOrUndefined(Exit.findErrorOption(exit));
		const refusal = unwrapMutationPhase(failure);
		expect(refusal).toBeInstanceOf(AuthoredRefusal);
		expect(refusal).toMatchObject({
			message: 'A person must belong to a team.',
			collection: 'people',
			action: 'transform'
		});
		expect(defectFrom(exit)).toBeUndefined();
		// The load-bearing half. The transform refuses *ahead of* the write, so there is nothing to
		// undo — and if the refusal had arrived after the insert, this row would exist and the
		// semantic in item 2 would be untrue.
		const rows = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.findMany(harness.effectId('refusal-read'), adminSubject, {
					collection: 'people'
				});
			})
		);
		expect(rows).toHaveLength(0);
	});

	it('admits a write the rule allows, so the suite is not satisfied by refusing everything', async () => {
		const id = recordId('admitted-person');
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.write(harness.effectId('admit-1'), adminSubject, [
					{
						collection: 'people',
						action: 'create',
						inputs: [{ id, name: 'Grace', team: 'payroll' }]
					}
				]);
			})
		);
		const rows = await harness.runtime.runPromise(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				return yield* collections.findMany(harness.effectId('admit-read'), adminSubject, {
					collection: 'people'
				});
			})
		);
		expect(rows).toHaveLength(1);
	});
});

/** The refusal an exit failed with, or `undefined` if it failed some other way. */
const refusalFrom = (exit: Exit.Exit<unknown, unknown>): AuthoredRefusal | undefined => {
	const error = Option.getOrUndefined(Exit.findErrorOption(exit));
	return error instanceof AuthoredRefusal ? error : undefined;
};

/**
 * The defect an exit died with, or `undefined` if it did not die.
 *
 * Asserted as absent in every refusal case above, because "the operation failed" is equally true of
 * the behaviour being replaced — the distinguishing fact is that nothing died.
 */
const defectFrom = (exit: Exit.Exit<unknown, unknown>): unknown => {
	const found = Exit.findDefect(exit);
	return Result.isSuccess(found) ? found.success : undefined;
};
