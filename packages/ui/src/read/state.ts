import { Predicate } from 'effect';
import type { LiveError, Query } from '../client/contract.js';
export type ReadState<T> =
	| { kind: 'loading' }
	| { kind: 'empty' }
	| { kind: 'noAccess' }
	| { kind: 'error'; code: string; message: string }
	| { kind: 'ready'; value: T };
export function readState<T>(
	value: T | undefined,
	error: LiveError | undefined,
	loading = true
): ReadState<T> {
	if (error !== undefined)
		return error.code === 'forbidden'
			? { kind: 'noAccess' }
			: { kind: 'error', code: error.code, message: error.message };
	return value === undefined ? { kind: loading ? 'loading' : 'empty' } : { kind: 'ready', value };
}
/** A one-shot read's rejection as a state (reads reject with `{ code }`, §3.5). */
export const failed = (e: unknown): ReadState<never> => {
	// a rejection is untyped: only its `code` member is read
	const code = Predicate.hasProperty(e, 'code') ? String(e.code) : 'error';
	return code === 'forbidden'
		? { kind: 'noAccess' }
		: { kind: 'error', code, message: e instanceof Error ? e.message : String(e) };
};
/** What a view reads of a `Query<T>` (live where a component reads it): its answer, its wait and its failure. */
export type Reading<T> = Pick<Query<T>, 'current' | 'loading' | 'error'>;
/** A reading's state for `ReadGate`; no reading (`null`) is empty. */
export const queryState = <T>(q: Reading<T> | null): ReadState<T> =>
	q === null
		? { kind: 'empty' }
		: q.error !== undefined
			? failed(q.error)
			: readState(q.current, undefined, q.loading);
/**
 * `q`'s answer seen through `f` (a later page's own rows), keeping its wait and failure; `f`'s `undefined` is no answer
 * yet. `Q` is the reading itself, so a `bolt.query(…)` argument keeps its own answer type.
 */
export function mapped<Q extends Reading<unknown>, B>(
	q: Q,
	f: (answer: Exclude<Q['current'], undefined>) => B | undefined
): Reading<B>;
export function mapped<A, B>(q: Reading<A>, f: (answer: A) => B | undefined): Reading<B> {
	return {
		get current() {
			const answer = q.current;
			return answer === undefined ? undefined : f(answer);
		},
		get loading() {
			return q.loading;
		},
		get error() {
			return q.error;
		}
	};
}
