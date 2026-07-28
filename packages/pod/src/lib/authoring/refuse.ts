import { HttpError } from '../server/collection/http_error.js';

/**
 * Refuse a mutation with a message the person who attempted it will read.
 *
 * A hook throws for two very different reasons, and the platform cannot tell them apart from a bare
 * `Error`:
 *
 * - **a refusal** — "A paid payroll run is immutable. Correct it with a later run." Someone wrote
 *   that sentence for a user. It is the answer to what they just tried to do.
 * - **a fault** — a null dereference, a driver error. Nobody wrote it for anyone, and showing it
 *   leaks internals while telling the user nothing they can act on.
 *
 * A plain `throw new Error(...)` is treated as the second kind: logged server-side, reported to the
 * client as `INTERNAL_ERROR` with no text. That is right for a fault and wrong for a refusal, which
 * is how carefully-worded rules end up reaching people as "something went wrong".
 *
 * `refuse` marks the first kind. The message is carried to the client verbatim and surfaced by the
 * form that attempted the write.
 *
 * ```ts
 * export default {
 *   update: {
 *     before: async ({ existing }) => {
 *       if (existing.lifecycle === 'PAID')
 *         refuse('A paid payroll run is immutable. Correct it with a later run.');
 *     }
 *   }
 * } satisfies Hooks;
 * ```
 *
 * Write the message for the person, not the log: say what was refused and what to do instead.
 */
export function refuse(message: string): never {
	throw new HttpError(409, message);
}
