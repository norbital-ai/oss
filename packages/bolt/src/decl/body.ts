// A body as declarations store it and the guest calls it by path (D8). Effect-free: a bundle without a generator body
// imports this module and carries no Effect.
import type { ValueOf } from './fields.ts';
import type { BodyReturn } from './ctx.ts';
import type { Verdict, VerdictData } from './access/policy.ts';

/**
 * How the in-app agent may call a query or action: `direct` (default), `confirm` (an in-app confirmation card first) or `never`.
 */
export type AgentUse = 'direct' | 'confirm' | 'never';
/** The value a query, action or automation literal declares as its `output` (`undefined` when it declares none). */
export type OutputOf<X> = X extends { output: infer O } ? ValueOf<O> : undefined;
/** A body as a declaration stores it and the guest calls it by path. */
export type Body = (...args: never[]) => unknown;
/** A known authored generator, retaining its argument tuple and result; its failures are tagged (`BodyError`). */
export type GeneratorBody<A extends readonly unknown[] = readonly never[], O = unknown> = (...args: A) => BodyReturn<O>;
/** An attached generator at the invocation boundary. */
export type AttachedBody<A extends readonly unknown[], O> = (...args: A) => Promise<O>;

/** Set by the seed bundler's banner: declarations load for their data only and their bodies cannot execute. */
const SEED_BUILD = Symbol.for('norbital.bolt.seedBuild');
const GENERATOR = Symbol.for('norbital.bolt.generator');
const seed_body = <A extends readonly unknown[]>(body: (...args: A) => unknown) => {
	const blocked = (..._args: A): Promise<never> =>
		Promise.reject(new Error('a declaration body cannot run in a data-only seed build'));
	Object.defineProperty(blocked, 'name', { value: body.name });
	return Object.defineProperty(blocked, GENERATOR, { value: body });
};
/**
 * A body as a declaration stores it: a generator through the guest edge, its ctx the argument at `at` (-1: none). The
 * wrapper runs only at the guest ABI; authored bodies retain their generator signatures. The edge's `install()` sets
 * `wrap` only in a bundle that carries generator bodies, so a body-free bundle carries no Effect (D8).
 */
export function attached<A extends readonly unknown[], O>(
	body: GeneratorBody<A, O>, at: number
): AttachedBody<A, O> {
	// Keep the compiler's generator diagnostic when no generator installed the edge.
	if (attached.wrap === undefined) {
		// A build-time seed reader imports model modules for their declared fields; its bodies never run there.
		const seedBuild: unknown = Reflect.get(globalThis, SEED_BUILD);
		if (seedBuild === true) return seed_body(body);
		throw new Error('ctx-bearing body must be a generator function; guest edge missing');
	}
	return attached.wrap(body, at);
}
/** A policy check has a distinct result boundary: authored Verdict values become native verdict data. */
export function attached_verdict<A extends readonly unknown[]>(
	body: GeneratorBody<A, Verdict>, at: number
): AttachedBody<A, VerdictData> {
	if (attached.verdict === undefined) {
		const seedBuild: unknown = Reflect.get(globalThis, SEED_BUILD);
		if (seedBuild === true) return seed_body(body);
		throw new Error('ctx-bearing body must be a generator function; guest edge missing');
	}
	return attached.verdict(body, at);
}
/** The ambient property adds no module initialization to bundles without a guest edge. */
export declare namespace attached {
	export let wrap: (<A extends readonly unknown[], O>(
		body: GeneratorBody<A, O>, at: number
	) => AttachedBody<A, O>) | undefined;
	export let verdict: (<A extends readonly unknown[]>(
		body: GeneratorBody<A, Verdict>, at: number
	) => AttachedBody<A, VerdictData>) | undefined;
}
