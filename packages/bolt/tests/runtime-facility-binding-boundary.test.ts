import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { EffectId, InvocationId, success, type FacilityBinding } from '@norbital-ai/bolt-protocol';
import {
	FacilityError,
	invokeBinding,
	type CallContext
} from '../src/runtime/facilities/database.js';

const context: CallContext = {
	invocationId: InvocationId.make('invocation-1'),
	environment: 'test',
	tenantId: 'tenant'
};

const failureOf = (binding: FacilityBinding<unknown, unknown>) =>
	Effect.runPromise(
		Effect.flip(invokeBinding('connector', binding, context, EffectId.make('effect-1'), {}))
	);

/**
 * The guest's side of the facility contract. Whatever the host binding does, the guest sees a
 * typed `FacilityError` and never a defect: a defect here ends the invocation with a message
 * nobody can act on, and one shape of it (a binding resolving to nothing) used to be a
 * `TypeError` reading `_tag` of `undefined`.
 */
describe('invokeBinding boundary', () => {
	it('answers a binding that throws synchronously as a transport failure', async () => {
		const error = await failureOf({
			call: () => {
				throw new Error('threw before returning a promise');
			}
		});
		expect(error).toBeInstanceOf(FacilityError);
		expect(error).toMatchObject({
			code: 'transport_failure',
			message: 'threw before returning a promise'
		});
	});

	it('answers a binding that rejects as a transport failure', async () => {
		expect(await failureOf({ call: () => Promise.reject(new Error('rejected')) })).toMatchObject({
			code: 'transport_failure',
			message: 'rejected'
		});
	});

	it('answers a binding that resolves to something other than a facility result as a failure', async () => {
		for (const value of [undefined, null, 'ok', { value: 1 }, { _tag: 'Done' }]) {
			expect(await failureOf({ call: () => Promise.resolve(value as never) })).toMatchObject({
				code: 'invalid_result',
				operation: 'connector'
			});
		}
		const answered = await Effect.runPromise(
			invokeBinding(
				'connector',
				{ call: () => Promise.resolve(success({ ok: true })) },
				context,
				EffectId.make('effect-2'),
				{}
			)
		);
		expect(answered).toEqual({ ok: true });
	});
});
