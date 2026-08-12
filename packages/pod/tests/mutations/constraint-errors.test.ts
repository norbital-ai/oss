import { describe, it, expect } from 'vitest';
import { HttpError } from '$lib/server/collection/http_error.js';
import { rethrowConstraintViolation } from '$lib/server/collection/constraint-errors.server.js';
import { mutationRejection } from '$lib/server/collection/sync/mutation-rejection.server.js';

/** What node-postgres hands us for a class-23 failure. */
function driverError(fields: Record<string, unknown>): unknown {
	return Object.assign(new Error('constraint violation'), fields);
}

function rejectionFor(caught: unknown) {
	try {
		rethrowConstraintViolation(caught, 'employees');
	} catch (thrown) {
		return { rejection: mutationRejection(thrown), thrown };
	}
	return { rejection: mutationRejection(caught), thrown: undefined };
}

describe('constraint violations become answers a person can act on', () => {
	/**
	 * The whole point. `mutationRejection` refuses to surface anything that was not authored for the
	 * caller, so before this translation a duplicate name reached the user as the literal string
	 * `INTERNAL_ERROR` — untrue, since nothing internal failed, and useless, since it does not say
	 * what to change.
	 */
	it('names the field a duplicate collided on', () => {
		const { rejection } = rejectionFor(
			driverError({
				code: '23505',
				detail: 'Key (email)=(a@b.test) already exists.',
				constraint: 'employees_email_unique',
				table: 'employees'
			})
		);
		expect(rejection.reason).toBe('UNIQUE_VIOLATION');
		expect(rejection.detail).toBe('Another record already uses this email.');
	});

	it('falls back to the constraint name when the driver gives no detail line', () => {
		const { rejection } = rejectionFor(
			driverError({
				code: '23505',
				constraint: 'employees_identity_number_unique',
				table: 'employees'
			})
		);
		expect(rejection.detail).toBe('Another record already uses this identity number.');
	});

	it('reads every column of a composite unique key', () => {
		const { rejection } = rejectionFor(
			driverError({ code: '23505', detail: 'Key (company_id, code)=(1, A) already exists.' })
		);
		expect(rejection.detail).toBe('Another record already uses this company id and code.');
	});

	it('explains a dangling reference and a missing required value', () => {
		expect(
			rejectionFor(
				driverError({
					code: '23503',
					detail: 'Key (company_id)=(7) is not present in table "companies".'
				})
			).rejection.detail
		).toBe('The company id refers to a record that no longer exists.');

		const notNull = rejectionFor(driverError({ code: '23502', column: 'start_date' }));
		expect(notNull.rejection.reason).toBe('NOT_NULL_VIOLATION');
		expect(notNull.rejection.detail).toBe('start date is required.');
	});

	it('turns an exclusion violation into an actionable overlap conflict', () => {
		const { rejection, thrown } = rejectionFor(
			driverError({
				code: '23P01',
				constraint: 'employment_terms_no_overlap',
				detail:
					'Key (employment_id, norbital_daterange(effective_range))=(abc, [2026-01-01,2027-01-01)) conflicts with existing key.'
			})
		);
		expect(rejection.reason).toBe('EXCLUSION_VIOLATION');
		expect(rejection.detail).toBe(
			'This record overlaps another record that is already in effect.'
		);
		expect(thrown).toBeInstanceOf(HttpError);
		expect((thrown as HttpError).status).toBe(409);
		expect((thrown as HttpError).body.constraint).toBe('employment_terms_no_overlap');
	});

	/**
	 * The counterpart guarantee: only class-23 is translated. Anything else must keep collapsing to
	 * INTERNAL_ERROR, because dressing an unexpected failure up as user error tells the user to fix
	 * something they did not cause.
	 */
	it('leaves anything that is not a constraint violation completely alone', () => {
		for (const caught of [
			driverError({ code: '42P01' }),
			driverError({ code: 'ECONNREFUSED' }),
			new Error('boom'),
			{ nope: true }
		]) {
			expect(() => rethrowConstraintViolation(caught, 'employees')).not.toThrow();
			expect(mutationRejection(caught).reason).toBe('INTERNAL_ERROR');
		}
	});

	it('carries the field so a form can attach the message to the right input', () => {
		const { thrown } = rejectionFor(
			driverError({ code: '23505', detail: 'Key (email)=(a@b.test) already exists.' })
		);
		expect(thrown).toBeInstanceOf(HttpError);
		expect((thrown as HttpError).body.field).toBe('email');
		expect((thrown as HttpError).status).toBe(409);
	});
});
