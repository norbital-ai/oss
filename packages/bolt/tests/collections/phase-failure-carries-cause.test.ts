import { describe, expect, it } from 'vitest';
import {
	MutationPhaseFailure,
	mutationPhaseFailure
} from '../../src/runtime/collections/collections.contract.js';

/**
 * A wrapper must never destroy the failure it exists to carry.
 *
 * `collection` is `NonEmptyString`, and a `Schema.TaggedError` whose own field rejects its value
 * throws from the constructor — message "Schema validation failed", no `_tag`, no properties. Every
 * `instanceof` downstream then misses it and it falls through to a generic 500, so the real cause is
 * annihilated by the act of wrapping it. Observed as a payroll that committed a run, refused to
 * persist 290 payslips, and reported three words about it.
 */
describe('mutationPhaseFailure', () => {
	const cause = new Error('the write actually failed because of this');

	it('survives an empty collection name instead of throwing', () => {
		const failure = mutationPhaseFailure('settle', '', ['committed-id'], cause);
		expect(failure).toBeInstanceOf(MutationPhaseFailure);
		expect(failure.collection).not.toBe('');
		expect(failure.underlying).toBe(cause);
	});

	it('keeps a real collection name untouched', () => {
		const failure = mutationPhaseFailure('settle', 'payslips', [], cause, 'after-hook');
		expect(failure.collection).toBe('payslips');
		expect(failure.step).toBe('after-hook');
		expect(failure.phase).toBe('settle');
	});

	it('does not wrap a wrapper', () => {
		const inner = mutationPhaseFailure('prepare', 'payslips', [], cause);
		expect(mutationPhaseFailure('settle', 'payroll_runs', [], inner)).toBe(inner);
	});

	it('carries the cause through whitespace-only names too', () => {
		expect(mutationPhaseFailure('settle', '   ', [], cause).underlying).toBe(cause);
	});
});
