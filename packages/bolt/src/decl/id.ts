// A record id read from outside a typed row (a URL, a JSON payload, an integration's reply): decoded once into the
// model's branded `Id<C>`, so no author casts a string into one; or a fresh one a writer mints for a row it creates.
import { uuidv7 } from '@norbital-ai/host-api';
import { Schema } from 'effect';
import type { TargetName } from './names.ts';
import type { Id } from './values.ts';

const GUEST_UUIDV7 = Symbol.for('norbital.bolt.uuidv7');
const mintUuidv7 = (): string => {
	const hook = Reflect.get(globalThis, GUEST_UUIDV7);
	return typeof hook === 'function' ? String(hook()) : uuidv7();
};

/**
 * The schema of one model's record id: decodes a non-empty string into `Id<C>`.
 *
 * ```ts
 * const id = Schema.decodeUnknownSync(id_of('employee'))(params.get('employee')); // Id<'employee'>
 * ```
 */
export const id_of = <C extends TargetName>(model: C): Schema.declare<Id<C>> =>
	Schema.declare((u: unknown): u is Id<C> => typeof u === 'string' && u.length > 0, {
		identifier: `Id<${model}>`,
		expected: `a ${model} id`
	});
/**
 * A fresh uuidv7 for a row of `model` the caller creates: a created root carrying it can be named by
 * a later act in the same act map, which then commits both together. A run mints the same ids on every attempt.
 *
 * ```ts
 * const loan = new_id('loans');
 * yield* ctx.act({ 'loans.create': [{ id: loan, amount }], 'loan_repayments.create': [{ loan, due_on }] });
 * ```
 */
export const new_id = <C extends TargetName>(model: C): Id<C> =>
	Schema.decodeUnknownSync(id_of(model))(mintUuidv7());
