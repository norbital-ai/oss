// A record id read from outside a typed row (a URL, a JSON payload, an integration's reply): decoded once into the
// model's branded `Id<C>`, so no author casts a string into one.
import { Schema } from 'effect';
import type { TargetName } from './names.ts';
import type { Id } from './values.ts';

/**
 * The schema of one model's record id: decodes a non-empty string into `Id<C>`.
 *
 * ```ts
 * const id = Schema.decodeUnknownSync(idOf('employee'))(params.get('employee')); // Id<'employee'>
 * ```
 */
export const idOf = <C extends TargetName>(model: C): Schema.declare<Id<C>> =>
	Schema.declare((u: unknown): u is Id<C> => typeof u === 'string' && u.length > 0, {
		identifier: `Id<${model}>`,
		expected: `a ${model} id`
	});
