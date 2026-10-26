// A body as declarations store it and the guest calls it by path (D8). Effect-free: a bundle without a generator body
// imports this module and carries no Effect.
import type { ValueOf } from './fields.ts';

/**
 * How the in-app agent may call a query or action: `direct` (default), `confirm` (an in-app confirmation card first) or `never`.
 */
export type AgentUse = 'direct' | 'confirm' | 'never';
/** The value a query, action or automation literal declares as its `output` (`undefined` when it declares none). */
export type OutputOf<X> = X extends { output: infer O } ? ValueOf<O> : undefined;
/** A body as a declaration stores it and the guest calls it by path. */
export type Body = (...args: never[]) => unknown;

/** Set by the seed bundler's banner: declarations load for their data only, so their bodies stay unwrapped. */
const SEED_BUILD = Symbol.for('norbital.bolt.seedBuild');
/**
 * A body as a declaration stores it: a generator through the guest edge, its ctx the argument at `at` (-1: none). The
 * wrapper runs only at the guest ABI; authored bodies retain their generator signatures. The edge's `install()` sets
 * `wrap` only in a bundle that carries generator bodies, so a body-free bundle carries no Effect (D8).
 */
export function attached<F extends Body>(body: F, at: number): F {
	// Keep the compiler's generator diagnostic when no generator installed the edge.
	if (attached.wrap === undefined) {
		// A build-time seed reader imports model modules for their declared fields; its bodies never run there.
		if ((globalThis as { readonly [SEED_BUILD]?: boolean })[SEED_BUILD] === true) return body;
		throw new Error('ctx-bearing body must be a generator function; guest edge missing');
	}
	return attached.wrap(body, at) as F;
}
/** The ambient property adds no module initialization to bundles without a guest edge. */
export declare namespace attached {
	export let wrap: ((body: Body, at: number) => Body) | undefined;
}
