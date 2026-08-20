import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Effect, Exit, Option, Result } from 'effect';
import { refuse, AuthoredRefusal } from '../../src/authoring/refusal.js';
import { runAuthoredHandler } from '../../src/runtime/collections/authored.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import { Collections } from '../../src/runtime/collections/collections.js';
import {
	adminSubject,
	makeBoltTestRuntime,
	recordId,
	type BoltTestRuntime
} from '../support/bolt-test-layer.js';

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
		// The synchronous case is the one that could not be caught at all before this change: the
		// handler used to be called in `runAuthoredHandler`'s argument position, so the throw escaped
		// before the function was entered. It is also the majority spelling in every template.
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
		const exit = await outcomeOf(
			runAuthoredHandler(() => {
				throw new TypeError('cannot read properties of undefined');
			})
		);
		// The contract this change does *not* alter. A refusal is a rule; a `TypeError` is a fault, and
		// reporting it as a business rule would be the same conflation in the opposite direction.
		expect(refusalFrom(exit)).toBeUndefined();
		expect(String(defectFrom(exit))).toContain('cannot read properties of undefined');
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

describe('a refusal raised from a real hook', () => {
	let harness: BoltTestRuntime;

	beforeAll(async () => {
		harness = await makeBoltTestRuntime(undefined, {
			authored: {
				...emptyAuthoredRuntime,
				hooks: {
					people: {
						create: {
							// Nested under `perRecord` because that is where a rule authored for one record now
							// lives: `prepare` runs once for the batch and decides nothing, and `before` runs once
							// per record, which is the only place a refusal can come from.
							perRecord: {
								before: {
									description: 'Refuses a person with no team.',
									/**
									 * Typed as the *runtime* carrier declares it, not as an author would write it.
									 *
									 * These two shapes are deliberately different and it matters which one a test is
									 * standing in. `AuthoredHookPoint.handler` is `(context: unknown, api: unknown) =>
									 * unknown`, because by the time the runtime holds a handler the authoring types have
									 * already done their work at compile time. An author gets the narrow one —
									 * `CreateBefore` in `authoring/contracts-schema.ts` types the context properly, and
									 * `satisfies Hooks` from the generated `$types.js` is what applies it.
									 *
									 * This suite hand-builds an `AuthoredRuntime`, which is the runtime side, so it
									 * conforms to the runtime shape and narrows inside. Widening the declared type to
									 * make this line compile would be the fix in the wrong direction: it would loosen the
									 * contract every real workspace is written against in order to suit a double.
									 */
									handler: (context: unknown) => {
										const input = (context as { readonly input: Record<string, unknown> }).input;
										if (input['team'] == null) refuse('A person must belong to a team.');
										return input;
									}
								}
							}
						}
					}
				}
			}
		});
	});

	afterAll(async () => {
		await harness.dispose();
	});

	it('refuses the write, writes no row, and names the collection and the phase', async () => {
		const id = recordId('refused-person');
		const exit = await harness.runtime.runPromiseExit(
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				yield* collections.create(harness.effectId('refusal-1'), adminSubject, {
					collection: 'people',
					id,
					values: { name: 'Ada' }
				});
			})
		);
		const refusal = refusalFrom(exit);
		expect(refusal).toMatchObject({
			message: 'A person must belong to a team.',
			collection: 'people',
			action: 'create.before'
		});
		// The load-bearing half. A `before` hook refuses *ahead of* the write, so there is nothing to
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
				yield* collections.create(harness.effectId('admit-1'), adminSubject, {
					collection: 'people',
					id,
					values: { name: 'Grace', team: 'payroll' }
				});
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
