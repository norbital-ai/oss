import { describe, expect, it } from 'vitest';
import { AuthoredRefusal, refusalAt } from '../../src/authoring/refusal.js';

/**
 * The seam that labels a refusal must never destroy a failure that is not one.
 *
 * `refusalAt` is reached from `Effect.catch` around an authored hook, whose error channel is *typed*
 * `AuthoredRefusal` and is not one: an Effect the handler returns keeps its own channel, and the
 * authoring signatures declare that channel `never`. A nested write that fails — `payslips.mutate`
 * inside a payroll `create.after` — therefore arrives here as a tagged collections failure wearing a
 * refusal's type. Rebuilding it threw from the `NonEmptyString` message field, and a
 * `Schema.TaggedError` that throws yields a plain `Error` with no `_tag` and no properties, so the
 * original failure was annihilated by the seam that existed only to label it.
 */
describe('refusalAt', () => {
	const site = { collection: 'payslips', action: 'create' } as const;

	it('hands back a tagged non-refusal untouched instead of throwing', () => {
		const failure = { _tag: 'Bolt.Collections.MutationPhaseFailure', phase: 'settle' };
		expect(refusalAt(failure, site)).toBe(failure);
	});

	it('hands back an ordinary Error untouched rather than dressing it as a refusal', () => {
		const failure = new Error('the write actually failed');
		const out = refusalAt(failure, site);
		expect(out).toBe(failure);
		expect(out).not.toBeInstanceOf(AuthoredRefusal);
	});

	it('still stamps a real refusal with the site', () => {
		const stamped = refusalAt(new AuthoredRefusal({ message: 'a rule refused this' }), site);
		expect(stamped).toBeInstanceOf(AuthoredRefusal);
		expect((stamped as AuthoredRefusal).collection).toBe('payslips');
		expect((stamped as AuthoredRefusal).action).toBe('create');
		expect((stamped as AuthoredRefusal).message).toBe('a rule refused this');
	});

	it('does not relabel a refusal that already named its own collection', () => {
		const owned = new AuthoredRefusal({
			message: 'the run is settled',
			collection: 'payroll_runs',
			action: 'update'
		});
		expect(refusalAt(owned, site)).toBe(owned);
	});
});
