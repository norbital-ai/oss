import { MutationPhaseFailure } from '../../src/runtime/collections/collections.contract.js';

/**
 * The failure a mutation phase wrapped, or the failure it already is.
 *
 * `mutationPhaseFailure` keeps its `cause` rather than replacing it so the original error — an
 * `AuthoredRefusal` mapped to a 422, a loud database guard mapped to its message — stays reachable
 * by every caller that decides on `instanceof` or on the message. Only assertions unwrap it, which
 * is why this lives beside the suites rather than on the runtime's public surface.
 */
export const unwrapMutationPhase = (cause: unknown): unknown =>
	cause instanceof MutationPhaseFailure ? cause.underlying : cause;
